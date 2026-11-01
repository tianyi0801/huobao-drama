/**
 * 本地算力环境检测 — 设置页「本地算力」面板的数据源
 *
 * 轻量检测（默认）：ComfyUI 可达性 + GPU/显存 + FFmpeg + 模板结构
 * 深度检测（用户点「重新检测」）：额外拉 /object_info 校验节点齐备、上传探针验证 input 可写
 *
 * 所有网络探测都有短超时：ComfyUI 没启动时设置页必须秒回，不能卡住。
 */
import { getComfyConfig, type ComfyWorkflowTemplate } from './config.js'
import { ComfyClient, type ComfyObjectInfo } from './client.js'
import { describeTemplate, validateTemplate } from './template.js'
import { listBundledWorkflows, listComfyPresets, type ComfyPresetSummary } from './presets.js'
import { checkFfmpegSuite } from '../../utils/ffmpeg.js'
import { volumeFreeBytes } from '../../utils/dirsize.js'
import { DATA_ROOT } from '../../utils/paths.js'

const OBJECT_INFO_TTL_MS = 60_000
const objectInfoCache = new Map<string, { at: number; data: ComfyObjectInfo }>()

async function loadObjectInfo(url: string): Promise<ComfyObjectInfo> {
  const cached = objectInfoCache.get(url)
  if (cached && Date.now() - cached.at < OBJECT_INFO_TTL_MS) return cached.data
  const client = new ComfyClient(url, 10_000)
  const data = await client.objectInfo()
  objectInfoCache.set(url, { at: Date.now(), data })
  return data
}

/** 1x1 透明 PNG，用于验证 input 目录可写 */
const PROBE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

export interface ComfyDeviceInfo {
  name: string
  type: string
  vramTotalBytes: number | null
  vramFreeBytes: number | null
}

export interface ComfyServiceReport {
  url: string
  reachable: boolean
  latencyMs: number | null
  version: string | null
  pythonVersion: string | null
  os: string | null
  devices: ComfyDeviceInfo[]
  /** 深度检测才填充 */
  uploadWritable: boolean | null
  uploadError: string | null
  error: string | null
}

export interface TemplateReport {
  present: boolean
  ok: boolean
  errors: string[]
  warnings: string[]
  missingNodes: string[]
  summary: ReturnType<typeof describeTemplate>
}

/** 内置 UI 工作流在目标 ComfyUI 上的安装状态 */
export interface BundledWorkflowStatus {
  presetId: string
  presetLabel: string
  filename: string
  nodeCount: number
  bytes: number
  installed: boolean
}

export interface LocalEnvReport {
  ready: boolean
  enabled: boolean
  deepChecked: boolean
  checkedAt: string
  blockers: string[]
  warnings: string[]
  comfyui: ComfyServiceReport
  ffmpeg: { ffmpeg: boolean; ffprobe: boolean }
  storage: { dataDir: string; freeBytes: number | null }
  templates: {
    image: TemplateReport | null
    imageEdit: TemplateReport | null
    video: TemplateReport | null
  }
  presets: ComfyPresetSummary[]
  /** 内置 UI 工作流（可一键导入 ComfyUI 界面） */
  bundledWorkflows: BundledWorkflowStatus[]
  optionValues: Record<string, any>
  /** 图片像素预算（本地模型的采样耗时与像素量近似成正比） */
  imagePixelBudget: number
  /** 镜头衔接：同场景相邻分镜是否带上上一段尾帧作为参考 */
  continuityReference: boolean
  poll: { intervalMs: number; imageTimeoutMs: number; videoTimeoutMs: number }
  uploadSubfolder: string
}

function emptyTemplateReport(): TemplateReport {
  return { present: false, ok: false, errors: [], warnings: [], missingNodes: [], summary: null }
}

function checkTemplate(
  template: ComfyWorkflowTemplate | null,
  objectInfo: ComfyObjectInfo | null,
): TemplateReport | null {
  if (!template) return emptyTemplateReport()
  const validation = validateTemplate(template, objectInfo || undefined)
  return {
    present: true,
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    missingNodes: validation.missingNodes,
    summary: describeTemplate(template),
  }
}

async function probeComfy(url: string): Promise<ComfyServiceReport> {
  const report: ComfyServiceReport = {
    url,
    reachable: false,
    latencyMs: null,
    version: null,
    pythonVersion: null,
    os: null,
    devices: [],
    uploadWritable: null,
    uploadError: null,
    error: null,
  }
  const startedAt = Date.now()
  try {
    // 本地服务应当秒回；设置页首屏不能被一个没启动的 ComfyUI 拖住
    const client = new ComfyClient(url, 1_500)
    const stats = await client.systemStats()
    report.reachable = true
    report.latencyMs = Date.now() - startedAt
    report.version = stats.system?.comfyui_version ?? null
    report.pythonVersion = stats.system?.python_version ?? null
    report.os = stats.system?.os ?? null
    report.devices = (stats.devices || []).map(device => ({
      name: device.name || '未知设备',
      type: device.type || '',
      vramTotalBytes: typeof device.vram_total === 'number' ? device.vram_total : null,
      vramFreeBytes: typeof device.vram_free === 'number' ? device.vram_free : null,
    }))
  } catch (error: any) {
    report.error = error?.message || '无法连接 ComfyUI'
    report.latencyMs = Date.now() - startedAt
  }
  return report
}

async function probeUpload(url: string, subfolder: string): Promise<{ writable: boolean; error: string | null }> {
  try {
    const client = new ComfyClient(url, 15_000)
    await client.upload('probe.png', PROBE_PNG, `${subfolder}/__probe__`, 'image/png')
    return { writable: true, error: null }
  } catch (error: any) {
    return { writable: false, error: error?.message || 'input 目录不可写' }
  }
}

/**
 * 收集本地环境报告
 * @param deep true 时额外校验节点齐备度与 input 可写（会多花 1-3 秒）
 */
export async function collectLocalEnv(deep = false): Promise<LocalEnvReport> {
  const config = getComfyConfig()
  const blockers: string[] = []
  const warnings: string[] = []

  const [comfyui, ffmpegSuite, freeBytes] = await Promise.all([
    probeComfy(config.url),
    checkFfmpegSuite(),
    volumeFreeBytes(DATA_ROOT).catch(() => null),
  ])

  if (!config.enabled) blockers.push('本地算力未启用')
  if (!comfyui.reachable) blockers.push(`ComfyUI 未连接：${comfyui.error || config.url}`)
  if (comfyui.reachable && comfyui.devices.length === 0) warnings.push('未检测到可用 GPU（可能以 CPU 模式运行，速度会非常慢）')

  let objectInfo: ComfyObjectInfo | null = null
  if (deep && comfyui.reachable) {
    try {
      objectInfo = await loadObjectInfo(config.url)
    } catch (error: any) {
      warnings.push(`无法读取节点定义（/object_info）：${error?.message || error}`)
    }
    if (objectInfo) {
      const probe = await probeUpload(config.url, config.uploadSubfolder)
      comfyui.uploadWritable = probe.writable
      comfyui.uploadError = probe.error
      if (!probe.writable) blockers.push(`素材上传失败：${probe.error}`)
    }
  }

  // 内置 UI 工作流的安装状态：ComfyUI 可达时对比 workflows 目录
  let bundledWorkflows: BundledWorkflowStatus[] = []
  if (comfyui.reachable) {
    try {
      const remote = await new ComfyClient(config.url, 5_000).listUserWorkflows()
      const flat = new Set(remote.map(name => name.replace(/\\/g, '/')))
      bundledWorkflows = listBundledWorkflows().map(item => ({
        presetId: item.presetId,
        presetLabel: item.presetLabel,
        filename: item.filename,
        nodeCount: item.nodeCount,
        bytes: item.bytes,
        installed: flat.has(item.filename),
      }))
    } catch {
      bundledWorkflows = []
    }
  }

  const templates = {
    image: checkTemplate(config.image, objectInfo),
    imageEdit: checkTemplate(config.imageEdit, objectInfo),
    video: checkTemplate(config.video, objectInfo),
  }

  if (!config.image && !config.imageEdit) blockers.push('未配置图片工作流模板')
  if (!config.video) blockers.push('未配置视频工作流模板')
  for (const [key, label] of [['image', '文生图'], ['imageEdit', '图片编辑'], ['video', '视频']] as const) {
    const report = templates[key]
    if (!report?.present) continue
    if (!report.ok) blockers.push(`${label}模板校验失败：${report.errors[0] || '未知错误'}`)
  }
  if (!ffmpegSuite.ffmpeg || !ffmpegSuite.ffprobe) {
    warnings.push('FFmpeg/FFprobe 不可用：视频拼接与封面帧提取会失败')
  }
  if (freeBytes !== null && freeBytes < 2 * 1024 * 1024 * 1024) {
    warnings.push(`磁盘剩余空间不足 2GB（${Math.round(freeBytes / 1024 / 1024)}MB）`)
  }

  return {
    ready: blockers.length === 0,
    enabled: config.enabled,
    deepChecked: deep,
    checkedAt: new Date().toISOString(),
    blockers,
    warnings,
    comfyui,
    ffmpeg: ffmpegSuite,
    storage: { dataDir: DATA_ROOT, freeBytes },
    templates,
    presets: listComfyPresets(),
    bundledWorkflows,
    optionValues: config.optionValues,
    imagePixelBudget: config.imagePixelBudget,
    continuityReference: config.continuityReference,
    poll: config.poll,
    uploadSubfolder: config.uploadSubfolder,
  }
}

/** 保存配置前校验单个模板是否可用（不请求网络，只做结构校验） */
export function quickValidate(template: ComfyWorkflowTemplate | null): TemplateReport | null {
  return checkTemplate(template, null)
}
