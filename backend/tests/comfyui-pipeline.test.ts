/**
 * 本地 ComfyUI 生成全链路测试
 *
 * 走真实的 generateImage：建 sys_task → 提交 /prompt → 轮询 /history → 下载 /view → 落盘。
 * 用 mock ComfyUI 替代本机服务，不占用 GPU。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-pipeline-'))
// 数据库与媒体都指向临时目录，避免污染仓库 data/
process.env.SQLITE_PATH = path.join(tmpRoot, 'huobao.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(tmpRoot, 'data')
process.env.WORKSPACE_PATH = path.resolve(import.meta.dirname, '../workspace')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const { eq } = await import('drizzle-orm')
const { db, schema } = await import('../src/db/index.ts')
const { saveComfyConfig } = await import('../src/services/comfyui/config.ts')
const { buildTemplateFromPreset } = await import('../src/services/comfyui/presets.ts')
const { generateImage } = await import('../src/services/generation.ts')

async function startMockComfy() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    req.resume()
    if (url.pathname === '/system_stats') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ system: { comfyui_version: 'test' }, devices: [{ name: 'Mock', vram_total: 1, vram_free: 1 }] }))
      return
    }
    if (url.pathname === '/prompt') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'pipe-1' }))
      })
      return
    }
    if (url.pathname.startsWith('/history/')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        'pipe-1': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 461: { images: [{ filename: 'local_0001.png', subfolder: '', type: 'output' }] } },
        },
      }))
      return
    }
    if (url.pathname === '/view') {
      res.setHeader('Content-Type', 'image/png')
      res.end(PNG_1PX)
      return
    }
    res.statusCode = 404
    res.end('nope')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('图片生成全链路：提交 → 轮询 → 下载 → 落盘为 .png', async () => {
  const mock = await startMockComfy()
  try {
    saveComfyConfig({
      enabled: true,
      url: mock.url,
      image: buildTemplateFromPreset('qwen-image-2.1-t2i'),
      imageEdit: buildTemplateFromPreset('qwen-image-2.1-edit'),
      optionValues: { prompt_enhancer: false },
    })

    const taskId = await generateImage({ prompt: '一个赛博朋克风格的雨夜街道', size: '1024x1024' })

    const deadline = Date.now() + 25_000
    let row: any = null
    while (Date.now() < deadline) {
      const [found] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
      if (found && (found.status === 'completed' || found.status === 'failed')) { row = found; break }
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    assert.ok(row, '任务应在超时前结束')
    assert.equal(row.status, 'completed', `任务失败：${row?.errorMsg || ''}`)
    assert.equal(row.provider, 'comfyui')
    assert.match(String(row.localPath), /^static\/images\/.+\.png$/, '产物必须落成 .png（/view 的扩展名在查询参数里）')

    const absolute = path.join(process.env.HUOBAO_DATA_DIR!, String(row.localPath))
    assert.ok(fs.existsSync(absolute), `产物文件应存在：${absolute}`)
    assert.ok(fs.statSync(absolute).size > 0)
  } finally {
    await mock.close()
  }
})

test('ComfyUI 返回 node_errors 时任务直接失败并保留可读错误', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ node_errors: { '459:452': { errors: [{ message: 'clip 文件不存在', details: 'qwen3vl' }] } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    saveComfyConfig({
      enabled: true,
      url,
      image: buildTemplateFromPreset('qwen-image-2.1-t2i'),
    })
    const taskId = await generateImage({ prompt: '测试节点校验失败' })
    const deadline = Date.now() + 15_000
    let row: any = null
    while (Date.now() < deadline) {
      const [found] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
      if (found && (found.status === 'failed' || found.status === 'completed')) { row = found; break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(row?.status, 'failed')
    assert.match(String(row?.errorMsg), /节点校验失败/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
