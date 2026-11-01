<template>
  <section class="card setup-panel le-panel">
    <div class="setup-panel-head compact">
      <div>
        <div class="setup-title">{{ t('settings.localEngine.title') }}</div>
        <div class="setup-desc">{{ t('settings.localEngine.desc') }}</div>
      </div>
      <span :class="['tag', report?.ready ? 'tag-success' : 'tag-error']">
        {{ report?.ready ? t('settings.localEngine.ready') : t('settings.localEngine.notReady') }}
      </span>
    </div>

    <!-- 服务地址与检测 -->
    <div class="le-row">
      <input
        v-model="form.url"
        class="input le-url"
        placeholder="http://127.0.0.1:8188"
        @blur="saveBase"
      />
      <label class="le-switch">
        <input type="checkbox" class="sr-only" :checked="form.enabled" @change="onToggleEnabled" />
        <span class="switch" :class="{ on: form.enabled }"></span>
        <span class="le-switch-text">{{ t('settings.localEngine.enabled') }}</span>
      </label>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="refresh(false)">
        <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        {{ t('settings.localEngine.detect') }}
      </button>
      <button class="btn btn-ghost btn-sm" :disabled="deepLoading" @click="refresh(true)">
        <Cpu :size="13" :class="{ 'animate-spin': deepLoading }" />
        {{ t('settings.localEngine.deepDetect') }}
      </button>
    </div>

    <!-- 环境信息 -->
    <div class="le-grid">
      <div class="le-item">
        <span class="le-k">{{ t('settings.localEngine.svcComfy') }}</span>
        <span :class="['le-v', report?.comfyui?.reachable ? 'ok' : 'bad']">
          {{ report?.comfyui?.reachable
            ? `${t('settings.localEngine.connected')} · v${report.comfyui.version || '?'} · ${report.comfyui.latencyMs}ms`
            : (report?.comfyui?.error || t('settings.localEngine.untouched')) }}
        </span>
      </div>
      <div class="le-item">
        <span class="le-k">{{ t('settings.localEngine.device') }}</span>
        <span class="le-v">{{ deviceText }}</span>
      </div>
      <div class="le-item">
        <span class="le-k">{{ t('settings.localEngine.svcFfmpeg') }}</span>
        <span :class="['le-v', report?.ffmpeg?.ffmpeg && report?.ffmpeg?.ffprobe ? 'ok' : 'bad']">
          {{ report?.ffmpeg?.ffmpeg && report?.ffmpeg?.ffprobe
            ? t('settings.localEngine.available')
            : t('settings.localEngine.unavailable') }}
        </span>
      </div>
      <div class="le-item">
        <span class="le-k">{{ t('settings.localEngine.disk') }}</span>
        <span class="le-v">{{ freeText }}</span>
      </div>
    </div>

    <!-- 图片像素预算：本地扩散模型耗时与像素量近似成正比 -->
    <div class="le-row le-budget">
      <span class="le-option-label">{{ t('settings.localEngine.pixelBudget') }}</span>
      <select class="input le-select" :value="pixelBudget" @change="onPixelBudgetChange">
        <option v-for="opt in PIXEL_BUDGETS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <span class="le-hint">{{ t('settings.localEngine.pixelBudgetHint') }}</span>
    </div>

    <!-- 镜头衔接：同场景相邻分镜带上上一段尾帧 -->
    <div class="le-row le-budget">
      <span class="le-option-label">{{ t('settings.localEngine.continuity') }}</span>
      <label class="config-switch">
        <input type="checkbox" class="sr-only" :checked="continuityOn" @change="onContinuityChange" />
        <span class="switch" :class="{ on: continuityOn }"></span>
      </label>
      <span class="le-hint">{{ t('settings.localEngine.continuityHint') }}</span>
    </div>

    <!-- 阻断项与警告 -->
    <div v-if="report?.blockers?.length" class="le-issues bad">
      <div v-for="(b, i) in report.blockers" :key="`b${i}`" class="le-issue">
        <AlertTriangle :size="12" /> {{ b }}
      </div>
    </div>
    <div v-if="report?.warnings?.length" class="le-issues warn">
      <div v-for="(w, i) in report.warnings" :key="`w${i}`" class="le-issue">
        <AlertTriangle :size="12" /> {{ w }}
      </div>
    </div>
    <p v-if="report?.ready" class="le-ok">
      {{ t('settings.localEngine.allGood') }}
    </p>

    <!-- 高级设置：工作流模板 / 可调项 / 内置工作流导入（未就绪时默认展开） -->
    <details class="le-advanced" :open="advancedOpen">
      <summary>{{ t('settings.localEngine.advanced') }}</summary>

    <!-- 工作流模板槽位 -->
    <div class="le-slots">
      <div v-for="slot in SLOTS" :key="slot.kind" class="le-slot">
        <div class="le-slot-head">
          <span class="le-slot-title">{{ t(slot.labelKey) }}</span>
          <span v-if="templateOf(slot.kind)" class="tag tag-success">
            {{ templateOf(slot.kind).summary?.nodeCount }} nodes
          </span>
          <span v-else class="tag">{{ t('settings.localEngine.notBound') }}</span>
        </div>
        <div class="le-slot-body">
          <span v-if="templateOf(slot.kind)" class="le-slot-name">
            {{ templateOf(slot.kind).summary?.name }}
          </span>
          <span v-else class="le-slot-name muted">{{ t('settings.localEngine.notBoundHint') }}</span>
          <div class="le-slot-actions">
            <select class="input le-select" :value="currentPresetId(slot.kind)" @change="onApplyPreset(slot.kind, $event)">
              <option value="">{{ t('settings.localEngine.usePreset') }}</option>
              <option v-for="p in presetsOf(slot.kind)" :key="p.id" :value="p.id" :disabled="!p.available">
                {{ p.label }}{{ p.available ? '' : ` (${t('settings.localEngine.presetMissing')})` }}
              </option>
            </select>
            <button
              v-if="templateOf(slot.kind)"
              class="btn btn-danger btn-icon btn-sm"
              :title="t('settings.localEngine.remove')"
              @click="onRemove(slot.kind)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
        <!-- 模板校验问题 -->
        <ul v-if="templateOf(slot.kind)?.errors?.length" class="le-errors">
          <li v-for="(err, i) in templateOf(slot.kind).errors.slice(0, 3)" :key="i">{{ err }}</li>
        </ul>
      </div>
    </div>

    <!-- 可调项 -->
    <div v-if="optionList.length" class="le-options">
      <div class="le-options-title">{{ t('settings.localEngine.options') }}</div>
      <div v-for="opt in optionList" :key="opt.id" class="le-option">
        <span class="le-option-label" :title="opt.hint || ''">{{ opt.label }}</span>
        <label v-if="opt.type === 'boolean'" class="config-switch">
          <input type="checkbox" class="sr-only" :checked="booleanOptionOn(opt)" @change="onOptionChange(opt.id, ($event.target as HTMLInputElement).checked)" />
          <span class="switch" :class="{ on: booleanOptionOn(opt) }"></span>
        </label>
        <select
          v-else-if="opt.type === 'select'"
          class="input le-select"
          :value="optionValues[opt.id] ?? opt.default"
          @change="onOptionChange(opt.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="c in opt.choices || []" :key="c" :value="c">{{ c }}</option>
        </select>
        <input
          v-else-if="opt.type === 'number'"
          class="input le-number mono"
          type="number"
          :min="opt.min"
          :max="opt.max"
          :step="opt.step"
          :value="optionValues[opt.id] ?? opt.default"
          @change="onOptionChange(opt.id, Number(($event.target as HTMLInputElement).value))"
        />
        <input
          v-else
          class="input le-text"
          :value="optionValues[opt.id] ?? opt.default"
          @change="onOptionChange(opt.id, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <!-- 内置 UI 工作流：一键导入 ComfyUI 界面直接打开 -->
    <div v-if="bundledWorkflows.length" class="le-bundled">
      <div class="le-bundled-head">
        <span class="le-slot-title">{{ t('settings.localEngine.bundledTitle') }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="importing" @click="onImportWorkflows(false)">
          <Download :size="13" /> {{ t('settings.localEngine.importBundled') }}
        </button>
        <button
          v-if="hasMissingBundled"
          class="btn btn-ghost btn-sm"
          :disabled="importing"
          @click="onImportWorkflows(true)"
        >{{ t('settings.localEngine.reimportBundled') }}</button>
      </div>
      <div v-for="wf in bundledWorkflows" :key="wf.presetId" class="le-bundled-row">
        <span class="le-bundled-name">{{ wf.presetLabel }}</span>
        <span class="le-bundled-file mono">{{ wf.filename }}</span>
        <span :class="['tag', wf.installed ? 'tag-success' : '']">
          {{ wf.installed ? t('settings.localEngine.bundledInstalled') : t('settings.localEngine.bundledMissing') }}
        </span>
      </div>
      <p class="le-hint">{{ t('settings.localEngine.bundledHint') }}</p>
    </div>

    <p class="le-hint le-timing">{{ t('settings.localEngine.timingHint') }}</p>

    <!-- 导入自己的 API 工作流 -->
    <details class="le-import">
      <summary>{{ t('settings.localEngine.importTitle') }}</summary>
      <p class="setup-desc">{{ t('settings.localEngine.importHint') }}</p>
      <div class="le-row">
        <select v-model="importSlot" class="input le-select">
          <option value="image">{{ t('settings.localEngine.slot.image') }}</option>
          <option value="imageEdit">{{ t('settings.localEngine.slot.imageEdit') }}</option>
          <option value="video">{{ t('settings.localEngine.slot.video') }}</option>
        </select>
        <select v-model="importPreset" class="input le-select">
          <option value="">{{ t('settings.localEngine.importPresetHint') }}</option>
          <option v-for="p in presetsOf(importSlot)" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <input ref="fileInput" type="file" accept="application/json,.json" class="sr-only" @change="onFilePick" />
        <button class="btn btn-ghost btn-sm" @click="fileInput?.click()">
          <Upload :size="13" /> {{ t('settings.localEngine.importPick') }}
        </button>
      </div>
        <p v-if="importFile" class="le-import-file mono">{{ importFile }}</p>
      </details>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AlertTriangle, Cpu, Download, RefreshCw, Trash2, Upload } from 'lucide-vue-next'
import { localEnvAPI, workflowAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

const SLOTS = [
  { kind: 'image', labelKey: 'settings.localEngine.slot.image' },
  { kind: 'imageEdit', labelKey: 'settings.localEngine.slot.imageEdit' },
  { kind: 'video', labelKey: 'settings.localEngine.slot.video' },
] as const

const report = ref<any>(null)
const loading = ref(false)
const deepLoading = ref(false)
const form = reactive({ url: '', enabled: false })
const optionValues = ref<Record<string, any>>({})
const PIXEL_BUDGETS = [
  { value: 262144, label: '0.25 MP' },
  { value: 524288, label: '0.5 MP' },
  { value: 1048576, label: '1 MP（推荐）' },
  { value: 2097152, label: '2 MP' },
  { value: 4194304, label: '4 MP（2K）' },
]
const importSlot = ref<'image' | 'imageEdit' | 'video'>('image')
const importPreset = ref('')
const importFile = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
let pendingImport: any = null
let optionTimer: ReturnType<typeof setTimeout> | null = null

const deviceText = computed(() => {
  const devices = report.value?.comfyui?.devices || []
  if (!devices.length) return t('settings.localEngine.noDevice')
  return devices.map((d: any) => {
    const free = d.vramFreeBytes ? `${Math.round(d.vramFreeBytes / 1024 ** 3)}G` : '?'
    const total = d.vramTotalBytes ? `${Math.round(d.vramTotalBytes / 1024 ** 3)}G` : '?'
    return `${d.name} (${free}/${total})`
  }).join(' · ')
})

const freeText = computed(() => {
  const bytes = report.value?.storage?.freeBytes
  if (typeof bytes !== 'number') return t('settings.localEngine.unknown')
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
})

/** 三个模板的可调项合并去重（同名 id 只渲染一次） */
const optionList = computed(() => {
  const seen = new Set<string>()
  const list: any[] = []
  for (const key of ['image', 'imageEdit', 'video']) {
    const options = report.value?.templates?.[key]?.summary?.options || []
    for (const opt of options) {
      if (seen.has(opt.id)) continue
      seen.add(opt.id)
      list.push(opt)
    }
  }
  return list
})

function booleanOptionOn(opt: { id: string; default?: unknown }) {
  const saved = optionValues.value
  return (Object.prototype.hasOwnProperty.call(saved, opt.id) ? saved[opt.id] : opt.default) === true
}

const pixelBudget = computed(() => Number(report.value?.imagePixelBudget) || 4194304)
const continuityOn = computed(() => report.value?.continuityReference !== false)

async function onContinuityChange(event: Event) {
  const value = (event.target as HTMLInputElement).checked
  try {
    await localEnvAPI.saveConfig({ continuityReference: value })
    await load()
    toast.success(t('settings.localEngine.saved'))
  } catch (error) {
    toastError(error)
  }
}

const importing = ref(false)
const bundledWorkflows = computed<any[]>(() => report.value?.bundledWorkflows || [])
const hasMissingBundled = computed(() => bundledWorkflows.value.some(w => !w.installed))

/** 把内置 UI 工作流写进 ComfyUI 的 workflows 目录（默认不覆盖同名文件） */
async function onImportWorkflows(overwrite: boolean) {
  importing.value = true
  try {
    const res = await workflowAPI.importBundled(undefined, overwrite)
    const imported = res?.imported?.length || 0
    const skipped = res?.skipped?.length || 0
    const failed = res?.failed?.length || 0
    if (failed) toast.error(t('settings.localEngine.importFailed', { n: failed }))
    else toast.success(t('settings.localEngine.importDone', { imported, skipped }))
    await load()
  } catch (error) {
    toastError(error)
  } finally {
    importing.value = false
  }
}

async function onPixelBudgetChange(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  try {
    await localEnvAPI.saveConfig({ imagePixelBudget: value })
    await load()
    toast.success(t('settings.localEngine.saved'))
  } catch (error) {
    toastError(error)
  }
}

/*
 * 后端对未绑定的槽位也返回 { present: false, summary: null } 的报告对象。
 * 直接判空会让「未绑定」被当成已绑定：卡片显示绿色 tag 但节点数和名称为空，
 * 还会多出一个删除按钮。这里统一按 present 判定，未绑定就是 null。
 */
function templateOf(kind: string) {
  const slotReport = report.value?.templates?.[kind]
  return slotReport?.present ? slotReport : null
}

/**
 * 当前槽位绑定的预设 id，用于让下拉框回显已选中的预设。
 * 之前写死 value=""，模板明明已绑定却一直显示「选择预设…」，看起来像没检测到工作流。
 */
function currentPresetId(kind: string) {
  const name = templateOf(kind)?.summary?.name
  if (!name) return ''
  const hit = presetsOf(kind).find(p => p.templateName === name || p.label === name)
  return hit?.id || ''
}

function presetsOf(kind: string) {
  return (report.value?.presets || []).filter((p: any) => p.slot === kind)
}

/**
 * 「高级设置」的展开状态。
 * 不能直接绑 `:open="!report?.ready"`：那样每次检测都会重置折叠状态，
 * 点击「启用本地生成」后 ready 翻转，details 会被强制收起，看起来像内容凭空消失。
 * 这里只在首次加载时按就绪状态给一次默认值，之后完全交给用户控制。
 */
const advancedOpen = ref(true)
let advancedInitialized = false

function applyReport(data: any) {
  report.value = data
  form.url = data?.comfyui?.url || form.url
  form.enabled = data?.enabled === true
  optionValues.value = { ...(data?.optionValues || {}) }
  if (!advancedInitialized) {
    advancedInitialized = true
    advancedOpen.value = data?.ready !== true
  }
}

async function load() {
  try {
    applyReport(await localEnvAPI.status())
  } catch (error) {
    toastError(error)
  }
}

async function refresh(deep: boolean) {
  if (deep) deepLoading.value = true
  else loading.value = true
  try {
    applyReport(deep ? await localEnvAPI.test() : await localEnvAPI.status())
    if (deep) toast.success(t('settings.localEngine.detected'))
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
    deepLoading.value = false
  }
}

async function saveBase() {
  try {
    await localEnvAPI.saveConfig({ url: form.url, enabled: form.enabled })
    await load()
  } catch (error) {
    toastError(error)
  }
}

async function onToggleEnabled(event: Event) {
  form.enabled = (event.target as HTMLInputElement).checked
  await saveBase()
}

function onOptionChange(id: string, value: any) {
  optionValues.value = { ...optionValues.value, [id]: value }
  if (optionTimer) clearTimeout(optionTimer)
  optionTimer = setTimeout(async () => {
    try {
      await localEnvAPI.saveConfig({ optionValues: optionValues.value })
    } catch (error) {
      toastError(error)
    }
  }, 400)
}

async function onApplyPreset(kind: string, event: Event) {
  const select = event.target as HTMLSelectElement
  const presetId = select.value
  select.value = ''
  if (!presetId) return
  try {
    await workflowAPI.apply(presetId, { kind })
    toast.success(t('settings.localEngine.applied'))
    await load()
  } catch (error) {
    toastError(error)
  }
}

async function onRemove(kind: string) {
  try {
    await workflowAPI.remove(kind)
    toast.success(t('settings.localEngine.removed'))
    await load()
  } catch (error) {
    toastError(error)
  }
}

async function onFilePick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importFile.value = file.name
  try {
    pendingImport = JSON.parse(await file.text())
  } catch {
    pendingImport = null
    toast.error(t('settings.localEngine.importInvalid'))
    return
  }
  if (!importPreset.value) {
    toast.error(t('settings.localEngine.importPresetHint'))
    return
  }
  try {
    // 先用该预设的绑定表校验用户自己的 API 图，避免写进一份字段对不上的模板
    const preview = await workflowAPI.preview(importPreset.value, { api: pendingImport })
    if (!preview?.validation?.ok) {
      toast.error(preview?.validation?.errors?.[0] || t('settings.localEngine.importMismatch'))
      return
    }
    await workflowAPI.apply(importPreset.value, { kind: importSlot.value, api: pendingImport })
    toast.success(t('settings.localEngine.applied'))
    await load()
  } catch (error) {
    toastError(error)
  } finally {
    input.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
.le-panel { display: flex; flex-direction: column; gap: 12px; }
.le-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.le-url { flex: 1 1 240px; min-width: 200px; }
.le-switch { position: relative; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; cursor: pointer; }
.config-switch { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; cursor: pointer; }
.le-switch > input.sr-only,
.config-switch > input.sr-only { top: 0; left: 0; margin: 0; }
.le-switch input:focus-visible + .switch,
.config-switch input:focus-visible + .switch { box-shadow: 0 0 0 3.5px var(--button-focus); }
.le-row > .switch,
.le-row > .config-switch { flex: 0 0 auto; }
.le-switch-text { font: 500 11.5px var(--font-body); color: var(--text-2); }
.le-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; }
.le-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--surface-sunken); border-radius: var(--radius-md); }
.le-k { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
.le-v { font: 500 11.5px var(--font-mono, var(--font-body)); color: var(--text-1); word-break: break-all; }
.le-v.ok { color: var(--success-text, var(--text-1)); }
.le-v.bad { color: var(--danger-text, var(--text-1)); }
.le-slots { display: flex; flex-direction: column; gap: 8px; }
.le-slot { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.le-slot-head { display: flex; align-items: center; gap: 8px; }
.le-slot-title { font: 600 12px var(--font-body); color: var(--text-0); }
.le-slot-body { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.le-slot-name { flex: 1 1 160px; font: 500 11.5px var(--font-body); color: var(--text-2); }
.le-slot-name.muted { color: var(--text-3); }
.le-slot-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.le-budget { align-items: center; }
.le-hint { font: 500 11px var(--font-body); color: var(--text-3); }
.le-timing { border-top: 1px solid var(--border); padding-top: 8px; }
.le-select { min-width: 132px; max-width: 220px; }
.le-number { width: 88px; }
.le-text { min-width: 160px; }
.le-errors { margin: 0; padding-left: 16px; font: 500 11px var(--font-body); color: var(--danger-text, var(--text-2)); }
.le-options { display: flex; flex-direction: column; gap: 6px; }
.le-options-title { font: 600 12px var(--font-body); color: var(--text-0); }
.le-option { display: flex; align-items: center; gap: 10px; }
.le-option-label { flex: 1 1 auto; font: 500 11.5px var(--font-body); color: var(--text-2); }
.le-issues { display: flex; flex-direction: column; gap: 4px; }
.le-issues.bad .le-issue { color: var(--danger-text, var(--text-1)); }
.le-issues.warn .le-issue { color: var(--warning-text, var(--text-2)); }
.le-issue { display: flex; align-items: flex-start; gap: 6px; font: 500 11.5px var(--font-body); }
.le-ok { margin: 0; font: 600 11.5px var(--font-body); color: var(--success-text, var(--text-1)); }
/* 高级设置折叠区：首屏只留状态与地址，模板/可调项收起来 */
.le-advanced { border-top: 1px solid var(--border); padding-top: 8px; }
.le-advanced > summary,
.le-import > summary {
  cursor: pointer;
  font: 600 11.5px var(--font-body);
  color: var(--text-2);
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.le-advanced > summary::-webkit-details-marker { display: none; }
.le-advanced > summary::before { content: '▸'; color: var(--text-3); transition: transform .15s; }
.le-advanced[open] > summary::before { transform: rotate(90deg); }
.le-advanced[open] > summary { margin-bottom: 10px; }
.le-bundled { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
.le-bundled-head { display: flex; align-items: center; gap: 8px; }
.le-bundled-row { display: flex; align-items: center; gap: 8px; }
.le-bundled-name { flex: 0 0 auto; font: 500 11.5px var(--font-body); color: var(--text-2); }
.le-bundled-file { flex: 1 1 auto; font: 500 10.5px var(--font-mono, var(--font-body)); color: var(--text-3); word-break: break-all; }
.le-import { border-top: 1px solid var(--border); padding-top: 8px; }
.le-import summary { cursor: pointer; font: 600 11.5px var(--font-body); color: var(--text-2); }
.le-import-file { font: 500 11px var(--font-mono, var(--font-body)); color: var(--text-3); }
</style>
