import { toast } from 'vue-sonner'
import { api } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

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
    text: '',
    reasoningChars: 0,
    startedAt: 0,
    elapsedMs: 0,
    error: null,
  }
}

/** 从 fetch 响应体里逐块解析 SSE，回调每个事件的 data 对象 */
async function consumeSSE(resp: Response, onEvent: (event: string, data: any) => void) {
  const reader = resp.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  const flush = (block: string) => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!dataLines.length) return
    const raw = dataLines.join('\n')
    let data: any = raw
    try { data = JSON.parse(raw) } catch { /* 非 JSON 时原样给出 */ }
    onEvent(event, data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf('\n\n')
    while (idx >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      if (block.trim()) flush(block)
      idx = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) flush(buffer)
}

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const activity = reactive<AgentActivity>(createActivity())

  let timer: ReturnType<typeof setInterval> | null = null

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

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
      case 'tool-call':
        activity.tools.push({
          id: String(data?.id ?? data?.name ?? `tool-${activity.tools.length}`),
          name: String(data?.name ?? 'tool'),
          args: data?.args ? String(data.args) : undefined,
          status: 'running',
        })
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
  async function tryStream(type: string, payload: any): Promise<boolean> {
    const resp = await fetch(`${SSE_PREFIX}/agent/${type}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
    await consumeSSE(resp, applyEvent)
    return true
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void, model?: string, configId?: number) {
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

    try {
      const streamed = await tryStream(type, payload)
      if (!streamed) {
        // 旧版后端：退化为一次性请求，面板只显示「思考中」
        activity.phase = 'thinking'
        await api.post<any>(`/agent/${type}/chat`, payload)
      }
      activity.phase = 'done'
      toast.success(i18n.global.t('composables.agent.done'))
      onDone?.()
    } catch (err: any) {
      activity.phase = 'error'
      activity.error = err?.message || String(err)
      toastError(err)
    } finally {
      activity.active = false
      activity.elapsedMs = Date.now() - activity.startedAt
      stopTimer()
      running.value = false
      runningType.value = null
    }
  }

  return { running, runningType, activity, run }
}
