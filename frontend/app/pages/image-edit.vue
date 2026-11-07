<template>
  <div class="page iep-page">
    <!-- ===== 顶栏 ===== -->
    <header class="iep-topbar">
      <div class="iep-brand">
        <h1 class="iep-title">
          <Wand2 :size="16" :stroke-width="2.1" />
          {{ t('imageEdit.title') }}
        </h1>
        <span class="iep-sub">{{ t('imageEdit.sub') }}</span>
      </div>
      <span class="iep-engine" :class="engineReady ? 'is-ok' : 'is-warn'">
        <i class="iep-engine-dot" />
        <span>{{ engineReady ? t('imageEdit.engine.ready') : engineLoading ? t('imageEdit.engine.checking') : engineHint }}</span>
      </span>
    </header>

    <!-- 引擎未就绪提示条 -->
    <div v-if="!engineLoading && !engineReady" class="iep-banner">
      <TriangleAlert :size="14" :stroke-width="1.9" />
      <span>{{ engineHint }}</span>
      <NuxtLink to="/settings" class="iep-banner-link">{{ t('imageEdit.engine.goSettings') }}</NuxtLink>
    </div>

    <div class="iep-layout">
      <!-- ===== 左：控制栏（可滚动） ===== -->
      <aside class="iep-sidebar">
        <!-- 输入 -->
        <section class="iep-sec">
          <header class="iep-sec-head">
            <ImagePlus :size="13" :stroke-width="2" />
            <h2>{{ t('imageEdit.input.title') }}</h2>
            <span class="iep-sec-note">{{ t('imageEdit.slot.max') }}</span>
          </header>

          <div class="iep-slots">
            <div
              class="iep-slot"
              :class="{ 'has-image': !!base, 'is-uploading': uploading.base }"
              role="button"
              tabindex="0"
              @click="onSlotClick('base')"
              @keydown.enter.prevent="onSlotClick('base')"
              @dragover.prevent
              @drop.prevent="onDrop('base', $event)"
            >
              <span class="iep-slot-tag">{{ t('imageEdit.slot.base') }}<em>*</em></span>
              <template v-if="base">
                <img :src="base.url" alt="" class="iep-slot-img" />
                <div class="iep-slot-mask">
                  <button class="btn btn-sm" @click.stop="openPicker('base')">{{ t('imageEdit.slot.replace') }}</button>
                  <button class="btn btn-sm btn-danger" @click.stop="clearSlot('base')">{{ t('imageEdit.slot.remove') }}</button>
                </div>
              </template>
              <div v-else class="iep-slot-empty">
                <Loader2 v-if="uploading.base" :size="16" class="animate-spin" />
                <ImagePlus v-else :size="16" :stroke-width="1.6" />
                <span>{{ uploading.base ? t('imageEdit.result.running') : t('imageEdit.slot.upload') }}</span>
              </div>
            </div>

            <!-- 参考图：动态槽位（图2 起）；空槽位渲染上传占位而非破图 -->
            <div
              v-for="(ref, index) in refImages"
              :key="ref.id"
              class="iep-slot"
              :class="{ 'has-image': !!ref.url, 'is-uploading': uploadingRefs.has(ref.id) }"
              role="button"
              tabindex="0"
              @click="onRefSlotClick(ref)"
              @keydown.enter.prevent="onRefSlotClick(ref)"
              @dragover.prevent
              @drop.prevent="onRefDrop(ref, $event)"
            >
              <span class="iep-slot-tag">图{{ index + 2 }}</span>
              <template v-if="ref.url">
                <img :src="ref.url" alt="" class="iep-slot-img" />
                <span v-if="ref.name" class="iep-slot-name">{{ ref.name }}</span>
                <div class="iep-slot-mask">
                  <button class="btn btn-sm" @click.stop="openRefPicker(ref.id)">{{ t('imageEdit.slot.replace') }}</button>
                  <button class="btn btn-sm btn-danger" @click.stop="removeRef(ref.id)">{{ t('imageEdit.slot.remove') }}</button>
                </div>
              </template>
              <div v-else class="iep-slot-empty">
                <Loader2 v-if="uploadingRefs.has(ref.id)" :size="16" class="animate-spin" />
                <ImagePlus v-else :size="16" :stroke-width="1.6" />
                <span>{{ t('imageEdit.slot.upload') }}</span>
                <div class="iep-slot-mask">
                  <button class="btn btn-sm btn-danger" @click.stop="removeRef(ref.id)">{{ t('imageEdit.slot.remove') }}</button>
                </div>
              </div>
            </div>

            <!-- 追加参考图 -->
            <button
              v-if="refImages.length < MAX_REFS"
              type="button"
              class="iep-slot iep-slot-add"
              :disabled="busy"
              @click="addRefSlot"
            >
              <ImagePlus :size="16" :stroke-width="1.6" />
              <span>{{ t('imageEdit.slot.addRef') }}</span>
            </button>
          </div>

          <input ref="baseInput" type="file" accept="image/*" class="sr-only" @change="onPick('base', $event)" />
          <input ref="refInput" type="file" accept="image/*" class="sr-only" @change="onRefPick($event)" />
        </section>

        <!-- 局部编辑 -->
        <section class="iep-sec">
          <header class="iep-sec-head">
            <Crop :size="13" :stroke-width="2" />
            <h2>{{ t('imageEdit.region.draw') }}</h2>
            <button
              v-if="regionRect"
              type="button"
              class="btn btn-sm iep-clear-btn"
              @click="clearRegion"
            >{{ t('imageEdit.region.clear') }}</button>
          </header>
          <button
            type="button"
            class="iep-region-btn"
            :class="{ 'is-on': regionMode }"
            :disabled="!base || busy"
            @click="toggleRegionMode"
          >
            <SquareDashedMousePointer :size="14" :stroke-width="2" />
            <span>{{ regionMode ? t('imageEdit.region.exit') : t('imageEdit.region.draw') }}</span>
            <i v-if="regionRect" class="iep-region-badge-on">{{ regionBadge }}</i>
          </button>
          <p class="iep-hint">{{ regionHint }}</p>
        </section>

        <!-- 指令 -->
        <section class="iep-sec">
          <header class="iep-sec-head">
            <PenLine :size="13" :stroke-width="2" />
            <h2>{{ t('imageEdit.prompt.label') }}</h2>
            <span class="iep-sec-note">{{ t('imageEdit.prompt.desc') }}</span>
          </header>

          <textarea
            v-model="prompt"
            class="textarea iep-prompt"
            rows="4"
            :placeholder="t('imageEdit.prompt.placeholder')"
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
              :class="{ 'is-disabled': item.disabled }"
              :title="item.disabled ? t('imageEdit.err.needRef') : item.label"
              @click="applyQuick(item)"
            >{{ item.short }}</button>
          </div>
        </section>

        <!-- 参数 -->
        <section class="iep-sec">
          <header class="iep-sec-head" @click="advOpen = !advOpen">
            <SlidersHorizontal :size="13" :stroke-width="2" />
            <h2>{{ t('imageEdit.adv.title') }}</h2>
            <ChevronDown :size="13" :stroke-width="2.2" class="iep-chev" :class="{ 'is-open': advOpen }" />
          </header>

          <div v-if="advOpen" class="iep-adv">
            <div class="iep-field">
              <label class="iep-field-label">{{ t('imageEdit.adv.quality') }}</label>
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
                  {{ t('imageEdit.adv.custom') }}
                </button>
              </div>
            </div>

            <div v-if="customSize" class="iep-field">
              <label class="iep-field-label">{{ t('imageEdit.adv.customSize') }}</label>
              <div class="iep-size-inputs">
                <input v-model.number="customWidth" class="input iep-num" type="number" min="256" max="4096" step="8" />
                <span class="dim">×</span>
                <input v-model.number="customHeight" class="input iep-num" type="number" min="256" max="4096" step="8" />
                <span class="iep-note">{{ customPixelNote }}</span>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('imageEdit.adv.resolution') }}</label>
              <div class="seg iep-seg">
                <button
                  v-for="r in RESOLUTIONS"
                  :key="r.value"
                  type="button"
                  class="seg-item"
                  :class="{ on: resolution === r.value }"
                  :title="t('imageEdit.adv.resolutionHint')"
                  @click="resolution = r.value"
                >{{ r.labelKey ? t(r.labelKey) : r.label }}</button>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('imageEdit.adv.steps') }}</label>
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
              <label class="iep-field-label">{{ t('imageEdit.adv.seed') }}</label>
              <div class="iep-seed-row">
                <input
                  v-model="seed"
                  class="input iep-seed"
                  type="text"
                  inputmode="numeric"
                  :placeholder="t('imageEdit.adv.seedPlaceholder')"
                />
                <button type="button" class="btn btn-sm" @click="seed = String(randomSeed())">
                  <Dices :size="12" :stroke-width="2" />
                </button>
              </div>
            </div>

            <div class="iep-field">
              <label class="iep-field-label">{{ t('imageEdit.adv.negative') }}</label>
              <textarea
                v-model="negativePrompt"
                class="textarea iep-negative"
                rows="2"
                :placeholder="t('imageEdit.adv.negativePlaceholder')"
              />
            </div>

            <p class="iep-note">{{ t('imageEdit.adv.persistHint') }}</p>
          </div>
        </section>

        <!-- 底部固定操作区 -->
        <div class="iep-submit-bar">
          <div class="iep-ratio">
            <label class="iep-field-label">{{ t('imageEdit.output.label') }}</label>
            <select v-model="ratioMode" class="input iep-ratio-select">
              <option value="auto">{{ t('imageEdit.output.auto') }}</option>
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
              {{ t('imageEdit.action.cancel') }}
            </button>
            <button v-else class="btn btn-primary iep-submit" :disabled="!engineReady" @click="generate">
              <Sparkles :size="14" :stroke-width="2" />
              {{ result || errorMsg ? t('imageEdit.action.regenerate') : t('imageEdit.action.generate') }}
            </button>
          </div>
          <p class="iep-note iep-kbd">{{ t('imageEdit.action.shortcut') }}</p>
        </div>
      </aside>

      <!-- ===== 右：画布区 ===== -->
      <main class="iep-stage">
        <!-- 生成中 -->
        <div v-if="busy" class="iep-stage-inner">
          <div class="iep-canvas iep-canvas-running">
            <img v-if="base" :src="base.url" alt="" class="iep-canvas-img is-dimmed" />
            <div class="iep-running-overlay">
              <Loader2 :size="22" class="animate-spin" />
              <p class="iep-running-title">{{ t('imageEdit.result.running') }}</p>
              <p class="iep-running-time">{{ t('imageEdit.result.elapsed', { s: elapsed }) }}</p>
              <div class="progress iep-progress"><span class="iep-progress-bar" /></div>
            </div>
          </div>
        </div>

        <!-- 选区绘制：优先于结果/错误展示，否则生成完成后无法重新框选 -->
        <div v-else-if="regionMode && base" class="iep-stage-inner">
          <div class="iep-canvas iep-canvas-region">
            <div
              ref="regionCanvas"
              class="iep-region-canvas"
              @pointerdown="onRegionPointerDown"
              @pointermove="onRegionPointerMove"
              @pointerup="onRegionPointerUp"
              @pointerleave="onRegionPointerUp"
            >
              <img ref="regionImage" :src="base.url" alt="" class="iep-canvas-img" draggable="false" @load="onRegionImageLoad" />
              <div v-if="regionDraft || regionRect" class="iep-region-box" :style="regionBoxStyle">
                <span class="iep-region-badge">{{ regionBadge }}</span>
              </div>
            </div>
          </div>
          <footer class="iep-region-bar">
            <span class="iep-note">{{ regionHint }}</span>
            <button v-if="regionRect" type="button" class="btn btn-sm" @click="clearRegion">
              {{ t('imageEdit.region.clear') }}
            </button>
          </footer>
        </div>

        <!-- 失败 -->
        <div v-else-if="errorMsg" class="iep-stage-inner">
          <div class="iep-state iep-state-error">
            <TriangleAlert :size="22" :stroke-width="1.7" />
            <p class="iep-state-title">{{ t('imageEdit.result.failed') }}</p>
            <p class="iep-state-msg">{{ errorMsg }}</p>
            <button class="btn btn-sm" @click="generate">{{ t('imageEdit.action.retry') }}</button>
          </div>
        </div>

        <!-- 完成 -->
        <div v-else-if="result" class="iep-stage-inner">
          <div class="iep-canvas">
            <img :src="result.url" alt="" class="iep-canvas-img iep-canvas-clickable" :title="t('imageEdit.action.view')" @click="preview = result.url" />
          </div>
          <footer class="iep-result-bar">
            <div class="iep-result-meta">
              <p class="iep-result-prompt" :title="result.prompt">{{ result.prompt }}</p>
              <button
                v-if="result.seed"
                type="button"
                class="iep-seed-chip"
                :title="t('imageEdit.result.useSeed')"
                @click="seed = String(result.seed)"
              >seed {{ result.seed }}</button>
            </div>
            <div class="iep-result-actions">
              <button class="btn btn-sm" @click="useAsBase(result)">
                <CornerUpLeft :size="12" :stroke-width="2" />
                {{ t('imageEdit.action.useAsBase') }}
              </button>
              <button class="btn btn-sm btn-primary" @click="download(result)">
                <Download :size="12" :stroke-width="2" />
                {{ t('imageEdit.action.download') }}
              </button>
            </div>
          </footer>
        </div>

        <!-- 空态 -->
        <div v-else class="iep-stage-inner">
          <div class="iep-state iep-state-empty">
            <ImageIcon :size="28" :stroke-width="1.4" />
            <p class="iep-state-title">{{ t('imageEdit.result.empty') }}</p>
            <ol class="iep-steps">
              <li>{{ t('imageEdit.result.step1') }}</li>
              <li>{{ t('imageEdit.result.step2') }}</li>
              <li>{{ t('imageEdit.result.step3') }}</li>
            </ol>
          </div>
        </div>

        <!-- 历史缩略图条 -->
        <footer v-if="history.length" class="iep-history">
          <span class="iep-history-label">{{ t('imageEdit.result.session') }}</span>
          <div class="iep-history-list">
            <div v-for="(item, i) in history" :key="item.id || item.at" class="iep-history-item">
              <button class="iep-history-thumb" :title="t('imageEdit.action.view')" @click="preview = item.url">
                <img :src="item.url" alt="" loading="lazy" />
              </button>
              <div class="iep-history-ops">
                <button class="btn btn-sm btn-icon" :title="t('imageEdit.action.useAsBase')" @click="useAsBase(item)">
                  <CornerUpLeft :size="11" :stroke-width="1.9" />
                </button>
                <button class="btn btn-sm btn-icon" :title="t('imageEdit.action.download')" @click="download(item)">
                  <Download :size="11" :stroke-width="1.9" />
                </button>
                <button
                  v-if="item.id"
                  class="btn btn-sm btn-icon"
                  :title="t('imageEdit.action.removeHistory')"
                  @click="removeHistory(item)"
                >
                  <Trash2 :size="11" :stroke-width="1.9" />
                </button>
              </div>
              <span class="iep-history-index">#{{ history.length - i }}</span>
            </div>
          </div>
          <span class="iep-note">{{ t('imageEdit.result.sessionHint') }}</span>
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
      <button class="iep-lightbox-close" :title="t('imageEdit.action.close')" @click="preview = null">
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
  CornerUpLeft,
  Crop,
  Dices,
  Download,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from 'lucide-vue-next'
import { localEnvAPI, settingsAPI, taskAPI, uploadAPI, workspaceImageAPI } from '~/composables/useApi'
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
/** 采样步数档位（编辑类任务 20~25 步通常已够） */
const STEP_OPTIONS = [12, 20, 25, 40]
/**
 * 输出分辨率：编辑模式的出图尺寸由工作流 TextEncodeQwenImage21.resolution 决定。
 * 0 = 跟随参考图（参考图发送前压缩到 768px，故约 768px 出图）
 */
const RESOLUTIONS = [
  { value: 0, labelKey: 'imageEdit.adv.resLabel' },
  { value: 1024, label: '1K' },
  { value: 1536, label: '1.5K' },
  { value: 2048, label: '2K' },
]
/** 单张上传图上限，避免超出 ComfyUI 输入目录与内存承受范围 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']

const baseInput = ref(null)
const refInput = ref(null)

const base = ref(null)
/** 参考图（图2 起，最多 MAX_REFS 张）：{ id, url, path, name, width, height }，id 为空位占位 */
const refImages = ref([])
const uploading = reactive({ base: false })
/** 每个参考槽位独立的上传态 */
const uploadingRefs = reactive(new Set())
let refSlotSeq = 0
/** 参考图上限 = 工作流图片槽位总数 - 底图 1 张 */
const MAX_REFS = 3

const refImage = computed(() => refImages.value.find(item => item?.url) || null)

function addRefSlot() {
  if (refImages.value.length >= MAX_REFS || busy.value) return
  const slot = { id: `slot-${++refSlotSeq}`, url: '', path: '', name: '', width: 0, height: 0 }
  refImages.value.push(slot)
  // 追加后直接打开文件选择器，省一次点击
  openRefPicker(slot.id)
}

function removeRef(id) {
  if (busy.value) return
  uploadingRefs.delete(id)
  // 已上传的槽位移除后补一个空槽到队尾（保持可用槽位数量），全空则清空列表
  const list = refImages.value.filter(item => item.id !== id)
  refImages.value = list.some(item => item.url) ? list : []
}

function openRefPicker(id) {
  const slot = refImages.value.find(item => item.id === id)
  const input = refInput.value
  if (!slot || !input || uploadingRefs.has(id)) return
  // 记录目标槽位：单例 file input 复用，change 时按 slotId 回填
  input.dataset.slotId = id
  input.click()
}

function onRefSlotClick(ref) {
  if (ref?.url) preview.value = ref.url
  else openRefPicker(ref.id)
}

function onRefDrop(ref, event) {
  const file = event.dataTransfer?.files?.[0]
  if (file) void acceptRefFile(ref, file)
}

async function onRefPick(event) {
  const input = refInput.value
  const slotId = input?.dataset?.slotId
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  const slot = refImages.value.find(item => item.id === slotId)
  if (!slot) return
  if (!file) {
    // 用户取消选择：清掉因「添加参考图」而新开的空槽位，避免残留占位
    if (!slot.url) refImages.value = refImages.value.filter(item => item.id !== slotId)
    return
  }
  await acceptRefFile(slot, file)
}

async function acceptRefFile(slot, file) {
  if (!file.type?.startsWith('image/')) {
    toast.error(t('imageEdit.err.notImage'))
    return
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    toast.error(t('imageEdit.err.tooLarge'))
    return
  }
  uploadingRefs.add(slot.id)
  try {
    const res = await uploadAPI.image(file)
    const rawUrl = String(res?.url || '')
    const url = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
    const path = String(res?.path || rawUrl.replace(/^\//, ''))
    const size = await readImageSize(url)
    Object.assign(slot, { url, path, name: file.name || '', ...size })
  } catch (e) {
    toastError(e, { fallback: 'imageEdit.err.uploadFailed' })
  } finally {
    uploadingRefs.delete(slot.id)
  }
}

const prompt = ref('')
const ratioMode = ref('auto')

// ===== 局部编辑（选区重绘） =====
const regionMode = ref(false)
const regionCanvas = ref(null)
const regionImage = ref(null)
/** 用户框选的原始选区（底图像素坐标） */
const regionRect = ref(null)
/** 拖拽过程中的临时选区（展示坐标） */
const regionDraft = ref(null)
const regionDragging = ref(false)
const regionStart = ref(null)
/** 底图原始尺寸（显示尺寸 → 像素坐标换算） */
const regionImgSize = ref({ width: 0, height: 0 })
/** 画布渲染尺寸（ResizeObserver 维护，驱动选区框在窗口缩放时重算） */
const regionCanvasSize = ref({ width: 0, height: 0 })
let regionResizeObserver = null

watch(regionCanvas, (canvas) => {
  regionResizeObserver?.disconnect()
  if (!canvas) return
  regionResizeObserver = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect
    if (box) regionCanvasSize.value = { width: box.width, height: box.height }
  })
  regionResizeObserver.observe(canvas)
})

onBeforeUnmount(() => regionResizeObserver?.disconnect())

const regionHint = computed(() => {
  if (!base.value) return t('imageEdit.region.needBase')
  if (regionMode.value) {
    if (!regionRect.value) return t('imageEdit.region.hintDraw')
    const unit = t('imageEdit.region.badgeUnit')
    return t('imageEdit.region.hintSelected', {
      rect: `${Math.round(regionRect.value.w)}×${Math.round(regionRect.value.h)}${unit}`,
    })
  }
  return ''
})

const regionBadge = computed(() => {
  const rect = regionDraft.value || regionRect.value
  if (!rect) return ''
  return `${Math.round(rect.w)}×${Math.round(rect.h)}`
})

/**
 * contain 布局度量：图片在画布内按比例缩放居中，
 * 返回实际内容区（相对画布的像素偏移与尺寸）及缩放系数。
 * 选区框定位与指针坐标换算都必须基于内容区，而不是画布本身——
 * 画布与图片比例不同时 contain 会留白，用画布坐标会错位。
 */
function containMetrics() {
  const canvas = regionCanvas.value
  const size = regionImgSize.value
  // 读取 regionCanvasSize 只为建立 computed 依赖，让窗口缩放时选区框重算
  void regionCanvasSize.value
  if (!canvas || !size.width || !size.height) return null
  const bounds = canvas.getBoundingClientRect()
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height)
  return {
    left: (bounds.width - size.width * scale) / 2,
    top: (bounds.height - size.height * scale) / 2,
    width: size.width * scale,
    height: size.height * scale,
    scale,
  }
}

/** 选区框样式：基于 contain 内容区做像素定位（图片居中留白时依然贴合） */
const regionBoxStyle = computed(() => {
  const rect = regionDraft.value || regionRect.value
  const metrics = containMetrics()
  if (!rect || !metrics) return {}
  return {
    left: `${metrics.left + rect.x * metrics.scale}px`,
    top: `${metrics.top + rect.y * metrics.scale}px`,
    width: `${rect.w * metrics.scale}px`,
    height: `${rect.h * metrics.scale}px`,
  }
})

function toggleRegionMode() {
  regionMode.value = !regionMode.value
  if (!regionMode.value) clearRegion()
}

function clearRegion() {
  regionRect.value = null
  regionDraft.value = null
}

/** 底图更换后尺寸重测；旧选区坐标基于旧图，一并清掉 */
function onRegionImageLoad(event) {
  const img = event.target
  regionImgSize.value = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 }
  if (regionRect.value) regionRect.value = null
}

watch(base, () => {
  if (!base.value) {
    regionMode.value = false
    clearRegion()
  }
})

/** 事件坐标 → 底图像素坐标（按 contain 内容区换算，剔除居中留白） */
function eventToImagePoint(event) {
  const metrics = containMetrics()
  const canvas = regionCanvas.value
  if (!metrics || !canvas) return null
  const bounds = canvas.getBoundingClientRect()
  const x = (event.clientX - bounds.left - metrics.left) / metrics.scale
  const y = (event.clientY - bounds.top - metrics.top) / metrics.scale
  const size = regionImgSize.value
  return {
    x: Math.min(Math.max(0, x), size.width),
    y: Math.min(Math.max(0, y), size.height),
  }
}

function onRegionPointerDown(event) {
  if (event.button !== 0) return
  const point = eventToImagePoint(event)
  if (!point) return
  event.preventDefault()
  regionCanvas.value?.setPointerCapture?.(event.pointerId)
  regionDragging.value = true
  regionStart.value = point
  regionDraft.value = { x: point.x, y: point.y, w: 0, h: 0 }
}

function onRegionPointerMove(event) {
  if (!regionDragging.value || !regionStart.value) return
  const point = eventToImagePoint(event)
  if (!point) return
  const start = regionStart.value
  regionDraft.value = {
    x: Math.min(start.x, point.x),
    y: Math.min(start.y, point.y),
    w: Math.abs(point.x - start.x),
    h: Math.abs(point.y - start.y),
  }
}

function onRegionPointerUp(event) {
  if (!regionDragging.value) return
  regionDragging.value = false
  if (event?.pointerId != null) regionCanvas.value?.releasePointerCapture?.(event.pointerId)
  const draft = regionDraft.value
  regionDraft.value = null
  // 太小的框视为误触，不生效
  if (!draft || draft.w < 8 || draft.h < 8) return
  regionRect.value = { x: draft.x, y: draft.y, w: draft.w, h: draft.h }
}

const busy = ref(false)
const elapsed = ref(0)
const result = ref(null)
const errorMsg = ref('')
const history = ref([])
const preview = ref(null)

const engine = ref({ enabled: false, imageReady: false, url: '' })
const engineLoading = ref(true)

// 请求内容查看：保留最近一次提交的任务号，生成结束后仍可回溯真实发给模型的提示词
const lastTaskId = ref(null)
const requestOpen = ref(false)
const requestItems = computed(() => (lastTaskId.value
  ? [{ id: lastTaskId.value, label: t('requestSnapshot.taskImageEdit') }]
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
  return t('imageEdit.adv.customPixelNote', { mp: (pixels / 1024 / 1024).toFixed(2) })
})

let pollTimer = null
let taskId = null
let cancelledByUser = false

const engineReady = computed(() => engine.value.enabled && engine.value.imageReady)
const engineHint = computed(() => (engine.value.enabled
  ? t('imageEdit.engine.notReady')
  : t('imageEdit.engine.notEnabled')))

/** 快捷指令：需要参考图的条目在没有任何参考图时置灰 */
const QUICK_KEYS = [
  { key: 'fusion', needRef: true },
  { key: 'outfit', needRef: true },
  { key: 'style', needRef: false },
  { key: 'cleanup', needRef: false },
  { key: 'enhance', needRef: false },
]
const quickItems = computed(() => {
  const hasRef = refImages.value.some(item => item.url)
  return QUICK_KEYS.map(item => ({
    key: item.key,
    label: t(`imageEdit.prompt.${item.key}`),
    short: t(`imageEdit.prompt.${item.key}Short`),
    disabled: item.needRef && !hasRef,
  }))
})

/** 输出尺寸提示：跟随底图时把底图原始宽高一并显示，方便判断比例是否被压缩 */
const outputNote = computed(() => {
  const size = outputSize()
  if (ratioMode.value !== 'auto' || !base.value?.width) return size
  return t('imageEdit.output.noteAuto', { w: base.value.width, h: base.value.height, size })
})

onMounted(() => {
  loadEngine()
  loadHistory()
  window.addEventListener('paste', onPaste)
})

onBeforeUnmount(() => {
  stopTimer()
  cancelledByUser = true
  window.removeEventListener('paste', onPaste)
})

/**
 * Ctrl/Cmd+V 粘贴图片：路由到最合适的槽位——
 * 底图为空 → 底图；有空参考槽 → 该槽；参考未满 → 新增槽；都满了 → 替换底图。
 * 焦点在输入框/文本域时不劫持（避免干扰正常文本粘贴）。
 */
function onPaste(event) {
  if (busy.value) return
  const active = document.activeElement
  const tag = active?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return
  const items = event.clipboardData?.items
  if (!items) return
  let file = null
  for (const item of items) {
    if (item.type?.startsWith('image/')) { file = item.getAsFile(); break }
  }
  if (!file) return
  event.preventDefault()
  void routeImage(file)
}

async function routeImage(file) {
  // 1) 底图空 → 底图
  if (!base.value) {
    await acceptFile('base', file)
    toast.success(t('imageEdit.ctx.pastedTo', { target: t('imageEdit.slot.base') }))
    return
  }
  // 2) 已有空的参考槽 → 填入
  const emptyRef = refImages.value.find(item => !item.url)
  if (emptyRef) {
    await acceptRefFile(emptyRef, file)
    const index = refImages.value.indexOf(emptyRef)
    toast.success(t('imageEdit.ctx.pastedTo', { target: `图${index + 2}` }))
    return
  }
  // 3) 参考未满 → 新增槽位
  if (refImages.value.length < MAX_REFS) {
    const slot = { id: `slot-${++refSlotSeq}`, url: '', path: '', name: '', width: 0, height: 0 }
    refImages.value.push(slot)
    await acceptRefFile(slot, file)
    toast.success(t('imageEdit.ctx.pastedTo', { target: `图${refImages.value.length + 1}` }))
    return
  }
  // 4) 都满了 → 替换底图
  await acceptFile('base', file)
  toast.success(t('imageEdit.ctx.pastedTo', { target: t('imageEdit.slot.base') }))
}

/** 从服务端恢复历史：记录带 id，便于逐条删除；加载失败不阻断工作台 */
async function loadHistory() {
  try {
    const rows = await workspaceImageAPI.list('image_edit')
    history.value = (Array.isArray(rows) ? rows : []).map(row => {
      const path = String(row.local_path || row.localPath || '')
      return {
        id: row.id,
        url: path.startsWith('/') ? path : `/${path}`,
        path,
        prompt: String(row.prompt || ''),
        at: Date.parse(row.created_at || row.createdAt || '') || Date.now(),
        seed: Number(row.seed) > 0 ? Number(row.seed) : null,
      }
    })
  } catch { /* 历史不可用不影响生成 */ }
}

async function removeHistory(item) {
  if (!item.id) return
  try {
    await workspaceImageAPI.del(item.id)
    history.value = history.value.filter(entry => entry.id !== item.id)
  } catch (e) {
    toastError(e, { fallback: 'imageEdit.err.failed' })
  }
}

async function loadEngine() {
  engineLoading.value = true
  try {
    const info = await settingsAPI.localEngine()
    engine.value = {
      enabled: !!info?.enabled,
      imageReady: !!info?.imageReady,
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
    engine.value = { enabled: false, imageReady: false, url: '' }
  } finally {
    engineLoading.value = false
  }
}

function openPicker() {
  if (uploading.base) return
  baseInput.value?.click()
}

/** 已上传时点击缩略图看大图，未上传时点击选择文件 */
function onSlotClick() {
  if (base.value) preview.value = base.value.url
  else openPicker()
}

async function onPick(kind, event) {
  const file = event.target?.files?.[0]
  // 清空 input，保证同一张图可以再次选择并触发 change
  if (event.target) event.target.value = ''
  if (file) await acceptFile(kind, file)
}

function onDrop(kind, event) {
  const file = event.dataTransfer?.files?.[0]
  if (file) void acceptFile(kind, file)
}

async function acceptFile(kind, file) {
  if (!file.type?.startsWith('image/')) {
    toast.error(t('imageEdit.err.notImage'))
    return
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    toast.error(t('imageEdit.err.tooLarge'))
    return
  }
  uploading[kind] = true
  try {
    const res = await uploadAPI.image(file)
    const rawUrl = String(res?.url || '')
    const url = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
    const path = String(res?.path || rawUrl.replace(/^\//, ''))
    const size = await readImageSize(url)
    base.value = { url, path, name: file.name || '', ...size }
  } catch (e) {
    toastError(e, { fallback: 'imageEdit.err.uploadFailed' })
  } finally {
    uploading[kind] = false
  }
}

function clearSlot() {
  if (uploading.base || busy.value) return
  base.value = null
}

/** 读取图片真实像素，用于「跟随底图」推算输出尺寸 */
function readImageSize(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = src
  })
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
  const baseRatio = base.value?.width && base.value?.height
    ? base.value.width / base.value.height
    : 16 / 9
  const ratio = ratioMode.value === 'auto' ? baseRatio : parseRatio(ratioMode.value)
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

/** 选区四舍五入到整数像素（后端按整数处理） */
function roundRegion(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  }
}

function parseRatio(mode) {
  const [w, h] = String(mode).split(':').map(Number)
  return w > 0 && h > 0 ? w / h : 16 / 9
}

/**
 * 本地编辑工作流按 LoadImage 顺序接收参考图：images[0] → 图1，images[1] → 图2。
 * 提示词必须显式说明「图1/图2」各是什么，否则模型无法区分底图与素材。
 *
 * 局部编辑：选区以 <bbox> 归一化坐标（0-999）写进提示词，由模型整图重绘——
 * 不做本地裁切拼接，选区与参考图（图2）可以同时使用。
 */
function composePrompt() {
  const refs = refImages.value.filter(item => item.url)
  let prefix = refs.length
    ? t('imageEdit.prompt.multiImagesPrefix', { from: 2, to: refs.length + 1 })
    : t('imageEdit.prompt.oneImagePrefix')
  // 局部编辑：选区红框由后端画在图1上（视觉编码器直接可见），
  // 提示词只需自然语言指代；整图重绘让新内容与周围自然融合
  if (regionRect.value) {
    prefix += t('imageEdit.prompt.regionMarked')
  }
  return `${prefix}${prompt.value.trim()}`
}

function applyQuick(item) {
  if (busy.value) return
  if (item.disabled) {
    toast.warning(t('imageEdit.err.needRef'))
    return
  }
  prompt.value = item.label
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
  if (!base.value) {
    toast.error(t('imageEdit.err.needBase'))
    return
  }
  if (!prompt.value.trim()) {
    toast.error(t('imageEdit.err.needPrompt'))
    return
  }

  busy.value = true
  cancelledByUser = false
  errorMsg.value = ''
  result.value = null
  // 收起绘制模式（选区坐标保留）：否则生成完成后画布仍被绘制态占据，看不到结果；
  // 再次点「局部重绘」会带着旧选区进入，可清除后重画
  regionMode.value = false
  startTimer()

  try {
    // 清晰度与步数改动写回模板默认（作用域：全局，影响后续所有图片生成）
    await syncDefaults()
    const seedValue = Number(seed.value)
    const task = await taskAPI.generate({
      type: 'image',
      // workspace_kind：后端在出图时把结果写入独立历史表，刷新页面可回看
      workspace_kind: 'image_edit',
      prompt: composePrompt(),
      // 顺序即工作流的图 1 / 图 2…，禁止调换；空槽位不参与提交
      reference_images: [
        base.value.path,
        ...refImages.value.filter(item => item.url).map(item => item.path),
      ],
      ...(regionRect.value ? { region: roundRegion(regionRect.value) } : {}),
      size: outputSize(),
      // 本次强制覆盖步数与输出分辨率；种子留空则由后端随机（实际值可从请求内容里查到）
      option_overrides: { steps: steps.value, resolution: resolution.value },
      ...(Number.isSafeInteger(seedValue) && seedValue > 0 ? { seed: seedValue } : {}),
      ...(negativePrompt.value.trim() ? { negative_prompt: negativePrompt.value.trim() } : {}),
      // local_only：后端只允许本机 ComfyUI 执行，绝不回退云端配置
      local_only: true,
    })
    taskId = task?.id ?? null
    if (!taskId) throw new Error(t('imageEdit.err.failed'))
    lastTaskId.value = taskId
    await pollTask(taskId)
  } catch (e) {
    if (!cancelledByUser) {
      errorMsg.value = mapError(e, { fallback: 'imageEdit.err.failed' })
      toastError(e, { fallback: 'imageEdit.err.failed' })
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
  // resolution 为 0 也是有效值（跟随参考图），只有与已存默认不同才写回
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
    toast.success(t('imageEdit.adv.saved'))
  } catch (e) {
    toastError(e, { fallback: 'imageEdit.err.saveDefaults' })
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
        errorMsg.value = t('imageEdit.err.failed')
        return
      }
      const url = path.startsWith('/') ? path : `/${path}`
      const item = { url, path, prompt: prompt.value.trim(), at: Date.now(), seed: readUsedSeed(res) }
      result.value = item
      // 先本地立即展示，再用服务端已落库的历史覆盖（带上 id 才能逐条删除）
      history.value = [item, ...history.value].slice(0, 24)
      void loadHistory()
      toast.success(t('imageEdit.result.done'))
      return
    }

    if (res.status === 'failed' || res.status === 'cancelled') {
      if (res.error_code === 'cancelled' || res.errorCode === 'cancelled') return
      const msg = res.error_msg || res.errorMsg || t('imageEdit.err.failed')
      errorMsg.value = msg
      toastError(msg)
      return
    }
  }
  errorMsg.value = t('imageEdit.err.timeout')
}

async function cancelTask() {
  if (!taskId) return
  cancelledByUser = true
  try {
    await taskAPI.cancel(taskId)
  } catch { /* 本地队列不可达也不阻断界面复位 */ }
  stopTimer()
  busy.value = false
  toast.info(t('imageEdit.action.cancelDone'))
}

function useAsBase(item) {
  if (busy.value) return
  base.value = { url: item.url, path: item.path, name: item.name || '', width: 0, height: 0 }
  void readImageSize(item.url).then(size => {
    if (base.value?.url === item.url) base.value = { ...base.value, ...size }
  })
  result.value = null
  errorMsg.value = ''
  toast.success(t('imageEdit.action.based'))
}

function download(item) {
  const ext = String(item.path || '').match(/\.(png|jpe?g|webp)$/i)?.[0] || '.png'
  const a = document.createElement('a')
  a.href = item.url
  a.download = `image-edit-${item.at || Date.now()}${ext}`
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

/* --- 上传槽 --- */
.iep-slots {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.iep-slot {
  position: relative;
  aspect-ratio: 4 / 3;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-input);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.16s var(--ease-out), background 0.16s var(--ease-out), transform 0.16s var(--ease-out);
}
.iep-slot:hover { border-color: var(--border-focus); background: var(--bg-hover); }
.iep-slot:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.iep-slot.has-image {
  border-style: solid;
  border-color: var(--border);
  background: var(--media-surface);
}
.iep-slot.has-image:hover { transform: translateY(-1px); border-color: var(--border-strong); }
.iep-slot.is-uploading { cursor: progress; }
.iep-slot-img { width: 100%; height: 100%; object-fit: contain; display: block; }
/* 槽位标签叠在图片上，用深色磨砂底保证任何底图/主题下都可读 */
.iep-slot-tag {
  position: absolute;
  top: 7px;
  left: 7px;
  z-index: 1;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-0) 62%, transparent);
  color: #fff;
  font: 600 10.5px var(--font-body);
  backdrop-filter: blur(6px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}
.iep-slot-tag em { font-style: normal; color: #ffb0b0; margin-left: 1px; }
/* 槽位底部文件名（渐变衬底，常显） */
.iep-slot-name {
  position: absolute;
  inset: auto 0 0 0;
  padding: 16px 9px 6px;
  background: linear-gradient(to top, color-mix(in srgb, var(--bg-0) 72%, transparent), transparent);
  color: #fff;
  font: 500 9.5px var(--font-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

/* 追加参考图按钮 */
.iep-slot-add {
  border-style: dashed;
  flex-direction: column;
  gap: 5px;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}
.iep-slot-add:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.iep-slot-add:disabled { opacity: 0.45; cursor: not-allowed; }
.iep-slot-mask {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  gap: 6px;
  justify-content: center;
  padding: 8px;
  background: linear-gradient(to top, color-mix(in srgb, var(--bg-0) 78%, transparent), transparent);
  opacity: 0;
  transition: opacity 0.16s var(--ease-out);
}
.iep-slot:hover .iep-slot-mask,
.iep-slot:focus-within .iep-slot-mask { opacity: 1; }
.iep-slot-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--text-3);
  padding: 12px;
  text-align: center;
  font-size: 11px;
  line-height: 1.5;
}

/* --- 局部编辑 --- */
.iep-region-btn {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text-2);
  font: 550 12px var(--font-body);
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
}
.iep-region-btn:hover:not(:disabled) { color: var(--text-0); border-color: var(--border-hover); background: var(--bg-hover); }
.iep-region-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.iep-region-btn.is-on {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-bg);
}
.iep-region-badge-on {
  margin-left: auto;
  font: 600 10px var(--font-mono);
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--on-accent);
  font-style: normal;
}
.iep-hint { font-size: 11px; color: var(--text-3); line-height: 1.65; }

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

/* --- 选区画布 --- */
.iep-canvas-region { align-items: stretch; justify-content: stretch; }
.iep-region-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.iep-region-bar .iep-note { flex: 1; min-width: 0; }
.iep-region-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: crosshair;
  user-select: none;
  touch-action: none;
}
.iep-region-canvas .iep-canvas-img { pointer-events: none; }
.iep-region-box {
  position: absolute;
  border: 1.5px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  pointer-events: none;
}
.iep-region-badge {
  position: absolute;
  top: -1px;
  left: -1px;
  transform: translateY(-100%);
  padding: 2px 7px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--accent);
  color: var(--on-accent);
  font: 600 10px var(--font-mono);
  white-space: nowrap;
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
