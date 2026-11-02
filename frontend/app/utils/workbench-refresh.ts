/** 合并并发刷新；较早请求返回的快照不覆盖保存后请求的新快照。 */
export function createWorkbenchRefresh<T>(load: () => Promise<T>, apply: (snapshot: T) => void) {
  let requested = 0
  let pending: Promise<void> | null = null
  return () => {
    requested++
    if (!pending) {
      pending = (async () => {
        while (true) {
          const version = requested
          const snapshot = await load()
          if (version !== requested) continue
          apply(snapshot)
          break
        }
      })().finally(() => { pending = null })
    }
    return pending
  }
}
