<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog rs-dialog">
      <div class="dialog-head">
        <div class="rs-head-text">
          <h3 class="dialog-title">{{ t('requestSnapshot.title') }}</h3>
          <p class="rs-sub">{{ t('requestSnapshot.subtitle') }}</p>
        </div>
        <button class="btn btn-icon ml-auto" :title="t('requestSnapshot.close')" @click="close">
          <X :size="15" :stroke-width="2" />
        </button>
      </div>

      <div class="dialog-body">
        <div v-if="loading" class="rs-state">
          <Loader2 :size="18" class="animate-spin" />
          <span>{{ t('requestSnapshot.loading') }}</span>
        </div>

        <div v-else-if="!items.length" class="rs-state">
          <Info :size="18" :stroke-width="1.7" />
          <span>{{ t('requestSnapshot.noTask') }}</span>
        </div>

        <template v-else>
          <!-- 同一分镜可能同时有分镜图任务和视频任务，用分段切换 -->
          <div v-if="loaded.length > 1" class="seg rs-tabs">
            <button
              v-for="(item, i) in loaded"
              :key="item.id"
              type="button"
              class="seg-item"
              :class="{ on: i === activeIndex }"
              @click="activeIndex = i"
            >
              {{ item.label }}
            </button>
          </div>

          <div v-if="!snapshot" class="rs-state">
            <Info :size="18" :stroke-width="1.7" />
            <span>{{ t('requestSnapshot.empty') }}</span>
          </div>

          <template v-else>
            <!-- 请求元信息 -->
            <div class="rs-meta">
              <span class="rs-meta-item"><em>{{ t('requestSnapshot.provider') }}</em>{{ snapshot.provider || '-' }}</span>
              <span class="rs-meta-item"><em>{{ t('requestSnapshot.mode') }}</em>{{ snapshot.mode || '-' }}</span>
              <span v-if="snapshot.template" class="rs-meta-item"><em>{{ t('requestSnapshot.template') }}</em>{{ snapshot.template }}</span>
              <span class="rs-meta-item"><em>{{ t('requestSnapshot.method') }}</em>{{ snapshot.method || '-' }}</span>
              <span class="rs-meta-item"><em>{{ t('requestSnapshot.bodySize') }}</em>{{ bodySize }}</span>
              <span class="rs-meta-item"><em>{{ t('requestSnapshot.time') }}</em>{{ timeText(snapshot.at) }}</span>
            </div>
            <div v-if="snapshot.url" class="rs-url mono" :title="snapshot.url">{{ snapshot.url }}</div>

            <!-- 提示词：唯一权威版本 -->
            <div class="rs-section">
              <div class="rs-section-head">
                <h4>{{ t('requestSnapshot.prompt') }}</h4>
                <span v-if="snapshot.promptTruncated" class="tag tag-warning">{{ t('requestSnapshot.truncated') }}</span>
                <button class="btn btn-sm ml-auto" @click="copyText(snapshot.prompt)">
                  {{ t('requestSnapshot.copyPrompt') }}
                </button>
              </div>
              <pre class="rs-prompt">{{ snapshot.prompt || t('requestSnapshot.emptyPrompt') }}</pre>
              <div v-if="snapshot.negativePrompt" class="rs-negative">
                <span class="rs-label">{{ t('requestSnapshot.negativePrompt') }}</span>
                <pre class="rs-prompt">{{ snapshot.negativePrompt }}</pre>
              </div>
            </div>

            <!-- 生效参数 -->
            <div v-if="parameterRows.length" class="rs-section">
              <h4>{{ t('requestSnapshot.parameters') }}</h4>
              <div class="rs-table">
                <div v-for="row in parameterRows" :key="row.key" class="rs-row">
                  <span class="rs-key mono">{{ row.key }}</span>
                  <span class="rs-val mono">{{ row.value }}</span>
                </div>
              </div>
            </div>

            <!-- 素材顺序：图1/图2、@图片N 的编号来源 -->
            <div v-if="snapshot.media?.length" class="rs-section">
              <h4>{{ t('requestSnapshot.media') }}</h4>
              <div class="rs-table">
                <div v-for="item in snapshot.media" :key="item.index + item.path" class="rs-row">
                  <span class="rs-key mono">#{{ item.index }} · {{ item.kind }}</span>
                  <span class="rs-val mono">{{ item.path }}</span>
                </div>
              </div>
            </div>

            <!-- 局部编辑选区 -->
            <div v-if="snapshot.region" class="rs-section">
              <h4>{{ t('requestSnapshot.region.title') }}</h4>
              <div class="rs-table">
                <div class="rs-row">
                  <span class="rs-key mono">{{ t('requestSnapshot.region.rect') }}</span>
                  <span class="rs-val mono">x={{ snapshot.region.rect.x }}, y={{ snapshot.region.rect.y }}, {{ snapshot.region.rect.w }}×{{ snapshot.region.rect.h }}{{ t('requestSnapshot.region.px') }}</span>
                </div>
              </div>
            </div>

            <!-- 绑定链路：项目字段 → 工作流节点 -->
            <div v-if="snapshot.bindings?.length" class="rs-section">
              <h4>{{ t('requestSnapshot.bindings') }}</h4>
              <div class="rs-table">
                <div v-for="(item, i) in snapshot.bindings" :key="i" class="rs-row rs-row-binding">
                  <span class="rs-key mono">{{ item.source }}</span>
                  <span class="rs-arrow">→</span>
                  <span class="rs-target mono">{{ item.target }}</span>
                  <span class="rs-val mono" :title="item.value">{{ item.value }}</span>
                </div>
              </div>
            </div>

            <!-- 备注 -->
            <div v-if="snapshot.notes?.length" class="rs-section">
              <h4>{{ t('requestSnapshot.notes') }}</h4>
              <ul class="rs-notes">
                <li v-for="(note, i) in snapshot.notes" :key="i">{{ note }}</li>
              </ul>
            </div>

            <!-- 请求体（云端厂商才有） -->
            <div v-if="snapshot.body" class="rs-section">
              <h4>{{ t('requestSnapshot.body') }}</h4>
              <pre class="rs-body mono">{{ bodyText }}</pre>
            </div>
          </template>
        </template>
      </div>

      <div class="dialog-foot">
        <button class="btn btn-sm" :disabled="!snapshot" @click="copyJson">{{ t('requestSnapshot.copyJson') }}</button>
        <button class="btn btn-sm btn-primary" @click="close">{{ t('requestSnapshot.close') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Info, Loader2, X } from 'lucide-vue-next'
import { taskAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * 请求内容查看器：展示某次生成真正提交给模型的提示词与参数。
 *
 * 快照来源 sys_task.request_snapshot（见 backend/src/services/request-snapshot.ts），
 * 一个分镜可能同时有分镜图任务与视频任务，因此支持多任务切换。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:open'])

const { t } = useI18n()

const loading = ref(false)
const loaded = ref([])
const activeIndex = ref(0)

const activeTask = computed(() => loaded.value[activeIndex.value] || null)

/** 快照可能是 JSON 字符串（后端 TEXT 列）或对象（内存态） */
const snapshot = computed(() => {
  const raw = activeTask.value?.row?.requestSnapshot ?? activeTask.value?.row?.request_snapshot
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
})

const parameterRows = computed(() => {
  const params = snapshot.value?.parameters
  if (!params || typeof params !== 'object') return []
  return Object.entries(params).map(([key, value]) => ({
    key,
    value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
  }))
})

const bodySize = computed(() => {
  const bytes = Number(snapshot.value?.bodyBytes || 0)
  if (!bytes) return '-'
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
})

const bodyText = computed(() => {
  const body = snapshot.value?.body
  if (!body) return ''
  try {
    return typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  } catch {
    return String(body)
  }
})

watch(() => props.open, (open) => {
  if (open) void load()
})

async function load() {
  loading.value = true
  activeIndex.value = 0
  try {
    loaded.value = await Promise.all((props.items || []).map(async (item) => ({
      ...item,
      row: await taskAPI.get(item.id).catch(() => null),
    })))
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

function timeText(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '')
    toast.success(t('requestSnapshot.copied'))
  } catch (error) {
    toastError(error)
  }
}

async function copyJson() {
  if (!snapshot.value) return
  await copyText(JSON.stringify(snapshot.value, null, 2))
}

function close() {
  emit('update:open', false)
}
</script>

<style scoped>
.rs-dialog {
  width: min(920px, calc(100vw - 80px));
}

.rs-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rs-sub { font-size: 12px; color: var(--text-3); }

.rs-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 12px;
  color: var(--text-3);
  font-size: 12.5px;
}

.rs-tabs { margin-bottom: var(--sp-4); }

.rs-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 6px;
}
.rs-meta-item em {
  font-style: normal;
  color: var(--text-3);
  margin-right: 5px;
  font-size: 11.5px;
}

.rs-url {
  font-size: 11.5px;
  color: var(--text-3);
  word-break: break-all;
  margin-bottom: var(--sp-3);
}

.rs-section { margin-top: var(--sp-4); }
.rs-section h4 {
  font-size: 12.5px;
  font-weight: 620;
  color: var(--text-1);
  margin-bottom: 6px;
}
.rs-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.rs-section-head h4 { margin-bottom: 0; }

.rs-prompt {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-input);
  color: var(--text-0);
  font: 12.5px/1.75 var(--font-body);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

.rs-negative { margin-top: 8px; }
.rs-label { font-size: 11.5px; color: var(--text-3); display: block; margin-bottom: 4px; }

.rs-table {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.rs-row {
  display: flex;
  gap: 12px;
  padding: 6px 12px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--border);
}
.rs-row:last-child { border-bottom: none; }
.rs-row:nth-child(odd) { background: var(--surface-soft); }
.rs-key {
  flex: 0 0 190px;
  color: var(--text-2);
  word-break: break-all;
}
.rs-val {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  word-break: break-all;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rs-row-binding { flex-wrap: nowrap; }
.rs-arrow { color: var(--text-3); flex: 0 0 auto; }
.rs-target { flex: 0 0 150px; color: var(--accent-text); word-break: break-all; }

.rs-notes {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
}

.rs-body {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-input);
  font-size: 11.5px;
  line-height: 1.7;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
