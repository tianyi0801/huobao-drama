/**
 * 视频尾帧提取 — 用于镜头衔接（下一段参考上一段结束时的画面）
 *
 * 与 video-poster.ts 的区别：海报帧取 0.5s（片头），这里取片尾最后一帧，
 * 作为「上一镜头结束状态」的视觉锚点。
 */
import path from 'path'
import { getAbsolutePath } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** static/videos/x.mp4 → static/videos/x_lastframe.jpg */
export function lastFramePathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_lastframe.jpg')
}

/**
 * 抽取视频最后一帧（存在则直接复用）。
 * 失败返回 null，不阻断生成流程。
 */
export async function extractVideoLastFrame(relativePath: string): Promise<string | null> {
  const outRel = lastFramePathFor(relativePath)
  const outAbs = getAbsolutePath(outRel)

  try {
    const { default: fs } = await import('node:fs/promises')
    // 已抽过且文件非空即复用，避免同一段反复解码
    const stat = await fs.stat(outAbs).catch(() => null)
    if (stat && stat.size > 1024) return outRel

    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const src = getAbsolutePath(relativePath)
    const meta = await new Promise<any>((resolve, reject) => {
      ffmpeg.ffprobe(src, (error, data) => (error ? reject(error) : resolve(data)))
    })
    const duration = Number(meta?.format?.duration || 0)
    if (!Number.isFinite(duration) || duration <= 0) return null

    // 输出端 seek 才能精确到指定时间点（输入端 seek 只到最近关键帧）
    const seek = Math.max(0, duration - 0.15)
    await fs.mkdir(path.dirname(outAbs), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src)
        .outputOptions([`-ss ${seek.toFixed(3)}`, '-frames:v 1', '-q:v 2'])
        .on('end', () => resolve())
        .on('error', reject)
        .save(outAbs)
    })

    const written = await fs.stat(outAbs).catch(() => null)
    if (!written || written.size < 1024) return null
    return outRel
  } catch (error: any) {
    console.warn(`[video-lastframe] 尾帧提取失败 ${relativePath}: ${error?.message || error}`)
    return null
  }
}
