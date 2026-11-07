<template>
  <div class="page iep-page">
    <!-- ===== 顶栏 ===== -->
    <header class="iep-topbar">
      <div class="iep-brand">
        <h1 class="iep-title">
          <ImagePlus :size="16" :stroke-width="2.1" />
          {{ t('textToImage.title') }}
        </h1>
        <span class="iep-sub">{{ t('textToImage.sub') }}</span>
      </div>
      <span class="iep-engine" :class="engineReady ? 'is-ok' : 'is-warn'">
        <i class="iep-engine-dot" />
        <span>{{ engineReady ? t('textToImage.engine.ready') : engineLoading ? t('textToImage.engine.checking') : engineHint }}</span>
      </span>
    </header>

    <!-- 引擎未就绪提示条 -->
    <div v-if="!engineLoading && !engineReady" class="iep-banner">
      <TriangleAlert :size="14" :stroke-width="1.9" />
      <span>{{ engineHint }}</span>
      <NuxtLink to="/settings" class="iep-banner-link">{{ t('textToImage.engine.goSettings') }}</NuxtLink>
    </div>

    <div class="iep-layout">
      <!-- ===== 左：控制栏（可滚动） ===== -->
      <aside class="iep-sidebar">
        <!-- 指令 -->
        <section class="iep-sec">
          <header class="iep-sec-head">
            <PenLine :size="13" :stroke-width="2" />
            <h2>{{ t('textToImage.prompt.label') }}</h2>
            <span class="iep-sec-note">{{ t('textToImage.prompt.desc') }}</span>
          </header>

          <textarea
            v-model="prompt"
            class="textarea iep-prompt"
            rows="4"
            :placeholder="t('textToImage.prompt.placeholder')"
            :disabled="busy"
            @keydown.ctrl.enter.prevent="generate"
            @keydown.meta.enter.prevent="generate"
          />

          <div class="iep-quick">
            <button
              v-for="item in quickItems"
              :key="item.key"
              type="button"
              class="iep-chip"
              :title="item.label"
              @click="applyQuick(item)"
            >{{ item.short }}</button>
          </div>
        </section>

        <!-- 参数 -->
        <section class="iep-sec">
          <header class="iep-sec-head" @click="advOpen = !advOpen">
            <SlidersHorizontal :size="13" :stroke-width="2" />
            <h2>{{ t('textToImage.adv.title') }}</h2>
            <ChevronDown :size="13" :stroke-width="2.2" class="iep-chev" :class="{ 'is-open': advOpen }" />
          </header>

          <div v-if="advOpen" class="iep-adv">
            <div class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.quality') }}</label>
              <div class="seg iep-seg">
                <button
                  v-for="b in BUDGETS"
                  :key="b.value"
                  type="button"
                  class="seg-item"
                  :class="{ on: !customSize && budget === b.value }"
                  @click="pickBudget(b.value)"
                >{{ b.label }}</button>
                <button type="button" class="seg-item" :class="{ on: customSize }" @click="customSize = true">
                  {{ t('textToImage.adv.custom') }}
                </button>
              </div>
            </div>

            <div v-if="customSize" class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.customSize') }}</label>
              <div class="iep-size-inputs">
                <input v-model.number="customWidth" class="input iep-num" type="number" min="256" max="4096" step="8" />
                <span class="dim">×</span>
                <input v-model.number="customHeight" class="input iep-num" type="number" min="256" max="4096" step="8" />
                <span class="iep-note">{{ customPixelNote }}</span>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.resolution') }}</label>
              <div class="seg iep-seg">
                <button
                  v-for="r in RESOLUTIONS"
                  :key="r.value"
                  type="button"
                  class="seg-item"
                  :class="{ on: resolution === r.value }"
                  :title="t('textToImage.adv.resolutionHint')"
                  @click="resolution = r.value"
                >{{ r.labelKey ? t(r.labelKey) : r.label }}</button>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.steps') }}</label>
              <div class="seg iep-seg">
                <button
                  v-for="s in stepOptions"
                  :key="s"
                  type="button"
                  class="seg-item"
                  :class="{ on: steps === s }"
                  @click="steps = s"
                >{{ s }}</button>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.seed') }}</label>
              <div class="iep-seed-row">
                <input
                  v-model="seed"
                  class="input iep-seed"
                  type="text"
                  inputmode="numeric"
                  :placeholder="t('textToImage.adv.seedPlaceholder')"
                />
                <button type="button" class="btn btn-sm" @click="seed = String(randomSeed())">
                  <Dices :size="12" :stroke-width="2" />
                </button>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('textToImage.adv.negative') }}</label>
              <textarea
                v-model="negativePrompt"
                class="textarea iep-negative"
                rows="2"
                :placeholder="t('textToImage.adv.negativePlaceholder')"
              />
            </div>

            <p class="iep-note">{{ t('textToImage.adv.persistHint') }}</p>
          </div>
        </section>

        <!-- 底部固定操作区 -->
        <div class="iep-submit-bar">
          <div class="iep-ratio">
            <label class="iep-field-label">{{ t('textToImage.output.label') }}</label>
            <select v-model="ratioMode" class="input iep-ratio-select">
              <option v-for="r in RATIOS" :key="r" :value="r">{{ r }}</option>
            </select>
            <span class="iep-note">{{ outputNote }}</span>
          </div>
          <div class="iep-submit-row">
            <button class="btn btn-sm" :disabled="!lastTaskId" :title="t('requestSnapshot.open')" @click="requestOpen = true">
              <Code2 :size="12" :stroke-width="2" />
            </button>
            <button v-if="busy" class="btn iep-submit" @click="cancelTask">
              <X :size="14" :stroke-width="2.2" />
              {{ t('textToImage.action.cancel') }}
            </button>
            <button v-else class="btn btn-primary iep-submit" :disabled="!engineReady" @click="generate">
              <Sparkles :size="14" :stroke-width="2" />
              {{ result || errorMsg ? t('textToImage.action.regenerate') : t('textToImage.action.generate') }}
            </button>
          </div>
          <p class="iep-note iep-kbd">{{ t('textToImage.action.shortcut') }}</p>
        </div>
      </aside>

      <!-- ===== 右：画布区 ===== -->
      <main class="iep-stage">
        <!-- 生成中 -->
        <div v-if="busy" class="iep-stage-inner">
          <div class="iep-canvas iep-canvas-running">
            <div class="iep-running-overlay">
              <Loader2 :size="22" class="animate-spin" />
              <p class="iep-running-title">{{ t('textToImage.result.running') }}</p>
              <p class="iep-running-time">{{ t('textToImage.result.elapsed', { s: elapsed }) }}</p>
              <div class="progress iep-progress"><span class="iep-progress-bar" /></div>
            </div>
          </div>
        </div>

        <!-- 失败 -->
        <div v-else-if="errorMsg" class="iep-stage-inner">
          <div class="iep-state iep-state-error">
            <TriangleAlert :size="22" :stroke-width="1.7" />
            <p class="iep-state-title">{{ t('textToImage.result.failed') }}</p>
            <p class="iep-state-msg">{{ errorMsg }}</p>
            <button class="btn btn-sm" @click="generate">{{ t('textToImage.action.retry') }}</button>
          </div>
        </div>

        <!-- 完成 -->
        <div v-else-if="result" class="iep-stage-inner">
          <div class="iep-canvas">
            <img :src="result.url" alt="" class="iep-canvas-img iep-canvas-clickable" :title="t('textToImage.action.view')" @click="preview = result.url" />
          </div>
          <footer class="iep-result-bar">
            <div class="iep-result-meta">
              <p class="iep-result-prompt" :title="result.prompt">{{ result.prompt }}</p>
              <button
                v-if="result.seed"
                type="button"
                class="iep-seed-chip"
                :title="t('textToImage.result.useSeed')"
                @click="seed = String(result.seed)"
              >seed {{ result.seed }}</button>
            </div>
            <div class="iep-result-actions">
              <button class="btn btn-sm btn-primary" @click="download(result)">
                <Download :size="12" :stroke-width="2" />
                {{ t('textToImage.action.download') }}
              </button>
            </div>
          </footer>
        </div>

        <!-- 空态 -->
        <div v-else class="iep-stage-inner">
          <div class="iep-state iep-state-empty">
            <ImageIcon :size="28" :stroke-width="1.4" />
            <p class="iep-state-title">{{ t('textToImage.result.empty') }}</p>
            <ol class="iep-steps">
              <li>{{ t('textToImage.result.step1') }}</li>
              <li>{{ t('textToImage.result.step2') }}</li>
              <li>{{ t('textToImage.result.step3') }}</li>
            </ol>
          </div>
        </div>

        <!-- 历史缩略图条 -->
        <footer v-if="history.length" class="iep-history">
          <span class="iep-history-label">{{ t('textToImage.result.session') }}</span>
          <div class="iep-history-list">
            <div v-for="(item, i) in history" :key="item.at" class="iep-history-item">
              <button class="iep-history-thumb" :title="t('textToImage.action.view')" @click="preview = item.url">
                <img :src="item.url" alt="" loading="lazy" />
              </button>
              <div class="iep-history-ops">
                <button class="btn btn-sm btn-icon" :title="t('textToImage.action.download')" @click="download(item)">
                  <Download :size="11" :stroke-width="1.9" />
                </button>
              </div>
              <span class="iep-history-index">#{{ history.length - i }}</span>
            </div>
          </div>
          <span class="iep-note">{{ t('textToImage.result.sessionHint') }}</span>
        </footer>
      </main>
    </div>

    <!-- 请求内容 -->
    <RequestSnapshotDialog
      :open="requestOpen"
      :items="requestItems"
      @update:open="(v) => { requestOpen = v }"
    />

    <!-- 大图预览 -->
    <div v-if="preview" class="iep-lightbox" @click="preview = null">
      <img :src="preview" alt="" class="iep-lightbox-img" @click.stop />
      <button class="iep-lightbox-close" :title="t('textToImage.action.close')" @click="preview = null">
        <X :size="16" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  ChevronDown,
  Code2,
  Dices,
  Download,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import { localEnvAPI, settingsAPI, taskAPI } from '~/composables/useApi'
import { mapError, toastError } from '~/composables/useToast'

const { t } = useI18n()

/** 默认输出像素预算：1MP（约 100 万像素），本地 8G 显存下推理耗时与画质平衡点 */
const DEFAULT_PIXEL_BUDGET = 1024 * 1024
/** 清晰度档：面积决定采样量，耗时随 MP 近似线性增长 */
const BUDGETS = [
  { value: 512 * 1024, label: '0.5MP' },
  { value: 1024 * 1024, label: '1MP' },
  { value: 2048 * 1024, label: '2MP' },
]
/** 采样步数档位（20~25 步通常已够） */
const STEP_OPTIONS = [12, 20, 25, 40]
/**
 * 输出分辨率：文生图工作流的 TextEncodeQwenImage21.resolution 决定出图尺寸档。
 * 0 = 由工作流的尺寸绑定决定（本页已通过 size 显式指定宽高）
 */
const RESOLUTIONS = [
  { value: 0, labelKey: 'textToImage.adv.resLabel' },
  { value: 1024, label: '1K' },
  { value: 1536, label: '1.5K' },
  { value: 2048, label: '2K' },
]
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const prompt = ref('')
const ratioMode = ref('1:1')

const busy = ref(false)
const elapsed = ref(0)
const result = ref(null)
const errorMsg = ref('')
const history = ref([])
const preview = ref(null)

const engine = ref({ enabled: false, textToImageReady: false, url: '' })
const engineLoading = ref(true)

// 请求内容查看：保留最近一次提交的任务号，生成结束后仍可回溯真实发给模型的提示词
const lastTaskId = ref(null)
const requestOpen = ref(false)
const requestItems = computed(() => (lastTaskId.value
  ? [{ id: lastTaskId.value, label: t('requestSnapshot.taskTextToImage') }]
  : []))
// ===== 高级参数：清晰度 / 分辨率 / 步数 / 种子 / 负面提示词 =====
const advOpen = ref(false)
const budget = ref(DEFAULT_PIXEL_BUDGET)
const customSize = ref(false)
const customWidth = ref(1376)
const customHeight = ref(768)
const steps = ref(25)
const resolution = ref(0)
const seed = ref('')
const negativePrompt = ref('')
/** 与服务端保存的模板默认值对比，决定提交前是否需要写回 */
const savedDefaults = ref({ steps: 25, budget: DEFAULT_PIXEL_BUDGET, resolution: 0 })

/** 服务端已保存一个不在档位里的步数时，也要让用户看到当前值 */
const stepOptions = computed(() => (STEP_OPTIONS.includes(steps.value)
  ? STEP_OPTIONS
  : [...STEP_OPTIONS, steps.value].sort((a, b) => a - b)))

const customPixelNote = computed(() => {
  const pixels = align8(clampSize(customWidth.value)) * align8(clampSize(customHeight.value))
  return t('textToImage.adv.customPixelNote', { mp: (pixels / 1024 / 1024).toFixed(2) })
})
let pollTimer = null
let taskId = null
let cancelledByUser = false
const engineReady = computed(() => engine.value.enabled && engine.value.textToImageReady)
const engineHint = computed(() => (engine.value.enabled
  ? t('textToImage.engine.notReady')
  : t('textToImage.engine.notEnabled')))
/** 快捷风格：追加到提示词末尾，用户可先写主体再叠风格 */
const STYLE_KEYS = ['cinematic', 'anime', 'flat', 'photo', 'poster']
const quickItems = computed(() => STYLE_KEYS.map(key => ({
  key,
  label: t(`textToImage.style.${key}`),
  short: t(`textToImage.style.${key}Short`),
})))

const outputNote = computed(() => t('textToImage.output.note', { size: outputSize() }))

onMounted(() => {
  loadEngine()
})
onBeforeUnmount(() => {
  stopTimer()
  cancelledByUser = true
})
async function loadEngine() {
  engineLoading.value = true
  try {
    const info = await settingsAPI.localEngine()
    engine.value = {
      enabled: !!info?.enabled,
      textToImageReady: !!info?.textToImageReady,
      url: info?.url || '',
    }
    // 回显当前模板默认：全局值是「像素上限」而非目标档位，
    // 页面默认取 1MP 与上限的较小值，避免一进页面就按 2MP 跑满
    const savedBudget = Number(info?.imagePixelBudget || 0)
    if (savedBudget >= 256 * 1024) budget.value = Math.min(DEFAULT_PIXEL_BUDGET, savedBudget)
    const savedSteps = Number(info?.optionValues?.steps || 0)
    if (Number.isFinite(savedSteps) && savedSteps > 0) steps.value = savedSteps
    const savedResolution = Number(info?.optionValues?.resolution ?? 0)
    if (Number.isFinite(savedResolution) && savedResolution >= 0) resolution.value = savedResolution
    savedDefaults.value = { steps: steps.value, budget: budget.value, resolution: resolution.value }
  } catch {
    engine.value = { enabled: false, textToImageReady: false, url: '' }
  } finally {
    engineLoading.value = false
  }
}
function align8(value) {
  return Math.max(64, Math.round(value / 8) * 8)
}
/** 自定义宽高收敛：256~4096（ComfyUI 上限），非数字回退 1024 */
function clampSize(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 1024
  return Math.min(4096, Math.max(256, num))
}
/** 目标比例 → 像素预算内的合规尺寸（宽高对齐 8，满足潜空间要求） */
function outputSize() {
  if (customSize.value) {
    return `${align8(clampSize(customWidth.value))}x${align8(clampSize(customHeight.value))}`
  }
  const ratio = parseRatio(ratioMode.value)
  const width = Math.sqrt(budget.value * ratio)
  const height = width / ratio
  return `${align8(width)}x${align8(height)}`
}
function pickBudget(value) {
  budget.value = value
  customSize.value = false
}
function randomSeed() {
  return Math.floor(Math.random() * 2 ** 40)
}
function parseRatio(mode) {
  const [w, h] = String(mode).split(':').map(Number)
  return w > 0 && h > 0 ? w / h : 16 / 9
}
function applyQuick(item) {
  if (busy.value) return
  const text = prompt.value.trim()
  if (!text) { prompt.value = item.label; return }
  // 重复点同一风格不叠加
  if (text.includes(item.label)) return
  prompt.value = `${text}，${item.label}`
}
function startTimer() {
  stopTimer()
  elapsed.value = 0
  pollTimer = setInterval(() => { elapsed.value += 1 }, 1000)
}

function stopTimer() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function generate() {
  if (busy.value) return
  if (!engineReady.value) {
    toast.error(engineHint.value)
    return
  }
  if (!prompt.value.trim()) {
    toast.error(t('textToImage.err.needPrompt'))
    return
  }

  busy.value = true
  cancelledByUser = false
  errorMsg.value = ''
  result.value = null
  startTimer()

  try {
    // 清晰度与步数改动写回模板默认（作用域：全局，影响后续所有图片生成）
    await syncDefaults()
    const seedValue = Number(seed.value)
    const task = await taskAPI.generate({
      type: 'image',
      // 不传 reference_images：后端据此选择「文生图」模板槽，走纯文生图工作流
      prompt: prompt.value.trim(),
      size: outputSize(),
      // 本次强制覆盖步数与输出分辨率；种子留空则由后端随机（实际值可从请求内容里查到）
      option_overrides: { steps: steps.value, resolution: resolution.value },
      ...(Number.isSafeInteger(seedValue) && seedValue > 0 ? { seed: seedValue } : {}),
      ...(negativePrompt.value.trim() ? { negative_prompt: negativePrompt.value.trim() } : {}),
      // local_only：后端只允许本机 ComfyUI 执行，绝不回退云端配置
      local_only: true,
    })
    taskId = task?.id ?? null
    if (!taskId) throw new Error(t('textToImage.err.failed'))
    lastTaskId.value = taskId
    await pollTask(taskId)
  } catch (e) {
    if (!cancelledByUser) {
      errorMsg.value = mapError(e, { fallback: 'textToImage.err.failed' })
      toastError(e, { fallback: 'textToImage.err.failed' })
    }
  } finally {
    stopTimer()
    busy.value = false
    taskId = null
  }
}

/**
 * 把清晰度与步数写回本地模板默认值。
 * 用户明确选择了「全局作用域」：这里落库后，短剧分镜生图等其它调用也会用新默认值。
 */
async function syncDefaults() {
  const patch = {}
  const optionPatch = {}
  if (steps.value !== savedDefaults.value.steps) optionPatch.steps = steps.value
  // resolution 为 0 也是有效值（由工作流默认档决定），只有与已存默认不同才写回
  if (resolution.value !== savedDefaults.value.resolution) optionPatch.resolution = resolution.value
  if (Object.keys(optionPatch).length) patch.optionPatch = optionPatch
  if (!customSize.value && budget.value !== savedDefaults.value.budget) patch.imagePixelBudget = budget.value
  if (!Object.keys(patch).length) return
  try {
    await localEnvAPI.saveConfig(patch)
    savedDefaults.value = {
      steps: steps.value,
      budget: customSize.value ? savedDefaults.value.budget : budget.value,
      resolution: resolution.value,
    }
    toast.success(t('textToImage.adv.saved'))
  } catch (e) {
    toastError(e, { fallback: 'textToImage.err.saveDefaults' })
    throw e
  }
}
/** 从请求快照里读回实际使用的种子，方便复现同一张图 */
function readUsedSeed(row) {
  const raw = row?.requestSnapshot ?? row?.request_snapshot
  if (!raw) return null
  try {
    const snap = typeof raw === 'string' ? JSON.parse(raw) : raw
    const value = Number(snap?.parameters?.seed)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}
/** 与后端图片任务节奏一致：2.5s 一档，最长 10 分钟 */
async function pollTask(id) {
  for (let i = 0; i < 240; i++) {
    await sleep(2500)
    if (cancelledByUser) return
    let res = null
    try {
      res = await taskAPI.get(id)
    } catch {
      continue
    }
    if (!res) continue

    if (res.status === 'completed') {
      const path = String(res.local_path || res.localPath || '')
      if (!path) {
        errorMsg.value = t('textToImage.err.failed')
        return
      }
      const url = path.startsWith('/') ? path : `/${path}`
      const item = { url, path, prompt: prompt.value.trim(), at: Date.now(), seed: readUsedSeed(res) }
      result.value = item
      // 仅会话内保留，刷新即丢失（不写入素材库）
      history.value = [item, ...history.value].slice(0, 12)
      toast.success(t('textToImage.result.done'))
      return
    }

    if (res.status === 'failed' || res.status === 'cancelled') {
      if (res.error_code === 'cancelled' || res.errorCode === 'cancelled') return
      const msg = res.error_msg || res.errorMsg || t('textToImage.err.failed')
      errorMsg.value = msg
      toastError(msg)
      return
    }
  }
  errorMsg.value = t('textToImage.err.timeout')
}
async function cancelTask() {
  if (!taskId) return
  cancelledByUser = true
  try {
    await taskAPI.cancel(taskId)
  } catch { /* 本地队列不可达也不阻断界面复位 */ }
  stopTimer()
  busy.value = false
  toast.info(t('textToImage.action.cancelDone'))
}
function download(item) {
  const ext = String(item.path || '').match(/\.(png|jpe?g|webp)$/i)?.[0] || '.png'
  const a = document.createElement('a')
  a.href = item.url
  a.download = `text-to-image-${item.at || Date.now()}${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
</script>
<style scoped>
.iep-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-base);
  animation: fadeUp 0.35s var(--ease-out) both;
  overflow: hidden;
}

/* ===== 顶栏 ===== */
.iep-topbar {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: 14px 24px 12px;
  flex-shrink: 0;
}
.iep-brand { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.iep-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text-0);
  white-space: nowrap;
}
.iep-sub {
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iep-engine {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 550;
  padding: 3px 11px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}
.iep-engine.is-ok { color: var(--tag-success-text); background: var(--success-bg); }
.iep-engine.is-warn { color: var(--tag-warning-text); background: var(--warning-bg); }
.iep-engine-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.iep-engine.is-ok .iep-engine-dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 20%, transparent); }

.iep-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 24px 10px;
  padding: 8px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 12.5px;
  flex-shrink: 0;
}
.iep-banner-link {
  margin-left: auto;
  font-weight: 600;
  color: var(--warn-link);
  text-decoration: none;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--warn-border);
  white-space: nowrap;
}
.iep-banner-link:hover { background: var(--warn-link-hover-bg); color: var(--warn-text); }

/* ===== 布局：左控制栏 + 右画布 ===== */
.iep-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 384px minmax(0, 1fr);
  gap: 0;
}
@media (max-width: 1080px) {
  .iep-layout { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .iep-sidebar { border-right: none; border-bottom: 1px solid var(--border); overflow: visible; }
  .iep-stage { min-height: 60vh; }
}

/* ===== 左：控制栏 ===== */
.iep-sidebar {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--surface-raised);
}
.iep-sec {
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.iep-sec-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-1);
}
.iep-sec-head h2 {
  font-size: 13px;
  font-weight: 640;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iep-sec-head svg { color: var(--text-3); flex-shrink: 0; }
.iep-sec-note {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
.iep-clear-btn { margin-left: auto; }

/* --- 指令 --- */
.iep-prompt { min-height: 92px; font-size: 12.5px; }
.iep-quick { display: flex; flex-wrap: wrap; gap: 6px; }
.iep-chip {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-2);
  border-radius: var(--radius-pill);
  padding: 4px 11px;
  font: 550 11.5px var(--font-body);
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
}
.iep-chip:hover:not(.is-disabled) { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.iep-chip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--button-focus); }
.iep-chip.is-disabled { opacity: 0.4; cursor: not-allowed; }

/* --- 参数 --- */
.iep-sec-head { cursor: default; }
.iep-chev { margin-left: auto; color: var(--text-3); transition: transform 0.18s var(--ease-out); }
.iep-chev.is-open { transform: rotate(180deg); }
.iep-adv {
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: fadeUp 0.2s var(--ease-out);
}
.iep-field { display: flex; align-items: center; gap: 10px; }
.iep-field-label {
  flex: 0 0 64px;
  font-size: 11.5px;
  font-weight: 550;
  color: var(--text-2);
  white-space: nowrap;
}
.iep-seg { flex-wrap: wrap; }
.iep-size-inputs { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; flex-wrap: wrap; }
.iep-num { width: 76px; padding: 5px 8px; font-size: 12px; }
.iep-seed-row { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.iep-seed { flex: 1; min-width: 0; padding: 6px 10px; font-size: 12px; font-family: var(--font-mono); }
.iep-negative { min-height: 52px; font-size: 12px; }
.iep-note { font-size: 10.5px; color: var(--text-3); line-height: 1.6; }

/* --- 底部操作区：粘性，始终可见 --- */
.iep-submit-bar {
  position: sticky;
  bottom: 0;
  margin-top: auto;
  padding: 14px 18px 16px;
  background: var(--surface-raised);
  border-top: 1px solid var(--border);
  box-shadow: 0 -6px 18px color-mix(in srgb, var(--bg-0) 8%, transparent);
  display: flex;
  flex-direction: column;
  gap: 9px;
  z-index: 2;
}
.iep-ratio { display: flex; align-items: center; gap: 8px; }
.iep-ratio-select { width: 110px; padding: 6px 9px; font-size: 12px; }
.iep-ratio .iep-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iep-submit-row { display: flex; align-items: center; gap: 8px; }
.iep-submit { flex: 1; min-height: 38px; }
.iep-kbd { text-align: center; }

/* ===== 右：画布区 ===== */
.iep-stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background:
    linear-gradient(45deg, color-mix(in srgb, var(--text-3) 4%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--text-3) 4%, transparent) 75%),
    linear-gradient(45deg, color-mix(in srgb, var(--text-3) 4%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--text-3) 4%, transparent) 75%);
  background-size: 24px 24px;
  background-position: 0 0, 12px 12px;
  background-color: var(--bg-input);
}
.iep-stage-inner {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 24px;
  gap: 12px;
}

/* --- 画布（图片容器） --- */
.iep-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  overflow: hidden;
  position: relative;
}
/*
 * min-width/min-height 必须显式归零：img 是 replaced flex item，
 * 默认 min-size:auto 的 content-based 下限是图片固有尺寸，
 * 会让 max-width/max-height 失效从而撑破容器（图片被裁切的原因）
 */
.iep-canvas-img {
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  width: auto;
  height: auto;
  object-fit: contain;
  display: block;
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
}
.iep-canvas-clickable { cursor: zoom-in; transition: box-shadow 0.18s var(--ease-out); }
.iep-canvas-clickable:hover { box-shadow: var(--shadow-lg); }
.iep-canvas-img.is-dimmed { opacity: 0.35; filter: saturate(0.6); }

/* --- 生成中遮罩 --- */
.iep-canvas-running { border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); }
.iep-running-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
}
.iep-running-overlay .animate-spin { color: var(--accent-text); }
.iep-running-title { font-size: 13px; font-weight: 620; color: var(--text-1); }
.iep-running-time { font-size: 11.5px; color: var(--text-3); font-family: var(--font-mono); }
.iep-progress { width: 200px; overflow: hidden; margin-top: 6px; }
.iep-progress-bar {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: inherit;
  background: var(--accent-gradient);
  animation: iepSlide 1.5s var(--ease-out) infinite;
}
@keyframes iepSlide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}

/* --- 结果栏 --- */
.iep-result-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  box-shadow: var(--shadow-sm);
}
.iep-result-meta { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.iep-result-prompt {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.iep-seed-chip {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  color: var(--text-2);
  font: 550 10.5px var(--font-mono);
  padding: 3px 10px;
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
  white-space: nowrap;
}
.iep-seed-chip:hover { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.iep-result-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* --- 状态（空 / 错误） --- */
.iep-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--text-3);
  padding: 32px;
}
.iep-state-title { font-size: 13.5px; font-weight: 620; color: var(--text-1); }
.iep-state-msg { font-size: 12px; color: var(--text-3); max-width: 48ch; line-height: 1.7; word-break: break-word; }
.iep-state-error {
  color: var(--warn-text);
  border: 1px solid var(--warn-border);
  border-radius: var(--radius-lg);
  background: var(--warn-bg);
  margin: 12px;
}
.iep-state-error .iep-state-title { color: var(--warn-text); }
.iep-state-error .iep-state-msg { color: var(--warn-text); opacity: 0.85; }
.iep-steps {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
  counter-reset: iep-step;
  text-align: left;
}
.iep-steps li::before {
  counter-increment: iep-step;
  content: counter(iep-step) '. ';
  color: var(--text-3);
}

/* --- 历史缩略图条 --- */
.iep-history {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  overflow-x: auto;
}
.iep-history-label {
  font-size: 11.5px;
  font-weight: 620;
  color: var(--text-2);
  white-space: nowrap;
  flex-shrink: 0;
}
.iep-history-list { display: flex; gap: 10px; }
.iep-history-item {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.iep-history-thumb {
  padding: 0;
  width: 92px;
  height: 60px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  overflow: hidden;
  cursor: zoom-in;
  line-height: 0;
  transition: border-color 0.16s var(--ease-out), transform 0.16s var(--ease-out);
}
.iep-history-thumb:hover { border-color: var(--accent); transform: translateY(-1px); }
.iep-history-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.iep-history-ops { display: flex; gap: 3px; }
.iep-history-ops .btn-icon { width: 22px; min-width: 22px; height: 22px; min-height: 22px; }
.iep-history-index { font: 550 9.5px var(--font-mono); color: var(--text-3); }
.iep-history .iep-note { white-space: nowrap; flex-shrink: 0; margin-left: auto; }

/* ===== 大图预览 ===== */
.iep-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: var(--scrim);
  backdrop-filter: blur(6px);
  cursor: zoom-out;
  animation: fadeIn 0.18s var(--ease-out);
}
.iep-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius);
  box-shadow: var(--shadow-elevated);
  cursor: default;
}
.iep-lightbox-close {
  position: absolute;
  top: 20px;
  right: 24px;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--media-surface);
  color: var(--on-media);
  cursor: pointer;
}
.iep-lightbox-close:hover { background: var(--bg-hover); color: var(--text-0); }
</style>
