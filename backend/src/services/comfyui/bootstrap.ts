/**
 * 本地算力首次启动预置
 *
 * 启动时把 workspace/comfyui/presets.json 里的内置工作流写进配置，
 * 用户只需在设置页填 ComfyUI 地址并打开开关即可生成。
 *
 * 兼容两种历史状态：
 * 1. 完全没有 comfyui_config → 三份模板全量预置。
 * 2. 已有点过「保存地址」但模板全空的记录（旧版本预设文件缺失时保存过 url）→ 补预置。
 * 已经在用的模板一律不覆盖，用户主动移除的单个槽位也不会被强行加回。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { getComfyConfig, saveComfyConfig } from './config.js'
import { buildTemplateFromPreset } from './presets.js'
import type { ComfyTemplateSlot } from './presets.js'

const CONFIG_KEY = 'comfyui_config'

const SLOT_PRESETS: { slot: ComfyTemplateSlot; presetId: string; label: string }[] = [
  { slot: 'image', presetId: 'qwen-image-2.1-t2i', label: '文生图' },
  { slot: 'imageEdit', presetId: 'qwen-image-2.1-edit', label: '图片编辑' },
  { slot: 'video', presetId: 'minimax-h3-ref2va', label: '视频' },
]

export function seedComfyDefaultsIfMissing(): void {
  const existing = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONFIG_KEY))
    .get()

  const current = existing ? getComfyConfig() : null
  // 已配置过任意一个模板就尊重用户当前状态（含主动移除），不再补预置
  if (current && SLOT_PRESETS.some(item => current[item.slot])) return

  const patch: Record<string, unknown> = {}
  for (const item of SLOT_PRESETS) {
    try {
      patch[item.slot] = buildTemplateFromPreset(item.presetId)
    } catch (error: any) {
      // 预设文件缺失或损坏不应阻断启动：设置页会提示用户导入工作流
      console.warn(`[comfyui] 内置工作流预置失败（${item.label}）：${error?.message || error}`)
    }
  }
  if (!Object.keys(patch).length) return

  try {
    if (!existing) patch.enabled = false
    saveComfyConfig(patch)
    console.log(`🧩 已预置本地 ComfyUI 工作流模板：${Object.keys(patch).filter(key => key !== 'enabled').join(' / ')}`)
  } catch (error: any) {
    console.warn(`[comfyui] 内置工作流预置写入失败：${error?.message || error}`)
  }
}
