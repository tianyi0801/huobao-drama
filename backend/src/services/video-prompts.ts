/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { assertAgentSaved } from '../agents/execution.js'
import { getComfyConfig } from './comfyui/config.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    : sbs.filter(sb => !(sb.videoPrompt || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  const videoLabel = `本地 ComfyUI · ${getComfyConfig().video?.name || 'H3 六节视频工作流'}`

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    for (const sb of pending) {
      const requestContext = buildAgentRequestContext({
        episodeId, dramaId, targetStoryboardId: sb.id, modelOverride: opts.model || undefined, textConfigId: opts.configId || undefined,
      })
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        const result = await agent.generate([{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
先调用 read_storyboard_context 获取该分镜的 description、atmosphere、duration 和绑定素材，按 MiniMax 官方 Ref2VA 六节结构（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）生成，六节正文用英文、对白放在 <d>[Chinese] 原句</d> 中。summary 用官方任务类型前缀，retention_analysis 用官方关系标记，detailed_description 的 [Shot 1] 不带时间戳，后续镜头用 At MM:SS.mmm。description 的【镜头N】是镜头数唯一来源：有几个镜头就写几个 [Shot N]，不得合并、不得新增；只有 description 本身单镜头时才写单个 Shot。主角、配角均有独立身份和清晰脸部，明确每人位置与动作。原句对白只在对应 Shot 写一次，不新增配音或配乐，无配乐写 N/A。读取 target_storyboard.available_image_references 并直接复制 image_reference（@角色名/@场景名/@道具名）引用实际素材，不手写图片编号。调用 update_storyboard 保存到分镜 ID:${sb.id}，参数只传 storyboard_id 和 video_prompt；不改描述、时长、绑定，不重新拆分整集。`,
        }], { maxSteps: 8, requestContext })
        assertAgentSaved('prompt_generator', result, requestContext)
        // 以本次保存回执与实际落库为准，旧值非空不代表本次成功
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        if ((fresh?.videoPrompt || '').trim()) task.completed++
        else {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but video_prompt is empty' })
        }
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
