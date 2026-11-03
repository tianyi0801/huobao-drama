import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'

export interface AgentSaveReceipt {
  tool: string
  result: Record<string, any>
}

/** 注册名与工具 id 保持一致；只有实际成功执行保存工具才记录回执。 */
export function registerAgentTools(tools: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.values(tools).map(tool => {
    const name = tool.id as string
    const registered = createTool({
      id: name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      execute: async (input: any, context: any) => {
        const rc = context?.requestContext as RequestContext | undefined
        const targetId = rc?.get('targetStoryboardId' as never)
        const extractTarget = rc?.get('extractTarget' as never)
        if (typeof extractTarget === 'string' && (name.startsWith('read_existing_') || name.startsWith('save_dedup_'))) {
          if (name !== `read_existing_${extractTarget}` && name !== `save_dedup_${extractTarget}`) {
            return { error: `本次只允许提取 ${extractTarget}` }
          }
        }
        if (typeof targetId === 'number' && (name.startsWith('save_') || name === 'update_storyboard')) {
          if (name !== 'update_storyboard' || input.storyboard_id !== targetId) {
            return { error: `本次只允许更新分镜 ${targetId} 的视频提示词` }
          }
        }
        const result = await tool.execute(input, context)
        if ((name.startsWith('save_') || name === 'update_storyboard') && result && !result.error) {
          const rc = context?.requestContext as RequestContext | undefined
          const receipts = rc?.get('saveReceipts' as never) as AgentSaveReceipt[] | undefined
          const receipt = { tool: name, result }
          receipts?.push(receipt)
          const notify = rc?.get('onSave' as never) as ((receipt: AgentSaveReceipt) => void) | undefined
          try { notify?.(receipt) } catch { /* 展示回调不能影响已成功的业务写入 */ }
        }
        return result
      },
    })
    return [name, registered]
  }))
}

/** 只记录计数，不输出模型正文、工具参数或密钥。缺失推理计数不能当作零推理。 */
export function getAgentUsage(result: any) {
  const usage = result?.usage || result?.totalUsage || {}
  return {
    finishReason: result?.finishReason,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens,
    textChars: typeof result?.text === 'string' ? result.text.length : undefined,
    toolCalls: result?.toolCalls?.length,
  }
}

/** 自然语言说“完成”不等于保存成功；空道具列表的成功保存也有回执。 */
export function assertAgentSaved(type: string, result: any, rc: RequestContext<any>, target?: string): void {
  if (result?.finishReason === 'length') {
    const usage = getAgentUsage(result)
    const details = [
      usage.outputTokens != null ? `输出 ${usage.outputTokens} token` : '',
      usage.reasoningTokens != null ? `其中推理 ${usage.reasoningTokens} token` : '',
    ].filter(Boolean).join('，')
    throw new Error(`模型输出达到长度上限，任务未完成${details ? `（${details}）` : ''}；请检查文本模型思考模式与单批输出长度`)
  }
  if (result?.finishReason === 'tool-calls') throw new Error('Agent 达到最大执行轮次，任务尚未完成；请检查已保存内容后再重试')
  const receipts = (rc.get('saveReceipts' as never) as AgentSaveReceipt[] | undefined) || []
  const saved = receipts.some(({ tool, result: output }) => {
    if (type === 'script_rewriter') return tool === 'save_script' && output.word_count > 0
    if (type === 'storyboard_breaker') return (tool === 'save_storyboards' && output.count > 0)
      || (tool === 'update_storyboard' && output.storyboard_id > 0 && output.updated_fields?.length > 0)
    if (type === 'extractor') return target ? tool === `save_dedup_${target}` : tool.startsWith('save_dedup_')
    const targetId = rc.get('targetStoryboardId' as never)
    if (type === 'prompt_generator' && typeof targetId === 'number') {
      return tool === 'update_storyboard' && output.storyboard_id === targetId && output.updated_fields?.includes('video_prompt')
    }
    return tool.startsWith('save_') || tool === 'update_storyboard'
  })
  if (!saved) throw new Error('AI 本次没有成功调用保存工具，数据未更新；请检查日志中的工具错误，不要把模型回复当作完成')
}
