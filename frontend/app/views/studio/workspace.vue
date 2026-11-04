<template>
  <div class="page studio-page">
    <!-- 头部：项目信息与模式标识 -->
    <div class="page-head card">
      <button class="back-btn" :title="t('common.back')" @click="navigateTo('/')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <div class="head-info">
        <h1 class="page-title">{{ drama?.title || t('studio.head.title') }}</h1>
        <span class="tag tag-accent">{{ t(`studio.types.${mode}.label`) }}</span>
        <span class="dim head-sub">{{ t('studio.head.sub') }}</span>
      </div>
      <span class="tag head-ratio">{{ t('studio.form.ratio') }} · {{ drama?.aspect_ratio || '—' }}</span>
    </div>

    <div v-if="invalid" class="card empty-card">
      <p>{{ t('studio.invalid') }}</p>
      <button class="btn" @click="navigateTo('/')">{{ t('common.back') }}</button>
    </div>

    <div v-else class="studio-layout">
      <!-- 左：素材 + 分段计划 + 生成参数 -->
      <div class="studio-main">
        <div class="section-head">
          <h2>{{ t('studio.materials.title') }}</h2>
          <p class="dim">{{ t('studio.materials.sub') }}</p>
        </div>
        <StudioMaterialSlot
          v-for="slot in modeDef?.slots || []"
          :key="slot.role"
          :slot-def="slot"
          :items="materialsOf(slot.role)"
          :project-id="projectId"
          :disabled="hasRunning"
          @changed="refreshMaterials"
        />

        <!-- 人物替换：按场景切镜的分段预览，时长完全以源视频为准 -->
        <div v-if="isSwap" class="card plan-card">
          <div class="plan-head">
            <h2 class="section-title">{{ t('studio.plan.title') }}</h2>
            <button class="btn btn-sm" type="button" :disabled="planLoading" @click="loadPlan">
              {{ t('common.refresh') }}
            </button>
          </div>
          <div v-if="planLoading" class="dim">{{ t('studio.plan.loading') }}</div>
          <div v-else-if="planError" class="result-error">{{ planError }}</div>
          <template v-else-if="plan?.ready">
            <div class="plan-meta">
              <span class="tag">{{ t('studio.plan.sourceDuration', { n: fmtSec(plan.source_duration) }) }}</span>
              <span class="tag">{{ t('studio.plan.cuts', { n: plan.scene_cuts }) }}</span>
              <span class="tag tag-accent">{{ t('studio.plan.estimate', { n: plan.estimated_tasks }) }}</span>
              <span class="dim">{{ t('studio.plan.meta', { w: plan.width, h: plan.height, fps: Math.round(plan.fps) }) }}</span>
            </div>
            <div class="segment-list">
              <div v-for="seg in plan.segments" :key="seg.index" class="segment-row">
                <span class="segment-index">#{{ seg.index + 1 }}</span>
                <span>{{ t('studio.plan.range', { start: seg.start.toFixed(1), end: seg.end.toFixed(1) }) }}</span>
                <span class="dim">{{ fmtSec(seg.duration) }}</span>
              </div>
            </div>
            <p class="field-hint">{{ t('studio.plan.hint') }}</p>
          </template>
          <div v-else class="dim">{{ t('studio.plan.empty') }}</div>
        </div>

        <div class="card form-card">
          <h2 class="section-title">{{ t('studio.form.title') }}</h2>
          <label class="field">
            <span class="field-label">{{ t('studio.form.prompt') }}</span>
            <textarea
              v-model="form.prompt"
              class="textarea"
              rows="4"
              :placeholder="t('studio.form.promptPlaceholder')"
            ></textarea>
          </label>
          <div class="form-row">
            <label v-if="!isSwap" class="field">
              <span class="field-label">{{ t('studio.form.duration') }}</span>
              <input v-model.number="form.duration" class="input" type="number" min="1" max="30" step="1" />
            </label>
            <div v-else class="field">
              <span class="field-label">{{ t('studio.plan.durationBySource') }}</span>
              <div class="readonly-value">{{ plan?.ready ? fmtSec(plan.source_duration) : '—' }}</div>
            </div>
            <label class="field">
              <span class="field-label">{{ t('studio.form.model') }}</span>
              <BaseSelect v-model="form.config_id" :options="modelOptions" :searchable="false" />
            </label>
          </div>
          <div class="form-foot">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="!ready || busy"
              @click="generate"
            >
              {{ busy ? t('studio.form.generating') : t('studio.form.generate') }}
            </button>
            <span v-if="!ready" class="field-hint">{{ t('studio.form.needMaterials') }}</span>
          </div>
        </div>
      </div>

      <!-- 右：进度与成片。人物替换看批次汇总，转场看单次生成 -->
      <aside class="studio-side">
        <template v-if="isSwap">
          <div class="section-head">
            <h2>{{ t('studio.batch.title') }}</h2>
            <button class="btn btn-sm" type="button" @click="refreshBatches">{{ t('common.refresh') }}</button>
          </div>
          <div v-if="!batches.length" class="card empty-card dim">{{ t('studio.batch.empty') }}</div>
          <article v-for="batch in batches" :key="batch.id" class="card batch-card">
            <div class="batch-head">
              <span class="tag" :class="batchStatusClass(batch)">{{ t('studio.batch.status.' + batch.status) }}</span>
              <span class="dim">{{ t('studio.batch.progress', { done: doneSegments(batch), total: batch.segments?.length || 0 }) }}</span>
            </div>
            <div v-if="batch.merged_url" class="batch-final">
              <video :src="withSlash(batch.merged_url)" controls preload="metadata"></video>
              <div class="result-actions">
                <a class="btn btn-sm" :href="withSlash(batch.merged_url)" download>{{ t('studio.batch.download') }}</a>
                <span class="dim">{{ fmtSec(batch.source_duration) }}</span>
              </div>
            </div>
            <p v-if="batch.error_msg" class="result-error truncate">{{ batch.error_msg }}</p>
            <div class="batch-segments">
              <div v-for="seg in batch.segments || []" :key="seg.id" class="segment-row">
                <span class="segment-index">#{{ seg.segment_index + 1 }}</span>
                <span>{{ seg.start_sec.toFixed(1) }}–{{ seg.end_sec.toFixed(1) }}s</span>
                <span class="tag" :class="segStatusClass(seg)">{{ t('studio.batch.seg.' + seg.status) }}</span>
              </div>
            </div>
          </article>
        </template>

        <template v-else>
          <div class="section-head">
            <h2>{{ t('studio.results.title') }}</h2>
            <button class="btn btn-sm" type="button" @click="refreshGenerations">{{ t('common.refresh') }}</button>
          </div>
          <div v-if="!generations.length" class="card empty-card dim">{{ t('studio.results.empty') }}</div>
          <article v-for="item in generations" :key="item.id" class="card result-card">
            <video
              v-if="item.status === 'completed' && item.preview_url"
              class="result-video"
              :src="item.preview_url"
              controls
              preload="metadata"
            ></video>
            <div v-else class="result-placeholder dim">{{ t('studio.results.status.' + (item.status || 'processing')) }}</div>
            <div class="result-body">
              <div class="result-meta">
                <span class="tag" :class="statusClass(item)">{{ t('studio.results.status.' + (item.status || 'processing')) }}</span>
                <span class="dim">{{ fmtDate(item.created_at) }}</span>
              </div>
              <p class="result-prompt truncate">{{ item.prompt || '—' }}</p>
              <p v-if="item.error_msg" class="result-error truncate">{{ item.error_msg }}</p>
            </div>
            <div class="result-actions">
              <a v-if="item.preview_url" class="btn btn-sm" :href="item.preview_url" download>{{ t('studio.results.download') }}</a>
              <button v-if="item.status === 'failed'" class="btn btn-sm" type="button" @click="recover(item)">
                {{ t('studio.results.recover') }}
              </button>
            </div>
          </article>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup>
/**
 * 独立视频工作台：人物替换（按镜头分段 + 汇总）/ 首尾帧转场（单次生成）。
 * 不加载短剧的集、分镜、角色数据，仅使用工作台自己的素材表与统一任务表。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { toastError } from '~/composables/useToast'
import BaseSelect from '~/components/BaseSelect.vue'
import StudioMaterialSlot from '~/components/studio/StudioMaterialSlot.vue'
import { dramaAPI, taskAPI } from '~/composables/useApi'
import { isStudioMode, studioAPI } from '~/composables/useStudio'

const { t } = useI18n()
const route = useRoute()
const mode = String(route.params.mode || '')
const projectId = Number(route.params.id)

const invalid = ref(!isStudioMode(mode) || !Number.isFinite(projectId) || projectId <= 0)
const isSwap = computed(() => mode === 'character_swap')
const drama = ref(null)
const modes = ref([])
const materials = ref([])
const generations = ref([])
const batches = ref([])
const configs = ref([])
const plan = ref(null)
const planLoading = ref(false)
const planError = ref('')
const submitting = ref(false)
const form = ref({ prompt: '', duration: 5, config_id: '' })
let pollTimer = null

const modeDef = computed(() => modes.value.find(item => item.id === mode))
const hasRunning = computed(() => isSwap.value
  ? batches.value.some(b => b.status === 'processing' || b.status === 'merging')
  : generations.value.some(item => item.status === 'processing'))
const busy = computed(() => submitting.value || hasRunning.value)
const ready = computed(() => {
  const slots = modeDef.value?.slots || []
  const hasMaterials = slots.every(slot => !slot.required || materials.value.some(m => m.role === slot.role))
  // 人物替换还需要成功探测源视频，否则无法分段
  return hasMaterials && (!isSwap.value || Boolean(plan.value?.ready))
})
const modelOptions = computed(() => [
  { label: t('studio.form.modelAuto'), value: '' },
  ...configs.value.filter(c => c.is_active).map(c => ({ label: `${c.name} · ${c.provider}`, value: c.id })),
])

function materialsOf(role) {
  return materials.value.filter(item => item.role === role)
}

function fmtSec(value) { return `${Number(value || 0).toFixed(1)}s` }
function withSlash(value) {
  const raw = String(value || '')
  if (!raw) return ''
  return /^https?:\/\//.test(raw) ? raw : `/${raw.replace(/^\//, '')}`
}
function fmtDate(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function doneSegments(batch) {
  return (batch.segments || []).filter(s => s.status === 'completed').length
}
function batchStatusClass(batch) {
  if (batch.status === 'completed') return 'tag-success'
  if (batch.status === 'failed') return 'tag-error'
  return ''
}
function segStatusClass(seg) {
  if (seg.status === 'completed') return 'tag-success'
  if (seg.status === 'failed') return 'tag-error'
  return ''
}
function statusClass(item) {
  if (item.status === 'completed') return 'tag-success'
  if (item.status === 'failed') return 'tag-error'
  return ''
}

async function refreshMaterials() {
  materials.value = await studioAPI.materials(projectId) || []
  if (isSwap.value) await loadPlan()
}
async function refreshBatches() { batches.value = await studioAPI.batches(projectId) || [] }
async function refreshGenerations() { generations.value = await studioAPI.generations(projectId) || [] }

async function loadPlan() {
  if (!isSwap.value) return
  planLoading.value = true
  planError.value = ''
  try {
    plan.value = await studioAPI.plan(projectId, form.value.config_id || undefined)
  } catch (error) {
    plan.value = null
    planError.value = error?.message || String(error)
  } finally {
    planLoading.value = false
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      if (isSwap.value) await refreshBatches()
      else await refreshGenerations()
      if (!hasRunning.value) stopPolling()
    } catch {
      // 轮询失败不打断页面，用户可手动刷新
    }
  }, 4000)
}

async function loadAll() {
  try {
    const [project, modeList, materialList, configList, progressList] = await Promise.all([
      dramaAPI.get(projectId),
      studioAPI.modes(),
      studioAPI.materials(projectId),
      studioAPI.videoConfigs(),
      isSwap.value ? studioAPI.batches(projectId) : studioAPI.generations(projectId),
    ])
    if (!isStudioMode(project?.project_type) || project.project_type !== mode) {
      invalid.value = true
      return
    }
    drama.value = project
    modes.value = modeList || []
    materials.value = materialList || []
    configs.value = configList || []
    if (isSwap.value) batches.value = progressList || []
    else generations.value = progressList || []
    form.value.prompt = modeDef.value?.default_prompt || ''
    if (isSwap.value) await loadPlan()
  } catch (error) {
    toastError(error)
  }
}

async function generate() {
  if (!ready.value || busy.value) return
  submitting.value = true
  try {
    await studioAPI.generate(projectId, {
      prompt: form.value.prompt,
      duration: Number(form.value.duration) || 5,
      config_id: form.value.config_id || undefined,
    })
    toast.success(isSwap.value ? t('studio.batch.submitted') : t('studio.toast.submitted'))
    if (isSwap.value) await refreshBatches()
    else await refreshGenerations()
    startPolling()
  } catch (error) {
    toastError(error)
  } finally {
    submitting.value = false
  }
}

async function recover(item) {
  try {
    await taskAPI.recover(item.id)
    toast.success(t('studio.toast.recovered'))
    await refreshGenerations()
    startPolling()
  } catch (error) {
    toastError(error)
  }
}

// 切换模型会改变单段时长上限，需要重新计算分段数
watch(() => form.value.config_id, () => { if (isSwap.value) loadPlan() })

onMounted(async () => {
  if (invalid.value) return
  await loadAll()
  if (hasRunning.value) startPolling()
})

onUnmounted(stopPolling)
</script>

<style scoped>
.studio-page {
  padding: 20px 28px 48px;
  overflow-y: auto;
  height: 100%;
  background: var(--surface-base);
}
.page-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 20px; }
.head-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.page-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-0); }
.head-sub { font-size: 11px; }
.head-ratio { flex-shrink: 0; }
.studio-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr); gap: 20px; align-items: start; }
.studio-main, .studio-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 2px; }
.section-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-0); }
.section-head p { margin: 0; font-size: 11px; }
.section-title { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--text-0); }
.plan-card, .form-card { padding: 16px; }
.plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.plan-head .section-title { margin-bottom: 12px; }
.plan-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 12px; }
.segment-list, .batch-segments { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.segment-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; background: var(--bg-2); font-size: 11px; color: var(--text-1); }
.segment-row .dim { margin-left: auto; }
.segment-index { min-width: 26px; font-weight: 600; color: var(--accent-text); }
.field-hint { margin-top: 10px; }
.readonly-value { padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); font-size: 12px; color: var(--text-1); }
.form-card { display: flex; flex-direction: column; gap: 12px; }
.form-row { display: grid; grid-template-columns: minmax(0, .7fr) minmax(0, 1.3fr); gap: 12px; }
.form-foot { display: flex; align-items: center; gap: 12px; }
.empty-card { padding: 28px 16px; text-align: center; font-size: 12px; }
.result-card, .batch-card { overflow: hidden; padding: 12px; }
.batch-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; font-size: 11px; }
.batch-final video, .result-video, .result-placeholder { width: 100%; aspect-ratio: 16 / 9; display: block; background: var(--bg-2); }
.result-placeholder { display: flex; align-items: center; justify-content: center; font-size: 12px; }
.result-body { padding: 10px 12px 6px; }
.result-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
.result-prompt { margin: 8px 0 0; font-size: 11px; color: var(--text-1); }
.result-error { margin: 5px 0 0; font-size: 11px; color: #ef5350; }
.result-actions { display: flex; align-items: center; gap: 8px; padding: 8px 0 0; }
.result-actions .btn { text-decoration: none; }
.batch-segments { margin-top: 10px; }
@media (max-width: 980px) {
  .studio-layout { grid-template-columns: 1fr; }
  .studio-page { padding: 16px; }
}
</style>
