/**
 * FFmpeg 统一配置与可用性探测
 *
 * 背景：Windows 上若 node_modules 跨平台拷贝、或 ffmpeg-static postinstall
 * 下载损坏（HTML 错误页被存成 ffmpeg.exe），spawn 非 PE 文件会同步抛
 * EFTYPE；该异常发生在 fluent-ffmpeg 的延迟回调里，外层 try/catch 接不住，
 * 直接崩掉整个 Node 进程。这里在业务调用前主动 spawn -version 探测，
 * 不可用时由业务侧优雅降级（海报帧跳过 / 拼接返回明确错误）。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { createRequire } from 'module'

// ffmpeg-static / ffprobe-static 均为可选依赖：npm 安装时提供内置二进制；
// 桌面版打包不携带这两个 npm 包（二进制随 resources/bin 分发），缺失时走 FFMPEG_BIN/FFPROBE_BIN
const req = createRequire(import.meta.url)

function resolveStatic(moduleName: string): string | null {
  try {
    const mod = req(moduleName)
    return (moduleName === 'ffprobe-static' ? mod?.path : mod) ?? null
  } catch {
    return null
  }
}

/** 在 PATH 里查找可执行文件（dev/服务器常直接用系统安装的 ffmpeg） */
function findInPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 该目录下不存在，继续找 */
      }
    }
  }
  return null
}

/**
 * 按「显式环境变量 → 内置 npm 包 → 系统 PATH」取第一个真实存在的二进制。
 * npm 包的 postinstall 可能下载失败（目录在、文件不在），此时必须继续回退，
 * 否则 dev 模式明明装了系统 ffmpeg 也会被误判为不可用。
 */
function pickBinary(envValue: string | undefined, name: string, staticPath: string | null): string | null {
  const candidates = [envValue, staticPath, findInPath(name)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* 该候选不可用，继续回退 */
    }
  }
  return null
}

const ffmpegPath = pickBinary(process.env.FFMPEG_BIN, 'ffmpeg', resolveStatic('ffmpeg-static'))
const ffprobePath = pickBinary(process.env.FFPROBE_BIN, 'ffprobe', resolveStatic('ffprobe-static'))

// 系统未安装 ffmpeg 时使用项目内置二进制
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath)
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath)

export { ffmpeg }

/** spawn 一次 -version 验证二进制真实可执行（含同步 EFTYPE 兜底） */
function probeBinary(binPath: string | null): Promise<boolean> {
  if (!binPath || !fs.existsSync(binPath)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 10_000)
    let child
    try {
      child = spawn(binPath, ['-version'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Windows 上 spawn 非 PE 文件（如下载损坏的 ffmpeg.exe）会同步抛 EFTYPE
      finish(false)
      return
    }
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

export interface FfmpegSuite {
  ffmpeg: boolean
  ffprobe: boolean
}

// 成功的探测结果缓存（进程内只探测一次）；失败不缓存，修复二进制后无需重启即可恢复
let okCache: FfmpegSuite | null = null
let warned = false

/** 探测内置 ffmpeg/ffprobe 是否可用 */
export async function checkFfmpegSuite(): Promise<FfmpegSuite> {
  if (okCache) return okCache
  const [ffmpegOk, ffprobeOk] = await Promise.all([probeBinary(ffmpegPath), probeBinary(ffprobePath)])
  const suite = { ffmpeg: ffmpegOk, ffprobe: ffprobeOk }
  if (ffmpegOk && ffprobeOk) {
    okCache = suite
  } else if (!warned) {
    warned = true
    console.warn(
      `[ffmpeg] 未找到可用的可执行文件 (ffmpeg=${ffmpegOk ? 'ok' : 'FAIL'}, ffprobe=${ffprobeOk ? 'ok' : 'FAIL'})。`
      + `已依次尝试 FFMPEG_BIN/FFPROBE_BIN、node_modules 内置包、系统 PATH。`
      + `海报帧提取与视频拼接将跳过/失败。修复：安装系统 ffmpeg（brew install ffmpeg / apt install ffmpeg），`
      + `或设置 FFMPEG_BIN/FFPROBE_BIN 指向有效可执行文件`
    )
  }
  return suite
}
