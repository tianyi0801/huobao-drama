/**
 * 视频工作台（人物替换 / 首尾帧转场）独立数据表。
 *
 * 该模块与短剧主流程的剧集、分镜、角色、场景表完全隔离：
 * 只通过 dramas.id 关联项目，仅复用 sys_task 承载单段生成任务。
 * 表结构与 Drizzle 映射都放在本文件，主 schema.ts 无需感知。
 */
import type Database from 'better-sqlite3'
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const studioMaterials = sqliteTable('studio_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  mode: text('mode').notNull(),
  role: text('role').notNull(),
  mediaType: text('media_type').notNull(),
  url: text('url').notNull(),
  localPath: text('local_path').notNull(),
  fileName: text('file_name'),
  createdAt: text('created_at').notNull(),
})

/** 一次「按镜头分段生成 + 汇总」的批次 */
export const studioBatches = sqliteTable('studio_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  mode: text('mode').notNull(),
  sourcePath: text('source_path').notNull(),
  sourceDuration: real('source_duration').notNull(),
  width: integer('width'),
  height: integer('height'),
  fps: real('fps'),
  hasAudio: integer('has_audio', { mode: 'boolean' }),
  provider: text('provider'),
  configId: integer('config_id'),
  prompt: text('prompt'),
  aspectRatio: text('aspect_ratio'),
  status: text('status').notNull().default('processing'),
  mergedUrl: text('merged_url'),
  mergedDuration: real('merged_duration'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

/** 批次内每个镜头段：起止秒、目标时长、参考切片、生成任务与产物 */
export const studioSegments = sqliteTable('studio_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  startSec: real('start_sec').notNull(),
  endSec: real('end_sec').notNull(),
  targetDuration: real('target_duration').notNull(),
  requestDuration: integer('request_duration').notNull(),
  clipPath: text('clip_path'),
  taskId: integer('task_id'),
  status: text('status').notNull().default('pending'),
  resultPath: text('result_path'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 启动时幂等建表，旧库无需数据迁移（新模式本身就是新增能力）。 */
export function initStudioSchema(sqlite: Database.Database) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS studio_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    role TEXT NOT NULL,
    media_type TEXT NOT NULL,
    url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    file_name TEXT,
    created_at TEXT NOT NULL
  )`)
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_studio_materials_project ON studio_materials(drama_id, mode)')

  sqlite.exec(`CREATE TABLE IF NOT EXISTS studio_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_duration REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    fps REAL,
    has_audio INTEGER,
    provider TEXT,
    config_id INTEGER,
    prompt TEXT,
    aspect_ratio TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    merged_url TEXT,
    merged_duration REAL,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`)
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_studio_batches_project ON studio_batches(drama_id, id)')

  sqlite.exec(`CREATE TABLE IF NOT EXISTS studio_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    segment_index INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    target_duration REAL NOT NULL,
    request_duration INTEGER NOT NULL,
    clip_path TEXT,
    task_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    result_path TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_studio_segments_batch ON studio_segments(batch_id, segment_index)')
}
