import fs from 'node:fs'
import path from 'node:path'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { now } from '../utils/response.js'

export class MergeDeleteError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) {
    super(message)
  }
}

function fileInfo(filePath: string) {
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MergeDeleteError('成品路径不是普通文件，无法安全删除', 400)
    }
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 仅解析拼接输出目录中的单个 MP4，不接受外部地址、目录或路径穿越。 */
function mergeFiles(url: string) {
  const match = /^(?:\/?static\/)?merged\/([\w-]+\.mp4)$/.exec(url)
  if (!match) throw new MergeDeleteError('成品不在本地拼接目录，无法安全删除', 400)
  const filename = match[1]
  const directory = path.resolve(STORAGE_ROOT, 'merged')
  try {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MergeDeleteError('拼接目录不是本地普通目录，无法安全删除', 400)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const video = path.join(directory, filename)
  const poster = path.join(directory, filename.replace(/\.mp4$/, '_poster.jpg'))
  return {
    video,
    poster,
    aliases: [`static/merged/${filename}`, `/static/merged/${filename}`, `merged/${filename}`, video],
  }
}

/** 文件清理成功后软删除记录；同步事务避免删除与拼接完成交错写入。 */
export function deleteEpisodeMerge(episodeId: number, mergeId: number) {
  return db.transaction((tx) => {
    const row = tx.select().from(schema.videoMerges)
      .where(and(eq(schema.videoMerges.id, mergeId), eq(schema.videoMerges.episodeId, episodeId))).get()
    if (!row) throw new MergeDeleteError('导出记录不存在', 404)
    if (row.deletedAt) return { id: mergeId, freedBytes: 0 }
    if (row.status !== 'completed' && row.status !== 'failed') {
      throw new MergeDeleteError('拼接任务尚未结束，请完成后再删除', 409)
    }

    let freedBytes = 0
    if (row.mergedUrl) {
      const files = mergeFiles(row.mergedUrl)
      const sharedMerge = tx.select().from(schema.videoMerges)
        .where(and(ne(schema.videoMerges.id, mergeId), isNull(schema.videoMerges.deletedAt), inArray(schema.videoMerges.mergedUrl, files.aliases))).get()
      const sharedShot = tx.select({ id: schema.storyboards.id }).from(schema.storyboards)
        .where(or(inArray(schema.storyboards.videoUrl, files.aliases), inArray(schema.storyboards.composedVideoUrl, files.aliases))).get()
      const sharedEpisode = tx.select({ id: schema.episodes.id }).from(schema.episodes)
        .where(and(ne(schema.episodes.id, episodeId), inArray(schema.episodes.videoUrl, files.aliases))).get()
      const usedAsInput = tx.select({ scenes: schema.videoMerges.scenes }).from(schema.videoMerges)
        .where(isNull(schema.videoMerges.deletedAt)).all().some((merge) => {
          try {
            const inputs = JSON.parse(merge.scenes || '[]')
            return Array.isArray(inputs) && inputs.some(input => files.aliases.includes(input))
          } catch { return false }
        })
      if (sharedMerge || sharedShot || sharedEpisode || usedAsInput) {
        throw new MergeDeleteError('该成品仍被其他导出或镜头引用，请解除引用后再删除', 409)
      }

      // 先检查全部路径，文件缺失视为已清理；其他错误保留记录供重试。
      const existing = [files.poster, files.video].map(file => ({ file, stat: fileInfo(file) }))
      for (const { file, stat } of existing) {
        if (!stat) continue
        try {
          fs.unlinkSync(file)
          freedBytes += stat.size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      tx.update(schema.episodes).set({ videoUrl: null, updatedAt: now() })
        .where(and(eq(schema.episodes.id, episodeId), inArray(schema.episodes.videoUrl, files.aliases))).run()
    }
    tx.update(schema.videoMerges).set({ deletedAt: now() })
      .where(and(eq(schema.videoMerges.id, mergeId), isNull(schema.videoMerges.deletedAt))).run()
    return { id: mergeId, freedBytes }
  })
}
