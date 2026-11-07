/**
 * 本地配音（Breeze-TTS-2）配置 — 存于 app_settings（key: local_tts_config）
 *
 * 与本地 ComfyUI 配置同构：key-value 落库、局部合并写入、无需建表或迁移。
 * 只保存路径与默认参数，不保存任何密钥、音频素材或模型权重。
 *
 * 该能力依赖本机 Windows + NVIDIA 显卡跑本地推理，配置在非 Windows 上也可保存，
 * 但安装与生成接口会统一拒绝（见 routes/localTts.ts）。
 */
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { DATA_ROOT } from '../../utils/paths.js'

const CONFIG_KEY = 'local_tts_config'

export const DEFAULT_GIT_URL = 'https://github.com/breezeblue-ai/breeze-tts.git'
/** 实测最自然的音色描述：程度词要克制，堆多了模型会过度表演 */
export const DEFAULT_INSTRUCTION = '二十岁出头、甜软、一点鼻音、细腻的气声、轻轻上挑'

export interface LocalTtsConfig {
  /** breeze-tts 推理工程根目录（git clone 的目标） */
  projectDir: string
  /** 模型权重目录；留空取 <projectDir>/breeze-tts-2 */
  modelDir: string
  /** 系统 Python 解释器；留空自动按 python / py -3 / python3 探测 */
  pythonPath: string
  /** 仓库地址，用户给的命令里就是这个 */
  gitUrl: string
  /** 是否使用工程内独立虚拟环境，避免污染系统 Python */
  useVenv: boolean
  /** 附加 pip 参数（如国内镜像 -i https://...），按空白拆分，不经过 shell */
  pipArgs: string
  /** 默认音色描述 */
  instruction: string
  /** 默认引导强度：纯设计/情绪控制 4.0，纯克隆 1.0 */
  cfgScale: number
  /** 默认随机种子 */
  seed: number
}

export function defaultLocalTtsConfig(): LocalTtsConfig {
  return {
    projectDir: path.join(DATA_ROOT, 'breeze-tts'),
    modelDir: '',
    pythonPath: '',
    gitUrl: DEFAULT_GIT_URL,
    useVenv: true,
    pipArgs: '',
    instruction: DEFAULT_INSTRUCTION,
    cfgScale: 4,
    seed: 42,
  }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback
}

function asNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** 与读取共用同一套规范化规则，避免脏数据进入 spawn 参数 */
function normalize(raw: unknown): LocalTtsConfig {
  const d = defaultLocalTtsConfig()
  const v = isObject(raw) ? raw : {}
  const gitUrl = asString(v.gitUrl)
  return {
    projectDir: asString(v.projectDir) || d.projectDir,
    modelDir: asString(v.modelDir),
    pythonPath: asString(v.pythonPath),
    gitUrl: /^https?:\/\/[^\s]+$/i.test(gitUrl) ? gitUrl : d.gitUrl,
    useVenv: v.useVenv !== false,
    pipArgs: asString(v.pipArgs).slice(0, 200),
    instruction: asString(v.instruction) || d.instruction,
    cfgScale: asNumber(v.cfgScale, d.cfgScale, 0.5, 10),
    seed: Math.round(asNumber(v.seed, d.seed, 0, 2_147_483_647)),
  }
}

export function getLocalTtsConfig(): LocalTtsConfig {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONFIG_KEY))
    .get()
  if (!row?.value) return defaultLocalTtsConfig()
  try {
    return normalize(JSON.parse(row.value))
  } catch {
    // 数据损坏时回退默认值，不拖垮设置页
    return defaultLocalTtsConfig()
  }
}

export function saveLocalTtsConfig(patch: unknown): LocalTtsConfig {
  const merged = normalize({ ...getLocalTtsConfig(), ...(isObject(patch) ? patch : {}) })
  db.insert(schema.appSettings)
    .values({ key: CONFIG_KEY, value: JSON.stringify(merged), updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(merged), updatedAt: now() },
    })
    .run()
  return merged
}

/** Windows 虚拟环境解释器；仅返回路径，是否可用由 env.ts 检测 */
export function venvPython(cfg: LocalTtsConfig): string {
  return path.join(cfg.projectDir, '.venv', 'Scripts', 'python.exe')
}

/** 实际跑 clone.py 的解释器：优先工程内 venv，其次用户指定，最后系统 python */
export function runtimePython(cfg: LocalTtsConfig): string {
  return cfg.useVenv ? venvPython(cfg) : (cfg.pythonPath || 'python')
}

/** 模型权重目录（留空时取工程内默认子目录） */
export function resolveModelDir(cfg: LocalTtsConfig): string {
  return cfg.modelDir || path.join(cfg.projectDir, 'breeze-tts-2')
}

/** 把附加参数拆成 argv；不经过 shell，天然规避命令注入 */
export function pipArgv(cfg: LocalTtsConfig): string[] {
  return cfg.pipArgs ? cfg.pipArgs.split(/\s+/).filter(Boolean) : []
}
