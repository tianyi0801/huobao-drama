import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { ComfyClient } from '../services/comfyui/client.js'
import { decorateTaskWithPreview, getPreview, resolveByteRange } from '../services/comfyui/live-preview.js'
import { generateImage, generateVideo, recoverVideoTask } from '../services/generation.js'
import { safeTaskError } from '../services/video-download.js'
import { COMFY_VIRTUAL_CONFIG_ID, getActiveConfig, getConfigById, resolveGenerationConfigId } from '../services/ai.js'
import { getComfyConfig } from '../services/comfyui/config.js'
import { injectStyleOpening } from '../services/video-prompt-structure.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { resolveDramaImageSize } from '../services/image-size.js'
import { resolveStoryboardVoiceReferences } from '../services/character-voice-references.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

app.post('/:id/recover', async c => {
  try {
    await recoverVideoTask(Number(c.req.param('id')))
    return success(c, { id: Number(c.req.param('id')) })
  } catch (error) { return badRequest(c, safeTaskError(error)) }
})

/**
 * POST /tasks/:id/cancel — 取消生成任务
 * 本地 ComfyUI：排队中的从队列删除，正在执行的用 interrupt；
 * 云端厂商没有取消接口，只能在本机标记取消并停止轮询（上游可能继续跑）。
 */
app.post('/:id/cancel', async c => {
  const id = Number(c.req.param('id'))
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!task) return badRequest(c, '任务不存在')
  if (task.status !== 'processing') return badRequest(c, '任务已结束，无需取消')

  let upstream = 'not_attempted'
  if ((task.provider || '').toLowerCase().includes('comfy') && task.taskId) {
    try {
      const client = new ComfyClient(getComfyConfig().url)
      const running = await client.isRunning(task.taskId)
      if (running) await client.interrupt()
      else await client.deleteQueued([task.taskId])
      upstream = running ? 'interrupted' : 'dequeued'
    } catch {
      // 队列不可达不阻断本地取消：任务至少要停止轮询并退出待处理态
      upstream = 'unreachable'
    }
  }

  await db.update(schema.sysTask).set({
    status: 'failed', stage: 'cancelled', errorCode: 'cancelled', errorMsg: '任务已取消',
    completedAt: now(), updatedAt: now(),
  }).where(eq(schema.sysTask.id, id))
  logTaskStart('Task', 'cancel', { id, provider: task.provider, upstream })
  return success(c, { id, upstream })
})

app.get('/:id/diagnostics', async c => {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(c.req.param('id'))))
  if (!task) return badRequest(c, '任务不存在')
  return success(c, { id: task.id, upstreamTaskId: task.taskId, provider: task.provider, model: task.model,
    status: task.status, stage: task.stage, errorCode: task.errorCode, error: safeTaskError(task.errorMsg),
    hasResult: !!task.resultUrl, hasLocalFile: !!task.localPath, createdAt: task.createdAt, updatedAt: task.updatedAt,
    version: process.env.HUOBAO_VERSION || 'development' })
})

type TaskType = 'image' | 'video'

const WAN_MEDIA_TYPES = new Set([
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
])

/**
 * 兼容项目原有扁平入参，也支持 Wan 3.0 官方 model/input/parameters 结构。
 */
function normalizeVideoRequest(body: any) {
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters
    : {}
  const media = Array.isArray(input.media) ? input.media : []

  const mediaUrls = (type: string) => media
    .filter((item: any) => item?.type === type)
    .map((item: any) => item?.url)

  return {
    ...body,
    prompt: body.prompt ?? input.prompt ?? '',
    reference_image_urls: body.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: body.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: body.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: body.first_frame_url ?? mediaUrls('first_frame')[0],
    last_frame_url: body.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: body.file_url ?? mediaUrls('file')[0],
    link_url: body.link_url ?? mediaUrls('link')[0],
    generate_audio: body.generate_audio ?? parameters.audio,
    duration: body.duration ?? parameters.duration,
    aspect_ratio: body.aspect_ratio ?? parameters.ratio,
    resolution: body.resolution ?? parameters.resolution,
    seed: body.seed ?? parameters.seed,
    prompt_extend: body.prompt_extend ?? parameters.prompt_extend,
    watermark: body.watermark ?? parameters.watermark,
    official_media: media,
  }
}

function validateVideoRequest(body: any, provider?: string): string | null {
  for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return `${key} 必须为数组`
    if (Array.isArray(body[key]) && body[key].some((url: any) => typeof url !== 'string' || !url.trim())) {
      return `${key} 中的每个 URL 都必须为非空字符串`
    }
  }

  if (body.official_media.length) {
    for (const item of body.official_media) {
      if (!item || typeof item !== 'object' || !WAN_MEDIA_TYPES.has(item.type) || typeof item.url !== 'string' || !item.url.trim()) {
        return 'input.media 中的每项都必须包含官方支持的 type 和非空 url'
      }
    }
    for (const type of ['first_frame', 'last_frame', 'file', 'link']) {
      if (body.official_media.filter((item: any) => item.type === type).length > 1) {
        return `Wan 3.0 input.media 中 ${type} 最多 1 项`
      }
    }
  }

  const imgs = body.reference_image_urls.length
  const vids = body.reference_video_urls.length
  const auds = body.reference_audio_urls.length
  const first = Boolean(body.first_frame_url)
  const last = Boolean(body.last_frame_url)
  const file = Boolean(body.file_url)
  const link = Boolean(body.link_url)

  if ((provider || '').toLowerCase() === 'aliyun') {
    if (imgs > 10 || vids > 5 || auds > 5) return 'Wan 3.0 参考素材超限：图片≤10、视频≤5、音频≤5'
    if (last && !first) return 'Wan 3.0 尾帧必须与首帧同时传入'
    if (file && link) return 'Wan 3.0 file 与 link 不能同时传入'
    if ((first || last) && (imgs + vids + auds > 0 || file || link)) {
      return 'Wan 3.0 的 first_frame/last_frame 不能与 reference_image/reference_video/reference_audio/file/link 混用'
    }
    const total = imgs + vids + auds + Number(first) + Number(last) + Number(file) + Number(link)
    if (total > 20) return 'Wan 3.0 input.media 最多 20 项'
  } else {
    if (imgs > 9 || vids > 3 || auds > 3) return '参考素材超限：图片≤9、视频≤3、音频≤3'
    if (auds > 0 && imgs + vids === 0) return '参考音频需要至少 1 个参考图片或视频'
  }

  if (!String(body.prompt || '').trim() && imgs + vids + auds === 0 && !first && !last && !file && !link) {
    return '视频生成需要至少一个参考素材或 prompt'
  }
  return null
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, '提示词必填')
    // 采样控制：种子决定可复现性。ComfyUI 的 KSampler 支持 2^64，这里按 JS 安全整数收敛
    if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
      const seed = Number(body.seed)
      if (!Number.isSafeInteger(seed) || seed <= 0) {
        return badRequest(c, 'seed 必须是正整数')
      }
    }
    if (body.negative_prompt !== undefined && body.negative_prompt !== null && typeof body.negative_prompt !== 'string') {
      return badRequest(c, 'negative_prompt 必须为字符串')
    }
    // 模板可调项覆盖：只接受标量，避免把整张图塞进配置
    if (body.option_overrides !== undefined && body.option_overrides !== null) {
      if (typeof body.option_overrides !== 'object' || Array.isArray(body.option_overrides)) {
        return badRequest(c, 'option_overrides 必须为对象')
      }
      for (const [key, value] of Object.entries(body.option_overrides)) {
        if (typeof value !== 'number' && typeof value !== 'boolean') {
          return badRequest(c, `option_overrides.${key} 必须为数字或布尔值`)
        }
      }
    }
    // 局部编辑选区：x/y/w/h 像素坐标，超出底图的交给服务端收敛
    if (body.region !== undefined && body.region !== null) {
      const region = body.region
      if (typeof region !== 'object' || Array.isArray(region)
        || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(region[key])))) {
        return badRequest(c, 'region 必须是包含 x/y/w/h 数值的选区对象')
      }
      if (Number(region.w) < 8 || Number(region.h) < 8) return badRequest(c, '选区太小（最小 8×8 像素）')
    }
    // 图片编辑工作台只允许走本机 ComfyUI：显式 local_only 时绝不回退云端配置，
    // 避免「本地没配好」静默切到云端模型并产生费用
    if (body.local_only === true) {
      const comfy = getComfyConfig()
      if (!comfy.enabled) return badRequest(c, '本地算力已关闭，请到「设置 → 本地算力」启用后再试')
      if (!comfy.imageEdit?.outputNodes?.length) {
        return badRequest(c, '未配置「图片编辑」工作流，请到「设置 → 本地算力」导入')
      }
    }
  }

  const videoBody = type === 'video' ? normalizeVideoRequest(body) : null

  try {
    if (type === 'video' && body.storyboard_id) {
      const [latest] = await db.select().from(schema.sysTask).where(and(
        eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, Number(body.storyboard_id))
      )).orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') return badRequest(c, '该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && body.force_new !== true) {
        return badRequest(c, '请先恢复原任务；重新生成需明确确认可能再次计费')
      }
    }
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    // local_only：固定用本机引擎的虚拟配置 id，generateImage 解析时只认 ComfyUI
    let configId: number | undefined = body.local_only === true
      ? COMFY_VIRTUAL_CONFIG_ID
      : body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        // 本地算力就绪时忽略历史写入的云端锁定配置，避免配好 ComfyUI 仍请求外部厂商
        configId = resolveGenerationConfigId(body.config_id, locked, type)
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
      }
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? (await getConfigById(configId)) ?? await getActiveConfig('video')
        : await getActiveConfig('video')
      const validationError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (validationError) return badRequest(c, validationError)
      const voices = await resolveStoryboardVoiceReferences(String(videoBody.prompt || ''), Number(body.storyboard_id) || undefined, videoBody.reference_audio_urls)
      videoBody.prompt = voices.prompt
      videoBody.reference_audio_urls = voices.audioUrls
      if (voices.hasVoiceReferences && videoBody.generate_audio === false) return badRequest(c, '引用角色音色时需要开启视频声音')
      const referenceError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (referenceError) return badRequest(c, referenceError)

    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    // 官方要求风格句写成 [Shot 1] 之前的 1—2 句英文，不能堆在画面节末尾
    let videoPrompt = videoBody?.prompt
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      if (stylePrompt) videoPrompt = injectStyleOpening(String(videoPrompt), stylePrompt)
    }

    // 未显式指定尺寸时按项目画面比例 + 集清晰度档推导，避免竖屏项目出横图
    const imageSize = type === 'image' && !body.size
      ? await resolveDramaImageSize(body.drama_id, undefined)
      : body.size

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: body.prompt,
        model: body.model,
        size: imageSize,
        referenceImages: body.reference_images,
        frameType: body.frame_type,
        seed: body.seed,
        negativePrompt: body.negative_prompt,
        optionOverrides: body.option_overrides,
        region: body.region ? {
          x: Math.round(Number(body.region.x)),
          y: Math.round(Number(body.region.y)),
          w: Math.round(Number(body.region.w)),
          h: Math.round(Number(body.region.h)),
        } : undefined,
        configId,
      })
      : await generateVideo({
        forceNew: body.force_new === true,
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        prompt: videoPrompt,
        model: videoBody!.model,
        referenceMode: 'reference',
        imageUrl: videoBody!.image_url,
        firstFrameUrl: videoBody!.first_frame_url,
        lastFrameUrl: videoBody!.last_frame_url,
        referenceImageUrls: videoBody!.reference_image_urls,
        referenceVideoUrls: videoBody!.reference_video_urls,
        referenceAudioUrls: videoBody!.reference_audio_urls,
        referenceFileUrl: videoBody!.file_url,
        referenceLinkUrl: videoBody!.link_url,
        generateAudio: videoBody!.generate_audio,
        duration: videoBody!.duration,
        aspectRatio: videoBody!.aspect_ratio,
        resolution: episodeResolution || videoBody!.resolution,
        seed: videoBody!.seed,
        promptExtend: videoBody!.prompt_extend,
        watermark: videoBody!.watermark,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /tasks/:id — 轮询任务状态
// GET /tasks/:id/first-pass — 二采还在跑时先把一采视频流给界面
app.get('/:id/first-pass', async (c) => {
  const id = Number(c.req.param('id'))
  const preview = getPreview(id)
  if (!preview?.filename) return badRequest(c, '一采视频尚未生成')
  const comfy = getComfyConfig()
  const query = new URLSearchParams({
    filename: preview.filename,
    subfolder: preview.subfolder || '',
    type: preview.type || 'output',
  })
  try {
    const upstream = await fetch(`${comfy.url.replace(/\/+$/, '')}/view?${query}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!upstream.ok || !upstream.body) return badRequest(c, '读取一采视频失败')
    // 一采文件通常只有几 MB：整段缓冲后自己处理 Range，
    // 避免浏览器拖动进度条或边下边播时因为上游不支持分段而黑屏
    const buffer = Buffer.from(await upstream.arrayBuffer())
    const total = buffer.length
    const contentType = upstream.headers.get('content-type') || 'video/mp4'
    const plan = resolveByteRange(total, c.req.header('range'))
    if (plan.status === 206) {
      const slice = buffer.subarray(plan.start, plan.end + 1)
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${plan.start}-${plan.end}/${total}`,
          'Content-Length': String(slice.length),
          'Cache-Control': 'no-store',
        },
      })
    }
    if (plan.status === 416) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
    }
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total),
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return badRequest(c, safeTaskError(error))
  }
})

app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, row ? decorateTaskWithPreview(row) : null)
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = await db.select().from(schema.sysTask)

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  // 请求快照体积较大，列表接口一律剔除，按任务 id 单独读取（GET /tasks/:id）
  return success(c, rows.map(({ requestSnapshot: _snapshot, ...rest }) => rest))
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (task?.status === 'processing') return badRequest(c, '任务运行中，暂不能删除')
  await db.delete(schema.sysTask).where(eq(schema.sysTask.id, id))
  return success(c)
})

export default app
