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

/**
 * 模板可调项增量迁移 — 老库里的图片模板没有「输出分辨率」选项，
 * 而编辑模式的出图尺寸实际由 TextEncodeQwenImage21.resolution 决定（0=跟随参考图）。
 * 只补缺失的选项，不改动用户已保存的取值；找不到目标节点就跳过。
 */
export function migrateComfyTemplateOptions(): void {
  const current = getComfyConfig()
  const patch: Record<string, unknown> = {}

  for (const slot of ['image', 'imageEdit'] as const) {
    const template = current[slot]
    if (!template) continue
    if ((template.options || []).some(option => option.id === 'resolution')) continue

    // 找到带 resolution 输入的 Qwen 文本编码节点（编辑模板 459:474 / 文生图模板 459:452）
    const target = Object.entries(template.api).find(([, node]) =>
      /TextEncodeQwenImage/i.test(String(node.class_type || '')) && 'resolution' in (node.inputs || {}))
    if (!target) continue

    patch[slot] = {
      ...template,
      options: [...(template.options || []), {
        id: 'resolution',
        label: '输出分辨率 (Resolution)',
        type: 'number',
        default: 0,
        min: 0,
        max: 4096,
        step: 32,
        targets: [{ node: target[0], input: 'resolution' }],
        hint: '0 跟随参考图尺寸（参考图发送前会压到 768px，故约 768px 出图）；1024 / 2048 会把参考图缩放到约该尺寸并按此出图，更清晰但更慢',
      }],
    }
  }

  if (!Object.keys(patch).length) return
  try {
    saveComfyConfig(patch)
    console.log(`🧩 已为本地工作流补充「输出分辨率」可调项：${Object.keys(patch).join(' / ')}`)
  } catch (error: any) {
    console.warn(`[comfyui] 可调项迁移写入失败：${error?.message || error}`)
  }
}

/** 编辑模板最多支持的图片槽位（图1 底图 + 3 张参考素材） */
const EDIT_IMAGE_SLOTS = 4

/**
 * 编辑模板参考图槽位扩展 — TextEncodeQwenImage21 的 images 是动态输入
 * （COMFY_AUTOGROW_V3，最多 16 路），但老模板只接了 2 个 LoadImage。
 * 这里给缺槽位的编辑模板补 LoadImage 节点、编码器连线与可选绑定，
 * 让图片编辑页可以传「底图 + 多张参考素材」。
 */
export function migrateComfyEditImageSlots(): void {
  const current = getComfyConfig()
  const template = current.imageEdit
  if (!template) return

  // 已有的 images 槽位绑定数（index 0..N）
  const existing = template.bindings
    .filter(b => b.source === 'images' && b.index !== undefined)
    .map(b => b.index as number)
  const maxIndex = existing.length ? Math.max(...existing) : -1
  if (maxIndex >= EDIT_IMAGE_SLOTS - 1) return

  // 找编码器节点与其现有 image_N 输入
  const encoderEntry = Object.entries(template.api).find(([, node]) =>
    /TextEncodeQwenImage/i.test(String(node.class_type || '')) &&
    Object.keys(node.inputs || {}).some(key => key.startsWith('images.')))
  if (!encoderEntry) return
  const [encoderId, encoder] = encoderEntry
  const existingKeys = new Set(Object.keys(encoder.inputs).filter(key => key.startsWith('images.')))

  const api: Record<string, any> = { ...template.api }
  const bindings = [...template.bindings]
  const addedSlots: number[] = []

  for (let slot = maxIndex + 1; slot < EDIT_IMAGE_SLOTS; slot++) {
    const key = `images.image_${slot + 1}`
    const nodeId = `huobao-ref-${slot + 1}`
    if (!existingKeys.has(key)) {
      encoder.inputs[key] = [nodeId, 0]
    }
    api[nodeId] = { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: `参考图 ${slot + 1}` } }
    bindings.push({
      source: 'images',
      index: slot,
      optional: true,
      targets: [{ node: nodeId, input: 'image' }],
    })
    addedSlots.push(slot + 1)
  }

  try {
    saveComfyConfig({ imageEdit: { ...template, api, bindings } })
    console.log(`🧩 已为「图片编辑」工作流扩展参考图槽位：图${addedSlots.join('、图')}`)
  } catch (error: any) {
    console.warn(`[comfyui] 参考图槽位迁移写入失败：${error?.message || error}`)
  }
}
