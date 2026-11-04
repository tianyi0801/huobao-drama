/**
 * 工作台分段媒体处理：探测、场景切镜、切片、时长规整、拼接与原音轨合成。
 *
 * 纯文件/命令层，不依赖数据库，也不引用剧集/分镜表。
 * 设计目标：让「按镜头分段生成」的成片总时长与源视频一致，并保留原音轨。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { v4 as uuid } from 'uuid'
import { ffmpegBin, ffprobeBin, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'

const execFileAsync = promisify(execFile)
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 }

/** 场景切镜阈值：越高切点越少，0.35 对多数实拍素材较稳 */
export const SCENE_THRESHOLD = 0.35

export interface VideoMeta {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

export interface DurationLimits { min: number; max: number }

export interface PlannedSegment {
  index: number
  start: number
  end: number
  duration: number
  /** 实际提交给模型的整数秒（受模型上下限约束） */
  requestDuration: number
}

/** 各视频服务的单段时长约束；取保守上限，避免长镜头二次切分后动作还原变差。 */
export function limitsForProvider(provider?: string | null): DurationLimits {
  switch (String(provider || '').toLowerCase()) {
    case 'aliyun': return { min: 2, max: 15 }
    case 'minimax': return { min: 4, max: 15 }
    case 'volcengine': return { min: 4, max: 15 }
    case 'comfyui': return { min: 2, max: 10 }
    default: return { min: 4, max: 10 }
  }
}

async function assertSuite() {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe || !ffmpegBin || !ffprobeBin) {
    throw new Error('本机 ffmpeg/ffprobe 不可用，无法按镜头切分视频。请安装 ffmpeg 或设置 FFMPEG_BIN / FFPROBE_BIN 后重启服务')
  }
}

/** 探测源视频时长、分辨率、帧率与音轨，秒为单位的浮点值。 */
export async function probeVideo(relativePath: string): Promise<VideoMeta> {
  await assertSuite()
  const abs = getAbsolutePath(relativePath)
  if (!fs.existsSync(abs)) throw new Error('源视频文件不存在或已被清理，请重新上传')

  const { stdout } = await execFileAsync(ffprobeBin!, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate',
    '-of', 'json', abs,
  ], EXEC_OPTIONS)

  let data: any
  try { data = JSON.parse(String(stdout)) } catch { throw new Error('无法解析源视频元数据') }
  const duration = Number(data?.format?.duration || 0)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取源视频时长')

  const streams: any[] = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find(s => s.codec_type === 'video')
  const [num, den] = String(video?.r_frame_rate || '24/1').split('/').map(Number)
  const rawFps = den > 0 ? num / den : 24

  return {
    duration,
    width: Number(video?.width) || 1280,
    height: Number(video?.height) || 720,
    fps: Math.min(30, Math.max(12, Math.round(rawFps) || 24)),
    hasAudio: streams.some(s => s.codec_type === 'audio'),
  }
}

/**
 * ffmpeg 场景检测：select 过滤出切点帧，showinfo 把 pts_time 打到 stderr。
 * 解析失败时返回空数组，调用方退化为「整段单镜头」，不阻断生成。
 */
export async function detectSceneCuts(
  relativePath: string,
  duration: number,
  threshold = SCENE_THRESHOLD,
): Promise<number[]> {
  await assertSuite()
  const abs = getAbsolutePath(relativePath)
  const filter = `select='gt(scene,${threshold})',showinfo`

  let stderr = ''
  try {
    const result = await execFileAsync(ffmpegBin!, [
      '-hide_banner', '-i', abs, '-vf', filter, '-an', '-f', 'null', '-',
    ], EXEC_OPTIONS)
    stderr = String(result.stderr || '')
  } catch (error: any) {
    stderr = String(error?.stderr || '')
    if (!stderr) {
      console.warn(`[studio-segments] 场景检测失败，退化为单段：${error?.message || error}`)
      return []
    }
  }

  const cuts = new Set<number>()
  const re = /pts_time:([0-9]+\.?[0-9]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(stderr))) {
    const t = Number(match[1])
    // 过滤贴着片头片尾的伪切点，避免切出极短片段
    if (Number.isFinite(t) && t > 0.3 && t < duration - 0.3) {
      cuts.add(Math.round(t * 1000) / 1000)
    }
  }
  return [...cuts].sort((a, b) => a - b)
}

/**
 * 把镜头切点转成可生成的分段计划：
 * 1) 过短镜头并入相邻镜头（部分模型最短 4s，生成 4s 会拉长画面导致时长对不上）；
 * 2) 超过模型单段上限的镜头按上限均分二次切分；
 * 3) requestDuration 取整并收敛到模型上下限，targetDuration 保留精确值用于事后规整。
 */
export function buildSegmentPlan(meta: VideoMeta, cuts: number[], limits: DurationLimits): PlannedSegment[] {
  const total = meta.duration
  const boundaries = [0, ...cuts.filter(c => c > 0.3 && c < total - 0.3), total].sort((a, b) => a - b)

  let ranges: Array<{ start: number; end: number }> = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]
    const end = boundaries[i + 1]
    if (end - start > 0.05) ranges.push({ start, end })
  }
  if (!ranges.length) ranges = [{ start: 0, end: total }]

  // 源视频本身短于模型下限时不做合并，否则会把整段吞成一段
  if (total > limits.min) {
    const merged: typeof ranges = []
    for (const range of ranges) {
      const last = merged[merged.length - 1]
      if (last && last.end - last.start < limits.min) last.end = range.end
      else merged.push({ ...range })
    }
    if (merged.length > 1) {
      const last = merged[merged.length - 1]
      if (last.end - last.start < limits.min) {
        merged[merged.length - 2].end = last.end
        merged.pop()
      }
    }
    ranges = merged
  }

  const finalRanges: typeof ranges = []
  for (const range of ranges) {
    const duration = range.end - range.start
    if (duration <= limits.max + 0.001) {
      finalRanges.push(range)
      continue
    }
    const parts = Math.ceil(duration / limits.max)
    const step = duration / parts
    for (let k = 0; k < parts; k++) {
      finalRanges.push({ start: range.start + k * step, end: range.start + (k + 1) * step })
    }
  }

  return finalRanges.map((range, index) => {
    const duration = range.end - range.start
    return {
      index,
      start: Math.round(range.start * 1000) / 1000,
      end: Math.round(range.end * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
      requestDuration: Math.min(limits.max, Math.max(limits.min, Math.round(duration))),
    }
  })
}

/** 源视频按时间段切出该镜头的参考切片（去掉音轨，减少上传体积）。 */
export async function cutSourceClip(
  sourceRel: string, start: number, end: number, outRel: string,
): Promise<void> {
  await assertSuite()
  const src = getAbsolutePath(sourceRel)
  const out = getAbsolutePath(outRel)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const duration = Math.max(0.1, end - start)
  await execFileAsync(ffmpegBin!, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', start.toFixed(3), '-i', src, '-t', duration.toFixed(3),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ], EXEC_OPTIONS)
}

/**
 * 把模型产物规整到该段的精确目标时长与统一画幅/帧率。
 * 上游不保证按请求秒数出片，短片用 tpad 克隆末帧补齐，长片用 -t 截断，
 * 否则拼接后总时长无法与源视频对齐。
 */
export async function normalizeGeneratedClip(
  inputRel: string, targetDuration: number, meta: VideoMeta, outRel: string,
): Promise<void> {
  await assertSuite()
  const src = getAbsolutePath(inputRel)
  const out = getAbsolutePath(outRel)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const width = Math.ceil((meta.width || 1280) / 2) * 2
  const height = Math.ceil((meta.height || 720) / 2) * 2
  const fps = meta.fps || 24
  const filter = [
    `fps=${fps}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `tpad=stop_mode=clone:stop_duration=${(targetDuration + 2).toFixed(3)}`,
  ].join(',')

  await execFileAsync(ffmpegBin!, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-vf', filter, '-t', targetDuration.toFixed(3),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', out,
  ], EXEC_OPTIONS)
}

/** 拼接所有规整后的段，并把源视频原音轨合成回成片。 */
export async function concatAndMux(
  clipRels: string[], sourceRel: string, meta: VideoMeta, outRel: string,
): Promise<void> {
  await assertSuite()
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)
  fs.writeFileSync(listPath, clipRels.map(p => `file '${getAbsolutePath(p)}'`).join('\n'), 'utf-8')

  const silentRel = `static/merged/${uuid()}-silent.mp4`
  const silentAbs = getAbsolutePath(silentRel)
  const out = getAbsolutePath(outRel)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  try {
    // 各段已统一编码参数，concat 可直接流拷贝
    await execFileAsync(ffmpegBin!, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', silentAbs,
    ], EXEC_OPTIONS)

    // 1:a:0? 让无音轨的源视频也能正常合成；-t 保证成片长度等于源视频
    await execFileAsync(ffmpegBin!, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', silentAbs, '-i', getAbsolutePath(sourceRel),
      '-map', '0:v:0', '-map', '1:a:0?',
      '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k',
      '-t', meta.duration.toFixed(3), '-movflags', '+faststart', out,
    ], EXEC_OPTIONS)
  } finally {
    fs.rmSync(listPath, { force: true })
    fs.rmSync(silentAbs, { force: true })
  }
}

export function segmentClipPath(batchId: number, index: number): string {
  return `static/segments/batch-${batchId}-${index}-src.mp4`
}

export function segmentNormPath(batchId: number, index: number): string {
  return `static/segments/batch-${batchId}-${index}-norm.mp4`
}

export function mergedPath(): string {
  return `static/merged/${uuid()}.mp4`
}
