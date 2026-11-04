/**
 * 视频工作台独立路由（人物替换 / 首尾帧转场）。
 *
 * 与短剧主流程的路由互不依赖：不读写剧集、分镜、角色表，
 * 仅复用 /upload 保存的素材地址、sys_task 的单段生成生命周期与结果文件。
 * 人物替换按镜头切分并汇总，转场仍是单次生成。
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, getInsertId, schema } from '../db/index.js'
import { studioBatches, studioMaterials, studioSegments } from '../db/studio-schema.js'
import { generateVideo } from '../services/generation.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { runBatch } from '../services/studio-orchestrator.js'
import { buildSegmentPlan, detectSceneCuts, limitsForProvider, probeVideo } from '../services/studio-segments.js'
import {
  MODE_DEFAULT_PROMPTS, assembleVideoRequest, describeModes, isStudioMode, slotsOf, validateMaterials,
  type MaterialRole, type MediaType, type StudioMaterialRef, type StudioMode,
} from '../services/studio.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'

const app = new Hono()

type ProjectRow = typeof schema.dramas.$inferSelect
type ProjectCheck = { project: ProjectRow; mode: StudioMode } | { error: string; code: 400 | 404 }

async function requireProject(id: number): Promise<ProjectCheck> {
  if (!Number.isFinite(id) || id <= 0) return { error: '项目 ID 无效', code: 400 }
  const [project] = await db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, id), isNull(schema.dramas.deletedAt)))
  if (!project) return { error: '项目不存在', code: 404 }
  if (!isStudioMode(project.projectType)) return { error: '该项目不是人物替换或转场项目', code: 400 }
  return { project, mode: project.projectType }
}

function reject(c: any, result: Extract<ProjectCheck, { error: string }>) {
  return result.code === 404 ? notFound(c, result.error) : badRequest(c, result.error)
}

async function materialsOf(dramaId: number, mode: StudioMode): Promise<StudioMaterialRef[]> {
  const rows = await db.select().from(studioMaterials)
    .where(and(eq(studioMaterials.dramaId, dramaId), eq(studioMaterials.mode, mode)))
    .orderBy(studioMaterials.id)
  return rows.map(row => ({
    role: row.role as MaterialRole,
    mediaType: row.mediaType as MediaType,
    localPath: row.localPath,
    url: row.url,
  }))
}

function mapGeneration(row: typeof schema.sysTask.$inferSelect) {
  const local = row.localPath ? `/${String(row.localPath).replace(/^\//, '')}` : ''
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    preview_url: local || row.resultUrl || '',
    error_msg: row.errorMsg,
    error_code: row.errorCode,
    created_at: row.createdAt,
    completed_at: row.completedAt,
  }
}

/** 按当前视频配置解析模型时长约束，并生成场景切镜计划。 */
async function buildPlan(materials: StudioMaterialRef[], configId?: number) {
  const source = materials.find(m => m.role === 'source_video')
  if (!source) throw new Error('缺少源视频，请先上传')
  const config = configId
    ? (await getConfigById(configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
  const limits = limitsForProvider(config?.provider)
  const meta = await probeVideo(source.localPath)
  const cuts = await detectSceneCuts(source.localPath, meta.duration)
  const segments = buildSegmentPlan(meta, cuts, limits)
  return { source, config, limits, meta, cuts, segments }
}

// 模式定义由后端单点维护，前端按此渲染素材槽位
app.get('/modes', c => success(c, describeModes()))

// 人物替换的分段预览：让用户在提交前看到镜头数、预计生成次数与源视频时长
app.get('/projects/:id/plan', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  if (checked.mode !== 'character_swap') return badRequest(c, '仅人物替换项目需要分段计划')

  const materials = await materialsOf(id, checked.mode)
  if (!materials.some(m => m.role === 'source_video')) {
    return success(c, { ready: false, reason: '缺少源视频' })
  }
  try {
    const configId = Number(c.req.query('config_id')) || undefined
    const plan = await buildPlan(materials, configId)
    return success(c, {
      ready: true,
      source_duration: plan.meta.duration,
      width: plan.meta.width,
      height: plan.meta.height,
      fps: plan.meta.fps,
      has_audio: plan.meta.hasAudio,
      provider: plan.config?.provider || null,
      limits: plan.limits,
      scene_cuts: plan.cuts.length,
      estimated_tasks: plan.segments.length,
      segments: plan.segments.map(s => ({
        index: s.index,
        start: s.start,
        end: s.end,
        duration: s.duration,
        request_duration: s.requestDuration,
      })),
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '无法生成分段计划')
  }
})

// 素材列表
app.get('/projects/:id/materials', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  const rows = await db.select().from(studioMaterials)
    .where(and(eq(studioMaterials.dramaId, id), eq(studioMaterials.mode, checked.mode)))
    .orderBy(studioMaterials.id)
  return success(c, toSnakeCaseArray(rows))
})

// 登记一条已上传素材（文件由通用 /upload 接口落盘，这里只保存引用）
app.post('/projects/:id/materials', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  const body = await c.req.json()
  const slot = slotsOf(checked.mode).find(s => s.role === body.role)
  if (!slot) return badRequest(c, '当前模式不支持该素材类型')
  if (slot.mediaType !== body.media_type) return badRequest(c, '素材类型与槽位不匹配')
  const url = String(body.url || '').trim()
  const localPath = String(body.path || '').trim()
  if (!url || !localPath) return badRequest(c, '素材地址不能为空')

  const existing = await materialsOf(id, checked.mode)
  if (existing.filter(m => m.role === slot.role).length >= slot.max) {
    return badRequest(c, `该槽位最多 ${slot.max} 个素材，请先删除后再上传`)
  }

  const res = await db.insert(studioMaterials).values({
    dramaId: id,
    mode: checked.mode,
    role: slot.role,
    mediaType: slot.mediaType,
    url,
    localPath,
    fileName: body.file_name ? String(body.file_name) : null,
    createdAt: now(),
  })
  return created(c, { id: getInsertId(res) })
})

app.delete('/materials/:materialId', async c => {
  const id = Number(c.req.param('materialId'))
  const [row] = await db.select().from(studioMaterials).where(eq(studioMaterials.id, id))
  if (!row) return notFound(c, '素材不存在')
  await db.delete(studioMaterials).where(eq(studioMaterials.id, id))
  return success(c)
})

/** 人物替换：创建批次，按镜头串行生成后自动汇总（含原音轨）。 */
async function startCharacterSwapBatch(c: any, dramaId: number, project: ProjectRow, body: any) {
  const materials = await materialsOf(dramaId, 'character_swap')
  const materialError = validateMaterials('character_swap', materials)
  if (materialError) return badRequest(c, materialError)

  const [running] = await db.select().from(studioBatches).where(and(
    eq(studioBatches.dramaId, dramaId),
    inArray(studioBatches.status, ['processing', 'merging']),
  ))
  if (running) return badRequest(c, '当前项目已有生成中的批次，请等待完成')

  try {
    const configId = Number(body.config_id) || undefined
    const plan = await buildPlan(materials, configId)
    if (!plan.segments.length) return badRequest(c, '未能生成有效的镜头分段')

    const ratio = project.aspectRatio && project.aspectRatio !== 'adaptive' ? project.aspectRatio : null
    const prompt = String(body.prompt || '').trim() || MODE_DEFAULT_PROMPTS.character_swap
    const ts = now()
    const result = await db.insert(studioBatches).values({
      dramaId,
      mode: 'character_swap',
      sourcePath: plan.source.localPath,
      sourceDuration: plan.meta.duration,
      width: plan.meta.width,
      height: plan.meta.height,
      fps: plan.meta.fps,
      hasAudio: plan.meta.hasAudio,
      provider: plan.config?.provider || null,
      configId: configId ?? null,
      prompt,
      aspectRatio: ratio,
      status: 'processing',
      createdAt: ts,
      updatedAt: ts,
    })
    const batchId = getInsertId(result)

    for (const segment of plan.segments) {
      await db.insert(studioSegments).values({
        batchId,
        dramaId,
        segmentIndex: segment.index,
        startSec: segment.start,
        endSec: segment.end,
        targetDuration: segment.duration,
        requestDuration: segment.requestDuration,
        status: 'pending',
        createdAt: ts,
        updatedAt: ts,
      })
    }

    void runBatch(batchId)
    return created(c, {
      batch_id: batchId,
      segment_count: plan.segments.length,
      source_duration: plan.meta.duration,
      estimated_tasks: plan.segments.length,
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '分段计划创建失败')
  }
}

// 发起生成：转场走单次生成，人物替换走分段批次
app.post('/projects/:id/generate', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  const body = await c.req.json()

  const materials = await materialsOf(id, checked.mode)
  const materialError = validateMaterials(checked.mode, materials)
  if (materialError) return badRequest(c, materialError)

  if (checked.mode === 'character_swap') {
    return startCharacterSwapBatch(c, id, checked.project, body)
  }

  const duration = Number(body.duration ?? 5)
  if (!Number.isFinite(duration) || duration < 1 || duration > 30) {
    return badRequest(c, '视频时长须在 1~30 秒之间')
  }
  // 桌面端单用户场景，避免连点重复提交造成多次计费
  const [running] = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'video'),
    eq(schema.sysTask.dramaId, id),
    eq(schema.sysTask.status, 'processing'),
  ))
  if (running) return badRequest(c, '当前项目已有生成中的任务，请等待完成')

  const ratio = checked.project.aspectRatio && checked.project.aspectRatio !== 'adaptive'
    ? checked.project.aspectRatio : undefined
  const request = assembleVideoRequest(checked.mode, materials, {
    prompt: body.prompt,
    duration,
    aspectRatio: ratio,
    configId: body.config_id ? Number(body.config_id) : undefined,
  })

  try {
    const taskId = await generateVideo({ dramaId: id, ...request })
    return created(c, { task_id: taskId })
  } catch (error: any) {
    return badRequest(c, error?.message || '生成任务创建失败')
  }
})

// 批次列表（含各镜头段状态），前端据此展示分段进度与汇总成片
app.get('/projects/:id/batches', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  const rows = await db.select().from(studioBatches)
    .where(eq(studioBatches.dramaId, id))
    .orderBy(desc(studioBatches.id))
    .limit(20)
  const items = await Promise.all(rows.map(async batch => {
    const segments = await db.select().from(studioSegments)
      .where(eq(studioSegments.batchId, batch.id))
      .orderBy(studioSegments.segmentIndex)
    return { ...toSnakeCase(batch), segments: toSnakeCaseArray(segments) }
  }))
  return success(c, items)
})

// 单段任务列表：转场成片与人物替换的各镜头任务都在这里
app.get('/projects/:id/generations', async c => {
  const id = Number(c.req.param('id'))
  const checked = await requireProject(id)
  if ('error' in checked) return reject(c, checked)
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'video'),
    eq(schema.sysTask.dramaId, id),
  )).orderBy(desc(schema.sysTask.id))
  return success(c, rows.map(mapGeneration))
})

export default app
