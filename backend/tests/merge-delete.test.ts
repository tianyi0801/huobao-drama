import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// 独立数据库与存储目录，不访问当前项目的成品和配置。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-merge-delete-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { default: mergeRoutes } = await import('../src/routes/merge.ts')
const { deleteEpisodeMerge } = await import('../src/services/merge-delete.ts')
const mergedDir = path.join(root, 'static', 'merged')
const ts = '2026-11-02T00:00:00.000Z'

beforeEach(() => {
  db.delete(schema.videoMerges).run()
  db.delete(schema.storyboards).run()
  db.delete(schema.episodes).run()
  for (const id of [1, 2]) {
    db.insert(schema.episodes).values({ id, dramaId: 1, episodeNumber: id, title: '测试剧集', createdAt: ts, updatedAt: ts }).run()
  }
  fs.mkdirSync(mergedDir, { recursive: true })
  for (const file of fs.readdirSync(mergedDir)) fs.rmSync(path.join(mergedDir, file), { recursive: true, force: true })
})
after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function insertMerge(url: string | null, status = 'completed', episodeId = 1, scenes: string[] = []) {
  return getInsertId(db.insert(schema.videoMerges).values({
    episodeId, dramaId: 1, provider: 'ffmpeg', model: 'ffmpeg-concat-h264-aac', status, mergedUrl: url, scenes: JSON.stringify(scenes), createdAt: ts,
  }).run())
}
function output(name: string) {
  const url = `static/merged/${name}.mp4`
  const video = path.join(mergedDir, `${name}.mp4`)
  const poster = path.join(mergedDir, `${name}_poster.jpg`)
  fs.writeFileSync(video, '测试成品视频')
  fs.writeFileSync(poster, '测试成品封面')
  return { url, video, poster }
}
function record(id: number) {
  return db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id)).get()!
}
async function remove(id: number, episodeId = 1) {
  return mergeRoutes.request(`/episodes/${episodeId}/merges/${id}`, { method: 'DELETE' })
}

test('删除成品和封面、清空当前剧集引用，不删除原始分镜视频', async () => {
  const files = output('finished')
  const original = path.join(root, 'static', 'source.mp4')
  fs.writeFileSync(original, '原始视频')
  const sourceUrl = 'static/source.mp4'
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, videoUrl: sourceUrl, createdAt: ts, updatedAt: ts }).run()
  const id = insertMerge(files.url, 'completed', 1, [sourceUrl])
  db.update(schema.episodes).set({ videoUrl: files.url }).where(eq(schema.episodes.id, 1)).run()
  const bytes = fs.statSync(files.video).size + fs.statSync(files.poster).size
  const response = await remove(id)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.freedBytes, bytes)
  assert.equal(fs.existsSync(files.video), false)
  assert.equal(fs.existsSync(files.poster), false)
  assert.ok(record(id).deletedAt)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id, 1)).get()!.videoUrl, null)
  assert.equal(fs.readFileSync(original, 'utf8'), '原始视频')
  assert.equal(db.select().from(schema.storyboards).get()!.videoUrl, sourceUrl)
  assert.deepEqual((await (await mergeRoutes.request('/episodes/1/merges')).json()).data, [])
  assert.equal((await (await mergeRoutes.request('/episodes/1/merge')).json()).data, null)
  assert.equal((await remove(id)).status, 200)
})

test('删除旧成品不会覆盖新成品引用，最新状态排除已删除项', async () => {
  const old = output('old'), current = output('current')
  const oldId = insertMerge(old.url), currentId = insertMerge(current.url)
  db.update(schema.episodes).set({ videoUrl: current.url }).where(eq(schema.episodes.id, 1)).run()
  assert.equal((await remove(oldId)).status, 200)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id, 1)).get()!.videoUrl, current.url)
  assert.equal(fs.existsSync(current.video), true)
  assert.equal((await remove(currentId)).status, 200)
  assert.equal((await (await mergeRoutes.request('/episodes/1/merge')).json()).data, null)
})

test('未结束的任务禁止删除；剧集归属、非法ID与不存在记录受保护', async () => {
  for (const status of ['pending', 'processing']) {
    const files = output(status), id = insertMerge(files.url, status)
    assert.equal((await remove(id)).status, 409)
    assert.equal(record(id).deletedAt, null)
    assert.equal(fs.existsSync(files.video), true)
    assert.equal((await remove(id, 2)).status, 404)
  }
  assert.equal((await remove(99999)).status, 404)
  assert.equal((await remove(-1)).status, 400)
  assert.equal((await mergeRoutes.request('/episodes/1/merges/abc', { method: 'DELETE' })).status, 400)
})

test('文件缺失和失败记录仍可安全删除，重复删除幂等', async () => {
  const id = insertMerge('static/merged/missing.mp4')
  assert.deepEqual(deleteEpisodeMerge(1, id), { id, freedBytes: 0 })
  assert.deepEqual(deleteEpisodeMerge(1, id), { id, freedBytes: 0 })
  const failed = insertMerge(null, 'failed')
  assert.equal((await remove(failed)).status, 200)
  assert.ok(record(failed).deletedAt)
})

test('拒绝外部URL、绝对路径、目录与路径穿越，保留记录和文件', async () => {
  const outside = path.join(root, 'protected.mp4')
  fs.writeFileSync(outside, '保留文件')
  for (const url of ['https://example.com/video.mp4', outside, 'static/videos/source.mp4', 'static/merged/../protected.mp4', 'static/merged/nested/file.mp4']) {
    const id = insertMerge(url)
    assert.equal((await remove(id)).status, 400)
    assert.equal(record(id).deletedAt, null)
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), '保留文件')
})

test('拒绝视频或封面的符号链接及非文件路径，删除前验证全部路径', async () => {
  const outside = path.join(root, 'outside.mp4')
  fs.writeFileSync(outside, '不能删除')
  const video = path.join(mergedDir, 'linked.mp4')
  fs.symlinkSync(outside, video)
  assert.equal((await remove(insertMerge('static/merged/linked.mp4'))).status, 400)
  assert.equal(fs.existsSync(video), true)
  const files = output('poster-link')
  fs.unlinkSync(files.poster)
  fs.symlinkSync(outside, files.poster)
  assert.equal((await remove(insertMerge(files.url))).status, 400)
  assert.equal(fs.existsSync(files.video), true)
  const directory = output('directory')
  fs.unlinkSync(directory.video)
  fs.mkdirSync(directory.video)
  assert.equal((await remove(insertMerge(directory.url))).status, 400)
  assert.equal(fs.readFileSync(outside, 'utf8'), '不能删除')
})

test('其他导出、原始镜头、其他剧集或拼接输入引用同一成品时禁止删除', async () => {
  const files = output('shared'), id = insertMerge(files.url)
  const shared = insertMerge('/' + files.url, 'completed', 2)
  assert.equal((await remove(id)).status, 409)
  db.delete(schema.videoMerges).where(eq(schema.videoMerges.id, shared)).run()
  const shot = getInsertId(db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, composedVideoUrl: files.url, createdAt: ts, updatedAt: ts }).run())
  assert.equal((await remove(id)).status, 409)
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, shot)).run()
  db.update(schema.episodes).set({ videoUrl: files.url }).where(eq(schema.episodes.id, 2)).run()
  assert.equal((await remove(id)).status, 409)
  db.update(schema.episodes).set({ videoUrl: null }).where(eq(schema.episodes.id, 2)).run()
  const input = insertMerge(null, 'processing', 2, [files.url])
  assert.equal((await remove(id)).status, 409)
  db.delete(schema.videoMerges).where(eq(schema.videoMerges.id, input)).run()
  assert.equal((await remove(id)).status, 200)
})

test('磁盘清理失败保留记录与剧集引用，重试可清理剩余文件', async (t) => {
  const files = output('retry'), id = insertMerge(files.url)
  db.update(schema.episodes).set({ videoUrl: files.url }).where(eq(schema.episodes.id, 1)).run()
  const original = fs.unlinkSync
  const mocked = t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === files.video) throw Object.assign(new Error('模拟文件占用'), { code: 'EBUSY' })
    return original(file)
  })
  const response = await remove(id)
  mocked.mock.restore()
  assert.equal(response.status, 500)
  assert.equal(record(id).deletedAt, null)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id, 1)).get()!.videoUrl, files.url)
  assert.equal(fs.existsSync(files.video), true)
  assert.equal((await remove(id)).status, 200)
  assert.equal(fs.existsSync(files.video), false)
})

test('并发重复请求只清理一次，第二次返回成功', async () => {
  const files = output('concurrent'), id = insertMerge(files.url)
  const results = await Promise.all([remove(id), remove(id)])
  assert.deepEqual(results.map(r => r.status), [200, 200])
  const values = await Promise.all(results.map(r => r.json()))
  assert.equal(values.filter(v => v.data.freedBytes > 0).length, 1)
})

test('前端删除事件、确认和列表刷新已接入，四种语言文案完整', () => {
  const source = fs.readFileSync(new URL('../../frontend/app/views/drama/episode.vue', import.meta.url), 'utf8')
  assert.match(source, /@click\.stop="askDeleteMerge\(m\)"/)
  assert.match(source, /@keydown\.enter\.stop/)
  assert.match(source, /:open="mergeDelete\.open"/)
  assert.match(source, /await mergeAPI\.del\(epId\.value, item\.id\)/)
  assert.match(source, /deletedMergeIds\.has\(m\.id\)/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(fs.readFileSync(new URL(`../../frontend/app/locales/${lang}.json`, import.meta.url), 'utf8'))
    for (const key of ['deleteTitle', 'deleteMessage', 'deleted', 'deleteRunning']) assert.equal(typeof locale.episode.export[key], 'string')
  }
})
