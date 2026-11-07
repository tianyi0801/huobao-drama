/**
 * 应用设置路由 — 全局配置的读写入口（当前：AI 内容语言）
 */
import { Hono } from 'hono'
import {
  getContentLanguage,
  setContentLanguage,
  getToursSeen,
  setToursSeen,
  getWorkspaceSyncNotice,
  setWorkspaceSyncNotice,
  getThinkingMode,
  setThinkingMode,
  CONTENT_LANGUAGES,
  type ContentLanguage,
} from '../services/app-settings.js'
import { getComfyConfig, isComfyReadyFor } from '../services/comfyui/config.js'
import { success, badRequest } from '../utils/response.js'

const app = new Hono()

// GET /local-engine — 本地算力是否就绪（首页未配置引导用，不发起网络探测）
app.get('/local-engine', async (c) => {
  const config = getComfyConfig()
  return success(c, {
    enabled: config.enabled,
    url: config.url,
    imageReady: isComfyReadyFor('image'),
    // 按槽拆分的就绪状态：文生图页必须检查 image 槽本身，
    // 不能只看 imageReady（它是 image || imageEdit 的并集）
    textToImageReady: !!config.image?.outputNodes?.length,
    imageEditReady: !!config.imageEdit?.outputNodes?.length,
    videoReady: isComfyReadyFor('video'),
    // 图片侧当前默认值：图片工作台要按全局默认回显清晰度与步数（不发起网络探测）
    imagePixelBudget: config.imagePixelBudget,
    optionValues: config.optionValues,
  })
})

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /workspace-notice — 升级后待告知的内置模板同步结果（null = 无通知）
app.get('/thinking-mode', async (c) => {
  return success(c, { enabled: getThinkingMode() })
})

app.put('/thinking-mode', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body?.enabled !== 'boolean') return badRequest(c, 'enabled 必须为布尔值')
  return success(c, { enabled: setThinkingMode(body.enabled) })
})

app.get('/workspace-notice', async (c) => {
  return success(c, { notice: getWorkspaceSyncNotice() })
})

// POST /workspace-notice/dismiss — 前端展示过即清除，保证只提示一次
app.post('/workspace-notice/dismiss', async (c) => {
  setWorkspaceSyncNotice(null)
  return success(c, { dismissed: true })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

export default app
