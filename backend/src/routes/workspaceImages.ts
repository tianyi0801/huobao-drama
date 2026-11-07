import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

const KINDS = new Set(['text2image', 'image_edit'])

// GET /workspace-images?kind=text2image|image_edit&limit=24 — 工作台图片历史（倒序）
app.get('/', async (c) => {
  const kind = String(c.req.query('kind') || '').trim()
  const rawLimit = Number(c.req.query('limit') ?? 24)
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 24

  const rows = await (kind && KINDS.has(kind)
    ? db.select().from(schema.workspaceImages).where(eq(schema.workspaceImages.kind, kind))
      .orderBy(desc(schema.workspaceImages.createdAt), desc(schema.workspaceImages.id)).limit(limit)
    : db.select().from(schema.workspaceImages)
      .orderBy(desc(schema.workspaceImages.createdAt), desc(schema.workspaceImages.id)).limit(limit))

  return success(c, rows.map(row => toSnakeCase(row)))
})

// DELETE /workspace-images/:id — 只删历史记录，不动磁盘图片（图片仍可能被任务/素材引用）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return notFound(c, '历史记录不存在')
  const [row] = await db.select().from(schema.workspaceImages).where(eq(schema.workspaceImages.id, id))
  if (!row) return notFound(c, '历史记录不存在')
  await db.delete(schema.workspaceImages).where(eq(schema.workspaceImages.id, id))
  return success(c, { id })
})

export default app
