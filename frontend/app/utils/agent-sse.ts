/** 收到明确的 done 才完成；连接关闭本身不代表 Agent 执行成功。 */
export async function consumeAgentSSE(resp: Response, onEvent: (event: string, data: any) => void) {
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('实时响应没有内容')
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let dataLines: string[] = []
  let completed = false

  function dispatch() {
    if (!dataLines.length) { event = 'message'; return }
    const data = JSON.parse(dataLines.join('\n'))
    onEvent(event, data)
    if (event === 'error') throw new Error(data?.message || 'AI 执行失败')
    if (event === 'done') completed = true
    event = 'message'
    dataLines = []
  }

  function line(value: string) {
    if (!value) { dispatch(); return }
    if (value.startsWith('event:')) event = value.slice(6).trim()
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).replace(/^ /, ''))
  }

  try {
    while (!completed) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0 && !completed) {
        line(buffer.slice(0, idx).replace(/\r$/, ''))
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
      }
      if (done) {
        if (!completed && buffer) line(buffer.replace(/\r$/, ''))
        if (!completed) dispatch()
        break
      }
    }
    if (!completed) throw new Error('实时连接提前结束，任务结果未确认；请检查已保存内容后再重试')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
