/**
 * 本地配音环境检测 — 「音频制作」页环境卡的数据源
 *
 * 分层检测，互相独立的探测全部并发，短超时：Windows 上没装 Python / git 时
 * 页面也必须尽快返回，不能让某个探测的超时串行累加拖住首屏。
 * 轻量检测：平台、Python、pip、git、工程目录、虚拟环境、权重、显卡、磁盘、输出目录。
 * 深度检测：额外 import 关键依赖（首次 import torch 较慢，单独放深度档）。
 *
 * 只在 Windows 支持：非 win32 时直接返回 supported=false，不执行任何本机命令探测。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  getLocalTtsConfig,
  resolveModelDir,
  venvPython,
  type LocalTtsConfig,
} from './config.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { volumeFreeBytes } from '../../utils/dirsize.js'

export type CheckLevel = 'blocker' | 'warning' | 'info'

export interface EnvCheck {
  key: string
  label: string
  ok: boolean
  level: CheckLevel
  detail: string
}

export interface GpuInfo {
  name: string
  memoryTotalMiB: number
  memoryUsedMiB: number
}

export interface LocalTtsEnvReport {
  supported: boolean
  platform: string
  ready: boolean
  deepChecked: boolean
  checkedAt: string
  config: LocalTtsConfig
  checks: EnvCheck[]
  blockers: string[]
  warnings: string[]
  gpu: GpuInfo | null
  diskFreeGiB: number | null
}

export interface ProbeResult {
  ok: boolean
  output: string
}

/** 执行一次本机命令并回收输出；所有调用都带超时，避免拖住页面 */
export function probe(cmd: string, args: string[], timeoutMs = 8000): Promise<ProbeResult> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: output.trim() })
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish(false)
    }, timeoutMs)

    try {
      // Windows 上中文文本统一走 UTF-8，避免 cmd 代码页乱码
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch {
      finish(false)
      return
    }
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 4000) output = output.slice(-4000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish(false))
    child.on('close', code => finish(code === 0))
  })
}

export interface PythonCommand {
  cmd: string
  /** py launcher 需要 -3 前缀，python/python3 不需要 */
  prefix: string[]
  version: string
}

/**
 * 找可用的系统 Python：显式配置 → python → py -3 → python3。
 * Windows 上「py -3」是官方 launcher，比 App Execution Alias 的 python.exe 可靠。
 * 候选并发探测（按声明顺序取第一个成功），避免某个候选超时拖累整体。
 */
export async function resolveBasePython(cfg: LocalTtsConfig): Promise<PythonCommand | null> {
  const candidates: Array<{ cmd: string; prefix: string[] }> = cfg.pythonPath
    ? [{ cmd: cfg.pythonPath, prefix: [] }]
    : [
        { cmd: 'python', prefix: [] },
        { cmd: 'py', prefix: ['-3'] },
        { cmd: 'python3', prefix: [] },
      ]
  const results = await Promise.all(
    candidates.map(c => probe(c.cmd, [...c.prefix, '--version'], 6000)),
  )
  for (let i = 0; i < candidates.length; i++) {
    const result = results[i]
    if (result.ok && /Python\s+\d+\.\d+/i.test(result.output)) {
      return { ...candidates[i], version: result.output.split(/\r?\n/)[0] }
    }
  }
  return null
}

export function isWindowsSupported(): boolean {
  return process.platform === 'win32'
}

/** 8GB 卡实测：显存已占 >2GiB 时本地推理几乎必然 OOM */
const VRAM_WARN_MIB = 2048

export async function collectLocalTtsEnv(deep = false): Promise<LocalTtsEnvReport> {
  const cfg = getLocalTtsConfig()
  const checks: EnvCheck[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  const add = (key: string, label: string, ok: boolean, level: CheckLevel, detail: string) => {
    checks.push({ key, label, ok, level, detail })
    if (!ok && level === 'blocker') blockers.push(`${label}：${detail}`)
    if (!ok && level === 'warning') warnings.push(`${label}：${detail}`)
  }

  const base: Omit<LocalTtsEnvReport, 'supported' | 'ready' | 'checks' | 'blockers' | 'warnings' | 'gpu' | 'diskFreeGiB'> = {
    platform: process.platform,
    deepChecked: deep,
    checkedAt: new Date().toISOString(),
    config: cfg,
  }
  const empty = { gpu: null as GpuInfo | null, diskFreeGiB: null as number | null }

  // 平台是硬门槛，非 Windows 直接返回，不在 macOS / Linux 上探测本机命令
  if (!isWindowsSupported()) {
    add('platform', '操作系统', false, 'blocker', '本地配音仅支持 Windows（需 NVIDIA CUDA 与 Windows 版 Python）')
    return {
      ...base, ...empty, supported: false, ready: false,
      checks, blockers, warnings: [],
    }
  }
  add('platform', '操作系统', true, 'info', 'Windows（支持本地推理）')

  // 输出目录先建好，statfs 才能取到磁盘余量
  let outputOk = false
  try {
    fs.mkdirSync(path.join(STORAGE_ROOT, 'tts'), { recursive: true })
    outputOk = true
  } catch { /* 权限不足 */ }

  // 第一批：彼此独立的本机探测并发执行，总耗时取决于最慢的一项
  const [python, git, gpuProbe, free] = await Promise.all([
    resolveBasePython(cfg),
    probe('git', ['--version'], 6000),
    probe('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], 10_000),
    volumeFreeBytes(STORAGE_ROOT),
  ])

  // 不用 venv 时复用 resolveBasePython 的结果：Windows 上可能只有「py -3」可用，
  // 直接 spawn('python') 会命中无效的 App Execution Alias
  const venvPath = venvPython(cfg)
  const hasVenv = fs.existsSync(venvPath)
  const runtimeCmd = cfg.useVenv ? venvPath : (python?.cmd ?? 'python')
  const runtimePrefix = cfg.useVenv ? [] : (python?.prefix ?? [])
  const runtimeOk = cfg.useVenv ? hasVenv : !!python

  // 第二批：依赖 Python 结果的探测同样并发（深度检测才额外 import 依赖）
  const [pip, runtimeProbe, deps] = await Promise.all([
    python
      ? probe(python.cmd, [...python.prefix, '-m', 'pip', '--version'], 8000)
      : Promise.resolve({ ok: false, output: '' }),
    runtimeOk
      ? probe(runtimeCmd, [...runtimePrefix, '--version'], 6000)
      : Promise.resolve({ ok: false, output: '' }),
    deep && runtimeOk
      ? probe(runtimeCmd, [...runtimePrefix, '-c', 'import torch, soundfile; print("deps-ok")'], 90_000)
      : Promise.resolve(null),
  ])

  // --- Python / pip ---
  const versionMatch = python?.version.match(/Python\s+(\d+)\.(\d+)/i)
  const minorOk = versionMatch ? Number(versionMatch[1]) > 3 || (Number(versionMatch[1]) === 3 && Number(versionMatch[2]) >= 10) : false
  add('python', 'Python', !!python, 'blocker',
    python ? `${python.version}${minorOk ? '' : '（建议 3.10 以上，推荐 3.12）'}` : '未找到 Python，请安装 3.10+ 并勾选「Add Python to PATH」')
  if (python && !minorOk) {
    add('pythonVersion', 'Python 版本', false, 'warning', '当前版本偏低，建议改用 3.12')
  }
  add('pip', 'pip', pip.ok, 'blocker', pip.ok ? pip.output.split(/\r?\n/)[0] : 'python -m pip 不可用，请修复 Python 安装')

  // --- git（仅工程尚未拉取时是硬门槛） ---
  const projectExists = fs.existsSync(cfg.projectDir)
  const hasRequirements = fs.existsSync(path.join(cfg.projectDir, 'requirements.txt'))
  const gitLevel: CheckLevel = hasRequirements ? 'warning' : 'blocker'
  add('git', 'Git', git.ok, gitLevel, git.ok ? git.output.split(/\r?\n/)[0] : '未找到 git，无法自动拉取推理工程')

  // --- 工程目录 ---
  const hasClone = fs.existsSync(path.join(cfg.projectDir, 'clone.py'))
  add('project', '推理工程', projectExists && hasRequirements, 'blocker',
    !projectExists ? `目录不存在：${cfg.projectDir}，可点「一键安装环境」自动 git clone`
      : !hasRequirements ? '缺少 requirements.txt，请确认工程目录是否正确'
        : cfg.projectDir)
  add('entry', '推理入口', hasClone, 'blocker',
    hasClone ? 'clone.py 已就绪' : '缺少 clone.py，请确认仓库版本或手动指定推理入口')

  // --- 虚拟环境与运行时 ---
  if (cfg.useVenv) {
    add('venv', '虚拟环境', hasVenv, 'blocker',
      hasVenv ? venvPath : '尚未创建 .venv，可点「一键安装环境」自动创建')
  } else {
    add('venv', '虚拟环境', true, 'info', '按配置使用系统 Python（未启用独立虚拟环境）')
  }
  add('runtime', '运行时解释器', runtimeProbe.ok, 'blocker',
    runtimeProbe.ok ? `${[runtimeCmd, ...runtimePrefix].join(' ')} · ${runtimeProbe.output.split(/\r?\n/)[0]}` : `${runtimeCmd} 不可执行`)

  if (deep) {
    add('deps', '关键依赖', deps?.ok === true, 'blocker',
      deps?.ok ? 'torch / soundfile 可正常导入' : 'torch 或 soundfile 导入失败，请先执行「一键安装环境」')
  }

  // --- 模型权重 ---
  const modelDir = resolveModelDir(cfg)
  let weightOk = false
  if (fs.existsSync(modelDir)) {
    try {
      weightOk = fs.readdirSync(modelDir).some(f => f.endsWith('.safetensors') || f === 'model.safetensors.index.json')
    } catch { /* 目录不可读按缺失处理 */ }
  }
  add('weights', '模型权重', weightOk, 'warning',
    weightOk ? modelDir : `未在 ${modelDir} 找到权重，请按仓库说明下载（推理若报找不到模型即为此项）`)

  // --- 显卡 / 显存 ---
  let gpu: GpuInfo | null = null
  if (gpuProbe.ok) {
    const parts = gpuProbe.output.split(/\r?\n/)[0]?.split(',').map(s => s.trim()) || []
    const total = Number(parts[1])
    const used = Number(parts[2])
    if (parts[0] && Number.isFinite(total)) {
      gpu = { name: parts[0], memoryTotalMiB: total, memoryUsedMiB: Number.isFinite(used) ? used : 0 }
    }
  }
  add('gpu', 'NVIDIA 显卡', !!gpu, 'warning',
    gpu ? `${gpu.name} · 显存 ${gpu.memoryTotalMiB}MiB，已占 ${gpu.memoryUsedMiB}MiB` : '未检测到 NVIDIA 显卡，本地推理可能不可用')
  if (gpu && gpu.memoryUsedMiB > VRAM_WARN_MIB) {
    add('vram', '显存占用', false, 'warning', `已占 ${gpu.memoryUsedMiB}MiB，8GB 卡上建议先关闭占用显存的程序再生成`)
  }

  // --- 输出目录 / 磁盘 ---
  add('output', '输出目录', outputOk, 'blocker',
    outputOk ? path.join(STORAGE_ROOT, 'tts') : '输出目录不可写，请检查数据目录权限')
  const diskFreeGiB = free === null ? null : Math.round((free / 1024 ** 3) * 10) / 10
  if (diskFreeGiB !== null) {
    add('disk', '磁盘空间', diskFreeGiB >= 10, 'warning',
      `剩余 ${diskFreeGiB} GiB${diskFreeGiB < 10 ? '，模型权重较大，建议预留 10GiB 以上' : ''}`)
  }

  return {
    ...base,
    supported: true,
    ready: blockers.length === 0,
    gpu,
    diskFreeGiB,
    checks,
    blockers,
    warnings,
  }
}
