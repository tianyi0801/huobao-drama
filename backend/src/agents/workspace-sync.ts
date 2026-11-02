/**
 * 内置 workspace 模板同步（prompts / skills / comfyui）
 *
 * 产品规则（已确认）：以内置为准，覆盖同名文件；用户新建的内容保留。
 * - prompts：模板版本或内容变化时强制覆盖，回到内置默认提示词
 * - skills：模板版本或内容变化时强制覆盖内置技能；用户新建的技能目录（内置没有的）不受影响
 * - comfyui：随包只读资产（用户自定义模板存数据库），每次启动覆盖
 * - 废弃清理：按上次同步清单删除「上次内置、这次已删除」的文件，
 *   否则旧规范会继续被 scanSkillPaths / loadAgentPromptFile 加载，新旧规范互相冲突
 * - 覆盖前备份到 <workspace>/.backup/<版本>-<时间戳>/，用户改过的内容可找回
 * - 纯告知：结果写入 app_settings，前端启动后提示一次，不打断使用
 *
 * 三端统一：桌面版 / Docker 通过 WORKSPACE_TEMPLATE_DIR 指向随包模板；
 * 源码模式不设置该变量（workspace 即源码目录），跳过同步。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getWorkspaceSyncNotice, setWorkspaceSyncNotice, type WorkspaceSyncNotice } from '../services/app-settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 可写工作目录：桌面版为 userData 副本，Docker 为数据卷，dev 为仓库 backend/workspace */
const WORKSPACE_DIR = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.resolve(__dirname, '../../workspace')

/** 随包内置模板目录；源码模式不设置该变量 → 跳过同步 */
const TEMPLATE_DIR = process.env.WORKSPACE_TEMPLATE_DIR
  ? path.resolve(process.env.WORKSPACE_TEMPLATE_DIR)
  : ''

/** 按模板版本覆盖的目录（用户可编辑，覆盖前备份） */
const VERSIONED_DIRS = ['prompts', 'skills'] as const
/** 每次启动强制覆盖的随包只读资产 */
const ALWAYS_DIRS = ['comfyui'] as const

/** 模板版本清单（随包发布，改内置 prompt/skill 时递增 version） */
const MANIFEST_FILE = 'template.json'
/** 上次同步记录（存在用户目录，记录写入了哪些内置文件） */
const STATE_FILE = '.template-state.json'
/** 备份目录（存在用户目录，不参与 Agent 扫描） */
const BACKUP_DIR = '.backup'
const MAX_BACKUPS = 5

interface TemplateState {
  version: number | null
  /** 模板内容指纹，兼容旧状态文件未记录此字段的情况 */
  fingerprint?: string
  /** prompts + skills 的内置文件（相对 workspace 根，posix 分隔） */
  files: string[]
  /** comfyui 的内置文件 */
  comfyFiles: string[]
  syncedAt: string
}

function statIfExists(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 所有文件操作都使用规范相对路径，并拒绝根目录及路径链中的符号链接。 */
function safePath(root: string, rel: string): string {
  const parts = rel.split('/')
  if (!rel || /[\\\u0000:]/.test(rel) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`不安全的模板路径：${rel}`)
  }
  const rootStat = statIfExists(root)
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw new Error(`模板根目录不是普通目录：${root}`)
  }
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = statIfExists(current)
    if (stat?.isSymbolicLink()) throw new Error(`模板路径包含符号链接：${rel}`)
    if (stat && index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`模板路径的父级不是目录：${rel}`)
    }
  }
  return current
}

function existingFile(root: string, rel: string): boolean {
  const stat = statIfExists(safePath(root, rel))
  if (stat && !stat.isFile()) throw new Error(`模板目标不是普通文件：${rel}`)
  return Boolean(stat)
}

/** 清单缺失、不可读或非法时中止同步，不能反复重置用户内容。 */
function readTemplateVersion(): number {
  const parsed = JSON.parse(fs.readFileSync(safePath(TEMPLATE_DIR, MANIFEST_FILE), 'utf8'))
  if (!Number.isSafeInteger(parsed?.version) || parsed.version < 1) {
    throw new Error('内置模板版本必须为正整数')
  }
  return parsed.version
}

/** 扫描失败必须上抛；只有完整扫描成功后才能判断哪些内置文件已废弃。 */
function walkFiles(root: string, rel: string): string[] {
  const dir = safePath(root, rel)
  if (!statIfExists(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`
    safePath(root, childRel)
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel))
    else if (entry.isFile()) out.push(childRel)
    else throw new Error(`模板包含非普通文件：${childRel}`)
  }
  return out.sort()
}

function readState(): TemplateState | null {
  const file = safePath(WORKSPACE_DIR, STATE_FILE)
  if (!statIfExists(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object'
    || (parsed.version !== null && (!Number.isSafeInteger(parsed.version) || parsed.version < 1))) {
    throw new Error('模板同步状态损坏，跳过本次同步')
  }
  const toList = (value: unknown, dirs: readonly string[]): string[] => {
    if (!Array.isArray(value)) throw new Error('模板同步文件清单损坏')
    for (const rel of value) {
      if (typeof rel !== 'string' || !dirs.some(dir => rel.startsWith(`${dir}/`))) {
        throw new Error('模板同步清单包含非允许目录')
      }
      safePath(WORKSPACE_DIR, rel)
    }
    return [...new Set(value)]
  }
  return {
    version: parsed.version,
    fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : undefined,
    files: toList(parsed.files, VERSIONED_DIRS),
    comfyFiles: toList(parsed.comfyFiles, ALWAYS_DIRS),
    syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
  }
}

function templateFingerprint(root: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(JSON.stringify(rel)).update('\0')
    hash.update(createHash('sha256').update(fs.readFileSync(safePath(root, rel))).digest())
  }
  return hash.digest('hex')
}

/** 原子写入同步状态，只有全部操作成功后才提交新版。 */
function writeState(state: TemplateState): void {
  const file = safePath(WORKSPACE_DIR, STATE_FILE)
  const tmp = safePath(WORKSPACE_DIR, `${STATE_FILE}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: 'wx' })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** 按备份时间保留最近五份，当前备份永远保留，不按版本字符串排序。 */
function pruneBackups(current: string): void {
  try {
    const root = safePath(WORKSPACE_DIR, BACKUP_DIR)
    const backups = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^v\d+-\d{14}(?:-|$)/.test(entry.name))
      .map(entry => {
        const rel = `${BACKUP_DIR}/${entry.name}`
        return { rel, time: fs.statSync(safePath(WORKSPACE_DIR, rel)).mtimeMs }
      })
      .sort((a, b) => b.time - a.time || b.rel.localeCompare(a.rel))
    const others = backups.filter(item => item.rel !== current)
    for (const item of others.slice(MAX_BACKUPS - 1)) {
      fs.rmSync(safePath(WORKSPACE_DIR, item.rel), { recursive: true, force: true })
    }
  } catch (error) {
    console.warn(`[workspace-sync] 旧备份清理失败：${(error as Error).message}`)
  }
}

/** 所有备份都成功且校验一致后才允许覆盖；失败直接抛出，原文件保留。 */
function backupFiles(files: string[], version: number): string {
  if (!files.length) return ''
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const relRoot = `${BACKUP_DIR}/v${version}-${stamp}-${randomUUID()}`
  const root = safePath(WORKSPACE_DIR, relRoot)
  fs.mkdirSync(root, { recursive: true })
  for (const rel of files) {
    const src = safePath(WORKSPACE_DIR, rel)
    const dest = safePath(root, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL)
    if (!fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      throw new Error(`模板备份校验失败：${rel}`)
    }
  }
  return relRoot
}

/** 只清理废弃内置文件的空父目录，不遍历或删除用户新建的空目录。 */
function removeEmptyDirs(files: string[]): void {
  for (const file of files) {
    let rel = path.posix.dirname(file)
    while (rel.includes('/')) {
      try {
        fs.rmdirSync(safePath(WORKSPACE_DIR, rel))
      } catch {
        break
      }
      rel = path.posix.dirname(rel)
    }
  }
}

/** 先把完整模板写到独立暂存区，任何读取或复制失败都不触碰当前文件。 */
function stageFiles(files: string[], stageRoot: string): void {
  for (const rel of files) {
    const src = safePath(TEMPLATE_DIR, rel)
    const dest = safePath(stageRoot, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL)
    if (!fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      throw new Error(`模板暂存校验失败：${rel}`)
    }
  }
}

/** 同步失败保留旧状态以便重试；部分应用失败时告知真实结果，不宣称升级完成。 */
export function syncWorkspaceTemplate(): WorkspaceSyncNotice | null {
  if (!TEMPLATE_DIR || !fs.existsSync(TEMPLATE_DIR)) return null
  const relative = path.relative(WORKSPACE_DIR, TEMPLATE_DIR)
  if (!relative) return null
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    console.warn('[workspace-sync] 模板目录不能位于可写工作目录内')
    return null
  }

  let stageRoot = ''
  let backupDir = ''
  let version: number | null = null
  let overwritten = 0
  let added = 0
  let removed = 0
  let failed = false
  let notice: WorkspaceSyncNotice | null = null
  try {
    // 校验版本、完整扫描并读取所有内容，成功后才允许改动用户目录。
    version = readTemplateVersion()
    const versioned = VERSIONED_DIRS.flatMap(dir => walkFiles(TEMPLATE_DIR, dir)).sort()
    const always = ALWAYS_DIRS.flatMap(dir => walkFiles(TEMPLATE_DIR, dir)).sort()
    const fingerprint = templateFingerprint(TEMPLATE_DIR, versioned)
    for (const rel of always) fs.readFileSync(safePath(TEMPLATE_DIR, rel))
    safePath(WORKSPACE_DIR, STATE_FILE)
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
    const state = readState()
    const obsolete = (state?.files || []).filter(rel => !versioned.includes(rel))
    // 内容指纹兜底：忘记递增版本时，新增/修改内置规范仍能更新到用户端。
    // 旧状态未记录指纹时先补建基线，不因迁移元数据而重置同版本用户编辑。
    const changed = !state || version !== state.version
      || (state.fingerprint !== undefined && fingerprint !== state.fingerprint)
      || obsolete.length > 0 || versioned.some(rel => !state.files.includes(rel))
    const apply = changed ? versioned : []
    const obsoleteComfy = (state?.comfyFiles || []).filter(rel => !always.includes(rel))
    const existing = new Set([...apply, ...obsolete, ...always, ...obsoleteComfy]
      .filter(rel => existingFile(WORKSPACE_DIR, rel)))

    stageRoot = safePath(WORKSPACE_DIR, `.workspace-sync-${randomUUID()}`)
    fs.mkdirSync(stageRoot)
    stageFiles([...apply, ...always], stageRoot)
    // 在任何覆盖或删除前，必须完整备份所有受影响的用户可编辑文件。
    backupDir = backupFiles([...apply, ...obsolete].filter(rel => existing.has(rel)), version)

    for (const rel of [...apply, ...always]) {
      const dest = safePath(WORKSPACE_DIR, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(safePath(stageRoot, rel), dest)
      if (apply.includes(rel)) {
        if (existing.has(rel)) overwritten++
        else added++
      }
    }
    for (const rel of [...obsolete, ...obsoleteComfy]) {
      if (!existing.has(rel)) continue
      fs.unlinkSync(safePath(WORKSPACE_DIR, rel))
      if (obsolete.includes(rel)) removed++
    }
    removeEmptyDirs([...obsolete, ...obsoleteComfy])

    // 纯删除操作重试时文件可能已不存在，仍需把上次的未完成通知更新为成功。
    const pending = getWorkspaceSyncNotice()
    if (overwritten > 0 || removed > 0) {
      notice = { version, syncedAt: new Date().toISOString(), overwritten, added, removed, backupDir, incomplete: false }
    } else if (pending?.incomplete && pending.version === version) {
      notice = { ...pending, syncedAt: new Date().toISOString(), incomplete: false }
    }
    // 告知落库同样必须成功，否则不提交新版状态，避免覆盖后用户永远收不到提示。
    if (notice) setWorkspaceSyncNotice(notice)
    // 不吞掉操作错误：只有全部成功后才写入版本，失败下次仍会重试。
    writeState({ version, fingerprint, files: versioned, comfyFiles: always, syncedAt: new Date().toISOString() })
    console.log(`[workspace-sync] 模板已同步 v${version}：覆盖 ${overwritten}，新增 ${added}，清理 ${removed}`)
  } catch (error) {
    failed = true
    console.warn(`[workspace-sync] 模板同步未完成，保留旧状态以便下次重试：${(error as Error).message}`)
  } finally {
    if (stageRoot) {
      try {
        fs.rmSync(stageRoot, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[workspace-sync] 暂存目录清理失败：${(error as Error).message}`)
      }
    }
  }

  if (failed && (notice || overwritten > 0 || removed > 0 || added > 0)) {
    notice = notice ? { ...notice, incomplete: true }
      : { version, syncedAt: new Date().toISOString(), overwritten, added, removed, backupDir, incomplete: true }
    try {
      setWorkspaceSyncNotice(notice)
    } catch (error) {
      console.warn(`[workspace-sync] 同步通知落库失败：${(error as Error).message}`)
    }
  }
  // 失败时保留所有备份，避免重试期间清理掉唯一的原始编辑内容。
  if (backupDir && !failed) pruneBackups(backupDir)
  return notice
}
