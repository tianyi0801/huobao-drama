/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * 允许返回 Promise：本地 ComfyUI 需要先把参考图上传到 input 目录再提交
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  /** 允许返回 Promise：本地 ComfyUI 需要先上传参考素材再提交 */
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 普通请求为可 JSON 序列化的对象（generation.ts 统一 JSON.stringify）；
   * multipart 上传（如 OpenAI /v1/images/edits）直接返回 FormData，
   * 此时 headers 不要设置 Content-Type，边界由 fetch 自动生成。
   */
  body: any
  /** 适配器自述的请求内容（真实提示词 / 生效参数 / 素材顺序 / 绑定链路），用于请求快照 */
  debug?: RequestDebug
}

/**
 * 请求快照：适配器把「真正送进模型的东西」原样交出来，
 * 避免用户只能翻后端控制台才知道提示词被改写成了什么样。
 */
export interface RequestDebug {
  /** 调用形态，如 text_to_image / image_edit / video */
  mode: string
  /** 实际提交给模型的提示词（已完成风格注入、节名归一、@素材编号等改写） */
  prompt: string
  negativePrompt?: string
  /** 实际生效的参数（尺寸、种子、步数、清晰度、时长等） */
  parameters?: Record<string, unknown>
  /** 命中的工作流模板名（本地 ComfyUI） */
  template?: string
  /** 提交顺序即素材编号（图1/图2、@图片N），顺序错位会直接改变成片 */
  media?: Array<{ index: number; kind: string; path: string }>
  /** 工作流绑定链路：项目字段 → 节点输入，便于确认中间变更落在哪 */
  bindings?: Array<{ source: string; target: string; value: string }>
  /** 提交图规模（节点数 / 序列化字节数） */
  graph?: { nodes: number; bytes: number }
  /** 局部编辑选区（原图像素坐标，rect） */
  region?: {
    rect: Record<string, number>
  }
  /** 补充说明（被丢弃的素材、降级原因等） */
  notes?: string[]
}

export interface AIConfig {
  id?: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  /** 可选种子；为空时由适配器随机生成，避免重复生成出同一张图 */
  seed?: number | null
  /** 负面提示词；本地工作流若 cfg=1 则对出图无影响，仅作记录 */
  negativePrompt?: string | null
  /** 本次请求覆盖模板可调项（如 steps），优先级高于全局默认值 */
  optionOverrides?: Record<string, unknown> | null
  /** 局部编辑几何信息（JSON：regionRect/regionArea/regionCrop），仅用于请求快照展示 */
  region?: string | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  referenceVideoUrls?: string | null
  referenceAudioUrls?: string | null
  referenceFileUrl?: string | null
  referenceLinkUrl?: string | null
  generateAudio?: number | boolean | null
  duration?: number | null
  aspectRatio?: string | null
  resolution?: string | null
  seed?: number | null
  promptExtend?: number | boolean | null
  watermark?: number | boolean | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
  duration?: number
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  stage?: 'transferring'
  videoUrl?: string
  duration?: number
  error?: string
}
