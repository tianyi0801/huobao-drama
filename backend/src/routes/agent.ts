/**
 * Agent 聊天路由
 *
 * - POST /:type/chat   非流式（兼容旧调用方）
 * - POST /:type/stream 流式（SSE）：把「思考 / 调工具 / 输出文本」实时推给前端，
 *   用于工作台显示「AI 正在做什么」。工具副作用（写剧本、写分镜）仍由工具自身落库，
 *   事件只承担展示职责，因此流式与一次性执行的结果一致。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

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
      { maxSteps: 20, requestContext },
    )

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

// POST /agent/:type/stream — 流式 Agent 对话（SSE）
// 事件：start / step / text / reasoning / tool-call / tool-result / done / error
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
    let text = ''
    const toolStartedAt = new Map<string, number>()
    // 页面关闭/切走时中止 Agent，避免后台空跑
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    c.req.raw.signal.addEventListener('abort', onAbort)

    try {
      const result = await agent.stream([{ role: 'user', content: message }], {
        maxSteps: 20,
        requestContext,
        abortSignal: abort.signal,
      })
      await stream.writeSSE({ event: 'start', data: JSON.stringify({ agent: agentType }) })

      for await (const chunk of result.fullStream as AsyncIterable<any>) {
        const payload = chunk?.payload || {}
        switch (chunk?.type) {
          case 'step-start':
            await stream.writeSSE({ event: 'step', data: JSON.stringify({ index: payload.stepIndex ?? null }) })
            break
          case 'text-delta': {
            const delta = String(payload.text || '')
            if (!delta) break
            text += delta
            await stream.writeSSE({ event: 'text', data: JSON.stringify({ text: delta }) })
            break
          }
          case 'reasoning-delta': {
            const delta = String(payload.text || '')
            if (delta) await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ text: delta }) })
            break
          }
          case 'tool-call': {
            const name = normalizeToolName(chunk) || 'tool'
            const id = payload.toolCallId || `${name}-${toolStartedAt.size}`
            toolStartedAt.set(id, performance.now())
            logTaskProgress('Agent', 'tool-call', { agentType, tool: name })
            await stream.writeSSE({
              event: 'tool-call',
              data: JSON.stringify({ id, name, args: summarize(payload.args) }),
            })
            break
          }
          case 'tool-result': {
            const name = normalizeToolName(chunk) || 'tool'
            const id = payload.toolCallId || [...toolStartedAt.keys()].pop() || name
            const startedAt = toolStartedAt.get(id)
            const ms = startedAt ? Math.round(performance.now() - startedAt) : undefined
            logTaskProgress('Agent', 'tool-result', { agentType, tool: name, ms })
            await stream.writeSSE({
              event: 'tool-result',
              data: JSON.stringify({ id, name, ok: !payload.isError, ms, preview: summarize(payload.result, 120) }),
            })
            break
          }
          case 'error':
            throw new Error(payload?.error?.message || payload?.message || 'Agent 执行失败')
          default:
            break
        }
      }

      const elapsedMs = Math.round(performance.now() - startTime)
      logTaskSuccess('Agent', `${agentType} stream`, { elapsedMs, chars: text.length })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ text, elapsedMs }) })
    } catch (err: any) {
      const reason = abort.signal.aborted ? '已取消' : (err?.message || 'Agent 执行失败')
      logTaskError('Agent', `${agentType} stream`, { error: reason })
      if (!abort.signal.aborted) console.error(err?.stack || err)
      try {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: reason }) })
      } catch { /* 连接已断开，无需再写 */ }
    } finally {
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
