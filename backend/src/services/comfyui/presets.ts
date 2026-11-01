/**
 * 内置工作流预设 — workspace/comfyui/ 下的「API 图 + 绑定表」
 *
 * 目录结构：
 *   workspace/comfyui/presets.json                    预设清单（绑定表 + 可调项）
 *   workspace/comfyui/*.api.json                      ComfyUI「Export (API)」导出的执行图
 *
 * 预设只依赖节点 id，用户换工作流时在前端重新绑定即可。
 * 桌面版由主进程注入 WORKSPACE_PATH（userData 下的可写副本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeTemplate, type ComfyWorkflowTemplate } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/services/comfyui → 上三级为 backend/
export const COMFY_WORKSPACE_DIR = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH, 'comfyui')
  : path.resolve(__dirname, '../../../workspace/comfyui')

const PRESETS_FILE = path.join(COMFY_WORKSPACE_DIR, 'presets.json')

/** 预设占用的配置槽位：图片分「文生图」与「图片编辑」两个槽 */
export type ComfyTemplateSlot = 'image' | 'imageEdit' | 'video'

export interface ComfyPresetDefinition {
  id: string
  label: string
  kind: 'image' | 'video'
  slot: ComfyTemplateSlot
  apiFile?: string
  /** UI 格式工作流（可导入 ComfyUI 界面直接打开/编辑） */
  workflowFile?: string
  description?: string
  template: {
    name?: string
    outputNodes?: string[]
    bindings?: unknown
    options?: unknown
    videoOutputIndex?: number
  }
}

export interface ComfyPresetSummary {
  id: string
  label: string
  kind: 'image' | 'video'
  slot: ComfyTemplateSlot
  description: string
  /** 对应 API 图是否就位（缺失时不能直接套用） */
  available: boolean
  nodeCount: number
  /** 可导入 ComfyUI 的 UI 格式工作流文件名（无则为 null） */
  workflowFile: string | null
}

let cache: { mtimeMs: number; presets: ComfyPresetDefinition[] } | null = null

/** 读取预设清单；文件缺失或损坏时返回空数组（不抛错，让设置页能正常打开） */
export function loadPresetDefinitions(): ComfyPresetDefinition[] {
  try {
    const stat = fs.statSync(PRESETS_FILE)
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.presets
    const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8'))
    const list = Array.isArray(raw?.presets) ? raw.presets : []
    const presets: ComfyPresetDefinition[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const label = typeof item.label === 'string' ? item.label.trim() : id
      const kind = item.kind === 'video' ? 'video' : 'image'
      // 未声明 slot 时按 kind 兜底：图片默认占「文生图」槽
      const slot: ComfyTemplateSlot = item.slot === 'imageEdit' || item.slot === 'video' || item.slot === 'image'
        ? item.slot
        : (kind === 'video' ? 'video' : 'image')
      if (!id || !item.template) continue
      presets.push({
        id,
        label: label || id,
        kind,
        slot,
        ...(typeof item.apiFile === 'string' ? { apiFile: item.apiFile } : {}),
        ...(typeof item.workflowFile === 'string' ? { workflowFile: item.workflowFile } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        template: item.template,
      })
    }
    cache = { mtimeMs: stat.mtimeMs, presets }
    return presets
  } catch {
    return []
  }
}

function readApiFile(fileName: string): unknown {
  const full = path.join(COMFY_WORKSPACE_DIR, fileName)
  if (!fs.existsSync(full)) throw new Error(`预设的工作流文件不存在：${fileName}`)
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'))
  } catch (error: any) {
    throw new Error(`工作流文件不是合法 JSON（${fileName}）：${error?.message || error}`)
  }
}

/**
 * 可调项的默认值取自用户工作流的当前值。
 *
 * 目的：不动面板就等于不动工作流。否则预设里写死的 default（4 步 / 1.5 倍…）
 * 会覆盖使用者已经调好的参数，违背「默认配置尽量不要动」。
 */
function syncOptionDefaultsFromGraph(template: ComfyWorkflowTemplate): void {
  for (const option of template.options || []) {
    const target = option.targets[0]
    if (!target) continue
    const node = template.api[target.node]
    if (!node) continue
    let value: any = node.inputs[target.input]
    for (const key of target.path || []) {
      if (value == null || typeof value !== 'object') { value = undefined; break }
      value = value[key]
    }
    if (value === undefined || value === null) continue
    if (option.type === 'number' && typeof value !== 'number') continue
    if (option.type === 'boolean' && typeof value !== 'boolean') continue
    if (option.type === 'select' && !(option.choices || []).includes(value)) continue
    option.default = value
  }
}

function composeTemplate(preset: ComfyPresetDefinition, api: unknown): ComfyWorkflowTemplate {
  const template = normalizeTemplate({
    name: preset.template.name || preset.label,
    api,
    outputNodes: preset.template.outputNodes,
    bindings: preset.template.bindings,
    options: preset.template.options,
    videoOutputIndex: preset.template.videoOutputIndex,
    savedAt: new Date().toISOString(),
  })
  if (!template) throw new Error(`预设 ${preset.id} 的工作流为空或不是 API 格式`)
  if (!template.outputNodes.length) {
    throw new Error(`预设 ${preset.id} 声明的输出节点不在工作流中，请核对节点 id`)
  }
  syncOptionDefaultsFromGraph(template)
  return template
}

/** 用预设自带的 API 图构建完整模板 */
export function buildTemplateFromPreset(presetId: string): ComfyWorkflowTemplate {
  const preset = loadPresetDefinitions().find(p => p.id === presetId)
  if (!preset) throw new Error(`未知的工作流预设：${presetId}`)
  if (!preset.apiFile) throw new Error(`预设 ${presetId} 没有关联工作流文件`)
  return composeTemplate(preset, readApiFile(preset.apiFile))
}

/** 用预设的绑定表 + 用户自己的 API 图构建模板（换工作流但沿用字段绑定时使用） */
export function buildTemplateFromPresetWithApi(presetId: string, api: unknown): ComfyWorkflowTemplate {
  const preset = loadPresetDefinitions().find(p => p.id === presetId)
  if (!preset) throw new Error(`未知的工作流预设：${presetId}`)
  return composeTemplate(preset, api)
}

/** 设置页下拉列表用 */
export function listComfyPresets(): ComfyPresetSummary[] {
  return loadPresetDefinitions().map(preset => {
    let nodeCount = 0
    let available = false
    if (preset.apiFile) {
      try {
        const api = readApiFile(preset.apiFile)
        const graph = (api as any)?.prompt ?? api
        nodeCount = graph && typeof graph === 'object' ? Object.keys(graph).length : 0
        available = nodeCount > 0
      } catch {
        available = false
      }
    }
    return {
      id: preset.id,
      label: preset.label,
      kind: preset.kind,
      slot: preset.slot,
      description: preset.description || '',
      available,
      nodeCount,
      workflowFile: preset.workflowFile ? path.basename(preset.workflowFile) : null,
    }
  })
}

/** 每个 Agent 无关：按业务类型取默认预设 id */
export const DEFAULT_PRESET_BY_KIND: Record<'image' | 'imageEdit' | 'video', string> = {
  image: 'qwen-image-2.1-t2i',
  imageEdit: 'qwen-image-2.1-edit',
  video: 'minimax-h3-ref2va',
}

/** 可导入 ComfyUI 界面的内置工作流 */
export interface BundledWorkflow {
  presetId: string
  presetLabel: string
  /** 推送到 ComfyUI workflows 目录时使用的文件名 */
  filename: string
  content: string
  nodeCount: number
  bytes: number
}

function readWorkflowFile(relPath: string): { content: string; nodeCount: number } {
  const full = path.join(COMFY_WORKSPACE_DIR, relPath)
  if (!fs.existsSync(full)) throw new Error(`内置工作流文件不存在：${relPath}`)
  const content = fs.readFileSync(full, 'utf-8')
  let nodeCount = 0
  try {
    const parsed = JSON.parse(content)
    nodeCount = Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0
    if (!nodeCount) {
      // 允许存 API 格式作为兜底（虽然界面导入需要 UI 格式）
      nodeCount = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0
    }
  } catch {
    throw new Error(`内置工作流不是合法 JSON：${relPath}`)
  }
  return { content, nodeCount }
}

/** 列出所有可导入 ComfyUI 的内置工作流 */
export function listBundledWorkflows(): BundledWorkflow[] {
  return loadPresetDefinitions()
    .filter(preset => !!preset.workflowFile)
    .map(preset => {
      try {
        const { content, nodeCount } = readWorkflowFile(preset.workflowFile!)
        return {
          presetId: preset.id,
          presetLabel: preset.label,
          filename: path.basename(preset.workflowFile!),
          content,
          nodeCount,
          bytes: Buffer.byteLength(content, 'utf-8'),
        }
      } catch {
        return null
      }
    })
    .filter((item): item is BundledWorkflow => !!item)
}

/** 按预设 id 取单个内置工作流；不存在返回 null */
export function readBundledWorkflow(presetId: string): BundledWorkflow | null {
  return listBundledWorkflows().find(item => item.presetId === presetId) || null
}
