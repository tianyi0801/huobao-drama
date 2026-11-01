/**
 * 本地 ComfyUI 配置 — 存于 app_settings（key: comfyui_config）
 *
 * 改造后图片/视频生成的目标从云端厂商换成本机 ComfyUI 工作流；
 * 文本模型仍走 ai_service_configs，本模块不碰文本配置。
 *
 * 配置只保存「服务地址 + 工作流模板（API 格式图 + 字段绑定）」，
 * 不保存模型文件、LoRA、素材与密钥。
 *
 * 刻意做成同步 API（better-sqlite3 同步驱动），与 app-settings.ts 一致，
 * 供 services/ai.ts 的 getActiveConfig 直接调用。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'

const CONFIG_KEY = 'comfyui_config'

/** API 格式执行图里的单个节点（ComfyUI「Export (API)」原样结构） */
export interface ComfyApiNode {
  class_type: string
  inputs: Record<string, any>
  _meta?: Record<string, any>
}

/** 绑定目标：某节点某输入字段（可用 path 指向字典/数组内部） */
export interface ComfyBindingTarget {
  node: string
  input: string
  path?: (string | number)[]
}

/** 运行时数据源 —— 每次生成时按实际业务参数取值 */
export type ComfyBindingSource =
  | 'prompt'
  | 'negative_prompt'
  | 'width'
  | 'height'
  | 'seed'
  | 'duration_seconds'
  | 'frames'
  | 'fps'
  /** 厂商档位字符串，如 720P —— 由集设置的分辨率映射而来 */
  | 'resolution'
  /** 画面比例字符串，如 9:16 */
  | 'aspect_ratio'
  | 'filename_prefix'
  /** 参考图相对 ComfyUI input 的路径列表 */
  | 'images'
  /** 参考视频相对路径列表 */
  | 'videos'
  /** 参考音频相对路径列表 */
  | 'audios'
  /** 素材清单对象列表（含 media_type/filename/subfolder/type） */
  | 'media'
  /** 首帧图相对路径 */
  | 'first_frame'
  /** 尾帧图相对路径 */
  | 'last_frame'

export const BINDING_SOURCES: readonly ComfyBindingSource[] = [
  'prompt', 'negative_prompt', 'width', 'height', 'seed',
  'duration_seconds', 'frames', 'fps', 'resolution', 'aspect_ratio', 'filename_prefix',
  'images', 'videos', 'audios', 'media', 'first_frame', 'last_frame',
]

export interface ComfyBinding {
  source: ComfyBindingSource
  targets: ComfyBindingTarget[]
  /** value=直接写值；json=序列化成 JSON 字符串（素材清单类节点常见） */
  encoding?: 'value' | 'json'
  /** 数据源是数组时取第 N 项（0 基） */
  index?: number
  /**
   * 条件绑定：仅当面板可调项取值匹配时应用。
   * 典型用途：Prompt Enhancer 开关决定 prompt 写进「直通分支」还是「增强节点」。
   * 未声明时始终应用。
   */
  when?: Record<string, any>
  /**
   * 可选槽位：数据源数量不足（如只有 1 张参考图而模板有 2 个图槽）时，
   * 删除目标字段而不是写入空值，让工作流少一路输入。
   */
  optional?: boolean
}

/**
 * 模板可调项 —— 面板渲染成控件，提交前按用户当前取值写入 targets。
 * 典型用途：Prompt Enhancer 开关、一采/二采步数。
 */
export interface ComfyParamOption {
  id: string
  label: string
  type: 'boolean' | 'number' | 'text' | 'select'
  default: any
  targets: ComfyBindingTarget[]
  choices?: string[]
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface ComfyWorkflowTemplate {
  /** 面板展示名 */
  name: string
  /** API 格式执行图；键为节点 id 字符串 */
  api: Record<string, ComfyApiNode>
  /** 业务参数 → 工作流字段的绑定表 */
  bindings: ComfyBinding[]
  /** 产物读取节点 id（可多个，按 videoOutputIndex 选择） */
  outputNodes: string[]
  /** 多个视频产物时的选择下标；null/缺省表示必须唯一 */
  videoOutputIndex?: number | null
  /** 模板声明的可调项 */
  options?: ComfyParamOption[]
  /** 保存时间，仅用于展示 */
  savedAt?: string
}

export interface ComfyUiConfig {
  /** 关掉后图片/视频生成回退到「未配置」状态并提示 */
  enabled: boolean
  /** ComfyUI 服务地址，如 http://127.0.0.1:8188 */
  url: string
  /** 无参考图时的图片模板（纯文生图） */
  image: ComfyWorkflowTemplate | null
  /** 有参考图时的图片模板（图生图 / 图片编辑）；为空则回退到 image */
  imageEdit: ComfyWorkflowTemplate | null
  video: ComfyWorkflowTemplate | null
  /** 面板可调项的当前取值（按 option.id 存） */
  optionValues: Record<string, any>
  /**
   * 图片像素上限（安全阀，默认 4MP）。
   * 实际尺寸由「项目画面比例 + 集清晰度档（480p/720p/1080p）」决定，
   * 本字段只在传入尺寸异常巨大时兜底收敛，正常不参与计算。
   */
  imagePixelBudget: number
  /**
   * 镜头衔接：同一场景的相邻分镜生成时，把上一段的尾帧作为额外参考，
   * 避免机位朝向与空间关系跳变。默认开启。
   */
  continuityReference: boolean
  poll: {
    intervalMs: number
    /** 图片单任务最长等待 */
    imageTimeoutMs: number
    /** 视频单任务最长等待（本地算力慢，默认 1 小时） */
    videoTimeoutMs: number
  }
  /** 素材上传到 ComfyUI input 下的子目录前缀 */
  uploadSubfolder: string
}

export const DEFAULT_COMFY_CONFIG: ComfyUiConfig = {
  enabled: false,
  url: 'http://127.0.0.1:8188',
  image: null,
  imageEdit: null,
  video: null,
  optionValues: {},
  imagePixelBudget: 4 * 1024 * 1024,
  continuityReference: true,
  poll: { intervalMs: 3000, imageTimeoutMs: 600_000, videoTimeoutMs: 3_600_000 },
  uploadSubfolder: 'huobao',
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 规范化服务地址：去掉尾部斜杠，只允许 http/https */
export function normalizeComfyUrl(raw: unknown): string {
  const text = asString(raw, DEFAULT_COMFY_CONFIG.url).trim()
  if (!text) return DEFAULT_COMFY_CONFIG.url
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_COMFY_CONFIG.url
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host}${pathname}`
  } catch {
    return DEFAULT_COMFY_CONFIG.url
  }
}

/** 规范化单个绑定目标；非法返回 null（丢弃而不是让整份配置失效） */
function normalizeTarget(raw: unknown): ComfyBindingTarget | null {
  if (!isPlainObject(raw)) return null
  const node = asString(raw.node).trim()
  const input = asString(raw.input).trim()
  if (!node || !input) return null
  const path = Array.isArray(raw.path)
    ? raw.path.filter((v: unknown) => typeof v === 'string' || typeof v === 'number')
    : undefined
  return path && path.length ? { node, input, path: path as (string | number)[] } : { node, input }
}

function normalizeTargets(raw: unknown): ComfyBindingTarget[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeTarget).filter((t): t is ComfyBindingTarget => !!t)
}

function normalizeBindings(raw: unknown): ComfyBinding[] {
  if (!Array.isArray(raw)) return []
  const result: ComfyBinding[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const source = asString(item.source).trim() as ComfyBindingSource
    if (!BINDING_SOURCES.includes(source)) continue
    const targets = normalizeTargets(item.targets)
    if (!targets.length) continue
    const binding: ComfyBinding = { source, targets }
    if (item.encoding === 'json') binding.encoding = 'json'
    if (typeof item.index === 'number' && Number.isInteger(item.index) && item.index >= 0) binding.index = item.index
    if (item.optional === true) binding.optional = true
    if (isPlainObject(item.when) && Object.keys(item.when).length) binding.when = item.when
    result.push(binding)
  }
  return result
}

function normalizeOptions(raw: unknown): ComfyParamOption[] {
  if (!Array.isArray(raw)) return []
  const result: ComfyParamOption[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = asString(item.id).trim()
    const label = asString(item.label).trim() || id
    const type = asString(item.type, 'boolean')
    if (!id || !['boolean', 'number', 'text', 'select'].includes(type)) continue
    const targets = normalizeTargets(item.targets)
    if (!targets.length) continue
    const option: ComfyParamOption = { id, label, type: type as ComfyParamOption['type'], default: item.default, targets }
    if (Array.isArray(item.choices)) option.choices = item.choices.filter((c: unknown) => typeof c === 'string')
    if (typeof item.min === 'number') option.min = item.min
    if (typeof item.max === 'number') option.max = item.max
    if (typeof item.step === 'number') option.step = item.step
    if (typeof item.hint === 'string') option.hint = item.hint
    result.push(option)
  }
  return result
}

/** 规范化 API 图：只保留 { class_type, inputs, _meta }，丢弃 UI 字段与非法节点 */
function normalizeApiGraph(raw: unknown): Record<string, ComfyApiNode> {
  if (!isPlainObject(raw)) return {}
  const graph: Record<string, ComfyApiNode> = {}
  for (const [id, node] of Object.entries(raw)) {
    if (!isPlainObject(node)) continue
    const classType = asString(node.class_type).trim()
    if (!classType || !isPlainObject(node.inputs)) continue
    graph[String(id)] = {
      class_type: classType,
      inputs: node.inputs,
      ...(isPlainObject(node._meta) ? { _meta: node._meta } : {}),
    }
  }
  return graph
}

export function normalizeTemplate(raw: unknown): ComfyWorkflowTemplate | null {
  if (!isPlainObject(raw)) return null
  // 兼容直接粘贴 ComfyUI 导出的 { "prompt": {...} } 包装
  const graphSource = isPlainObject(raw.api)
    ? raw.api
    : (isPlainObject(raw.prompt) ? raw.prompt : raw)
  const api = normalizeApiGraph(graphSource)
  if (!Object.keys(api).length) return null
  const outputNodes = Array.isArray(raw.outputNodes)
    ? raw.outputNodes.map((v: unknown) => String(v)).filter((v: string) => v in api)
    : []
  const videoOutputIndex = typeof raw.videoOutputIndex === 'number' && raw.videoOutputIndex >= 0
    ? raw.videoOutputIndex
    : null
  return {
    name: asString(raw.name).trim() || '未命名工作流',
    api,
    bindings: normalizeBindings(raw.bindings),
    outputNodes,
    videoOutputIndex,
    options: normalizeOptions(raw.options),
    ...(typeof raw.savedAt === 'string' ? { savedAt: raw.savedAt } : {}),
  }
}

/** 从数据库读取配置；无记录或数据损坏时返回默认值（不抛错，避免拖垮启动） */
export function getComfyConfig(): ComfyUiConfig {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONFIG_KEY))
    .get()
  if (!row?.value) return { ...DEFAULT_COMFY_CONFIG, poll: { ...DEFAULT_COMFY_CONFIG.poll } }
  let parsed: any
  try { parsed = JSON.parse(row.value) } catch { parsed = null }
  if (!isPlainObject(parsed)) return { ...DEFAULT_COMFY_CONFIG, poll: { ...DEFAULT_COMFY_CONFIG.poll } }

  const poll = isPlainObject(parsed.poll) ? parsed.poll : {}
  return {
    enabled: parsed.enabled === true,
    url: normalizeComfyUrl(parsed.url),
    image: normalizeTemplate(parsed.image),
    imageEdit: normalizeTemplate(parsed.imageEdit),
    video: normalizeTemplate(parsed.video),
    optionValues: isPlainObject(parsed.optionValues) ? parsed.optionValues : {},
    imagePixelBudget: asNumber(parsed.imagePixelBudget, DEFAULT_COMFY_CONFIG.imagePixelBudget, 262_144, 4_194_304),
    continuityReference: parsed.continuityReference !== false,
    poll: {
      intervalMs: asNumber(poll.intervalMs, DEFAULT_COMFY_CONFIG.poll.intervalMs, 500, 30_000),
      imageTimeoutMs: asNumber(poll.imageTimeoutMs, DEFAULT_COMFY_CONFIG.poll.imageTimeoutMs, 30_000, 7_200_000),
      videoTimeoutMs: asNumber(poll.videoTimeoutMs, DEFAULT_COMFY_CONFIG.poll.videoTimeoutMs, 60_000, 21_600_000),
    },
    uploadSubfolder: (asString(parsed.uploadSubfolder, DEFAULT_COMFY_CONFIG.uploadSubfolder)
      .replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_COMFY_CONFIG.uploadSubfolder),
  }
}

/** 合并写入（局部更新语义）；返回落库后的完整配置 */
export function saveComfyConfig(patch: unknown): ComfyUiConfig {
  const current = getComfyConfig()
  const input = isPlainObject(patch) ? patch : {}
  const merged: any = { ...current }
  if ('enabled' in input) merged.enabled = input.enabled === true
  if ('url' in input) merged.url = normalizeComfyUrl(input.url)
  if ('image' in input) merged.image = input.image
  if ('imageEdit' in input) merged.imageEdit = input.imageEdit
  if ('video' in input) merged.video = input.video
  if ('optionValues' in input) merged.optionValues = isPlainObject(input.optionValues) ? input.optionValues : {}
  if ('imagePixelBudget' in input) merged.imagePixelBudget = input.imagePixelBudget
  if ('continuityReference' in input) merged.continuityReference = input.continuityReference
  if ('poll' in input && isPlainObject(input.poll)) merged.poll = { ...current.poll, ...input.poll }
  if ('uploadSubfolder' in input) merged.uploadSubfolder = input.uploadSubfolder

  const normalized = normalizeComfyConfig(merged)
  db.insert(schema.appSettings)
    .values({ key: CONFIG_KEY, value: JSON.stringify(normalized), updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(normalized), updatedAt: now() },
    })
    .run()
  return normalized
}

/** 规范化整份配置（save 与读取共用同一套规则） */
export function normalizeComfyConfig(raw: unknown): ComfyUiConfig {
  const input = isPlainObject(raw) ? raw : {}
  const poll = isPlainObject(input.poll) ? input.poll : {}
  return {
    enabled: input.enabled === true,
    url: normalizeComfyUrl(input.url),
    image: normalizeTemplate(input.image),
    imageEdit: normalizeTemplate(input.imageEdit),
    video: normalizeTemplate(input.video),
    optionValues: isPlainObject(input.optionValues) ? input.optionValues : {},
    imagePixelBudget: asNumber(input.imagePixelBudget, DEFAULT_COMFY_CONFIG.imagePixelBudget, 262_144, 4_194_304),
    continuityReference: input.continuityReference !== false,
    poll: {
      intervalMs: asNumber(poll.intervalMs, DEFAULT_COMFY_CONFIG.poll.intervalMs, 500, 30_000),
      imageTimeoutMs: asNumber(poll.imageTimeoutMs, DEFAULT_COMFY_CONFIG.poll.imageTimeoutMs, 30_000, 7_200_000),
      videoTimeoutMs: asNumber(poll.videoTimeoutMs, DEFAULT_COMFY_CONFIG.poll.videoTimeoutMs, 60_000, 21_600_000),
    },
    uploadSubfolder: (asString(input.uploadSubfolder, DEFAULT_COMFY_CONFIG.uploadSubfolder)
      .replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_COMFY_CONFIG.uploadSubfolder),
  }
}

/** 图片/视频是否已具备本地生成条件（图生图模板可独立作为图片能力） */
export function isComfyReadyFor(kind: 'image' | 'video'): boolean {
  const config = getComfyConfig()
  if (!config.enabled) return false
  if (kind === 'image') {
    return [config.image, config.imageEdit]
      .some(t => !!t && t.outputNodes.length > 0)
  }
  const template = config.video
  return !!template && template.outputNodes.length > 0
}

/** 按是否有参考图选择图片模板：有图优先图生图，缺失则回退文生图 */
export function pickImageTemplate(hasReferenceImages: boolean): ComfyWorkflowTemplate | null {
  const config = getComfyConfig()
  if (!config.enabled) return null
  if (hasReferenceImages && config.imageEdit) return config.imageEdit
  return config.image
}
