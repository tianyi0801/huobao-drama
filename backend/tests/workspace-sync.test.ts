/**
 * 内置 workspace 模板同步行为测试
 *
 * 覆盖产品规则：以内置为准覆盖同名 prompt / skill，用户新建内容保留，
 * 覆盖前备份，废弃文件清理，且只在「真的覆盖/清理了已有内容」时告知用户。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huobao-workspace-sync-'))
const templateDir = path.join(root, 'template')
const workspaceDir = path.join(root, 'workspace')

process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = workspaceDir
process.env.WORKSPACE_TEMPLATE_DIR = templateDir
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getWorkspaceSyncNotice, setWorkspaceSyncNotice } = await import('../src/services/app-settings.ts')
const { syncWorkspaceTemplate } = await import('../src/agents/workspace-sync.ts')
const { db } = await import('../src/db/index.ts')
const { default: settingsRoutes } = await import('../src/routes/settings.ts')

after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 写文件（自动建目录） */
function write(abs: string, content: string) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** 重建模板目录（模拟「随包发布的新版模板」） */
function prepareTemplate(version: number, files: Record<string, string>) {
  fs.rmSync(templateDir, { recursive: true, force: true })
  write(path.join(templateDir, 'template.json'), JSON.stringify({ version }))
  for (const [rel, content] of Object.entries(files)) write(path.join(templateDir, rel), content)
}

const readWorkspace = (rel: string) => fs.readFileSync(path.join(workspaceDir, rel), 'utf8')
const existsInWorkspace = (rel: string) => fs.existsSync(path.join(workspaceDir, rel))

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true })
  setWorkspaceSyncNotice(null)
})

test('首次同步只新增文件，不打扰用户（无告知）', () => {
  prepareTemplate(6, {
    'prompts/script_rewriter.md': '内置提示词',
    'skills/script-rewriter/SKILL.md': '内置技能',
    'comfyui/presets.json': '{}',
  })
  const notice = syncWorkspaceTemplate()

  assert.equal(notice, null, '首次安装全部为新增，不应产生覆盖告知')
  assert.equal(readWorkspace('prompts/script_rewriter.md'), '内置提示词')
  assert.equal(readWorkspace('skills/script-rewriter/SKILL.md'), '内置技能')
  assert.equal(readWorkspace('comfyui/presets.json'), '{}')
  // 版本清单本身不落到用户目录
  assert.equal(existsInWorkspace('template.json'), false)
  assert.equal(getWorkspaceSyncNotice(), null)
})

test('模板版本升级时覆盖用户改过的 prompt 与 skill，并备份 + 落库告知', () => {
  prepareTemplate(6, {
    'prompts/extractor.md': '内置 v6',
    'skills/extractor/SKILL.md': '技能 v6',
  })
  syncWorkspaceTemplate()

  // 用户在设置页改过这两处
  write(path.join(workspaceDir, 'prompts/extractor.md'), '用户自定义提示词')
  write(path.join(workspaceDir, 'skills/extractor/SKILL.md'), '用户自定义技能')

  prepareTemplate(7, {
    'prompts/extractor.md': '内置 v7',
    'skills/extractor/SKILL.md': '技能 v7',
  })
  const notice = syncWorkspaceTemplate()

  assert.ok(notice, '覆盖已有内容时必须产生告知')
  assert.equal(notice!.version, 7)
  assert.equal(notice!.overwritten, 2)
  assert.equal(notice!.added, 0)
  assert.equal(readWorkspace('prompts/extractor.md'), '内置 v7')
  assert.equal(readWorkspace('skills/extractor/SKILL.md'), '技能 v7')

  // 原内容可在备份目录找回
  assert.match(notice!.backupDir, /^\.backup\//)
  assert.equal(
    readWorkspace(`${notice!.backupDir}/prompts/extractor.md`),
    '用户自定义提示词',
  )
  assert.equal(
    readWorkspace(`${notice!.backupDir}/skills/extractor/SKILL.md`),
    '用户自定义技能',
  )
  // 前端读到的通知与之一致
  assert.equal(getWorkspaceSyncNotice()?.version, 7)
  assert.equal(getWorkspaceSyncNotice()?.overwritten, 2)
})

test('用户新建的技能目录在升级时既不被覆盖也不被清理', () => {
  prepareTemplate(6, { 'skills/extractor/SKILL.md': '内置 v6' })
  syncWorkspaceTemplate()

  write(path.join(workspaceDir, 'skills/extractor/custom-rule/SKILL.md'), '用户新建规范')
  write(path.join(workspaceDir, 'prompts/my-extra.md'), '用户新增提示词')

  prepareTemplate(7, { 'skills/extractor/SKILL.md': '内置 v7' })
  syncWorkspaceTemplate()

  assert.equal(readWorkspace('skills/extractor/custom-rule/SKILL.md'), '用户新建规范')
  assert.equal(readWorkspace('prompts/my-extra.md'), '用户新增提示词')
  assert.equal(readWorkspace('skills/extractor/SKILL.md'), '内置 v7')
})

test('模板中已删除的旧文件会被清理，避免废弃规范继续注入提示词', () => {
  prepareTemplate(6, {
    'prompts/script_rewriter.md': '脚本',
    'skills/legacy-rule/SKILL.md': '已废弃规范',
  })
  syncWorkspaceTemplate()

  prepareTemplate(7, { 'prompts/script_rewriter.md': '脚本 v7' })
  const notice = syncWorkspaceTemplate()

  assert.ok(notice)
  assert.equal(notice!.removed, 1)
  assert.equal(existsInWorkspace('skills/legacy-rule/SKILL.md'), false)
  // 变空的目录一并清理
  assert.equal(existsInWorkspace('skills/legacy-rule'), false)
})

test('模板版本未变化时不覆盖用户目录（避免每次启动抹掉编辑）', () => {
  prepareTemplate(6, { 'prompts/extractor.md': '内置' })
  syncWorkspaceTemplate()

  write(path.join(workspaceDir, 'prompts/extractor.md'), '用户改后内容')
  const notice = syncWorkspaceTemplate()

  assert.equal(notice, null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户改后内容')
})

const readState = () => JSON.parse(readWorkspace('.template-state.json'))
const assertNoStage = () => assert.equal(
  fs.readdirSync(workspaceDir).some(name => name.startsWith('.workspace-sync-')),
  false,
  '同步结束必须清理暂存目录',
)

function prepareUpgrade() {
  prepareTemplate(6, { 'prompts/extractor.md': '内置 v6' })
  syncWorkspaceTemplate()
  write(path.join(workspaceDir, 'prompts/extractor.md'), '用户编辑')
  prepareTemplate(7, { 'prompts/extractor.md': '内置 v7' })
}

test('暂存复制失败不覆盖、不提交版本，恢复后下次同步能重试', (t) => {
  prepareUpgrade()
  const copy = fs.copyFileSync
  t.mock.method(fs, 'copyFileSync', (src, dest, mode) => {
    if (String(src).startsWith(templateDir)) throw new Error('模拟模板复制失败')
    return copy(src, dest, mode)
  })
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
  assertNoStage()

  t.mock.restoreAll()
  assert.equal(syncWorkspaceTemplate()?.version, 7)
  assert.equal(readWorkspace('prompts/extractor.md'), '内置 v7')
  assert.equal(readState().version, 7)
})

test('备份失败时原文件与旧状态都保留，不产生虚假备份告知', (t) => {
  prepareUpgrade()
  const copy = fs.copyFileSync
  t.mock.method(fs, 'copyFileSync', (src, dest, mode) => {
    if (String(dest).includes(`${path.sep}.backup${path.sep}`)) throw new Error('模拟备份失败')
    return copy(src, dest, mode)
  })
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
  assert.equal(getWorkspaceSyncNotice(), null)
  assertNoStage()
  t.mock.restoreAll()
  const notice = syncWorkspaceTemplate()
  assert.ok(notice?.backupDir)
  assert.equal(readWorkspace(`${notice.backupDir}/prompts/extractor.md`), '用户编辑')
})

test('备份内容校验失败时不覆盖用户文件', (t) => {
  prepareUpgrade()
  const copy = fs.copyFileSync
  t.mock.method(fs, 'copyFileSync', (src, dest, mode) => {
    copy(src, dest, mode)
    if (String(dest).includes(`${path.sep}.backup${path.sep}`)) fs.writeFileSync(dest, '损坏的备份')
  })
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
})

test('模板目录读取失败不会把已有规范误当成废弃文件删除', (t) => {
  prepareUpgrade()
  const readdir = fs.readdirSync
  t.mock.method(fs, 'readdirSync', (...args) => {
    if (String(args[0]) === path.join(templateDir, 'prompts')) throw new Error('模拟目录不可读')
    return Reflect.apply(readdir, fs, args)
  })
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
})

for (const invalid of ['损坏的 JSON', '{}', '{"version":null}', '{"version":0}', '{"version":1.5}']) {
  test(`版本清单非法时跳过同步，不反复抹掉编辑：${invalid}`, () => {
    prepareUpgrade()
    write(path.join(templateDir, 'template.json'), invalid)
    assert.equal(syncWorkspaceTemplate(), null)
    assert.equal(syncWorkspaceTemplate(), null)
    assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
    assert.equal(readState().version, 6)
  })
}

test('版本清单缺失时跳过同步，补回合法清单后恢复', () => {
  prepareUpgrade()
  fs.unlinkSync(path.join(templateDir, 'template.json'))
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
  write(path.join(templateDir, 'template.json'), '{"version":7}')
  assert.equal(syncWorkspaceTemplate()?.version, 7)
})

test('未递增版本时，内置文件内容与新增技能仍能通过指纹更新', () => {
  prepareTemplate(6, { 'prompts/extractor.md': '内置 v6' })
  syncWorkspaceTemplate()
  write(path.join(templateDir, 'prompts/extractor.md'), '同版本改进')
  write(path.join(templateDir, 'skills/extractor/new-rule/SKILL.md'), '新增规范')
  const notice = syncWorkspaceTemplate()
  assert.equal(notice?.overwritten, 1)
  assert.equal(notice?.added, 1)
  assert.equal(readWorkspace('prompts/extractor.md'), '同版本改进')
  assert.equal(readWorkspace('skills/extractor/new-rule/SKILL.md'), '新增规范')
  write(path.join(workspaceDir, 'prompts/extractor.md'), '用户之后编辑')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户之后编辑')
})

test('废弃清理不删除用户新建的空目录', () => {
  prepareUpgrade()
  const custom = path.join(workspaceDir, 'skills/extractor/user-empty')
  fs.mkdirSync(custom, { recursive: true })
  syncWorkspaceTemplate()
  assert.ok(fs.existsSync(custom))
})

for (const invalidPath of ['../guard.txt', 'prompts/../../guard.txt', 'comfyui/guard.txt', 'prompts\\..\\guard.txt', 'prompts//guard.txt']) {
  test(`同步清单拒绝越界或非允许目录：${invalidPath}`, () => {
    prepareUpgrade()
    const guard = path.join(root, 'guard.txt')
    write(guard, '隔离哨兵')
    const state = readState()
    state.files.push(invalidPath)
    write(path.join(workspaceDir, '.template-state.json'), JSON.stringify(state))
    assert.equal(syncWorkspaceTemplate(), null)
    assert.equal(fs.readFileSync(guard, 'utf8'), '隔离哨兵')
    assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
    assert.equal(readState().version, 6)
  })
}

test('ComfyUI 清单同样拒绝越界路径', () => {
  prepareUpgrade()
  const state = readState()
  state.comfyFiles.push('comfyui/../../guard.txt')
  write(path.join(workspaceDir, '.template-state.json'), JSON.stringify(state))
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(readState().version, 6)
})

test('同步状态损坏时保留用户内容，不当成首次安装覆盖', () => {
  prepareUpgrade()
  write(path.join(workspaceDir, '.template-state.json'), '损坏的同步状态')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
})

test('目标文件与父目录的符号链接不会引导操作到工作目录外', () => {
  prepareUpgrade()
  const external = path.join(root, 'external')
  const guard = path.join(external, 'extractor.md')
  write(guard, '外部哨兵')
  fs.unlinkSync(path.join(workspaceDir, 'prompts/extractor.md'))
  fs.symlinkSync(guard, path.join(workspaceDir, 'prompts/extractor.md'))
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(fs.readFileSync(guard, 'utf8'), '外部哨兵')
  fs.rmSync(path.join(workspaceDir, 'prompts'), { recursive: true, force: true })
  fs.symlinkSync(external, path.join(workspaceDir, 'prompts'), 'dir')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(fs.readFileSync(guard, 'utf8'), '外部哨兵')
})

test('模板源符号链接和备份目录符号链接均被拒绝', () => {
  prepareUpgrade()
  const guard = path.join(root, 'source-guard.md')
  write(guard, '源哨兵')
  fs.unlinkSync(path.join(templateDir, 'prompts/extractor.md'))
  fs.symlinkSync(guard, path.join(templateDir, 'prompts/extractor.md'))
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  prepareTemplate(7, { 'prompts/extractor.md': '新版' })
  const external = path.join(root, 'backup-external')
  fs.mkdirSync(external, { recursive: true })
  fs.symlinkSync(external, path.join(workspaceDir, '.backup'), 'dir')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.deepEqual(fs.readdirSync(external), [])
})

test('新版状态写入失败时保留旧版并提示未完成，恢复后重试', (t) => {
  prepareUpgrade()
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (String(dest).endsWith('.template-state.json')) throw new Error('模拟状态提交失败')
    return rename(src, dest)
  })
  const notice = syncWorkspaceTemplate()
  assert.equal(notice?.incomplete, true)
  assert.equal(readState().version, 6)
  assert.equal(readWorkspace(`${notice!.backupDir}/prompts/extractor.md`), '用户编辑')
  assertNoStage()
  t.mock.restoreAll()
  assert.equal(syncWorkspaceTemplate()?.incomplete, false)
  assert.equal(readState().version, 7)
})

test('部分文件应用失败时不提交新版，保留完整原始备份并可重试', (t) => {
  prepareTemplate(6, { 'prompts/a.md': '旧甲', 'prompts/b.md': '旧乙' })
  syncWorkspaceTemplate()
  prepareTemplate(7, { 'prompts/a.md': '新甲', 'prompts/b.md': '新乙' })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (String(dest) === path.join(workspaceDir, 'prompts/b.md')) throw new Error('模拟第二个文件替换失败')
    return rename(src, dest)
  })
  const notice = syncWorkspaceTemplate()
  assert.equal(notice?.incomplete, true)
  assert.equal(notice?.overwritten, 1)
  assert.equal(readState().version, 6)
  assert.equal(readWorkspace('prompts/b.md'), '旧乙')
  assert.equal(readWorkspace(`${notice!.backupDir}/prompts/a.md`), '旧甲')
  assert.equal(readWorkspace(`${notice!.backupDir}/prompts/b.md`), '旧乙')
  t.mock.restoreAll()
  syncWorkspaceTemplate()
  assert.equal(readWorkspace('prompts/b.md'), '新乙')
  assert.equal(readState().version, 7)
})

test('废弃文件删除失败时不提交新版，下次启动重试删除', (t) => {
  prepareTemplate(6, { 'skills/old/SKILL.md': '废弃规则' })
  syncWorkspaceTemplate()
  prepareTemplate(7, {})
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (String(file).endsWith('SKILL.md')) throw new Error('模拟废弃文件删除失败')
    return unlink(file)
  })
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readState().version, 6)
  assert.ok(existsInWorkspace('skills/old/SKILL.md'))
  t.mock.restoreAll()
  assert.equal(syncWorkspaceTemplate()?.removed, 1)
  assert.equal(readState().version, 7)
})

test('跨十位版本只保留最近五份备份，当前备份不会被删', () => {
  prepareTemplate(9, { 'prompts/extractor.md': '内置9' })
  syncWorkspaceTemplate()
  for (const version of [5, 6, 7, 8, 9]) {
    const dir = path.join(workspaceDir, `.backup/v${version}-20260101000000`)
    write(path.join(dir, 'prompts/extractor.md'), `历史${version}`)
    fs.utimesSync(dir, version, version)
  }
  prepareTemplate(10, { 'prompts/extractor.md': '内置10' })
  const notice = syncWorkspaceTemplate()
  assert.ok(notice?.backupDir)
  assert.ok(existsInWorkspace(notice.backupDir))
  assert.equal(readWorkspace(`${notice.backupDir}/prompts/extractor.md`), '内置9')
  assert.equal(fs.readdirSync(path.join(workspaceDir, '.backup')).length, 5)
  assert.equal(existsInWorkspace('.backup/v5-20260101000000'), false)
})

test('连续同版本更新的备份目录唯一，不会覆盖之前的原始内容', () => {
  prepareUpgrade()
  const first = syncWorkspaceTemplate()!
  write(path.join(templateDir, 'prompts/extractor.md'), '同版本再次改进')
  const second = syncWorkspaceTemplate()!
  assert.notEqual(first.backupDir, second.backupDir)
  assert.equal(readWorkspace(`${first.backupDir}/prompts/extractor.md`), '用户编辑')
  assert.equal(readWorkspace(`${second.backupDir}/prompts/extractor.md`), '内置 v7')
})

test('ComfyUI 同版本每次覆盖，删除的内置预设也会清理', () => {
  prepareTemplate(6, { 'comfyui/presets.json': '内置预设' })
  syncWorkspaceTemplate()
  write(path.join(workspaceDir, 'comfyui/presets.json'), '旧预设')
  syncWorkspaceTemplate()
  assert.equal(readWorkspace('comfyui/presets.json'), '内置预设')
  prepareTemplate(6, {})
  syncWorkspaceTemplate()
  assert.equal(existsInWorkspace('comfyui/presets.json'), false)
})

test('旧状态没有指纹时同版本先补基线，不覆盖用户编辑', () => {
  prepareTemplate(6, { 'prompts/extractor.md': '内置 v6' })
  syncWorkspaceTemplate()
  const state = readState()
  delete state.fingerprint
  write(path.join(workspaceDir, '.template-state.json'), JSON.stringify(state))
  write(path.join(workspaceDir, 'prompts/extractor.md'), '用户编辑')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '用户编辑')
  assert.equal(typeof readState().fingerprint, 'string')
  write(path.join(templateDir, 'prompts/extractor.md'), '同版本新版')
  syncWorkspaceTemplate()
  assert.equal(readWorkspace('prompts/extractor.md'), '同版本新版')
})

test('纯删除升级提交失败后重试成功，会纠正遗留的未完成通知', (t) => {
  prepareTemplate(6, { 'skills/old/SKILL.md': '废弃规范' })
  syncWorkspaceTemplate()
  prepareTemplate(7, {})
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (String(dest).endsWith('.template-state.json')) throw new Error('模拟提交失败')
    return rename(src, dest)
  })
  const first = syncWorkspaceTemplate()!
  assert.equal(first.incomplete, true)
  assert.equal(first.removed, 1)
  assert.equal(readState().version, 6)
  t.mock.restoreAll()
  const second = syncWorkspaceTemplate()!
  assert.equal(second.incomplete, false)
  assert.equal(second.backupDir, first.backupDir)
  assert.equal(getWorkspaceSyncNotice()?.incomplete, false)
  assert.equal(readState().version, 7)
  assert.equal(readWorkspace(`${first.backupDir}/skills/old/SKILL.md`), '废弃规范')
})

test('通知落库失败不提交新版状态，恢复后重试并告知', (t) => {
  prepareUpgrade()
  const prototype = db.$client.prepare('SELECT 1').constructor.prototype
  t.mock.method(prototype, 'run', () => {
    throw new Error('模拟通知写库失败')
  })
  const notice = syncWorkspaceTemplate()
  assert.equal(notice?.incomplete, true)
  assert.equal(readState().version, 6)
  t.mock.restoreAll()
  assert.equal(syncWorkspaceTemplate()?.incomplete, false)
  assert.equal(getWorkspaceSyncNotice()?.version, 7)
  assert.equal(readState().version, 7)
})

test('升级通知经真实接口返回，关闭后不再展示，且重启不会再次覆盖', async () => {
  prepareUpgrade()
  const notice = syncWorkspaceTemplate()!
  const response = await settingsRoutes.request('/workspace-notice')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data.notice, notice)
  const dismissed = await settingsRoutes.request('/workspace-notice/dismiss', { method: 'POST' })
  assert.equal(dismissed.status, 200)
  const next = await settingsRoutes.request('/workspace-notice')
  assert.equal((await next.json()).data.notice, null)
  write(path.join(workspaceDir, 'prompts/extractor.md'), '升级后用户编辑')
  assert.equal(syncWorkspaceTemplate(), null)
  assert.equal(getWorkspaceSyncNotice(), null)
  assert.equal(readWorkspace('prompts/extractor.md'), '升级后用户编辑')
})
