/**
 * 镜头衔接 — 让同一场景里紧邻的分镜共享视觉锚点
 *
 * 问题背景：分镜是逐段独立生成的，模型每次都自由决定机位与空间朝向，
 * 于是「第一段窗户在身后、第二段变成侧面」这种跳变会反复出现。
 *
 * 做法：本段生成前，取**同一场景内紧邻的上一条已出片分镜**的尾帧，
 * 作为额外参考图追加到素材清单末尾，并在提示词里显式声明它的语义。
 *
 * 只在同场景内衔接：跨场景本来就该换环境，把上一场带过来反而是错的。
 */
import { and, eq, isNotNull, lt, desc, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { extractVideoLastFrame } from '../utils/video-lastframe.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

/** 等待同场景前置分镜的上限：超时后放弃衔接直接生成，避免整条链卡死 */
const MAX_WAIT_MS = 60 * 60 * 1000
/** 前置任务的 updatedAt 超过这么久没变化，视为卡死，不再等待 */
const STALE_MS = 30 * 60 * 1000
const POLL_INTERVAL_MS = 3_000

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待同一场景里排在前面的分镜跑完。
 *
 * 为什么必须在后端等：视频批量提交时，若同时把 N 个任务交给 ComfyUI，
 * 提交图在提交那一刻就固定了，第 2 段拿不到第 1 段的尾帧，衔接就失效。
 * 放到后端逐段放行，无论前端是一次性批量还是手动逐个点，都能保证先后顺序，
 * 而且用户关掉页面也不影响。
 *
 * 返回 waitedMs 表示实际等待时长；timedOut 表示超时放弃（此时不衔接，照常生成）。
 */
export async function waitForScenePredecessor(
  currentTaskId: number,
  storyboardId: number | null | undefined,
): Promise<{ waitedMs: number; timedOut: boolean }> {
  if (!storyboardId) return { waitedMs: 0, timedOut: false }

  const [current] = await db.select({
    episodeId: schema.storyboards.episodeId,
    sceneId: schema.storyboards.sceneId,
    number: schema.storyboards.storyboardNumber,
  }).from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))

  if (!current?.episodeId || current.sceneId == null || current.number == null) {
    return { waitedMs: 0, timedOut: false }
  }

  const predecessors = await db.select({ id: schema.storyboards.id })
    .from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, current.episodeId),
      eq(schema.storyboards.sceneId, current.sceneId),
      lt(schema.storyboards.storyboardNumber, current.number),
    ))

  if (!predecessors.length) return { waitedMs: 0, timedOut: false }
  const ids = predecessors.map(row => row.id)

  const started = Date.now()
  let announced = false

  while (Date.now() - started < MAX_WAIT_MS) {
    const running = await db.select({
      id: schema.sysTask.id,
      updatedAt: schema.sysTask.updatedAt,
    }).from(schema.sysTask)
      .where(and(
        eq(schema.sysTask.type, 'video'),
        eq(schema.sysTask.status, 'processing'),
        inArray(schema.sysTask.storyboardId, ids),
      ))

    if (!running.length) return { waitedMs: Date.now() - started, timedOut: false }

    // 前置任务长时间没有推进，认为已卡死，不再拖住后面的镜头
    const stale = running.every(task => {
      const updated = Date.parse(String(task.updatedAt || ''))
      return Number.isFinite(updated) && Date.now() - updated > STALE_MS
    })
    if (stale) {
      logTaskWarn('Continuity', 'predecessor-stale', { currentTaskId, running: running.map(t => t.id) })
      return { waitedMs: Date.now() - started, timedOut: true }
    }

    if (!announced) {
      announced = true
      logTaskProgress('Continuity', 'waiting-predecessor', {
        currentTaskId,
        storyboardId,
        predecessors: ids,
        running: running.map(t => t.id),
      })
    }
    await sleep(POLL_INTERVAL_MS)
  }

  logTaskWarn('Continuity', 'wait-timeout', { currentTaskId, storyboardId })
  return { waitedMs: Date.now() - started, timedOut: true }
}

export interface PreviousShotFrame {
  /** 上一条分镜的 id */
  storyboardId: number
  /** 尾帧的相对路径（static/...） */
  framePath: string
}

/**
 * 解析「上一镜头的尾帧」。
 * 找不到同场景的已出片分镜、或抽帧失败时返回 null（调用方按普通流程生成）。
 */
export async function resolvePreviousShotFrame(
  storyboardId: number,
): Promise<PreviousShotFrame | null> {
  const [current] = await db.select({
    id: schema.storyboards.id,
    episodeId: schema.storyboards.episodeId,
    sceneId: schema.storyboards.sceneId,
    number: schema.storyboards.storyboardNumber,
  }).from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))

  if (!current?.episodeId) return null
  if (current.sceneId == null || current.number == null) return null

  // 同集 + 同场景 + 序号更小 + 已有视频，取序号最大的那条
  const [previous] = await db.select({
    id: schema.storyboards.id,
    videoUrl: schema.storyboards.videoUrl,
    number: schema.storyboards.storyboardNumber,
  }).from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, current.episodeId),
      eq(schema.storyboards.sceneId, current.sceneId),
      isNotNull(schema.storyboards.videoUrl),
      lt(schema.storyboards.storyboardNumber, current.number),
    ))
    .orderBy(desc(schema.storyboards.storyboardNumber))
    .limit(1)

  if (!previous?.videoUrl) return null
  // 只处理本地文件；远程 URL 需要先下载，暂不参与衔接
  if (!previous.videoUrl.startsWith('static/')) return null

  const framePath = await extractVideoLastFrame(previous.videoUrl)
  if (!framePath) {
    logTaskWarn('Continuity', 'lastframe-failed', { storyboardId, previousId: previous.id })
    return null
  }

  logTaskProgress('Continuity', 'linked', {
    storyboardId,
    previousId: previous.id,
    previousNumber: previous.number,
    framePath,
  })
  return { storyboardId: previous.id, framePath }
}

/**
 * 生成衔接提示词：把尾帧在素材清单里的序号说清楚，
 * 否则 reference_mention_mode=index 下模型不会主动去用它。
 */
export function buildContinuityPromptSuffix(imageIndex: number): string {
  return `\n@图片${imageIndex} 是上一镜头的结尾画面：延续它的空间布局、机位朝向、人物站位与光线方向，`
    + `本镜头在此基础上继续推进，不要更换场景朝向或重置构图。`
}
