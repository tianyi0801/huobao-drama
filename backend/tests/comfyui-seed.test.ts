import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// 独立数据库：不读取也不改动当前项目的本地算力配置
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-comfy-seed-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { getComfyConfig, saveComfyConfig } = await import('../src/services/comfyui/config.ts')
const { seedComfyDefaultsIfMissing } = await import('../src/services/comfyui/bootstrap.ts')

const KEY = 'comfyui_config'

beforeEach(() => {
  db.delete(schema.appSettings).run()
})
after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function storedValue() {
  return db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEY)).get()?.value || ''
}

test('完全未配置时预置三份内置工作流', () => {
  seedComfyDefaultsIfMissing()
  const config = getComfyConfig()
  assert.ok(config.image?.api)
  assert.ok(config.imageEdit?.api)
  assert.ok(config.video?.api)
  assert.equal(config.enabled, false)
})

test('只保存过地址、模板全空的旧记录会被补齐', () => {
  // 复现旧版本：预设文件缺失时先保存了地址，配置键已存在但模板全空，之后不再预置
  saveComfyConfig({ url: 'http://127.0.0.1:8188', enabled: true })
  assert.equal(getComfyConfig().image, null)

  seedComfyDefaultsIfMissing()
  const config = getComfyConfig()
  assert.equal(config.url, 'http://127.0.0.1:8188')
  assert.equal(config.enabled, true)
  assert.ok(config.image?.api)
  assert.ok(config.imageEdit?.api)
  assert.ok(config.video?.api)
})

test('用户主动移除单个模板后不会被强行加回', () => {
  seedComfyDefaultsIfMissing()
  assert.ok(getComfyConfig().video?.api)

  saveComfyConfig({ imageEdit: null, video: null })
  seedComfyDefaultsIfMissing()

  const config = getComfyConfig()
  assert.ok(config.image?.api)
  assert.equal(config.imageEdit, null)
  assert.equal(config.video, null)
})

test('重复启动保留用户修改过的地址', () => {
  seedComfyDefaultsIfMissing()
  assert.ok(storedValue().length > 0)

  saveComfyConfig({ url: 'http://10.0.0.2:8188' })
  seedComfyDefaultsIfMissing()

  assert.equal(getComfyConfig().url, 'http://10.0.0.2:8188')
})
