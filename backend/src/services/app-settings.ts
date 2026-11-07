/**
 * 应用级全局设置（app_settings key-value 表）
 * AI 内容语言：所有 Agent 产出（剧本/提取/分镜/提示词）统一使用的目标语言
 * 层次约束：本模块只依赖 db，严禁反向 import agents/*（agents/context.ts 会引用本模块）
 *
 * 注意：刻意做成同步 API（better-sqlite3 驱动的 .get()/.run()），
 * 供 agents/context.ts 的同步 buildAgentRequestContext 内部直接调用
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export const CONTENT_LANGUAGES = ['zh', 'en', 'ja', 'ko'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]

const CONTENT_LANGUAGE_KEY = 'content_language'

function isContentLanguage(v: unknown): v is ContentLanguage {
  return typeof v === 'string' && (CONTENT_LANGUAGES as readonly string[]).includes(v)
}

/** 读取全局内容语言；未设置或值非法时回退 'zh'（保持历史默认行为） */
export function getContentLanguage(): ContentLanguage {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONTENT_LANGUAGE_KEY))
    .get()
  return isContentLanguage(row?.value) ? row.value : 'zh'
}

/** 写入全局内容语言（upsert） */
export function setContentLanguage(lang: ContentLanguage): ContentLanguage {
  if (!isContentLanguage(lang)) throw new Error(`Invalid content language: ${lang}`)
  db.insert(schema.appSettings)
    .values({ key: CONTENT_LANGUAGE_KEY, value: lang, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: lang, updatedAt: now() },
    })
    .run()
  return lang
}

const TOURS_SEEN_KEY = 'tours_seen'
const MAX_TOURS_SEEN = 64

function sanitizeTourIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter(v => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, MAX_TOURS_SEEN)
}

/** 已看过的引导漫游 id 列表（JSON 数组存储）；桌面端端口随启动变化，localStorage 不可靠，故落库 */
export function getToursSeen(): string[] {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, TOURS_SEEN_KEY))
    .get()
  try { return sanitizeTourIds(JSON.parse(row?.value || '[]')) } catch { return [] }
}

/** 写入已看过的引导漫游 id 列表（upsert） */
export function setToursSeen(ids: unknown): string[] {
  const clean = sanitizeTourIds(ids)
  const value = JSON.stringify(clean)
  db.insert(schema.appSettings)
    .values({ key: TOURS_SEEN_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}

// ─── 内置 workspace 模板同步通知 ───────────────────────────────────
// 升级时内置 prompt / skill 会覆盖用户目录（产品规则：以内置为准）。
// 覆盖前自动备份，结果落库供前端「纯告知」一次，避免用户不知情。

/** 一次内置模板同步的结果摘要 */
export interface WorkspaceSyncNotice {
  /** 本次同步的模板版本号；模板未声明版本时为 null */
  version: number | null
  /** 同步时间（ISO 字符串） */
  syncedAt: string
  /** 被新版覆盖的已有文件数 */
  overwritten: number
  /** 新增的内置文件数 */
  added: number
  /** 清理掉的废弃内置文件数 */
  removed: number
  /** 备份目录（相对 workspace 根，如 .backup/v6-20261102120000）；空串表示本次无需备份 */
  backupDir: string
  /** 部分同步失败，旧版本状态保留，下次启动重试 */
  incomplete?: boolean
}

const WORKSPACE_NOTICE_KEY = 'workspace_sync_notice'

/** 读取待展示的模板同步通知；无通知返回 null */
export function getWorkspaceSyncNotice(): WorkspaceSyncNotice | null {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, WORKSPACE_NOTICE_KEY))
    .get()
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? parsed as WorkspaceSyncNotice : null
  } catch {
    return null
  }
}

/** 写入或清除（传 null）模板同步通知 */
export function setWorkspaceSyncNotice(notice: WorkspaceSyncNotice | null): void {
  if (!notice) {
    db.delete(schema.appSettings).where(eq(schema.appSettings.key, WORKSPACE_NOTICE_KEY)).run()
    return
  }
  const value = JSON.stringify(notice)
  db.insert(schema.appSettings)
    .values({ key: WORKSPACE_NOTICE_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
}

const THINKING_MODE_KEY = 'model_thinking_mode'

/**
 * 是否让文本模型使用思考模式（默认关闭）。
 * 开启后不再注入关思考参数，Agent 改为流式返回，界面可实时看到思考与输出。
 */
export function getThinkingMode(): boolean {
  try {
    const row = db.select().from(schema.appSettings)
      .where(eq(schema.appSettings.key, THINKING_MODE_KEY))
      .get()
    return row?.value === 'true'
  } catch {
    return false
  }
}

export function setThinkingMode(enabled: boolean): boolean {
  const value = enabled ? 'true' : 'false'
  db.insert(schema.appSettings)
    .values({ key: THINKING_MODE_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return enabled
}
