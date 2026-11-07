/**
 * 本地配音（Breeze-TTS-2）路由
 *
 * GET  /                 轻量状态：平台是否支持 + 当前配置（不探测本机命令，首屏秒回）
 * POST /test             环境检测，body.deep=true 时额外校验关键依赖可导入
 * PUT  /config           保存工程目录 / Python / 仓库地址 / 默认参数
 * POST /install          一键安装环境（git clone → venv → pip install），返回任务 id
 * POST /generate         生成语音，返回任务 id
 * GET  /jobs/:id         轮询任务状态与增量日志（since）
 * POST /jobs/:id/cancel  停止正在执行的任务
 * GET  /outputs          历史 wav 列表
 *
 * 平台约束：安装与生成只在 win32 上放行；其余接口在非 Windows 上可用于查看配置与提示。
 */
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import { collectLocalTtsEnv, isWindowsSupported } from '../services/local-tts/env.js'
import { getLocalTtsConfig, saveLocalTtsConfig } from '../services/local-tts/config.js'
import {
  cancelJob,
  generateSpeech,
  getJob,
  hasRunningJob,
  installEnvironment,
  jobSnapshot,
  listOutputs,
  startJob,
  type GenerateInput,
} from '../services/local-tts/runner.js'

const app = new Hono()
const WIN_ONLY = '本地配音仅支持 Windows（需 NVIDIA CUDA 与 Windows 版 Python），当前系统不可用'

const CONFIG_KEYS = [
  'projectDir', 'modelDir', 'pythonPath', 'gitUrl', 'useVenv',
  'pipArgs', 'instruction', 'cfgScale', 'seed',
] as const

app.get('/', (c) => {
  return success(c, {
    supported: isWindowsSupported(),
    platform: process.platform,
    config: getLocalTtsConfig(),
    running: hasRunningJob(),
    windowsOnlyHint: WIN_ONLY,
  })
})

app.post('/test', async (c) => {
  let body: any = {}
  try { body = await c.req.json() } catch { /* 允许空 body */ }
  try {
    return success(c, await collectLocalTtsEnv(body?.deep === true))
  } catch (error: any) {
    return badRequest(c, error?.message || '环境检测失败')
  }
})

app.put('/config', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, '请求体不是合法 JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(c, '请求体格式错误')
  const patch: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) if (key in body) patch[key] = body[key]
  if (!Object.keys(patch).length) return badRequest(c, '没有可更新的字段')
  try {
    return success(c, saveLocalTtsConfig(patch))
  } catch (error: any) {
    return badRequest(c, error?.message || '保存本地配音配置失败')
  }
})

app.post('/install', (c) => {
  if (!isWindowsSupported()) return badRequest(c, WIN_ONLY)
  if (hasRunningJob()) return badRequest(c, '已有任务在执行中，请等待完成或先停止')
  try {
    const job = startJob('install', installEnvironment)
    return success(c, { id: job.id })
  } catch (error: any) {
    return badRequest(c, error?.message || '启动环境安装失败')
  }
})

app.post('/generate', async (c) => {
  if (!isWindowsSupported()) return badRequest(c, WIN_ONLY)
  let body: any
  try { body = await c.req.json() } catch { return badRequest(c, '请求体不是合法 JSON') }

  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return badRequest(c, '请输入要合成的文本')
  if (text.length > 2000) return badRequest(c, '单次合成文本请控制在 2000 字以内')

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
  if (instruction.length > 300) return badRequest(c, '音色描述请控制在 300 字以内')

  const refAudio = typeof body.refAudio === 'string' ? body.refAudio.trim() : ''
  const refText = typeof body.refText === 'string' ? body.refText.trim() : ''
  if (!!refAudio !== !!refText) return badRequest(c, '参考音频与逐字稿必须同时提供')
  // 只允许引用本应用静态目录内的上传文件，避免把任意本机路径传给推理脚本
  if (refAudio && (!refAudio.startsWith('static/') || refAudio.includes('..'))) {
    return badRequest(c, '参考音频路径不合法')
  }

  const cfgScale = body.cfgScale === undefined || body.cfgScale === null ? undefined : Number(body.cfgScale)
  if (cfgScale !== undefined && (!Number.isFinite(cfgScale) || cfgScale < 0.5 || cfgScale > 10)) {
    return badRequest(c, 'cfg_scale 需在 0.5 ~ 10 之间')
  }
  const seed = body.seed === undefined || body.seed === null ? undefined : Number(body.seed)
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647)) {
    return badRequest(c, 'seed 需为非负整数')
  }

  const input: GenerateInput = {
    text,
    ...(instruction ? { instruction } : {}),
    ...(refAudio ? { refAudio, refText } : {}),
    ...(cfgScale !== undefined ? { cfgScale } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
  }

  if (hasRunningJob()) return badRequest(c, '已有任务在执行中，请等待完成或先停止')
  try {
    const job = startJob('generate', j => generateSpeech(j, input))
    return success(c, { id: job.id })
  } catch (error: any) {
    return badRequest(c, error?.message || '启动语音生成失败')
  }
})

app.get('/jobs/:id', (c) => {
  const id = c.req.param('id')
  if (!getJob(id)) return notFound(c, '任务不存在')
  const since = Number(c.req.query('since') || 0)
  return success(c, jobSnapshot(id, Number.isFinite(since) ? since : 0))
})

app.post('/jobs/:id/cancel', (c) => {
  try {
    const job = cancelJob(c.req.param('id'))
    return success(c, { id: job.id, status: job.status })
  } catch (error: any) {
    return notFound(c, error?.message || '任务不存在')
  }
})

app.get('/outputs', (c) => success(c, listOutputs()))

export default app
