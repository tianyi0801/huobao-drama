/**
 * 本地配音任务执行器 — 环境安装 / 语音生成共用一套「后台任务 + 增量日志」模型
 *
 * 设计取舍：
 * - 前端按 1.2s 轮询 GET /jobs/:id?since=N 拉增量日志，与现有生成任务轮询范式一致，
 *   断线重连天然安全，也不需要在 SSE 上处理代理缓冲。
 * - 任务与日志只留在进程内（重启即丢），属于过程性信息，不落库。
 * - 所有外部程序都用 spawn + argv 数组调用，绝不拼 shell 字符串，规避命令注入。
 */
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DATA_ROOT, STORAGE_ROOT } from '../../utils/paths.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { inspectWav } from './wav.js'
import {
  getLocalTtsConfig,
  pipArgv,
  runtimePython,
  venvPython,
  type LocalTtsConfig,
} from './config.js'
import { probe, resolveBasePython } from './env.js'

export type JobKind = 'install' | 'generate'
export type JobStatus = 'running' | 'done' | 'failed'

export interface TtsJob {
  id: string
  kind: JobKind
  status: JobStatus
  startedAt: string
  endedAt?: string
  logs: string[]
  result?: any
  error?: string
}

export interface GenerateInput {
  text: string
  instruction?: string
  /** 前端上传返回的相对路径，形如 static/uploads/xxx.wav */
  refAudio?: string
  refText?: string
  cfgScale?: number
  seed?: number
  name?: string
}

const MAX_JOBS = 30
const MAX_LOGS = 800
const INSTALL_TIMEOUT_MS = 60 * 60 * 1000
const GENERATE_TIMEOUT_MS = 20 * 60 * 1000

const jobs = new Map<string, TtsJob>()
const activeChildren = new Map<string, ChildProcess>()

function pushLog(job: TtsJob, line: string) {
  job.logs.push(line)
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS)
}

function trimJobs() {
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined || jobs.get(oldest)?.status === 'running') break
    jobs.delete(oldest)
  }
}

export function getJob(id: string): TtsJob | undefined {
  return jobs.get(id)
}

export function hasRunningJob(): boolean {
  for (const job of jobs.values()) if (job.status === 'running') return true
  return false
}

/** 供轮询接口取增量日志：nextSince 作为下一次请求的 since */
export function jobSnapshot(id: string, since = 0) {
  const job = jobs.get(id)
  if (!job) return null
  const start = Math.max(0, Math.min(since, job.logs.length))
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    logs: job.logs.slice(start),
    nextSince: job.logs.length,
    result: job.result,
    error: job.error,
  }
}

export function startJob(kind: JobKind, run: (job: TtsJob) => Promise<any>): TtsJob {
  if (hasRunningJob()) throw new Error('已有任务在执行中，请等待完成或先停止')
  const job: TtsJob = {
    id: randomUUID(),
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    logs: [],
  }
  jobs.set(job.id, job)
  trimJobs()

  void run(job).then(result => {
    if (job.status !== 'running') return
    job.status = 'done'
    job.endedAt = new Date().toISOString()
    job.result = result ?? null
    pushLog(job, `✅ ${kind === 'install' ? '环境安装' : '语音生成'}完成`)
  }).catch((error: any) => {
    if (job.status !== 'running') return
    job.status = 'failed'
    job.endedAt = new Date().toISOString()
    job.error = error?.message || '任务执行失败'
    pushLog(job, `❌ ${job.error}`)
  }).finally(() => {
    activeChildren.delete(job.id)
  })

  return job
}

export function cancelJob(id: string): TtsJob {
  const job = jobs.get(id)
  if (!job) throw new Error('任务不存在')
  if (job.status !== 'running') return job
  activeChildren.get(id)?.kill()
  job.status = 'failed'
  job.endedAt = new Date().toISOString()
  job.error = '已手动停止'
  pushLog(job, '⏹ 已手动停止')
  return job
}

/** 把子进程的 stdout/stderr 逐行转成日志；去掉进度条 ANSI 转义与回车残留 */
function attachOutput(job: TtsJob, stream: NodeJS.ReadableStream | null): () => void {
  let pending = ''
  const emitLine = (raw: string) => {
    const line = raw.replace(/\r/g, '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim()
    if (line) pushLog(job, line.slice(0, 500))
  }
  stream?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let idx = pending.indexOf('\n')
    while (idx >= 0) {
      emitLine(pending.slice(0, idx))
      pending = pending.slice(idx + 1)
      idx = pending.indexOf('\n')
    }
    // pip 的进度条用 \r 而非 \n，长时间不换行时按长度兜底切分
    if (pending.length > 1000) {
      emitLine(pending.slice(0, 1000))
      pending = pending.slice(1000)
    }
  })
  return () => { if (pending.trim()) emitLine(pending) }
}

function runCommand(
  job: TtsJob,
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  pushLog(job, `$ ${[cmd, ...args].join(' ')}`)
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined
    let settled = false
    // 先占位，避免 spawn 同步抛错时 finish 访问尚未初始化的刷洗函数（TDZ）
    let flushStdout: () => void = () => {}
    let flushStderr: () => void = () => {}
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChildren.delete(job.id)
      flushStdout()
      flushStderr()
      fn()
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish(() => reject(new Error(`命令超时（${Math.round(timeoutMs / 60000)} 分钟），已终止`)))
    }, timeoutMs)

    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          // Windows cmd 代码页会乱码，统一让 Python 侧用 UTF-8 输出
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      })
    } catch (error: any) {
      finish(() => reject(new Error(`无法启动 ${cmd}：${error?.message || '未知错误'}`)))
      return
    }
    activeChildren.set(job.id, child)
    flushStdout = attachOutput(job, child.stdout)
    flushStderr = attachOutput(job, child.stderr)
    child.on('error', (error: any) => finish(() => reject(new Error(`无法启动 ${cmd}：${error?.message || '未知错误'}`))))
    child.on('close', code => {
      if (job.status !== 'running') return finish(() => resolve())
      finish(() => code === 0
        ? resolve()
        : reject(new Error(`${path.basename(cmd)} 退出码 ${code}，详见上方日志`)))
    })
  })
}

/**
 * 一键安装环境，等价用户给的命令：
 *   git clone <url> <目录>
 *   cd <目录> && python -m venv .venv   （可选，默认开启隔离）
 *   python -m pip install -r requirements.txt
 * 每一步幂等：已有工程 / 已有虚拟环境时跳过，避免重复下载。
 */
export async function installEnvironment(job: TtsJob) {
  const cfg = getLocalTtsConfig()
  const dir = cfg.projectDir
  pushLog(job, '开始配置本地配音环境（仅 Windows 支持）')

  const python = await resolveBasePython(cfg)
  if (!python) throw new Error('未找到可用的 Python 3，请先安装 Python 3.10+ 并勾选「Add Python to PATH」')
  pushLog(job, `检测到 ${python.version}（${[python.cmd, ...python.prefix].join(' ')}）`)

  const requirements = path.join(dir, 'requirements.txt')
  if (!fs.existsSync(requirements)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      throw new Error(`目标目录已存在但不是 Breeze-TTS 工程（缺少 requirements.txt）：${dir}，请更换工程目录或手动清理`)
    }
    const git = await probe('git', ['--version'], 6000)
    if (!git.ok) throw new Error('未找到 git，请安装 Git for Windows 后重试')
    // 用户可能填了多层新目录，git clone 不会自动补齐中间层级
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    await runCommand(job, 'git', ['clone', cfg.gitUrl, dir], { timeoutMs: INSTALL_TIMEOUT_MS })
  } else {
    pushLog(job, `工程已存在，跳过 git clone：${dir}`)
  }
  if (!fs.existsSync(requirements)) throw new Error('git clone 后仍未找到 requirements.txt，请检查仓库地址')

  let runCmd = python.cmd
  let prefix = python.prefix
  if (cfg.useVenv) {
    const venv = venvPython(cfg)
    if (!fs.existsSync(venv)) {
      pushLog(job, '创建独立虚拟环境 .venv（不污染系统 Python）')
      await runCommand(job, python.cmd, [...python.prefix, '-m', 'venv', '.venv'], { cwd: dir, timeoutMs: 10 * 60 * 1000 })
    } else {
      pushLog(job, '虚拟环境已存在，跳过创建')
    }
    if (!fs.existsSync(venvPython(cfg))) throw new Error('虚拟环境创建失败，未找到 .venv/Scripts/python.exe')
    runCmd = venv
    prefix = []
  }

  pushLog(job, '安装 Python 依赖（torch 较大，首次可能需要几分钟到几十分钟）')
  await runCommand(job, runCmd, [...prefix, '-m', 'pip', 'install', '-r', 'requirements.txt', ...pipArgv(cfg)], {
    cwd: dir,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })

  if (!fs.existsSync(path.join(dir, 'clone.py'))) {
    pushLog(job, '⚠️ 仓库中未找到 clone.py，请确认仓库版本是否提供该推理入口')
  }
  pushLog(job, '提示：模型权重通常不包含在 git 仓库中，若检测页提示权重缺失，请按仓库说明下载后再生成')

  return { projectDir: dir, python: runCmd, useVenv: cfg.useVenv }
}

function modeOf(input: GenerateInput): 'design' | 'clone' | 'direction' {
  if (input.refAudio && input.instruction) return 'direction'
  if (input.refAudio) return 'clone'
  return 'design'
}

function safeName(name?: string): string {
  const cleaned = (name || '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '').slice(0, 40)
  return cleaned || new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
}

/** 生成语音：写 job JSON → 调 clone.py → 校验 wav → 返回可直接试听的静态地址 */
export async function generateSpeech(job: TtsJob, input: GenerateInput) {
  const cfg: LocalTtsConfig = getLocalTtsConfig()
  const clonePy = path.join(cfg.projectDir, 'clone.py')
  if (!fs.existsSync(clonePy)) throw new Error(`未找到推理入口 ${clonePy}，请先安装环境`)

  let pythonCmd = runtimePython(cfg)
  let pythonPrefix: string[] = []
  if (!cfg.useVenv) {
    // 不用虚拟环境时系统 Python 可能只有「py -3」可用，不能写死 'python'
    const base = cfg.pythonPath
      ? { cmd: cfg.pythonPath, prefix: [] as string[] }
      : await resolveBasePython(cfg)
    if (!base) throw new Error('未找到可用的 Python 3，请先安装 Python 3.10+ 并勾选「Add Python to PATH」')
    pythonCmd = base.cmd
    pythonPrefix = base.prefix
  }
  if (cfg.useVenv && !fs.existsSync(pythonCmd)) {
    throw new Error(`Python 解释器不存在：${pythonCmd}，请先安装环境`)
  }

  const outDir = path.join(STORAGE_ROOT, 'tts')
  fs.mkdirSync(outDir, { recursive: true })
  const filename = `${safeName(input.name)}_${Date.now().toString(36)}.wav`
  const outPath = path.join(outDir, filename)

  const mode = modeOf(input)
  const cfgScale = typeof input.cfgScale === 'number'
    ? input.cfgScale
    : (mode === 'clone' ? 1 : 4)
  const seed = typeof input.seed === 'number' ? input.seed : cfg.seed

  // 中文文本与音色描述全部走 UTF-8 JSON 文件，不进命令行（Windows cmd 代码页会乱码）
  const payload: Record<string, any> = {
    text: input.text,
    cfg_scale: cfgScale,
    seed,
    output: outPath,
  }
  if (input.instruction) payload.instruction = input.instruction
  if (input.refAudio) {
    payload.ref_audio = getAbsolutePath(input.refAudio)
    payload.ref_text = input.refText
  }

  const jobDir = path.join(DATA_ROOT, 'tts', 'jobs')
  fs.mkdirSync(jobDir, { recursive: true })
  const jobPath = path.join(jobDir, `${job.id}.json`)
  fs.writeFileSync(jobPath, JSON.stringify(payload, null, 2), 'utf8')

  pushLog(job, `模式：${mode === 'design' ? '音色设计' : mode === 'clone' ? '声音克隆' : '克隆 + 情绪控制'}`)
  pushLog(job, `参数：cfg_scale=${cfgScale}  seed=${seed}`)
  pushLog(job, `文本：${input.text.slice(0, 80)}${input.text.length > 80 ? '…' : ''}`)

  try {
    await runCommand(job, pythonCmd, [...pythonPrefix, clonePy, jobPath], {
      cwd: cfg.projectDir,
      timeoutMs: GENERATE_TIMEOUT_MS,
    })
  } finally {
    fs.rmSync(jobPath, { force: true })
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    throw new Error('未产出有效 wav，请查看上方日志（常见原因：显存不足 / 模型权重缺失）')
  }
  const metrics = inspectWav(outPath)
  pushLog(job, `校验：${metrics.duration}s · peak ${metrics.peak} · rms ${metrics.rms} · 静音 ${(metrics.silenceRatio * 100).toFixed(1)}% · ${metrics.verdict}`)
  if (metrics.verdict === 'FAIL') throw new Error(`产出音频未通过校验：${metrics.reason}`)

  return {
    name: filename,
    url: `/static/tts/${filename}`,
    path: `static/tts/${filename}`,
    // 用户需要在资源管理器里找到文件，磁盘绝对路径直接给前端展示/复制
    absolutePath: outPath,
    mode,
    text: input.text,
    instruction: input.instruction || '',
    cfgScale,
    seed,
    metrics,
  }
}

/** 历史产出（最近 N 个 wav），前端列表直接试听 */
export function listOutputs(limit = 30) {
  const dir = path.join(STORAGE_ROOT, 'tts')
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.wav'))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name))
        return {
          name,
          url: `/static/tts/${name}`,
          path: `static/tts/${name}`,
          absolutePath: path.join(dir, name),
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  } catch {
    return []
  }
}
