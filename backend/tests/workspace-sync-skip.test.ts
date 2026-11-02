/**
 * 源码模式（未注入 WORKSPACE_TEMPLATE_DIR）不做任何模板同步
 *
 * workspace 本身就是模板目录，同步会变成自我覆盖，必须跳过。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huobao-workspace-skip-'))
const workspaceDir = path.join(root, 'workspace')

process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = workspaceDir
process.env.MYSQL_AUTO_IMPORT = 'false'
// 关键：不注入模板目录，模拟 `npm start` 的源码运行方式
delete process.env.WORKSPACE_TEMPLATE_DIR

const { syncWorkspaceTemplate } = await import('../src/agents/workspace-sync.ts')
const { db } = await import('../src/db/index.ts')

after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('未注入模板目录时跳过同步，不创建也不改动 workspace', () => {
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(fs.existsSync(workspaceDir), false, '源码模式不应产生任何目录写入')
})
