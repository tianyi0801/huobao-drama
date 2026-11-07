/**
 * 本地 ComfyUI 运行中预览。
 *
 * H3 工作流会先跑一采、再跑二采（分块高清化）。一采完成时节点 12
 * （MiniMaxH3ConditionalFirstPassSaveVideo）就会把一采视频落盘，
 * 但整个 prompt 要等二采结束才进 history。
 *
 * 这里用 ComfyUI 的 /ws 事件流，在 executed(node=12) 到达时立刻记下文件名，
 * 前端就能在二采还在跑的时候先看到一采效果，不满意可以马上取消。
 */
import { logTaskProgress } from '../../utils/task-logger.js'

/** 一采保存节点：与 presets.json 中 minimax-h3-ref2va 的节点编号一致 */
export const FIRST_PASS_NODE = '12'

export interface ComfyPreviewState {
  /** 一采视频文件名（ComfyUI output 目录） */
  filename?: string
  subfolder?: string
  type?: string
  /** 二采进度 0-100，未知时为 null */
  progress: number | null
}

const previews = new Map<number, ComfyPreviewState>()

export function getPreview(taskId: number): ComfyPreviewState | undefined {
  return previews.get(taskId)
}

export function resetPreview(taskId: number): void {
  previews.delete(taskId)
}

/** 记录/更新预览状态；订阅回调与测试都走这里 */
export function setPreview(taskId: number, patch: Partial<ComfyPreviewState>): void {
  const current = previews.get(taskId) || { progress: null }
  previews.set(taskId, { ...current, ...patch })
}

export function clearPreview(taskId: number): void {
  previews.delete(taskId)
}

/** 把预览状态合并进任务响应，前端据此显示一采画面 */
export function decorateTaskWithPreview<T extends Record<string, any>>(task: T): T & {
  firstPassReady: boolean
  firstPassUrl: string | null
  previewProgress: number | null
} {
  const id = Number(task?.id)
  const state = Number.isFinite(id) ? previews.get(id) : undefined
  const ready = !!state?.filename
  return {
    ...task,
    firstPassReady: ready,
    // 必须带 /api/v1 前缀：路由挂在 /api/v1 下，静态资源才是根路径 /static
    firstPassUrl: ready ? `/api/v1/tasks/${id}/first-pass` : null,
    previewProgress: state?.progress ?? null,
  }
}

/**
 * 解析 ComfyUI ws 文本消息。
 * 抽成纯函数便于测试：只关心进度与一采落盘两类事件。
 */
export function parseComfyEvent(raw: string): {
  kind: 'progress' | 'first-pass' | 'other'
  progress?: number
  file?: { filename: string; subfolder: string; type: string }
} {
  let message: any
  try { message = JSON.parse(raw) } catch { return { kind: 'other' } }

  if (message?.type === 'progress') {
    const value = Number(message?.data?.value)
    const max = Number(message?.data?.max)
    if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
      return { kind: 'progress', progress: Math.max(0, Math.min(100, Math.round((value / max) * 100))) }
    }
    return { kind: 'other' }
  }

  if (message?.type === 'executed' && String(message?.data?.node) === FIRST_PASS_NODE) {
    const output = message?.data?.output || {}
    const groups = [output.videos, output.gifs, output.images]
    for (const group of groups) {
      if (!Array.isArray(group)) continue
      const hit = group.find((item: any) => item && typeof item.filename === 'string' && item.filename)
      if (hit) {
        return {
          kind: 'first-pass',
          file: {
            filename: String(hit.filename),
            subfolder: String(hit.subfolder || ''),
            type: String(hit.type || 'output'),
          },
        }
      }
    }
  }

  return { kind: 'other' }
}

export interface WatchOptions {
  comfyUrl: string
  clientId: string
  promptId: string
  taskId: number
}

/**
 * 订阅 ComfyUI 事件，直到任务结束或调用返回的 stop()。
 * 连接失败/断开都静默处理：预览只是锦上添花，不能影响任务本身。
 */
export function watchComfyRun(options: WatchOptions): () => void {
  const { comfyUrl, clientId, taskId } = options
  if (typeof WebSocket === 'undefined') return () => {}

  let socket: WebSocket | null = null
  let closed = false
  const state: ComfyPreviewState = { progress: null }
  previews.set(taskId, state)

  const close = () => {
    if (closed) return
    closed = true
    try { socket?.close() } catch { /* 已断开 */ }
    socket = null
  }

  try {
    const wsUrl = `${comfyUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws?clientId=${encodeURIComponent(clientId)}`
    socket = new WebSocket(wsUrl)
    socket.onopen = () => logTaskProgress('VideoTask', 'preview-ws-open', { id: taskId })
    socket.onmessage = (event: MessageEvent) => {
      if (closed || typeof event.data !== 'string') return
      const parsed = parseComfyEvent(event.data)
      // 诊断用：一采节点执行过但拿不到文件名时，把字段名打出来（不含内容）
      if (parsed.kind === 'other' && event.data.includes('"executed"') && event.data.includes(`"node":"${FIRST_PASS_NODE}"`)) {
        try {
          const raw = JSON.parse(event.data)
          logTaskProgress('VideoTask', 'first-pass-no-file', {
            id: taskId,
            keys: Object.keys(raw?.data?.output || {}),
          })
        } catch { /* 忽略解析失败 */ }
      }
      if (parsed.kind === 'progress' && parsed.progress != null) {
        state.progress = parsed.progress
        return
      }
      if (parsed.kind === 'first-pass' && parsed.file) {
        state.filename = parsed.file.filename
        state.subfolder = parsed.file.subfolder
        state.type = parsed.file.type
        logTaskProgress('VideoTask', 'first-pass-ready', { id: taskId, file: parsed.file.filename })
      }
    }
    socket.onerror = () => close()
    socket.onclose = () => close()
  } catch {
    return () => {}
  }

  return close
}

/**
 * 解析 Range 请求头，返回分段执行计划。
 * <video> 播放/拖动都会带 Range，直接忽略会让浏览器等整段下载甚至黑屏。
 */
export function resolveByteRange(total: number, header?: string | null): { status: 200 | 206 | 416; start: number; end: number } {
  const full = { status: 200 as const, start: 0, end: Math.max(0, total - 1) }
  if (!header || !total) return full
  const match = /bytes=(\d*)-(\d*)/.exec(header)
  if (!match) return full
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return full
  let start: number
  let end: number
  if (!rawStart) {
    // bytes=-N：最后 N 字节
    const count = Number(rawEnd)
    if (!Number.isFinite(count) || count <= 0) return full
    start = Math.max(0, total - count)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Math.min(Number(rawEnd), total - 1) : total - 1
  }
  if (!Number.isFinite(start) || start >= total || end < start) return { status: 416, start: 0, end: -1 }
  return { status: 206, start, end }
}
