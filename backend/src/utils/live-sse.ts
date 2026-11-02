import type { SSEStreamingApi } from 'hono/streaming'

/** 展示事件独立排队，模型回调不等待浏览器写入；慢连接不能无限积压。 */
export function createLiveSSE(stream: SSEStreamingApi, onDisconnect: () => void, heartbeatMs = 15_000) {
  let closed = false
  let pending = 0
  let tail = Promise.resolve()
  let resolveClosed: () => void = () => {}
  const disconnected = new Promise<void>(resolve => { resolveClosed = resolve })

  function disconnect() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    resolveClosed()
    onDisconnect()
  }

  function send(event: string, data: unknown): void {
    if (closed || stream.aborted || stream.closed) {
      disconnect()
      return
    }
    if (pending >= 256) {
      disconnect()
      stream.abort()
      return
    }
    const serialized = JSON.stringify(data)
    pending++
    tail = tail.then(async () => {
      if (closed) return
      await stream.writeSSE({ event, data: serialized })
      if (stream.aborted || stream.closed) disconnect()
    }).catch(disconnect).finally(() => { pending-- })
  }

  const heartbeat = setInterval(() => send('ping', {}), heartbeatMs)
  stream.onAbort(disconnect)

  return {
    send,
    flush: () => Promise.race([tail, disconnected]),
    dispose() {
      closed = true
      clearInterval(heartbeat)
      resolveClosed()
    },
  }
}
