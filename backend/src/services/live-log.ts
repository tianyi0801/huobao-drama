/**
 * 进程内实时日志中心 — 只服务「AI 正在干什么」的临时展示
 *
 * 设计取舍：
 * - **不落库**：日志属于过程性信息，后端重启即丢；要排查历史请用 task-logger 的控制台输出。
 * - 每个任务键保留最近 N 条：便于用户在任务运行中/刚结束后再点开日志也能看到前文（回放）。
 * - 零依赖的订阅模型：SSE 路由订阅、提取任务推送，两者通过 key 解耦。
 */
export type LiveLogKind = 'start' | 'step' | 'tool' | 'saved' | 'text' | 'done' | 'error'

export interface LiveLogEntry {
  /** 单调递增序号，前端用于去重与排序 */
  id: number
  /** 时间戳（毫秒） */
  at: number
  kind: LiveLogKind
  /** 工具 id（kind = tool / saved） */
  tool?: string
  /** kind = saved 时的新增/合并数量 */
  created?: number
  merged?: number
  /** kind = text 时的模型输出字数 */
  chars?: number
  /** kind = text 时的模型输出内容（已截断，仅用于展示「它说了什么」） */
  text?: string
  /** kind = step / done 时的轮次 */
  steps?: number
  /** kind = error 时的原始错误信息 */
  message?: string
}

const MAX_ENTRIES = 120
const MAX_KEYS = 200

const buffers = new Map<string, LiveLogEntry[]>()
const subscribers = new Map<string, Set<(entry: LiveLogEntry) => void>>()
let seq = 0

/** 追加一条日志并广播给当前订阅者 */
export function pushLiveLog(key: string, entry: Omit<LiveLogEntry, 'id' | 'at'>): LiveLogEntry {
  const full: LiveLogEntry = { ...entry, id: ++seq, at: Date.now() }

  // 重新插入以维持 LRU 顺序（Map 保持插入顺序）
  const existing = buffers.get(key)
  buffers.delete(key)
  const list = existing || []
  list.push(full)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  buffers.set(key, list)

  while (buffers.size > MAX_KEYS) {
    const oldest = buffers.keys().next().value
    if (oldest === undefined) break
    buffers.delete(oldest)
    subscribers.delete(oldest)
  }

  for (const cb of subscribers.get(key) || []) {
    try { cb(full) } catch { /* 单个订阅者异常不影响其他订阅者 */ }
  }
  return full
}

/** 读取缓冲（用于新订阅者连接时回放） */
export function readLiveLog(key: string): LiveLogEntry[] {
  return [...(buffers.get(key) || [])]
}

/** 订阅后续日志，返回退订函数 */
export function subscribeLiveLog(key: string, cb: (entry: LiveLogEntry) => void): () => void {
  let set = subscribers.get(key)
  if (!set) {
    set = new Set()
    subscribers.set(key, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
    if (set && set.size === 0) subscribers.delete(key)
  }
}

/** 清空某个任务键的日志（新一轮任务开始时调用，避免新旧日志混淆） */
export function clearLiveLog(key: string): void {
  buffers.delete(key)
}
