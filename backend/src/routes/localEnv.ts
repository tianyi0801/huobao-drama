/**
 * 本地算力环境路由
 *
 * GET  /                 轻量状态（ComfyUI 可达性 + FFmpeg + 模板结构），设置页首屏用
 * POST /test             深度检测（额外校验节点齐备 + input 目录可写）
 * PUT  /config           保存服务地址 / 启用开关 / 可调项 / 轮询参数
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { collectLocalEnv } from '../services/comfyui/env.js'
import { saveComfyConfig } from '../services/comfyui/config.js'
import { summarizeComfyConfig } from './workflows.js'

const app = new Hono()

app.get('/', async (c) => {
  try {
    return success(c, await collectLocalEnv(false))
  } catch (error: any) {
    return badRequest(c, error?.message || '环境检测失败')
  }
})

app.post('/test', async (c) => {
  try {
    return success(c, await collectLocalEnv(true))
  } catch (error: any) {
    return badRequest(c, error?.message || '环境检测失败')
  }
})

app.put('/config', async (c) => {
  try {
    const body = await c.req.json()
    const patch: Record<string, unknown> = {}
    for (const key of ['enabled', 'url', 'optionValues', 'imagePixelBudget', 'continuityReference', 'poll', 'uploadSubfolder']) {
      if (key in body) patch[key] = body[key]
    }
    if (!Object.keys(patch).length) return badRequest(c, '没有可更新的字段')
    const saved = saveComfyConfig(patch)
    return success(c, summarizeComfyConfig(saved))
  } catch (error: any) {
    return badRequest(c, error?.message || '保存本地算力配置失败')
  }
})

export default app
