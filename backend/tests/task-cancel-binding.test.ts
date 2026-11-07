import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('任务可取消且取消后不再被轮询覆盖；分镜只改描述不被历史绑定拦住', { timeout: 30_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'huobao-cancel-binding-'))
  process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = temporary
  process.env.WORKSPACE_PATH = path.join(temporary, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'

  const { Hono } = await import('hono')
  const { db, schema } = await import('../src/db/index.js')
  const { default: taskRoute } = await import('../src/routes/tasks.js')
  const { default: storyboardRoute } = await import('../src/routes/storyboards.js')
  const app = new Hono().route('/tasks', taskRoute).route('/storyboards', storyboardRoute)
  const now = new Date().toISOString()

  try {
    db.insert(schema.dramas).values({ id: 1, title: '取消测试', createdAt: now, updatedAt: now }).run()
    db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: '第一集', createdAt: now, updatedAt: now }).run()
    db.insert(schema.storyboards).values({
      id: 1, episodeId: 1, storyboardNumber: 1, description: '旧描述', duration: 5,
      sceneId: 999, createdAt: now, updatedAt: now,
    }).run()
    db.insert(schema.sysTask).values({
      id: 1, type: 'video', provider: 'openai', storyboardId: 1, dramaId: 1,
      status: 'processing', taskId: 'upstream-1', createdAt: now, updatedAt: now,
    }).run()

    await t.test('运行中的任务可以取消，状态落为已取消', async () => {
      const resp = await app.request('/tasks/1/cancel', { method: 'POST' })
      assert.equal(resp.status, 200)
      const [task] = db.select().from(schema.sysTask).all().filter(row => row.id === 1)
      assert.equal(task.status, 'failed')
      assert.equal(task.errorCode, 'cancelled')
      assert.equal(task.stage, 'cancelled')
    })

    await t.test('重复取消与已结束任务直接拒绝，不重复覆盖', async () => {
      const resp = await app.request('/tasks/1/cancel', { method: 'POST' })
      assert.equal(resp.status, 400)
    })

    await t.test('只改描述不再触发历史绑定校验，绑定字段变更仍校验', async () => {
      const edit = await app.request('/storyboards/1', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: '新的画面描述', duration: 7 }),
      })
      assert.equal(edit.status, 200)
      const [updated] = db.select().from(schema.storyboards).all().filter(row => row.id === 1)
      assert.equal(updated.description, '新的画面描述')
      assert.equal(updated.duration, 7)

      const badScene = await app.request('/storyboards/1', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_id: 999 }),
      })
      assert.equal(badScene.status, 400)
    })
  } finally {
    db.$client.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
