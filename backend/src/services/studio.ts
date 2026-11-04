/**
 * 视频工作台模式定义与生成参数组装。
 *
 * 本模块只描述「素材槽位 → 视频生成参数」的映射，不引用剧集、分镜、
 * 角色等短剧主流程概念；短剧流程也不需要 import 本模块。
 */
export const PROJECT_TYPES = ['drama', 'character_swap', 'transition'] as const
export type ProjectType = (typeof PROJECT_TYPES)[number]

export const STUDIO_MODES = ['character_swap', 'transition'] as const
export type StudioMode = (typeof STUDIO_MODES)[number]

export type MaterialRole = 'source_video' | 'reference_image' | 'first_frame' | 'last_frame'
export type MediaType = 'image' | 'video'

export interface StudioSlot {
  role: MaterialRole
  mediaType: MediaType
  required: boolean
  max: number
}

export interface StudioMaterialRef {
  role: MaterialRole
  mediaType: MediaType
  localPath: string
  url: string
}

/** 每种模式的素材槽位：角色替换用「源视频 + 人物参考图」，转场用「首帧 + 尾帧」。 */
export const MODE_SLOTS: Record<StudioMode, StudioSlot[]> = {
  character_swap: [
    { role: 'source_video', mediaType: 'video', required: true, max: 1 },
    { role: 'reference_image', mediaType: 'image', required: true, max: 9 },
  ],
  transition: [
    { role: 'first_frame', mediaType: 'image', required: true, max: 1 },
    { role: 'last_frame', mediaType: 'image', required: true, max: 1 },
  ],
}

export const MODE_DEFAULT_PROMPTS: Record<StudioMode, string> = {
  character_swap: '保持原视频的镜头运动、动作节奏、光影与背景不变，仅将画面中的人物替换为参考图片中的人物形象，保持五官、发型与服装一致，画面自然无违和感。',
  transition: '以首帧为起点、尾帧为终点生成一段平滑自然的转场，保持主体形态、色彩与光影连贯，镜头运动流畅，不出现突兀跳切或画面撕裂。',
}

const ROLE_LABELS: Record<MaterialRole, string> = {
  source_video: '源视频',
  reference_image: '人物参考图',
  first_frame: '首帧图片',
  last_frame: '尾帧图片',
}

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === 'string' && (PROJECT_TYPES as readonly string[]).includes(value)
}

export function isStudioMode(value: unknown): value is StudioMode {
  return typeof value === 'string' && (STUDIO_MODES as readonly string[]).includes(value)
}

export function slotsOf(mode: StudioMode): StudioSlot[] {
  return MODE_SLOTS[mode]
}

/** 供前端渲染素材区，避免前后端各维护一份槽位定义。 */
export function describeModes() {
  return STUDIO_MODES.map(id => ({
    id,
    // API 边界统一 snake_case，与项目其它接口一致
    slots: MODE_SLOTS[id].map(s => ({
      role: s.role,
      media_type: s.mediaType,
      required: s.required,
      max: s.max,
    })),
    default_prompt: MODE_DEFAULT_PROMPTS[id],
  }))
}

/** 返回中文错误原因，null 表示素材齐备。 */
export function validateMaterials(mode: StudioMode, materials: StudioMaterialRef[]): string | null {
  for (const slot of MODE_SLOTS[mode]) {
    const count = materials.filter(m => m.role === slot.role).length
    const label = ROLE_LABELS[slot.role]
    if (slot.required && count < 1) return `缺少必需素材：${label}`
    if (count > slot.max) return `素材「${label}」最多 ${slot.max} 个，当前 ${count} 个`
  }
  const allowed = new Set(MODE_SLOTS[mode].map(s => s.role))
  if (materials.some(m => !allowed.has(m.role))) return '存在当前模式不支持的素材类型'
  return null
}

export interface AssembledVideoRequest {
  prompt: string
  duration: number
  aspectRatio?: string
  configId?: number
  referenceVideoUrls?: string[]
  referenceImageUrls?: string[]
  firstFrameUrl?: string
  lastFrameUrl?: string
}

export interface AssembleOptions {
  prompt?: string
  duration?: number
  aspectRatio?: string
  configId?: number
}

/**
 * 把素材槽位翻译成统一视频生成任务参数。
 * 转场只传首尾帧，刻意不带其他参考素材——Wan 3.0 明确禁止两类入参混用。
 */
export function assembleVideoRequest(
  mode: StudioMode,
  materials: StudioMaterialRef[],
  options: AssembleOptions,
): AssembledVideoRequest {
  const pathsOf = (role: MaterialRole) => materials
    .filter(m => m.role === role)
    .map(m => String(m.localPath || '').trim())
    .filter(Boolean)

  const base: AssembledVideoRequest = {
    prompt: String(options.prompt || '').trim() || MODE_DEFAULT_PROMPTS[mode],
    duration: Number(options.duration) > 0 ? Number(options.duration) : 5,
    aspectRatio: options.aspectRatio || undefined,
    configId: options.configId || undefined,
  }

  if (mode === 'character_swap') {
    return {
      ...base,
      referenceVideoUrls: pathsOf('source_video'),
      referenceImageUrls: pathsOf('reference_image'),
    }
  }
  return {
    ...base,
    firstFrameUrl: pathsOf('first_frame')[0],
    lastFrameUrl: pathsOf('last_frame')[0],
  }
}
