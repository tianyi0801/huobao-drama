/**
 * 本地 ComfyUI 视频生成适配器
 *
 * 与云端适配器的差别：
 *   1. 参考素材必须先上传到 ComfyUI 的 input 目录，再以「媒体清单」形式写进工作流
 *   2. 素材顺序必须与提示词里的 @图片N 严格一致（前端已按 场景→角色→道具 排好）
 *   3. 结果是本地文件，通过 /view 下载后再由 generation.ts 落盘回写
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { ComfyClient, collectFiles } from '../comfyui/client.js'
import { getComfyConfig } from '../comfyui/config.js'
import { buildSubmission, type ComfyJobContext } from '../comfyui/template.js'
import { stageMany, taskSubfolder } from '../comfyui/staging.js'
import { resolveSeed, viewUrl } from './comfyui-image.js'
import { normalizeVideoPromptSections, validateVideoPromptTimeline } from '../video-prompt-structure.js'

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv']

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(v => String(v)).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(v => String(v)).filter(Boolean) : []
  } catch {
    return []
  }
}

/** H3 的全部档位 ↔ 短边像素（来自节点 object_info 的枚举） */
const H3_SHORT_SIDE: Record<string, number> = {
  '360P': 360, '416P': 416, '480P': 480, '540P': 540, '640P': 640,
  '720P': 720, '768P': 768, '832P': 832, '928P': 928, '1024P': 1024, '1080P': 1080,
}

/** fire宝 的 480p/720p/1080p → H3 的 480P/720P/1080P；未知值返回 undefined（保留模板默认） */
export function mapVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toUpperCase()
  if (!value) return undefined
  if (value in H3_SHORT_SIDE) return value
  if (value === '2K') return '1080P'
  return undefined
}

/**
 * 界面「清晰度」= **最终成片**分辨率，而工作流的 resolution 字段是**一采**档位。
 * 有二采时，一采必须按倍率回退，否则成片会超出所选档位
 * （选 720P 却出 720×1.5=1080P）。
 *
 * 720P / 1.5 → 480P（成片 720P）
 * 1080P / 1.5 → 720P（成片 1080P）
 * 二采关闭时一采直接等于所选档位
 *
 * 实测基线（RTX 4060 Ti 8G，二采 1.5x，5 秒镜头，2 张参考图）：
 *   一采 720P → 成片 1080P：10 分 49 秒（ComfyUI execution_start → success）
 * 一采档位每降一档，像素约降一半，耗时近似同比例下降。
 */
export function resolveFirstPassResolution(
  finalResolution: string | null | undefined,
  scale: number,
): string {
  const mapped = mapVideoResolution(finalResolution) || '720P'
  const target = H3_SHORT_SIDE[mapped] ?? 720
  const factor = Number.isFinite(scale) && scale > 1.01 ? scale : 1
  if (factor === 1) return mapped

  const wanted = target / factor
  // 取不超过目标值的最大档位，避免成片反而高于所选清晰度
  const picked = Object.entries(H3_SHORT_SIDE)
    .filter(([, side]) => side <= wanted + 1)
    .sort((a, b) => b[1] - a[1])[0]
  return picked?.[0] || '360P'
}

/** "16:9" / "9:16" → 宽高比分量；非法回退 16:9 */
function parseAspect(value: string | null | undefined): { w: number; h: number } {
  const match = /^(\d{1,2})\s*[:：/]\s*(\d{1,2})$/.exec(String(value || '').trim())
  if (!match) return { w: 16, h: 9 }
  const w = Number(match[1])
  const h = Number(match[2])
  return w > 0 && h > 0 ? { w, h } : { w: 16, h: 9 }
}

/**
 * 按「一采档位 + 画面比例」算出工作流的 width/height。
 *
 * H3 节点同时暴露 resolution 和 width/height，两者必须一致，
 * 否则一旦节点优先读宽高，界面上选的清晰度就白设了。
 * 档位数字代表短边像素：480P+16:9 → 856×480，720P+9:16 → 720×1280。
 */
export function computeVideoDimensions(
  resolution: string | null | undefined,
  aspectRatio: string | null | undefined,
): { width: number; height: number } {
  const mapped = mapVideoResolution(resolution) || '720P'
  const side = H3_SHORT_SIDE[mapped] ?? 720
  const ratio = parseAspect(aspectRatio)
  const align8 = (value: number) => Math.max(64, Math.round(value / 8) * 8)

  if (ratio.w >= ratio.h) {
    return { width: align8((side * ratio.w) / ratio.h), height: align8(side) }
  }
  return { width: align8(side), height: align8((side * ratio.h) / ratio.w) }
}

/** 读取可调项当前值（面板已保存值 > 模板默认值 > 兜底） */
function readOption(
  template: { options?: { id: string; default?: any }[] },
  saved: Record<string, any> | undefined,
  id: string,
  fallback: any,
): any {
  if (saved && saved[id] !== undefined && saved[id] !== null) return saved[id]
  const option = (template.options || []).find(item => item.id === id)
  return option?.default ?? fallback
}

/**
 * 画面比例收敛为 "宽:高" 形式；无法识别返回 undefined（保留工作流默认）。
 * 项目里的「自适应」存的是 adaptive，按 16:9 兜底 —— 与图片侧的尺寸推导保持一致。
 */
export function mapAspectRatio(value: string | null | undefined): string | undefined {
  const raw = String(value || '').trim()
  if (raw.toLowerCase() === 'adaptive') return '16:9'
  const match = /^(\d{1,2})\s*[:：/]\s*(\d{1,2})$/.exec(raw)
  if (!match) return undefined
  return `${Number(match[1])}:${Number(match[2])}`
}

/** 从 /history 结果里挑视频文件；多产物时用 template.videoOutputIndex 明确选择 */
export function pickVideoFile(result: any, outputNodes: string[], outputIndex?: number | null) {
  const entry = Object.values(result || {})[0] as any
  if (!entry) return { entry: null, file: null as null | { filename: string; subfolder?: string; type?: string } }

  // 按模板声明的顺序逐个节点找，第一个有产物的就是最终成片：
  // SaveChain（293/292）只在多段合并场景落盘，单段由 ConditionalSecondPassSave（188）产出，
  // 所以不能假设某一个节点一定存在。
  for (const nodeId of outputNodes) {
    const files = collectFiles(entry, [nodeId], VIDEO_EXTENSIONS)
    if (!files.length) continue
    if (outputIndex !== null && outputIndex !== undefined && files[outputIndex]) {
      return { entry, file: files[outputIndex] }
    }
    return { entry, file: files[0] }
  }

  const anyFile = collectFiles(entry, [], VIDEO_EXTENSIONS)
  if (!anyFile.length) return { entry, file: null }
  if (outputIndex !== null && outputIndex !== undefined && anyFile[outputIndex]) {
    return { entry, file: anyFile[outputIndex] }
  }
  return { entry, file: anyFile[0] }
}

export class ComfyUiVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const comfy = getComfyConfig()
    if (!comfy.enabled) throw new Error('本地算力已关闭，请到「设置 → 本地算力」启用')
    const template = comfy.video
    if (!template) throw new Error('当前没有可用的「视频」工作流模板，请到设置页导入')
    const isH3 = Object.values(template.api).some(node => node.class_type.includes('MiniMaxH3EasyV'))
    const rawPrompt = String(record.prompt || '').trim()
    // 历史分镜用的是自造节名，提交前归一成官方六节，避免旧数据仍以 shot_summary / reference_usage 进入模型
    const withVoice = isH3 ? rawPrompt.replace(/（音色参考音频(\d+)）/g, '（音色参考@音频$1）') : rawPrompt
    const prompt = isH3 ? normalizeVideoPromptSections(withVoice) : withVoice
    if (isH3 && !prompt) throw new Error('本地 H3 视频提示词不能为空，请先生成或填写分镜提示词')
    if (isH3) validateVideoPromptTimeline(prompt, Number(record.duration ?? 5))
    if (isH3 && /@(?!图片\d+|视频\d+|音频\d+)[^\s@#]+/.test(prompt)) {
      throw new Error('H3 提示词存在未解析的素材引用，请检查角色、场景、道具是否已绑定且有参考图')
    }

    const client = new ComfyClient(comfy.url)
    const subfolder = taskSubfolder(comfy.uploadSubfolder, record.id ?? 'video', 'vid')

    const referenceImages = parseJsonArray(record.referenceImageUrls)
    const referenceVideos = parseJsonArray(record.referenceVideoUrls)
    const referenceAudios = parseJsonArray(record.referenceAudioUrls)
    if (isH3 && new Set(referenceImages).size !== referenceImages.length) {
      throw new Error('H3 参考图重复会改变图片编号，请为每个角色使用独立参考图并去除重复素材')
    }
    // 首尾帧追加在参考图之后，重复帧不再追加，避免暂存去重改变序号
    const imageSources = [...referenceImages]
    for (const frame of [record.firstFrameUrl, record.lastFrameUrl]) {
      if (frame && !imageSources.includes(String(frame))) imageSources.push(String(frame))
    }

    const [stagedImages, stagedVideos, stagedAudios] = await Promise.all([
      stageMany(client, imageSources, 'image', subfolder),
      stageMany(client, referenceVideos, 'video', subfolder),
      stageMany(client, referenceAudios, 'audio', subfolder),
    ])
    // 清单顺序 = @图片N 的序号来源，图片必须整体排在最前
    const media = [...stagedImages, ...stagedVideos, ...stagedAudios].map(item => item.manifest)
    if (isH3) {
      const counts = { 图片: stagedImages.length, 视频: stagedVideos.length, 音频: stagedAudios.length }
      for (const match of prompt.matchAll(/@(图片|视频|音频)(\d+)/g)) {
        const index = Number(match[2])
        if (index < 1 || index > counts[match[1] as keyof typeof counts]) {
          throw new Error(`H3 素材引用 ${match[0]} 超出实际清单，请检查缺图、素材绑定与编号`)
        }
      }
    }

    // 界面「清晰度」是成片目标；二采开启时一采按倍率回退，关闭时一采直接等于目标
    const secondPassOn = readOption(template, comfy.optionValues, 'second_pass', true) !== false
    const secondPassScale = Number(readOption(template, comfy.optionValues, 'second_pass_scale', 1.5)) || 1.5
    const firstPassResolution = resolveFirstPassResolution(
      record.resolution,
      secondPassOn ? secondPassScale : 1,
    )

    // 宽高必须与 resolution 一起写：H3 节点同时暴露两组字段，只改档位可能与宽高打架
    const aspectRatio = mapAspectRatio(record.aspectRatio)
    const dimensions = computeVideoDimensions(firstPassResolution, aspectRatio)

    const context: ComfyJobContext = {
      prompt,
      resolution: firstPassResolution,
      aspectRatio,
      width: dimensions.width,
      height: dimensions.height,
      durationSeconds: Number(record.duration) > 0 ? Number(record.duration) : undefined,
      fps: 24,
      seed: resolveSeed(record.seed),
      media,
      filenamePrefix: `${comfy.uploadSubfolder}/video-${record.id ?? Date.now()}`,
    }

    const graph = buildSubmission(template, context, comfy.optionValues)
    return {
      url: `${comfy.url.replace(/\/+$/, '')}/prompt`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { prompt: graph, client_id: `huobao-video-${record.id ?? 'na'}` },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.error) throw new Error(`ComfyUI 拒绝执行：${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`)
    if (result?.node_errors && Object.keys(result.node_errors).length) {
      throw new Error(`ComfyUI 节点校验失败：${Object.keys(result.node_errors).join(', ')}`)
    }
    const taskId = result?.prompt_id ? String(result.prompt_id) : ''
    if (!taskId) throw new Error('ComfyUI 未返回任务编号（检查工作流是否有效）')
    return { isAsync: true, taskId }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: `${config.baseUrl.replace(/\/+$/, '')}/history/${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const comfy = getComfyConfig()
    const template = comfy.video
    try {
      const { entry, file } = pickVideoFile(result, template?.outputNodes || [], template?.videoOutputIndex ?? null)
      if (!entry) return { status: 'pending' }
      if (entry.status?.status_str === 'error') {
        const messages = Array.isArray(entry.status?.messages) ? entry.status.messages : []
        const detail = messages.map((m: any) => m?.[1]?.exception_message || m?.[1]?.message || '').filter(Boolean).join('；')
        return { status: 'failed', error: detail || 'ComfyUI 执行失败（查看服务端日志）' }
      }
      if (!entry.status?.completed) return { status: 'processing' }
      if (!file) return { status: 'failed', error: 'ComfyUI 已执行完成但未找到视频产物（核对模板的输出节点）' }
      return { status: 'completed', videoUrl: viewUrl(comfy.url, file) }
    } catch (error: any) {
      return { status: 'failed', error: error?.message || '解析 ComfyUI 结果失败' }
    }
  }

  extractVideoUrl(result: any): string | null {
    const comfy = getComfyConfig()
    const template = comfy.video
    try {
      const { file } = pickVideoFile(result, template?.outputNodes || [], template?.videoOutputIndex ?? null)
      return file ? viewUrl(comfy.url, file) : null
    } catch {
      return null
    }
  }
}
