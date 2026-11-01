/**
 * 本地 ComfyUI 图片生成适配器
 *
 * 与云端适配器的差别只在「请求怎么构造」与「结果从哪里取」：
 *   - 提交：把模板图填好参数后 POST /prompt，拿 prompt_id 当作异步任务号
 *   - 轮询：GET /history/{prompt_id}
 *   - 结果：/view?filename=...&subfolder=...&type=output 作为可下载地址
 *
 * 素材方面：参考图先按内容哈希上传到 ComfyUI 的 input 目录，
 * 再把相对路径写进 LoadImage.image（本机云端 adapter 没有这一步）。
 */
import type {
  AIConfig,
  ImageGenResponse,
  ImageGenerationRecord,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types'
import { ComfyClient, collectFiles } from '../comfyui/client.js'
import { getComfyConfig, pickImageTemplate, type ComfyWorkflowTemplate } from '../comfyui/config.js'
import { buildSubmission, type ComfyJobContext } from '../comfyui/template.js'
import { stageMany, taskSubfolder } from '../comfyui/staging.js'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

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

/**
 * 把请求尺寸收敛到像素预算内，并对齐 8 的倍数（EmptyLatentImage 的潜空间对齐）。
 *
 * 本地扩散模型的采样耗时与像素量近似成正比：实测 1920×1080（2.07MP）50s，
 * 1024×1024（1.05MP）25s；且高分辨率在 8G 显存上会触发低显存调度进一步变慢。
 * Qwen Image 2.1 的原生默认也是 1MP。
 */
function parseSize(size: string | null | undefined, pixelBudget?: number): { width: number; height: number } {
  const align = (n: number) => Math.max(64, Math.round(n / 8) * 8)
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(String(size || '').trim())
  const rawWidth = match ? Number(match[1]) : 1024
  const rawHeight = match ? Number(match[2]) : 1024
  const budget = pixelBudget && pixelBudget > 0 ? pixelBudget : 1024 * 1024

  const pixels = rawWidth * rawHeight
  if (pixels <= budget * 1.02) return { width: align(rawWidth), height: align(rawHeight) }

  const ratio = Math.sqrt(budget / pixels)
  return { width: align(rawWidth * ratio), height: align(rawHeight * ratio) }
}

/**
 * 未指定种子时给一个随机值。
 *
 * 工作流里的 RandomNoise 存的是上一次保存时的固定种子，
 * 如果这里返回 undefined，绑定会被跳过、永远复用同一个 seed，
 * 同一提示词反复生成会得到几乎一样的画面。
 */
export function resolveSeed(value: number | null | undefined): number {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  return Math.floor(Math.random() * 2 ** 47)
}

/** 图片模板的输出节点并集（文生图与图生图各一份配置） */
export function imageOutputNodes(configImage: ComfyWorkflowTemplate | null, configEdit: ComfyWorkflowTemplate | null): string[] {
  const ids = new Set<string>()
  for (const template of [configImage, configEdit]) {
    for (const id of template?.outputNodes || []) ids.add(String(id))
  }
  return [...ids]
}

/** 从 /history 结果里挑出图片文件；优先按声明的输出节点过滤 */
export function pickImageFile(result: any, outputNodes: string[]) {
  const entry = Object.values(result || {})[0] as any
  if (!entry) return { entry: null, file: null }
  const scoped = collectFiles(entry, outputNodes, IMAGE_EXTENSIONS)
  if (scoped.length) return { entry, file: scoped[0] }
  const anyNode = collectFiles(entry, [], IMAGE_EXTENSIONS)
  return { entry, file: anyNode[0] || null }
}

export class ComfyUiImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const comfy = getComfyConfig()
    if (!comfy.enabled) throw new Error('本地算力已关闭，请到「设置 → 本地算力」启用')

    const references = parseJsonArray(record.referenceImages)
    const template = pickImageTemplate(references.length > 0)
    if (!template) {
      throw new Error(references.length
        ? '当前没有可用的「图片编辑」工作流模板，请到设置页导入'
        : '当前没有可用的「文生图」工作流模板，请到设置页导入')
    }

    const client = new ComfyClient(comfy.url)
    const subfolder = taskSubfolder(comfy.uploadSubfolder, record.id ?? 'image', 'img')

    // 参考图先落地到 ComfyUI input，再把相对路径写进工作流
    const staged = references.length
      ? await stageMany(client, references, 'image', subfolder)
      : []

    const { width, height } = parseSize(record.size, comfy.imagePixelBudget)
    const context: ComfyJobContext = {
      prompt: String(record.prompt || ''),
      width,
      height,
      seed: resolveSeed(record.seed),
      filenamePrefix: `${comfy.uploadSubfolder}/img-${record.id ?? Date.now()}`,
      images: staged.map(s => s.path),
    }

    const graph = buildSubmission(template, context, comfy.optionValues)
    return {
      url: `${comfy.url.replace(/\/+$/, '')}/prompt`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { prompt: graph, client_id: `huobao-image-${record.id ?? 'na'}` },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
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

  parsePollResponse(result: any): ImagePollResponse {
    const comfy = getComfyConfig()
    const outputNodes = imageOutputNodes(comfy.image, comfy.imageEdit)
    const { entry, file } = pickImageFile(result, outputNodes)
    if (!entry) return { status: 'pending' }
    if (entry.status?.status_str === 'error') {
      const messages = Array.isArray(entry.status?.messages) ? entry.status.messages : []
      const detail = messages.map((m: any) => m?.[1]?.exception_message || m?.[1]?.message || '').filter(Boolean).join('；')
      return { status: 'failed', error: detail || 'ComfyUI 执行失败（查看服务端日志）' }
    }
    if (!entry.status?.completed) return { status: 'processing' }
    if (!file) return { status: 'failed', error: 'ComfyUI 已执行完成但未找到图片产物（核对模板的输出节点）' }
    return { status: 'completed', imageUrl: viewUrl(comfy.url, file) }
  }

  extractImageUrl(result: any): string | null {
    const comfy = getComfyConfig()
    const { file } = pickImageFile(result, imageOutputNodes(comfy.image, comfy.imageEdit))
    return file ? viewUrl(comfy.url, file) : null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    // ComfyUI 产物是文件，不走 base64 通道
    return null
  }
}

export function viewUrl(baseUrl: string, file: { filename?: string; subfolder?: string; type?: string }): string {
  const params = new URLSearchParams({
    filename: String(file.filename || ''),
    subfolder: String(file.subfolder || ''),
    type: String(file.type || 'output'),
  })
  return `${baseUrl.replace(/\/+$/, '')}/view?${params.toString()}`
}
