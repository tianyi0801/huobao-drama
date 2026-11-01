/**
 * 素材暂存 — 把 fire宝 的参考素材搬进 ComfyUI 的 input 目录
 *
 * 云端厂商接受「公网 URL / data URL」，本地 ComfyUI 只认 input 目录里的文件名，
 * 所以每次生成前必须先把素材上传上去，再把相对路径写进工作流字段。
 *
 * 支持三种来源：
 *   data:image/...;base64,...   参考图压缩后的内联数据（generation.ts 产出）
 *   http(s)://...               远程素材
 *   static/... 或绝对路径        本地生成物 / 上传物
 *
 * 文件名按内容 sha256 命名并 overwrite，重复任务不会堆积垃圾文件。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getAbsolutePath } from '../../utils/storage.js'
import type { ComfyClient } from './client.js'

export type MediaType = 'image' | 'video' | 'audio'

export interface StagedMedia {
  mediaType: MediaType
  /** ComfyUI input 内的文件名 */
  filename: string
  subfolder: string
  /** ComfyUI 侧相对路径 subfolder/filename */
  path: string
  /** H3 媒体清单条目 */
  manifest: {
    id: string
    media_type: MediaType
    filename: string
    subfolder: string
    storage_type: string
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
}

const DEFAULT_EXT: Record<MediaType, string> = { image: '.png', video: '.mp4', audio: '.wav' }
const MAX_BYTES = 200 * 1024 * 1024

function extFromName(name: string): string {
  const ext = path.extname(name || '').toLowerCase()
  return ext && ext.length <= 8 ? ext : ''
}

function parseDataUrl(source: string): { data: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source)
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = match[2] === ';base64'
  const payload = match[3]
  const data = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { data, mimeType }
}

async function loadMedia(source: string, mediaType: MediaType): Promise<{ data: Buffer; name: string; mimeType: string }> {
  const raw = String(source || '').trim()
  if (!raw) throw new Error('素材来源为空')

  // 1) data URL
  const inline = raw.startsWith('data:') ? parseDataUrl(raw) : null
  if (inline) {
    const ext = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === inline.mimeType)?.[0] || DEFAULT_EXT[mediaType]
    return { data: inline.data, name: `inline${ext}`, mimeType: inline.mimeType }
  }

  // 2) 远程 URL
  if (/^https?:\/\//i.test(raw)) {
    const resp = await fetch(raw, { signal: AbortSignal.timeout(120_000) })
    if (!resp.ok) throw new Error(`下载素材失败（${resp.status}）：${raw.slice(0, 120)}`)
    const buffer = Buffer.from(await resp.arrayBuffer())
    const urlPath = (() => { try { return new URL(raw).pathname } catch { return '' } })()
    const name = path.basename(urlPath) || `remote${DEFAULT_EXT[mediaType]}`
    const mimeType = resp.headers.get('content-type')?.split(';')[0]
      || MIME_BY_EXT[extFromName(name)]
      || 'application/octet-stream'
    return { data: buffer, name, mimeType }
  }

  // 3) 本地文件（static/ 相对路径或绝对路径）
  const localPath = path.isAbsolute(raw) ? raw : getAbsolutePath(raw.replace(/^\/+/, ''))
  const data = await fs.readFile(localPath).catch((error: any) => {
    throw new Error(`读取本地素材失败（${localPath}）：${error?.code === 'ENOENT' ? '文件不存在' : error?.message || error}`)
  })
  if (data.length > MAX_BYTES) throw new Error(`素材超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限：${path.basename(localPath)}`)
  const name = path.basename(localPath)
  return {
    data,
    name,
    mimeType: MIME_BY_EXT[extFromName(name)] || 'application/octet-stream',
  }
}

/** 上传单个素材；失败直接抛错（素材缺失时的静默降级比报错更危险） */
export async function stageMedia(
  client: ComfyClient,
  source: string,
  mediaType: MediaType,
  subfolder: string,
): Promise<StagedMedia> {
  const { data, name, mimeType } = await loadMedia(source, mediaType)
  if (data.length > MAX_BYTES) throw new Error(`素材超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限`)

  const ext = extFromName(name) || DEFAULT_EXT[mediaType]
  // 内容寻址命名：同内容重复上传只会覆盖同一个文件
  const filename = `${createHash('sha256').update(data).digest('hex').slice(0, 20)}${ext}`
  const uploaded = await client.upload(filename, data, subfolder, mimeType)
  const relative = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name

  return {
    mediaType,
    filename: uploaded.name,
    subfolder: uploaded.subfolder,
    path: relative,
    manifest: {
      id: createHash('sha256').update(`${relative}`).digest('hex').slice(0, 32),
      media_type: mediaType,
      filename: uploaded.name,
      subfolder: uploaded.subfolder,
      storage_type: uploaded.type || 'input',
    },
  }
}

/** 批量上传；空数组直接返回空（调用方按业务判断是否必需） */
export async function stageMany(
  client: ComfyClient,
  sources: string[] | null | undefined,
  mediaType: MediaType,
  subfolder: string,
): Promise<StagedMedia[]> {
  const list = Array.from(new Set((sources || []).map(s => String(s || '').trim()).filter(Boolean)))
  const staged: StagedMedia[] = []
  for (const source of list) {
    staged.push(await stageMedia(client, source, mediaType, subfolder))
  }
  return staged
}

/** 任务级子目录，避免不同任务互相污染；同任务重试复用同一目录 */
export function taskSubfolder(base: string, taskId: number | string, kind: string): string {
  const prefix = String(base || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'huobao'
  return `${prefix}/${kind}-${taskId}`
}
