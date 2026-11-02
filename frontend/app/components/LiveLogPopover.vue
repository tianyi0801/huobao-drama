<template>
  <div class="live-log">
    <button
      ref="anchorEl"
      type="button"
      class="btn btn-sm live-log-trigger"
      :class="{ 'is-open': isOpen, 'is-running': running }"
      :title="t('episode.liveLog.badge')"
      @click="toggle"
    >
      <ScrollText :size="11" />
      <span>{{ t('episode.liveLog.badge') }}</span>
      <span v-if="running" class="live-log-dot" />
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="panelEl"
        class="live-log-panel"
        :style="panelStyle"
        @pointerdown.stop
      >
        <div class="live-log-head">
          <span class="live-log-title">{{ t('episode.liveLog.title', { type: label }) }}</span>
          <span class="live-log-state" :class="{ 'is-on': running }">
            {{ running ? t('episode.liveLog.running') : t('episode.liveLog.finished') }}
          </span>
          <button type="button" class="live-log-close" @click="close">×</button>
        </div>

        <div ref="listEl" class="live-log-list">
          <template v-for="entry in entries" :key="entry.id">
            <!-- 模型说了什么：单列展示正文，避免和工具流水混在一行 -->
            <div v-if="entry.kind === 'text'" class="live-log-item is-text">
              <span class="live-log-time mono">{{ timeText(entry.at) }}</span>
              <div class="live-log-body">
                <div class="live-log-label">{{ t('episode.liveLog.text', { n: entry.chars ?? 0 }) }}</div>
                <div class="live-log-quote">{{ entry.text || '—' }}</div>
              </div>
            </div>
            <div v-else-if="entry.kind === 'error'" class="live-log-item is-error">
              <span class="live-log-time mono">{{ timeText(entry.at) }}</span>
              <div class="live-log-body">
                <div class="live-log-label is-bad">{{ t('episode.liveLog.failedLabel') }}</div>
                <div class="live-log-quote is-bad">{{ entry.message }}</div>
              </div>
            </div>
            <div v-else class="live-log-item" :class="`is-${entry.kind}`">
              <span class="live-log-time mono">{{ timeText(entry.at) }}</span>
              <span class="live-log-text">{{ render(entry) }}</span>
            </div>
          </template>
          <div v-if="!entries.length" class="live-log-empty">{{ t('episode.liveLog.empty') }}</div>
        </div>

        <div class="live-log-foot">{{ t('episode.liveLog.hint') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ScrollText } from 'lucide-vue-next'
import { usePopover } from '~/composables/usePopover'
import { resolveToolLabel } from '../utils/tool-labels'

/**
 * 资产提取的实时日志徽标：点击才展开，内容只来自后端内存缓冲（不落库）。
 * 打开时用 EventSource 订阅 SSE，关闭/卸载即断开。
 */
const props = defineProps<{
  episodeId: number
  target: string
  /** 类型中文名（角色/场景/道具），用于标题与文案 */
  label: string
  running: boolean
}>()

const { t, te } = useI18n()
const { isOpen, anchorEl, panelEl, panelStyle, toggle, close } = usePopover({
  placement: 'bottom-end',
  minWidth: 420,
  maxHeight: 360,
})

interface LogEntry {
  id: number
  at: number
  kind: 'start' | 'step' | 'tool' | 'saved' | 'text' | 'done' | 'error'
  tool?: string
  created?: number
  merged?: number
  chars?: number
  /** kind = text 时的模型输出内容 */
  text?: string
  steps?: number
  message?: string
}

const entries = ref<LogEntry[]>([])
const listEl = ref<HTMLElement | null>(null)
let source: EventSource | null = null

function disconnect() {
  source?.close()
  source = null
}

async function scrollToEnd() {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

function connect() {
  disconnect()
  if (!props.episodeId) return
  const url = `/api/v1/episodes/${props.episodeId}/extract-log?target=${encodeURIComponent(props.target)}`
  source = new EventSource(url)
  source.addEventListener('log', (event) => {
    try {
      const entry = JSON.parse((event as MessageEvent).data) as LogEntry
      if (entries.value.some(item => item.id === entry.id)) return
      // 新一轮任务开始：清掉上一轮残留，避免新旧日志混在一起
      if (entry.kind === 'start') entries.value = []
      entries.value.push(entry)
      void scrollToEnd()
    } catch { /* 非 JSON 心跳等忽略 */ }
  })
  // 服务端重启/网络断开：停止重连，避免无意义的重试风暴
  source.onerror = () => disconnect()
}

// 打开时订阅、关闭时断开；切换集/类型时重新订阅
watch(isOpen, (open) => {
  if (open) {
    entries.value = []
    connect()
  } else {
    disconnect()
  }
})
watch(() => [props.episodeId, props.target], () => {
  if (isOpen.value) {
    entries.value = []
    connect()
  }
})
onBeforeUnmount(disconnect)

function toolLabel(name?: string) {
  return resolveToolLabel(t, te, 'episode.liveLog', name)
}

function timeText(at: number) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function render(entry: LogEntry) {
  switch (entry.kind) {
    case 'start':
      return t('episode.liveLog.start', { type: props.label })
    case 'tool':
      return t('episode.liveLog.toolCall', { tool: toolLabel(entry.tool) })
    case 'saved':
      return t('episode.liveLog.saved', {
        tool: toolLabel(entry.tool),
        created: entry.created ?? 0,
        merged: entry.merged ?? 0,
      })
    case 'text':
      return t('episode.liveLog.text', { n: entry.chars ?? 0 })
    case 'done':
      return t('episode.liveLog.done', { n: entry.steps ?? 0 })
    case 'error':
      return t('episode.liveLog.failed', { msg: entry.message || '' })
    default:
      return ''
  }
}
</script>

<style scoped>
.live-log { position: relative; display: inline-flex; }
.live-log-trigger { gap: 4px; }
.live-log-trigger.is-open { border-color: var(--accent); color: var(--text-0); }
.live-log-trigger.is-running { color: var(--text-0); }
.live-log-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent);
  animation: live-log-pulse 1.1s ease-in-out infinite;
}
@keyframes live-log-pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }

.live-log-panel {
  position: fixed;
  z-index: 900;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 浮层必须完全不透明：用主题里真实存在的实色变量（--surface 未定义会变透明） */
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-elevated);
}
.live-log-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid var(--border);
}
.live-log-title { font: 600 12px var(--font-body); color: var(--text-0); }
.live-log-state { font: 500 10.5px var(--font-body); color: var(--text-3); }
.live-log-state.is-on { color: var(--accent); }
.live-log-close {
  margin-left: auto; border: none; background: none; cursor: pointer;
  color: var(--text-3); font-size: 15px; line-height: 1; padding: 0 2px;
}
.live-log-close:hover { color: var(--text-0); }

.live-log-list {
  flex: 1; min-height: 88px; max-height: 276px; overflow-y: auto;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.live-log-item {
  display: flex; gap: 8px; align-items: flex-start;
  font: 500 11.5px var(--font-body); color: var(--text-2); line-height: 1.55;
}
/* 工具调用 / 状态行：时间戳与文案基线对齐 */
.live-log-item:not(.is-text):not(.is-error) { align-items: baseline; }
.live-log-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.live-log-label {
  font: 600 10px var(--font-body); letter-spacing: .04em; color: var(--text-3);
}
.live-log-label.is-bad { color: #c0392b; }
/* 模型输出的原文：带左侧强调条，长文本内部滚动，不撑破面板 */
.live-log-quote {
  padding: 7px 9px; border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm, 6px); background: var(--bg-2);
  color: var(--text-1); font: 11.5px/1.65 var(--font-body);
  white-space: pre-wrap; word-break: break-word;
  max-height: 148px; overflow-y: auto;
}
.live-log-quote.is-bad {
  border-left-color: #c0392b; background: rgba(192, 57, 43, .08); color: #c0392b;
}
.live-log-time { flex: 0 0 auto; font-size: 10px; color: var(--text-3); }
.live-log-text { min-width: 0; word-break: break-word; }
.live-log-item.is-tool .live-log-text { color: var(--text-1); }
.live-log-item.is-saved .live-log-text { color: var(--success-text, var(--text-0)); }
.live-log-item.is-done .live-log-text { color: var(--success-text, var(--text-0)); font-weight: 600; }
.live-log-item.is-error .live-log-text { color: var(--danger-text, var(--text-1)); }
.live-log-empty { font: 500 11px var(--font-body); color: var(--text-3); padding: 8px 0; }
.live-log-foot {
  padding: 6px 12px 8px; border-top: 1px solid var(--border);
  font: 500 10px var(--font-body); color: var(--text-3);
}
</style>
