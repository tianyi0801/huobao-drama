/**
 * 人物替换批次编排：按镜头串行生成，全部完成后规整、拼接并合成原音轨。
 *
 * 独立于短剧的 storyboard-continuity / ffmpeg-merge 链路（那两者绑定分镜与剧集表）。
 * 每段仍复用统一 generateVideo + sys_task 生命周期，不改动老生成服务。
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { studioBatches, studioMaterials, studioSegments } from '../db/studio-schema.js'
import { generateVideo } from './generation.js'
import {
  concatAndMux, cutSourceClip, mergedPath, normalizeGeneratedClip,
  segmentClipPath, segmentNormPath, type VideoMeta,
} from './studio-segments.js'
import { now } from '../utils/response.js'

const POLL_INTERVAL_MS = 3000
const MAX_SEGMENT_WAIT_MS = 40 * 60 * 1000

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

interface TaskOutcome { status: string; localPath: string | null; errorMsg: string | null }

async function waitForTask(taskId: number): Promise<TaskOutcome> {
  const deadline = Date.now() + MAX_SEGMENT_WAIT_MS
  while (Date.now() < deadline) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) throw new Error('生成任务记录丢失')
    if (task.status === 'completed') return { status: 'completed', localPath: task.localPath, errorMsg: null }
    if (task.status === 'failed') return { status: 'failed', localPath: null, errorMsg: task.errorMsg }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('生成任务超时，请到任务诊断中检查上游状态')
}

/**
 * 执行批次；已完成的段会跳过，因此服务重启后可安全重跑。
 * 任一段失败即标记批次失败并停止后续段，避免继续计费。
 */
export async function runBatch(batchId: number): Promise<void> {
  const [batch] = await db.select().from(studioBatches).where(eq(studioBatches.id, batchId))
  if (!batch) return

  try {
    const segments = await db.select().from(studioSegments)
      .where(eq(studioSegments.batchId, batchId))
      .orderBy(studioSegments.segmentIndex)
    const portraits = await db.select().from(studioMaterials)
      .where(and(eq(studioMaterials.dramaId, batch.dramaId), eq(studioMaterials.role, 'reference_image')))
    const portraitPaths = portraits.map(p => p.localPath).filter(Boolean)
    const meta: VideoMeta = {
      duration: batch.sourceDuration,
      width: batch.width || 1280,
      height: batch.height || 720,
      fps: batch.fps || 24,
      hasAudio: Boolean(batch.hasAudio),
    }
    const completed: Array<{ index: number; resultPath: string; targetDuration: number }> = []

    for (const seg of segments) {
      // 重启恢复：已完成且有产物的段不重复生成
      if (seg.status === 'completed' && seg.resultPath) {
        completed.push({ index: seg.segmentIndex, resultPath: seg.resultPath, targetDuration: seg.targetDuration })
        continue
      }
      await db.update(studioSegments)
        .set({ status: 'processing', errorMsg: null, updatedAt: now() })
        .where(eq(studioSegments.id, seg.id))
      try {
        // 每段只把「对应时间片的源视频切片」作为参考，而不是整段源视频
        const clipPath = segmentClipPath(batchId, seg.segmentIndex)
        await cutSourceClip(batch.sourcePath, seg.startSec, seg.endSec, clipPath)
        await db.update(studioSegments).set({ clipPath, updatedAt: now() })
          .where(eq(studioSegments.id, seg.id))

        const prompt = [
          batch.prompt,
          `本段对应源视频 ${seg.startSec.toFixed(1)}s—${seg.endSec.toFixed(1)}s 的镜头，请保持该镜头的动作、镜头运动与节奏。`,
        ].filter(Boolean).join('\n')

        const taskId = await generateVideo({
          dramaId: batch.dramaId,
          prompt,
          referenceVideoUrls: [clipPath],
          referenceImageUrls: portraitPaths,
          duration: seg.requestDuration,
          aspectRatio: batch.aspectRatio || undefined,
          configId: batch.configId || undefined,
        })
        await db.update(studioSegments).set({ taskId, updatedAt: now() })
          .where(eq(studioSegments.id, seg.id))

        const outcome = await waitForTask(taskId)
        if (outcome.status !== 'completed' || !outcome.localPath) {
          throw new Error(outcome.errorMsg || '该镜头生成失败')
        }
        await db.update(studioSegments).set({
          status: 'completed', resultPath: outcome.localPath, errorMsg: null, updatedAt: now(),
        }).where(eq(studioSegments.id, seg.id))
        completed.push({
          index: seg.segmentIndex,
          resultPath: outcome.localPath,
          targetDuration: seg.targetDuration,
        })
      } catch (error: any) {
        await db.update(studioSegments).set({
          status: 'failed', errorMsg: String(error?.message || error), updatedAt: now(),
        }).where(eq(studioSegments.id, seg.id))
        throw error
      }
    }

    // 所有镜头出片后统一规整，保证总时长与源视频一致
    await db.update(studioBatches).set({ status: 'merging', updatedAt: now() })
      .where(eq(studioBatches.id, batchId))
    const normalized: string[] = []
    for (const item of completed.sort((a, b) => a.index - b.index)) {
      const normPath = segmentNormPath(batchId, item.index)
      await normalizeGeneratedClip(item.resultPath, item.targetDuration, meta, normPath)
      normalized.push(normPath)
    }
    const output = mergedPath()
    await concatAndMux(normalized, batch.sourcePath, meta, output)
    await db.update(studioBatches).set({
      status: 'completed', mergedUrl: output, mergedDuration: meta.duration,
      errorMsg: null, updatedAt: now(), completedAt: now(),
    }).where(eq(studioBatches.id, batchId))
  } catch (error: any) {
    await db.update(studioBatches).set({
      status: 'failed', errorMsg: String(error?.message || error), updatedAt: now(),
    }).where(eq(studioBatches.id, batchId))
    console.error(`[studio-batch] 批次 ${batchId} 失败：${error?.message || error}`)
  }
}

/** 服务重启后恢复未完成批次：重置未完成的段，重跑编排（已完成段不重复计费）。 */
export async function resumeStudioBatches(): Promise<void> {
  const batches = await db.select().from(studioBatches)
    .where(inArray(studioBatches.status, ['processing', 'merging']))
  for (const batch of batches) {
    await db.update(studioSegments)
      .set({ status: 'pending', taskId: null, errorMsg: null, updatedAt: now() })
      .where(and(eq(studioSegments.batchId, batch.id), ne(studioSegments.status, 'completed')))
    void runBatch(batch.id)
  }
  if (batches.length) console.log(`[studio-batch] 已恢复 ${batches.length} 个未完成批次`)
}
