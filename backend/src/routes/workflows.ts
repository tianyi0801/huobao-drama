/**
 * 本地工作流模板路由 — 设置页「本地算力」面板使用
 *
 * GET    /presets                内置预设清单
 * POST   /presets/:id/preview    用预设（可替换成用户自己的 API 图）生成模板草稿并校验，不落库
 * POST   /presets/:id/apply      用预设写入配置（kind 决定写到 image / imageEdit / video）
 * PUT    /:kind                  直接保存自定义模板（api + bindings + options + outputNodes）
 * POST   /validate               只校验不保存
 * DELETE /:kind                  移除某类模板
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import {
  getComfyConfig,
  normalizeTemplate,
  saveComfyConfig,
  type ComfyUiConfig,
  type ComfyWorkflowTemplate,
} from '../services/comfyui/config.js'
import {
  buildTemplateFromPreset,
  buildTemplateFromPresetWithApi,
  listBundledWorkflows,
  listComfyPresets,
} from '../services/comfyui/presets.js'
import { ComfyClient } from '../services/comfyui/client.js'
import { describeTemplate, validateTemplate } from '../services/comfyui/template.js'
import { quickValidate } from '../services/comfyui/env.js'

const app = new Hono()

const TEMPLATE_KINDS = ['image', 'imageEdit', 'video'] as const
type TemplateKind = typeof TEMPLATE_KINDS[number]

function parseKind(value: unknown): TemplateKind {
  const kind = String(value || '').trim() as TemplateKind
  if (!TEMPLATE_KINDS.includes(kind)) throw new Error('kind 必须是 image / imageEdit / video')
  return kind
}

/** 对前端暴露的配置摘要（不含完整 API 图，避免设置页一次拉几百 KB） */
export function summarizeComfyConfig(config: ComfyUiConfig = getComfyConfig()) {
  return {
    enabled: config.enabled,
    url: config.url,
    optionValues: config.optionValues,
    poll: config.poll,
    uploadSubfolder: config.uploadSubfolder,
    templates: {
      image: describeTemplate(config.image),
      imageEdit: describeTemplate(config.imageEdit),
      video: describeTemplate(config.video),
    },
  }
}

function templateFromBody(body: any): ComfyWorkflowTemplate {
  const template = normalizeTemplate(body?.template ?? body)
  if (!template) throw new Error('工作流模板无效（需要 API 格式执行图）')
  return { ...template, savedAt: new Date().toISOString() }
}

app.get('/presets', (c) => success(c, listComfyPresets()))

/**
 * GET /bundled — 内置的 UI 格式工作流清单
 * 附带「目标 ComfyUI 上是否已存在」，用于面板显示导入状态
 */
app.get('/bundled', async (c) => {
  const config = getComfyConfig()
  const bundled = listBundledWorkflows()
  let remote: string[] = []
  let reachable = false
  try {
    remote = await new ComfyClient(config.url, 5_000).listUserWorkflows()
    reachable = true
  } catch {
    reachable = false
  }
  const flat = new Set(remote.map(r => r.replace(/\\/g, '/')))
  return success(c, {
    reachable,
    items: bundled.map(item => ({
      presetId: item.presetId,
      presetLabel: item.presetLabel,
      filename: item.filename,
      nodeCount: item.nodeCount,
      bytes: item.bytes,
      installed: flat.has(item.filename),
    })),
  })
})

/**
 * POST /import — 把内置 UI 工作流写进 ComfyUI 的 workflows 目录
 * 走 ComfyUI 的 /userdata 接口，远程部署同样有效。
 * body: { presetIds?: string[]; overwrite?: boolean }
 * 默认不覆盖同名文件，避免冲掉使用者在 ComfyUI 里改过的版本。
 */
app.post('/import', async (c) => {
  try {
    const config = getComfyConfig()
    const body = await c.req.json().catch(() => ({}))
    const overwrite = body?.overwrite === true
    const wanted: string[] | null = Array.isArray(body?.presetIds) && body.presetIds.length
      ? body.presetIds.map((v: unknown) => String(v))
      : null

    const all = listBundledWorkflows()
    const targets = wanted ? all.filter(item => wanted.includes(item.presetId)) : all
    if (!targets.length) return badRequest(c, '没有可导入的工作流')

    const client = new ComfyClient(config.url, 10_000)
    const existing = new Set((await client.listUserWorkflows()).map(r => r.replace(/\\/g, '/')))

    const imported: string[] = []
    const skipped: string[] = []
    const failed: { filename: string; error: string }[] = []

    for (const item of targets) {
      if (existing.has(item.filename) && !overwrite) {
        skipped.push(item.filename)
        continue
      }
      try {
        await client.writeUserWorkflow(item.filename, item.content)
        imported.push(item.filename)
      } catch (error: any) {
        failed.push({ filename: item.filename, error: error?.message || String(error) })
      }
    }

    return success(c, { imported, skipped, failed })
  } catch (error: any) {
    return badRequest(c, error?.message || '导入工作流失败')
  }
})

app.post('/presets/:id/preview', async (c) => {
  try {
    const presetId = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const template = body?.api
      ? buildTemplateFromPresetWithApi(presetId, body.api)
      : buildTemplateFromPreset(presetId)
    return success(c, { summary: describeTemplate(template), validation: quickValidate(template) })
  } catch (error: any) {
    return badRequest(c, error?.message || '预览工作流失败')
  }
})

app.post('/presets/:id/apply', async (c) => {
  try {
    const presetId = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const kind = parseKind(body?.kind)
    const template = body?.api
      ? buildTemplateFromPresetWithApi(presetId, body.api)
      : buildTemplateFromPreset(presetId)
    const saved = saveComfyConfig({ [kind]: { ...template, savedAt: new Date().toISOString() } })
    return success(c, summarizeComfyConfig(saved))
  } catch (error: any) {
    return badRequest(c, error?.message || '应用工作流预设失败')
  }
})

app.post('/validate', async (c) => {
  try {
    const body = await c.req.json()
    const template = templateFromBody(body)
    return success(c, quickValidate(template))
  } catch (error: any) {
    return badRequest(c, error?.message || '校验工作流失败')
  }
})

app.put('/:kind', async (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    const body = await c.req.json()
    const template = templateFromBody(body)
    const report = quickValidate(template)
    if (!report?.ok) return badRequest(c, report?.errors?.[0] || '工作流模板校验失败')
    const saved = saveComfyConfig({ [kind]: template })
    return success(c, summarizeComfyConfig(saved))
  } catch (error: any) {
    return badRequest(c, error?.message || '保存工作流模板失败')
  }
})

app.delete('/:kind', async (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    const saved = saveComfyConfig({ [kind]: null })
    return success(c, summarizeComfyConfig(saved))
  } catch (error: any) {
    return badRequest(c, error?.message || '移除工作流模板失败')
  }
})

export default app
