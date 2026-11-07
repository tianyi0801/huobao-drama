/**
 * 请求快照 — 把「真正发给模型的提示词与参数」落库，供界面核对
 *
 * 为什么需要：项目对提示词做了多段改写（风格句注入、六节结构归一、@素材编号、
 * 尺寸/档位推导、参考图排序），这些中间结果此前只存在于后端控制台日志里，
 * 用户无法确认最后到底发了什么。快照把最终结果固化到 sys_task，随任务可回溯。
 *
 * 存什么：
 *   - 提示词全文（唯一权威版本，超过上限才截断并标注）
 *   - 实际生效参数（尺寸、种子、步数、清晰度、时长…）
 *   - 素材提交顺序（图1/图2、@图片N 的编号来源）
 *   - 工作流绑定链路（项目字段 → 节点输入）
 *   - 请求元信息（地址、方法、体积）
 *
 * 不存什么：ComfyUI 的完整提交图（几十到上百 KB/任务，会把库撑大），
 * 只记节点数与序列化体积；云端请求体保留脱敏后的前段。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskWarn, redactUrl } from '../utils/task-logger.js'
import type { RequestDebug } from './adapters/types.js'

/** 提示词上限：正常分镜提示词 2~6KB，留足余量 */
const MAX_PROMPT_CHARS = 24_000
/** 云端请求体保留上限 */
const MAX_BODY_CHARS = 12_000

export interface RequestSnapshotInput {
  type: 'image' | 'video'
  provider: string
  url: string
  method: string
  body: unknown
  debug?: RequestDebug
  /** 兜底提示词（adapters 未提供 debug 时用记录里的 prompt） */
  prompt?: string | null
}

export interface RequestSnapshot {
  at: string
  type: 'image' | 'video'
  provider: string
  mode: string
  method: string
  url: string
  prompt: string
  promptTruncated?: boolean
  negativePrompt?: string
  parameters?: Record<string, unknown>
  template?: string
  media?: Array<{ index: number; kind: string; path: string }>
  /** 局部编辑选区（原图像素坐标，rect） */
  region?: {
    rect: Record<string, number>
  }
  bindings?: Array<{ source: string; target: string; value: string }>
  graph?: { nodes: number; bytes: number }
  notes?: string[]
  /** 云端厂商的脱敏请求体（本地 ComfyUI 只记体积，不存整张图） */
  body?: unknown
  bodyTruncated?: boolean
  bodyBytes: number
  multipartFields?: string[]
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）`, truncated: true }
}

/** 数据 URL 只保留头部，其余内容对排查无价值但会撑爆存储 */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const head = value.slice(0, value.indexOf(',') + 1)
      return `${head}<omitted ${value.length} chars>`
    }
    return value.length > 600 ? `${value.slice(0, 600)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 6) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 60).map(item => sanitizeValue(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (['authorization', 'api_key', 'apikey', 'token', 'access_token'].includes(lower)
        || lower.includes('authorization') || lower.includes('token') || lower.includes('apikey') || lower.includes('api_key')) {
        out[key] = '***'
        continue
      }
      if (typeof raw === 'string' && (lower === 'url' || lower.endsWith('url'))) {
        out[key] = redactUrl(raw)
        continue
      }
      out[key] = sanitizeValue(raw, depth + 1)
    }
    return out
  }
  return String(value)
}

function sanitizeBody(body: unknown): { body?: unknown; bodyBytes: number; truncated?: boolean; multipartFields?: string[] } {
  if (body === undefined || body === null) return { bodyBytes: 0 }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return { bodyBytes: 0, multipartFields: [...body.keys()] }
  }
  let serialized = ''
  try {
    serialized = JSON.stringify(body)
  } catch {
    return { body: String(body), bodyBytes: String(body).length }
  }
  const bytes = serialized.length
  // 本地 ComfyUI 的 body.prompt 是整张执行图，体积大且与绑定链路重复，只记体积
  const record = body as Record<string, unknown>
  if (record && typeof record === 'object' && record.prompt && typeof record.prompt === 'object' && !Array.isArray(record.prompt)) {
    const { prompt: _graph, ...rest } = record
    return { body: sanitizeValue(rest), bodyBytes: bytes }
  }
  const { text, truncated } = truncateText(serialized, MAX_BODY_CHARS)
  let parsed: unknown = text
  if (!truncated) {
    try { parsed = sanitizeValue(JSON.parse(text)) } catch { parsed = text }
  }
  return { body: parsed, bodyBytes: bytes, truncated }
}

/** 组装快照对象（纯函数，便于测试与复用） */
export function buildRequestSnapshot(input: RequestSnapshotInput): RequestSnapshot {
  const debug = input.debug
  const rawPrompt = String(debug?.prompt ?? input.prompt ?? '')
  const { text: prompt, truncated } = truncateText(rawPrompt, MAX_PROMPT_CHARS)
  const bodyInfo = sanitizeBody(input.body)

  return {
    at: now(),
    type: input.type,
    provider: input.provider,
    mode: debug?.mode || (input.type === 'image' ? 'image' : 'video'),
    method: input.method,
    url: redactUrl(input.url),
    prompt,
    ...(truncated ? { promptTruncated: true } : {}),
    ...(debug?.negativePrompt ? { negativePrompt: debug.negativePrompt } : {}),
    ...(debug?.parameters ? { parameters: sanitizeValue(debug.parameters) as Record<string, unknown> } : {}),
    ...(debug?.template ? { template: debug.template } : {}),
    ...(debug?.region ? { region: debug.region } : {}),    ...(debug?.media?.length ? { media: debug.media } : {}),
    ...(debug?.bindings?.length ? { bindings: debug.bindings } : {}),
    ...(debug?.graph ? { graph: debug.graph } : {}),
    ...(debug?.notes?.length ? { notes: debug.notes } : {}),
    ...(bodyInfo.body !== undefined ? { body: bodyInfo.body } : {}),
    ...(bodyInfo.truncated ? { bodyTruncated: true } : {}),
    bodyBytes: bodyInfo.bodyBytes,
    ...(bodyInfo.multipartFields ? { multipartFields: bodyInfo.multipartFields } : {}),
  }
}

/** 落库：写失败不影响生成主流程，只记一条 warn */
export async function saveRequestSnapshot(taskId: number, input: RequestSnapshotInput): Promise<void> {
  try {
    const snapshot = buildRequestSnapshot(input)
    await db.update(schema.sysTask)
      .set({ requestSnapshot: JSON.stringify(snapshot), updatedAt: now() })
      .where(eq(schema.sysTask.id, taskId))
  } catch (error) {
    logTaskWarn('RequestSnapshot', 'save-failed', { taskId, error: (error as Error).message })
  }
}
