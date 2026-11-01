/**
 * 本地算力首次启动预置
 *
 * 只在 app_settings 里完全没有 comfyui_config 时执行一次：
 * 把 workspace/comfyui/presets.json 里的三份内置工作流写进配置，
 * 用户只需在设置页填 ComfyUI 地址并打开开关即可生成。
 *
 * 已有配置（哪怕被用户清空过模板）不会被覆盖 —— 「是否配置过」由配置键存在与否判定。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { saveComfyConfig } from './config.js'
import { buildTemplateFromPreset } from './presets.js'

const CONFIG_KEY = 'comfyui_config'

export function seedComfyDefaultsIfMissing(): void {
  const existing = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONFIG_KEY))
    .get()
  if (existing) return

  try {
    saveComfyConfig({
      enabled: false,
      image: buildTemplateFromPreset('qwen-image-2.1-t2i'),
      imageEdit: buildTemplateFromPreset('qwen-image-2.1-edit'),
      video: buildTemplateFromPreset('minimax-h3-ref2va'),
    })
    console.log('🧩 已预置本地 ComfyUI 工作流模板（文生图 / 图片编辑 / 视频）')
  } catch (error: any) {
    // 预设文件缺失或损坏不应阻断启动：设置页会提示用户导入工作流
    console.warn(`[comfyui] 内置工作流预置失败：${error?.message || error}`)
  }
}
