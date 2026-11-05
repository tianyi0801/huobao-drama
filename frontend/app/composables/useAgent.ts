import { toast } from 'vue-sonner'
import { onScopeDispose } from 'vue'
import { toastError } from './useToast'
import { i18n } from './i18n'
import { consumeAgentSSE } from '../utils/agent-sse'

/** 单次工具调用（展示用：AI 正在调哪个工具、耗时多久） */
export interface AgentToolEvent {
  id: string
  name: string
  args?: string
  status: 'running' | 'ok' | 'error'
  ms?: number
  preview?: string
}

export type AgentPhase = 'idle' | 'connecting' | 'thinking' | 'tool' | 'done' | 'error'

/** AI 实时活动状态：供工作台「AI 正在做什么」面板渲染 */
export interface AgentActivity {
  active: boolean
  type: string | null
  phase: AgentPhase
  /** 已调用/正在调用的工具，按时间顺序 */
  tools: AgentToolEvent[]
  toolCount: number
  savedCount: number
  savedBatches: number
  /** 已生成的正文（面板只展示尾部） */
  text: string
  /** 思考内容字符数（部分模型会产出 reasoning） */
  reasoningChars: number
  startedAt: number
  elapsedMs: number
  error: string | null
}

const TEXT_LIMIT = 50_000
const SSE_PREFIX = '/api/v1'

function createActivity(): AgentActivity {
  return {
    active: false,
    type: null,
    phase: 'idle',
    tools: [],
    toolCount: 0,
    savedCount: 0,
    savedBatches: 0,
    text: '',
    reasoningChars: 0,
    startedAt: 0,
    elapsedMs: 0,
    error: null,
  }
}

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const activity = reactive<AgentActivity>(createActivity())

  let timer: ReturnType<typeof setInterval> | null = null
  let controller: AbortController | null = null
  let disposed = false

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

  onScopeDispose(() => {
    disposed = true
    controller?.abort()
    stopTimer()
  })

  function reset(type: string) {
    Object.assign(activity, createActivity(), { active: true, type, phase: 'connecting', startedAt: Date.now() })
    stopTimer()
    timer = setInterval(() => {
      if (activity.active) activity.elapsedMs = Date.now() - activity.startedAt
    }, 200)
  }

  function applyEvent(event: string, data: any) {
    switch (event) {
      case 'start':
        activity.phase = 'thinking'
        break
      case 'text': {
        const delta = String(data?.text ?? '')
        if (!delta) break
        activity.text = (activity.text + delta).slice(-TEXT_LIMIT)
        activity.phase = 'thinking'
        break
      }
      case 'reasoning':
        activity.reasoningChars += String(data?.text ?? '').length
        break
      case 'saved':
        activity.savedBatches++
        if (data?.tool === 'save_storyboards' && Number.isFinite(data?.count)) activity.savedCount += data.count
        break
      case 'tool-call':
        activity.toolCount++
        activity.tools.push({
          id: String(data?.id ?? data?.name ?? `tool-${activity.tools.length}`),
          name: String(data?.name ?? 'tool'),
          args: data?.args ? String(data.args) : undefined,
          status: 'running',
        })
        if (activity.tools.length > 120) activity.tools.splice(0, activity.tools.length - 120)
        activity.phase = 'tool'
        break
      case 'tool-result': {
        const id = String(data?.id ?? '')
        const tool = activity.tools.find(t => t.id === id) || activity.tools[activity.tools.length - 1]
        if (tool) {
          tool.status = data?.ok === false ? 'error' : 'ok'
          tool.ms = typeof data?.ms === 'number' ? data.ms : undefined
          tool.preview = data?.preview ? String(data.preview) : undefined
        }
        activity.phase = 'thinking'
        break
      }
      case 'done':
        activity.phase = 'done'
        break
      case 'error':
        throw new Error(String(data?.message || i18n.global.t('composables.agent.failed')))
      default:
        break
    }
  }

  /** 走流式端点；后端不支持（404/405）时返回 false，由调用方回退到非流式 */
  async function tryStream(type: string, payload: any, signal: AbortSignal, onSaved?: () => void | Promise<void>): Promise<boolean> {
    const resp = await fetch(`${SSE_PREFIX}/agent/${type}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    if (resp.status === 404 || resp.status === 405) return false
    if (!resp.ok || !resp.body) {
      let message = `${resp.status}`
      try {
        const json = await resp.json()
        message = json?.message || message
      } catch { /* 响应非 JSON 时保留状态码 */ }
      throw new Error(message)
    }
    activity.phase = 'thinking'
    await consumeAgentSSE(resp, (event, data) => {
      applyEvent(event, data)
      if (event === 'saved' && !disposed && onSaved) {
        void Promise.resolve().then(onSaved).catch(toastError)
      }
    })
    return true
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>, model?: string, configId?: number, onSaved?: () => void | Promise<void>) {
    if (running.value) { toast.warning(i18n.global.t('composables.agent.busy')); return }
    running.value = true
    runningType.value = type
    reset(type)

    const payload = {
      message: msg,
      drama_id: dramaId,
      episode_id: episodeId,
      model: model || undefined,
      config_id: configId || undefined,
    }

    controller = new AbortController()
    try {
      const streamed = await tryStream(type, payload, controller.signal, onSaved)
      if (!streamed) {
        activity.phase = 'thinking'
        const resp = await fetch(`${SSE_PREFIX}/agent/${type}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        const json = await resp.json()
        if (!resp.ok || json.code >= 400) throw new Error(json.message || `${resp.status}`)
      }
      if (disposed || controller.signal.aborted) return
      await onDone?.()
      if (disposed || controller.signal.aborted) return
      activity.phase = 'done'
      toast.success(i18n.global.t('composables.agent.done'))
    } catch (err: any) {
      if (disposed || controller.signal.aborted) return
      activity.phase = 'error'
      activity.error = err?.message || String(err)
      toastError(err)
    } finally {
      activity.active = false
      activity.elapsedMs = Date.now() - activity.startedAt
      stopTimer()
      controller = null
      running.value = false
      runningType.value = null
    }
  }

  /** 手动停止：断开 SSE 后后端会 abort Agent，已保存的批次保留 */
  function cancel() {
    if (!controller) return
    controller.abort()
    controller = null
    activity.active = false
    activity.phase = 'error'
    activity.error = i18n.global.t('composables.agent.cancelled')
    activity.elapsedMs = Date.now() - activity.startedAt
    stopTimer()
    running.value = false
    runningType.value = null
  }

  return { running, runningType, activity, run, cancel }
}
