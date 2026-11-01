/**
 * 图片尺寸推导 — 由「项目画面比例 + 集清晰度档」共同决定
 *
 * 之前各路由把尺寸硬编码成 1920x1080：竖屏项目会出横图，
 * 且 2MP 的采样耗时是 1MP 的两倍。
 *
 * 现在统一规则：
 *   aspect_ratio（dramas） × episodes.resolution（480p/720p/1080p）
 *   → 约 0.5 / 1 / 2 MP 的合规尺寸，对齐 8 的倍数（EmptyLatentImage 潜空间对齐）
 *
 * 视频侧直接使用 resolution 本身，本模块只解决图片的宽高。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 清晰度档 → 像素预算 */
export const RESOLUTION_PIXEL_BUDGET: Record<string, number> = {
  '480p': 512 * 1024,   // 0.5 MP
  '720p': 1024 * 1024,  // 1 MP
  '1080p': 2048 * 1024, // 2 MP
}

export const DEFAULT_RESOLUTION = '720p'

/** 对齐到 8 的倍数，最小 64（与 ComfyUI 的 EmptyLatentImage 对齐要求一致） */
function align8(value: number): number {
  return Math.max(64, Math.round(value / 8) * 8)
}

/** "16:9" / "9:16" / "16x9" → 比例分数；非法回退 16:9 */
export function parseAspectRatio(raw: string | null | undefined): { width: number; height: number } {
  const match = /^(\d{1,2})\s*[:：/x×]\s*(\d{1,2})$/i.exec(String(raw || '').trim())
  if (!match) return { width: 16, height: 9 }
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : { width: 16, height: 9 }
}

/**
 * 按比例与清晰度档算出图片尺寸
 * 16:9 + 720p → 1368x768；9:16 + 720p → 768x1368；1:1 + 720p → 1024x1024
 */
export function computeImageSize(
  aspectRatio: string | null | undefined,
  resolution: string | null | undefined,
): string {
  const budget = RESOLUTION_PIXEL_BUDGET[String(resolution || DEFAULT_RESOLUTION).toLowerCase()]
    ?? RESOLUTION_PIXEL_BUDGET[DEFAULT_RESOLUTION]
  const ratio = parseAspectRatio(aspectRatio)
  const aspect = ratio.width / ratio.height

  // 由预算反推宽高：width * height = budget 且 width / height = aspect
  const width = Math.sqrt(budget * aspect)
  const height = width / aspect
  return `${align8(width)}x${align8(height)}`
}

/**
 * 查项目配置后算出本集的图片尺寸。
 * dramaId 缺失或项目不存在时按 16:9 + 当前清晰度兜底。
 */
export async function resolveDramaImageSize(
  dramaId: number | null | undefined,
  resolution: string | null | undefined,
): Promise<string> {
  if (!dramaId) return computeImageSize('16:9', resolution)
  const [drama] = await db.select({ aspectRatio: schema.dramas.aspectRatio })
    .from(schema.dramas)
    .where(eq(schema.dramas.id, dramaId))
  return computeImageSize(drama?.aspectRatio, resolution)
}
