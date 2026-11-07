/**
 * 工作流模板引擎 — 把「业务参数」翻译成「ComfyUI API 执行图」
 *
 * 四步：
 *   1. 深拷贝模板图
 *   2. 应用面板可调项（Prompt Enhancer 开关 / 步数 / 分辨率档位…）
 *   3. 按绑定表写入本次业务数据（prompt / 尺寸 / 种子 / 素材路径…）
 *   4. 剪枝：只保留「输出节点可达」的子图
 *
 * 第 4 步是本地算力的关键优化：关闭 Prompt Enhancer 时把 prompt 直接写进
 * TextEncode 节点，文本增强节点（含 9B 模型加载）因不可达而被剪掉，不再白跑。
 */
import type {
  ComfyApiNode,
  ComfyBinding,
  ComfyBindingSource,
  ComfyBindingTarget,
  ComfyWorkflowTemplate,
} from './config.js'
import type { ComfyObjectInfo } from './client.js'

/** 单次生成可用的业务上下文（都由 fire宝 的生成参数映射而来） */
export interface ComfyJobContext {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  seed?: number
  durationSeconds?: number
  frames?: number
  fps?: number
  /** 分辨率档位字符串，如 720P */
  resolution?: string
  /** 画面比例字符串，如 9:16 */
  aspectRatio?: string
  filenamePrefix?: string
  /** 已上传到 ComfyUI input 的相对路径 */
  images?: string[]
  videos?: string[]
  audios?: string[]
  /** 素材清单对象（H3 的 media_manifest 结构） */
  media?: Record<string, any>[]
  firstFrame?: string
  lastFrame?: string
}

export interface TemplateValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** 工作流用到、但本机 ComfyUI 未安装的节点类型 */
  missingNodes: string[]
}

const isLink = (value: unknown): value is [string, number] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'

/** 深拷贝，避免复用到同一份模板图导致参数串味 */
export function cloneGraph(template: ComfyWorkflowTemplate): Record<string, ComfyApiNode> {
  return JSON.parse(JSON.stringify(template.api)) as Record<string, ComfyApiNode>
}

function getContainer(graph: Record<string, ComfyApiNode>, target: ComfyBindingTarget) {
  const node = graph[target.node]
  if (!node) throw new Error(`工作流缺少节点 ${target.node}（绑定目标不存在）`)
  if (!(target.input in node.inputs)) {
    throw new Error(`节点 ${target.node} 没有输入字段 ${target.input}（请核对模板绑定）`)
  }
  return node
}

/** 写入绑定点；path 用于钻取字典/数组内部（如 format.bit_depth） */
export function setTarget(graph: Record<string, ComfyApiNode>, target: ComfyBindingTarget, value: unknown) {
  const node = getContainer(graph, target)
  if (!target.path || !target.path.length) {
    node.inputs[target.input] = JSON.parse(JSON.stringify(value ?? null))
    return
  }
  let cursor: any = node.inputs[target.input]
  for (const key of target.path.slice(0, -1)) {
    if (cursor == null || typeof cursor !== 'object' || !(key in cursor)) {
      throw new Error(`节点 ${target.node}.${target.input} 的路径 ${target.path.join('.')} 不存在`)
    }
    cursor = cursor[key]
  }
  const last = target.path[target.path.length - 1]
  if (cursor == null || typeof cursor !== 'object') {
    throw new Error(`节点 ${target.node}.${target.input} 的路径 ${target.path.join('.')} 无法写入`)
  }
  cursor[last] = value
}

/** 可选槽位缺数据时整段删除字段（让工作流少一路输入） */
export function removeTarget(graph: Record<string, ComfyApiNode>, target: ComfyBindingTarget) {
  const node = graph[target.node]
  if (!node) return
  if (!target.path || !target.path.length) {
    delete node.inputs[target.input]
    return
  }
  let cursor: any = node.inputs[target.input]
  for (const key of target.path.slice(0, -1)) {
    if (cursor == null || typeof cursor !== 'object') return
    cursor = cursor[key]
  }
  if (cursor && typeof cursor === 'object') delete cursor[target.path[target.path.length - 1]]
}

/**
 * 断开所有指向某节点的连线。
 * 可选槽位被摘掉后必须调用，否则会留下「引用已删除素材」的悬空输入，
 * ComfyUI 会报 missing required input。
 */
export function dropLinksTo(graph: Record<string, ComfyApiNode>, nodeId: string) {
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (isLink(value) && value[0] === nodeId) delete node.inputs[key]
    }
  }
}

/** 只保留输出节点可达的子图；返回新对象 */
export function pruneGraph(
  graph: Record<string, ComfyApiNode>,
  outputNodeIds: string[],
): Record<string, ComfyApiNode> {
  const result: Record<string, ComfyApiNode> = {}
  const visiting = new Set<string>()
  const visit = (id: string) => {
    const ident = String(id)
    if (ident in result) return
    if (visiting.has(ident)) throw new Error(`工作流存在环：${ident}`)
    const node = graph[ident]
    if (!node) throw new Error(`输出节点依赖的 ${ident} 不在工作流中`)
    visiting.add(ident)
    for (const value of Object.values(node.inputs)) {
      if (isLink(value)) visit(value[0])
    }
    result[ident] = node
    visiting.delete(ident)
  }
  for (const id of outputNodeIds) {
    if (!(String(id) in graph)) throw new Error(`输出节点 ${id} 不在工作流中`)
    visit(id)
  }
  return result
}

function optionMatches(when: Record<string, any> | undefined, values: Record<string, any>): boolean {
  if (!when) return true
  return Object.entries(when).every(([key, expected]) => {
    const actual = values[key]
    if (expected === undefined || expected === null) return actual === undefined || actual === null
    return actual === expected
  })
}

/** 面板可调项的最终取值：用户保存值 → 模板默认值 */
export function resolveOptionValues(
  template: ComfyWorkflowTemplate,
  saved: Record<string, any>,
): Record<string, any> {
  const values: Record<string, any> = {}
  for (const option of template.options || []) {
    const raw = Object.prototype.hasOwnProperty.call(saved, option.id) ? saved[option.id] : option.default
    if (option.type === 'boolean') values[option.id] = raw === true
    else if (option.type === 'number') {
      const n = Number(raw)
      values[option.id] = Number.isFinite(n) ? n : Number(option.default) || 0
    } else if (option.type === 'select') {
      values[option.id] = (option.choices || []).includes(raw) ? raw : option.default
    } else {
      values[option.id] = typeof raw === 'string' ? raw : String(option.default ?? '')
    }
  }
  return values
}

function contextValue(context: ComfyJobContext, source: ComfyBindingSource): unknown {
  switch (source) {
    case 'prompt': return context.prompt
    case 'negative_prompt': return context.negativePrompt
    case 'width': return context.width
    case 'height': return context.height
    case 'seed': return context.seed
    case 'duration_seconds': return context.durationSeconds
    case 'frames': return context.frames
    case 'fps': return context.fps
    case 'resolution': return context.resolution
    case 'aspect_ratio': return context.aspectRatio
    case 'filename_prefix': return context.filenamePrefix
    case 'images': return context.images
    case 'videos': return context.videos
    case 'audios': return context.audios
    case 'media': return context.media
    case 'first_frame': return context.firstFrame
    case 'last_frame': return context.lastFrame
    default: return undefined
  }
}

/** 绑定链路快照（项目字段 → 节点输入），用于「请求内容」里核对中间变更 */
export interface ComfyBindingTrace {
  source: string
  target: string
  value: string
}

export interface ComfySubmissionTrace {
  /** 本次生效的面板可调项 */
  options: Record<string, any>
  bindings: ComfyBindingTrace[]
}

export interface ComfySubmission {
  graph: Record<string, ComfyApiNode>
  trace: ComfySubmissionTrace
}

/** 快照里的值要短：提示词本身另有一份完整的，这里只证明「落到哪个节点」 */
function previewValue(value: unknown): string {
  if (value === undefined || value === null) return '(空)'
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    return text.length > 160 ? `${text.slice(0, 160)}…（${value.length} 字）` : text
  }
  if (Array.isArray(value)) {
    const text = value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' , ')
    return text.length > 160 ? `${text.slice(0, 160)}…（${value.length} 项）` : text
  }
  try {
    const text = JSON.stringify(value)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * 生成提交图：应用可调项 → 应用绑定 → 剪枝
 * 任何绑定写错都会抛错，宁可失败在前端也不要提交一张参数错位的图。
 *
 * buildSubmissionDetailed 额外返回绑定链路，供请求快照展示「项目字段最终落在哪个节点」；
 * buildSubmission 只是它的薄封装，行为完全一致。
 */
export function buildSubmissionDetailed(
  template: ComfyWorkflowTemplate,
  context: ComfyJobContext,
  savedOptionValues: Record<string, any>,
): ComfySubmission {
  const graph = cloneGraph(template)
  const values = resolveOptionValues(template, savedOptionValues)
  const bindings: ComfyBindingTrace[] = []

  // 1) 可调项
  for (const option of template.options || []) {
    const value = values[option.id]
    for (const target of option.targets) setTarget(graph, target, value)
  }

  // 2) 业务绑定（条件绑定用于 Prompt Enhancer 这类互斥分支）
  for (const binding of template.bindings) {
    if (!optionMatches(binding.when, values)) continue
    let value = contextValue(context, binding.source)
    if (binding.index !== undefined) {
      if (!Array.isArray(value)) value = undefined
      else value = value[binding.index]
    }
    const missing = value === undefined || value === null
      || (Array.isArray(value) && value.length === 0 && binding.source !== 'media')
      || (typeof value === 'string' && value.trim() === '')

    if (missing) {
      if (binding.optional) {
        for (const target of binding.targets) {
          removeTarget(graph, target)
          dropLinksTo(graph, target.node)
        }
        bindings.push({
          source: binding.index === undefined ? binding.source : `${binding.source}[${binding.index}]`,
          target: binding.targets.map(t => `${t.node}.${t.input}`).join(', '),
          value: '(未提供，可选槽位已移除)',
        })
      }
      continue
    }
    const payload = binding.encoding === 'json' ? JSON.stringify(value) : value
    for (const target of binding.targets) setTarget(graph, target, payload)
    bindings.push({
      source: binding.index === undefined ? binding.source : `${binding.source}[${binding.index}]`,
      target: binding.targets.map(t => `${t.node}.${t.input}`).join(', '),
      value: previewValue(value),
    })
  }

  // 3) 剪枝（同时天然清理掉未选中的互斥分支）
  // 预览节点必须一起保留，否则 ComfyUI 不会执行它，一采视频永远不落盘
  const outputs = [...new Set([...template.outputNodes, ...(template.previewOutputNodes || [])])]
    .filter(id => graph[id])
  return { graph: pruneGraph(graph, outputs), trace: { options: values, bindings } }
}

export function buildSubmission(
  template: ComfyWorkflowTemplate,
  context: ComfyJobContext,
  savedOptionValues: Record<string, any>,
): Record<string, ComfyApiNode> {
  return buildSubmissionDetailed(template, context, savedOptionValues).graph
}

/**
 * 校验模板：节点是否存在、绑定目标字段是否真实存在、输出节点是否声明。
 * 传入 objectInfo 时还会检查本机是否安装了所有节点类型。
 */
export function validateTemplate(
  template: ComfyWorkflowTemplate,
  objectInfo?: ComfyObjectInfo,
): TemplateValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const missingNodes: string[] = []

  if (!Object.keys(template.api).length) errors.push('工作流为空（没有可执行节点）')
  if (!template.outputNodes.length) errors.push('没有指定输出节点，无法读取生成结果')

  if (objectInfo) {
    for (const [id, node] of Object.entries(template.api)) {
      if (!objectInfo[node.class_type]) missingNodes.push(`${node.class_type}（节点 ${id}）`)
    }
    for (const missing of missingNodes) {
      errors.push(`本机 ComfyUI 未安装节点类型：${missing}`)
    }
  }

  const checkTarget = (target: ComfyBindingTarget, label: string) => {
    const node = template.api[target.node]
    if (!node) { errors.push(`${label}：节点 ${target.node} 不存在`); return }
    if (!(target.input in node.inputs)) {
      errors.push(`${label}：节点 ${target.node} 没有字段 ${target.input}`)
    }
  }

  for (const binding of template.bindings) {
    if (!binding.targets.length) errors.push(`绑定 ${binding.source} 没有目标字段`)
    for (const target of binding.targets) checkTarget(target, `绑定 ${binding.source}`)
  }
  for (const option of template.options || []) {
    for (const target of option.targets) checkTarget(target, `可调项 ${option.id}`)
  }

  for (const id of template.outputNodes) {
    if (!template.api[String(id)]) errors.push(`输出节点 ${id} 不存在`)
  }

  if (!template.bindings.some(b => b.source === 'prompt')) {
    warnings.push('模板没有 prompt 绑定，生成的提示词不会进入工作流')
  }

  return { ok: errors.length === 0, errors, warnings, missingNodes }
}

/** 面板展示用的摘要 */
export function describeTemplate(template: ComfyWorkflowTemplate | null) {
  if (!template) return null
  const nodeTypes = [...new Set(Object.values(template.api).map(n => n.class_type))]
  return {
    name: template.name,
    nodeCount: Object.keys(template.api).length,
    nodeTypes,
    bindingCount: template.bindings.length,
    outputNodes: template.outputNodes,
    videoOutputIndex: template.videoOutputIndex ?? null,
    options: (template.options || []).map(o => ({
      id: o.id,
      label: o.label,
      type: o.type,
      default: o.default,
      choices: o.choices,
      min: o.min,
      max: o.max,
      step: o.step,
      hint: o.hint,
    })),
    savedAt: template.savedAt ?? null,
  }
}
