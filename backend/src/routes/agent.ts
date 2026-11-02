/**
 * Agent 聊天路由
 *
 * - POST /:type/chat   非流式（兼容旧调用方）
 * - POST /:type/stream 通过 SSE 推送每轮工具结果与输出文本。
 *   模型本身沿用 generate 调用，避免流式工具参数在部分兼容接口上失败。
 *   展示队列不阻塞 AI；工具副作用（写剧本、写分镜）仍由工具自身落库。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { assertAgentSaved, getAgentUsage } from '../agents/execution.js'
import { STORYBOARD_MAX_STEPS } from '../agents/local-contract.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { createLiveSSE } from '../utils/live-sse.js'

const app = new Hono()

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()

  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: agentType === 'storyboard_breaker' ? STORYBOARD_MAX_STEPS : 20, requestContext },
    )
    assertAgentSaved(agentType, result, requestContext)

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

/** 工具入参/结果摘要 — 只给前端看"在做什么"，避免大 JSON 全量传输 */
function summarize(value: any, max = 160) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value) } catch { return String(value) }
  })()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// POST /agent/:type/stream — 实时活动 SSE，模型仍走非流式生成
// 事件：start / step / text / tool-call / tool-result / done / error；等待期间发送 ping
app.post('/:type/stream', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body
  if (!episode_id || !drama_id) {
    logTaskError('Agent', `${agentType} stream`, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) return badRequest(c, 'Agent 不存在')

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  logTaskStart('Agent', `${agentType} stream`, { dramaId: drama_id, episodeId: episode_id })
  const startTime = performance.now()

  // 反向代理默认会缓冲响应体，显式关闭才能逐块到达浏览器
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    const live = createLiveSSE(stream, onAbort)
    requestContext.set('onSave', receipt => {
      live.send('saved', { tool: receipt.tool, count: receipt.result.count, episode_id })
    })
    c.req.raw.signal.addEventListener('abort', onAbort)
    if (c.req.raw.signal.aborted) onAbort()
    let stepIndex = 0

    try {
      live.send('start', { agent: agentType })
      // 保持升级前的模型请求协议：SSE 只传展示信息，不强迫厂商支持流式工具调用。
      const result = await agent.generate([{ role: 'user', content: message }], {
        maxSteps: agentType === 'storyboard_breaker' ? STORYBOARD_MAX_STEPS : 20,
        requestContext,
        abortSignal: abort.signal,
        onStepFinish: (step: any) => {
          live.send('step', { index: ++stepIndex })
          logTaskProgress('Agent', 'step-usage', { agentType, step: stepIndex, ...getAgentUsage(step) })
          const calls = step?.toolCalls || []
          const results = step?.toolResults || []
          for (const [index, call] of calls.entries()) {
            const name = normalizeToolName(call) || 'tool'
            const id = call?.payload?.toolCallId || call?.toolCallId || `${stepIndex}-${index}`
            const toolResult = results.find((entry: any) =>
              (entry?.payload?.toolCallId || entry?.toolCallId) === id,
            ) || results[index]
            const output = toolResult?.payload?.result ?? toolResult?.result
            logTaskProgress('Agent', 'tool-finished', { agentType, step: stepIndex, tool: name })
            live.send('tool-call', { id, name, args: summarize(call?.payload?.args ?? call?.args) })
            if (toolResult) live.send('tool-result', {
              id, name,
              ok: !toolResult?.payload?.isError && !toolResult?.isError && !output?.error,
              preview: summarize(output, 120),
            })
          }
          if (step?.text) live.send('text', { text: String(step.text) })
        },
      })
      if (abort.signal.aborted) throw new Error('已取消')
      logTaskProgress('Agent', 'generation-usage', { agentType, ...getAgentUsage(result) })
      assertAgentSaved(agentType, result, requestContext)
      const elapsedMs = Math.round(performance.now() - startTime)
      logTaskSuccess('Agent', `${agentType} stream`, { elapsedMs, steps: stepIndex, chars: result.text?.length || 0 })
      live.send('done', { text: result.text || '', elapsedMs })
    } catch (err: any) {
      const reason = abort.signal.aborted ? '已取消' : (err?.message || 'Agent 执行失败')
      logTaskError('Agent', `${agentType} stream`, { elapsedMs: Math.round(performance.now() - startTime), error: reason })
      if (!abort.signal.aborted) console.error(err?.stack || err)
      live.send('error', { message: reason })
    } finally {
      await live.flush()
      live.dispose()
      c.req.raw.signal.removeEventListener('abort', onAbort)
    }
  })
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
