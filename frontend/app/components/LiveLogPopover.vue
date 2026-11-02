<template>
  <div class="live-log">
    <button ref="anchorEl" type="button" class="btn btn-sm live-log-trigger" :class="{ 'is-open': isOpen }" :title="t('episode.liveLog.title', { type: label })" :aria-expanded="isOpen" @click="toggle">
      <ScrollText :size="12" /><span>{{ t('episode.liveLog.badge') }}</span>
      <span v-if="running" class="live-log-dot" />
    </button>
    <Teleport to="body">
      <section v-if="isOpen" ref="panelEl" class="live-log-panel" :style="fittedPanelStyle" :aria-label="t('episode.liveLog.title', { type: label })" @pointerdown.stop>
        <header class="live-log-head">
          <span class="live-log-icon"><ScrollText :size="16" /></span>
          <div class="live-log-heading">
            <span class="live-log-title">{{ t('episode.liveLog.title', { type: label }) }}</span>
            <span class="live-log-state" :class="{ 'is-error': terminal?.kind === 'error' || interrupted }">{{ stateText }}</span>
          </div>
          <button type="button" class="live-log-close" :aria-label="t('common.close')" @click="close"><X :size="15" /></button>
        </header>

        <div class="live-log-summary">
          <div><strong>{{ totals.created }}</strong><span>{{ t('episode.logUi.created') }}</span></div>
          <div><strong>{{ totals.merged }}</strong><span>{{ t('episode.logUi.merged') }}</span></div>
          <div><strong>{{ totals.calls }}</strong><span>{{ t('episode.logUi.actions') }}</span></div>
        </div>
        <div class="live-log-controls">
          <span>{{ t('episode.logUi.timeline') }}</span>
          <label><input v-model="follow" type="checkbox" />{{ t('episode.logUi.follow') }}</label>
          <button v-if="interrupted" type="button" @click="connect">{{ t('episode.logUi.reconnect') }}</button>
        </div>

        <div ref="listEl" class="live-log-list">
          <div v-for="entry in displayEntries" :key="entry.id" class="live-log-item" :class="`is-${entry.kind}`">
            <span class="live-log-marker">
              <Check v-if="entry.kind === 'saved' || entry.kind === 'done'" :size="12" />
              <AlertCircle v-else-if="entry.kind === 'error'" :size="12" />
              <MessageSquare v-else-if="entry.kind === 'text'" :size="12" />
              <span v-else class="live-log-marker-dot" />
            </span>
            <div class="live-log-body">
              <div class="live-log-row-head">
                <span class="live-log-text">{{ render(entry) }}</span>
                <span v-if="entry.repeats > 1" class="live-log-repeat">× {{ entry.repeats }}</span>
                <time class="live-log-time">{{ timeText(entry.at) }}</time>
              </div>
              <pre v-if="entry.kind === 'text'" class="live-log-quote">{{ entry.text || '—' }}</pre>
              <pre v-if="entry.kind === 'error'" class="live-log-quote is-bad">{{ entry.message }}</pre>
            </div>
          </div>
          <div v-if="!entries.length" class="live-log-empty">
            <ScrollText :size="22" /><span>{{ t('episode.liveLog.empty', { type: label }) }}</span>
          </div>
        </div>
        <footer class="live-log-foot">{{ t('episode.liveLog.hint') }}</footer>
      </section>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, MessageSquare, ScrollText, X } from 'lucide-vue-next'
import { usePopover } from '~/composables/usePopover'
import { resolveToolLabel } from '../utils/tool-labels'
import { compactActivityLogs } from '../utils/activity-log'

const props = defineProps<{ episodeId: number; target: string; label: string; running: boolean }>()
const { t, te } = useI18n()
const { isOpen, anchorEl, panelEl, panelStyle, toggle, close } = usePopover({
  placement: 'bottom-end',
  minWidth: Math.min(440, typeof window === 'undefined' ? 440 : window.innerWidth - 24),
  maxHeight: 440,
})
const fittedPanelStyle = computed(() => {
  if (typeof window === 'undefined') return panelStyle.value
  const height = Math.min(440, window.innerHeight - 48)
  const top = parseFloat(String(panelStyle.value.top || 12))
  return { ...panelStyle.value, top: `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px` }
})
interface LogEntry {
  id: number
  at: number
  kind: 'start' | 'step' | 'tool' | 'saved' | 'text' | 'done' | 'error'
  tool?: string
  created?: number
  merged?: number
  chars?: number
  text?: string
  steps?: number
  message?: string
}
const entries = ref<LogEntry[]>([])
const displayEntries = computed(() => compactActivityLogs(entries.value))
const terminal = computed(() => [...entries.value].reverse().find(entry => entry.kind === 'done' || entry.kind === 'error'))
const interrupted = ref(false)
const follow = ref(true)
const listEl = ref<HTMLElement | null>(null)
const totals = computed(() => entries.value.reduce((value, entry) => ({
  created: value.created + (entry.kind === 'saved' ? entry.created || 0 : 0),
  merged: value.merged + (entry.kind === 'saved' ? entry.merged || 0 : 0),
  calls: value.calls + (entry.kind === 'tool' ? 1 : 0),
}), { created: 0, merged: 0, calls: 0 }))
const stateText = computed(() => {
  if (interrupted.value) return t('episode.logUi.disconnected')
  if (terminal.value?.kind === 'error') return t('episode.liveLog.failedLabel')
  if (terminal.value?.kind === 'done') return t('episode.liveLog.finished')
  return t(props.running ? 'episode.liveLog.running' : 'episode.logUi.waiting')
})
let source: EventSource | null = null
function disconnect() { source?.close(); source = null }
async function scrollToEnd() {
  if (!follow.value) return
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}
function connect() {
  disconnect()
  interrupted.value = false
  if (!props.episodeId) return
  const url = `/api/v1/episodes/${props.episodeId}/extract-log?target=${encodeURIComponent(props.target)}`
  source = new EventSource(url)
  const current = source
  source.addEventListener('log', (event) => {
    if (current !== source) return
    try {
      const entry = JSON.parse((event as MessageEvent).data) as LogEntry
      if (entries.value.some(item => item.id === entry.id)) return
      if (entry.kind === 'start') entries.value = []
      entries.value.push(entry)
      if (entries.value.length > 120) entries.value.splice(0, entries.value.length - 120)
      if (entry.kind === 'done' || entry.kind === 'error') disconnect()
      void scrollToEnd()
    } catch { /* 保留已有日志，不让格式异常影响任务 */ }
  })
  source.onerror = () => {
    if (current !== source) return
    interrupted.value = !terminal.value
    disconnect()
  }
}
watch(isOpen, (open) => {
  if (open) { entries.value = []; follow.value = true; connect() }
  else disconnect()
})
watch(() => [props.episodeId, props.target], () => {
  if (isOpen.value) { entries.value = []; connect() }
})
onBeforeUnmount(disconnect)
function toolLabel(name?: string) { return resolveToolLabel(t, te, 'episode.liveLog', name) }
function timeText(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
function render(entry: LogEntry) {
  switch (entry.kind) {
    case 'start': return t('episode.liveLog.start', { type: props.label })
    case 'tool': return toolLabel(entry.tool)
    case 'saved': return t('episode.liveLog.saved', { tool: toolLabel(entry.tool), created: entry.created ?? 0, merged: entry.merged ?? 0 })
    case 'text': return t('episode.liveLog.text', { n: entry.chars ?? 0 })
    case 'done': return t('episode.liveLog.done', { n: entry.steps ?? 0 })
    case 'error': return t('episode.liveLog.failedLabel')
    default: return t('episode.logUi.processing')
  }
}
</script>

<style scoped>
.live-log { display: inline-flex; }
.live-log-trigger { gap: 5px; }
.live-log-trigger.is-open { color: var(--accent-text); background: var(--accent-bg); }
.live-log-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.live-log-panel { z-index: 900; display: flex; flex-direction: column; max-width: calc(100vw - 24px); height: min(440px, calc(100dvh - 48px)); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-elevated); color: var(--text-1); }
.live-log-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0; padding: 14px; border-bottom: 1px solid var(--border); }
.live-log-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--accent-bg); color: var(--accent-text); }
.live-log-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.live-log-title { font-size: 12px; font-weight: 650; color: var(--text-0); }
.live-log-state { font-size: 10px; color: var(--text-2); }
.live-log-state.is-error { color: var(--error); }
.live-log-close { display: grid; place-items: center; margin-left: auto; padding: 5px; background: var(--bg-2); border: 0; border-radius: 6px; color: var(--text-2); cursor: pointer; }
.live-log-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 14px; flex-shrink: 0; }
.live-log-summary > div { display: flex; align-items: baseline; gap: 7px; padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-2); }
.live-log-summary strong { font: 600 17px var(--font-mono); color: var(--text-0); }
.live-log-summary span { color: var(--text-2); font-size: 10px; }
.live-log-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 14px 10px; flex-shrink: 0; font-size: 10px; color: var(--text-2); }
.live-log-controls > span { font-weight: 600; }
.live-log-controls label { display: flex; align-items: center; gap: 5px; margin-left: auto; cursor: pointer; }
.live-log-controls input { margin: 0; accent-color: var(--accent); }
.live-log-controls button { color: var(--accent-text); background: none; border: 0; cursor: pointer; font: inherit; }
.live-log-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 14px 12px; }
.live-log-item { position: relative; display: flex; align-items: flex-start; gap: 9px; padding: 0 0 12px; }
.live-log-item:not(:last-child)::after { content: ''; position: absolute; left: 10px; top: 23px; bottom: 2px; width: 1px; background: var(--border-strong); }
.live-log-marker { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; flex-shrink: 0; color: var(--text-2); background: var(--bg-2); }
.is-saved .live-log-marker, .is-done .live-log-marker { color: var(--success); background: var(--success-bg); }
.is-error .live-log-marker { color: var(--error); background: var(--error-bg); }
.is-text .live-log-marker { color: var(--info); background: var(--info-bg); }
.live-log-marker-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--text-2); }
.live-log-body { flex: 1; min-width: 0; padding-top: 2px; }
.live-log-row-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.live-log-text { font-size: 11px; line-height: 1.5; color: var(--text-1); overflow-wrap: anywhere; }
.is-done .live-log-text { font-weight: 650; color: var(--success); }
.is-error .live-log-text { color: var(--error); }
.live-log-time { margin-left: auto; flex-shrink: 0; font: 9px var(--font-mono); color: var(--text-2); }
.live-log-repeat { font: 10px var(--font-mono); color: var(--text-2); }
.live-log-quote { margin: 7px 0 0; padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text-1); font: 11px/1.7 var(--font-body); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 144px; overflow-y: auto; }
.live-log-quote.is-bad { color: var(--error); border-color: var(--error); }
.live-log-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px 14px; text-align: center; font-size: 11px; line-height: 1.7; color: var(--text-2); }
.live-log-foot { padding: 9px 14px; border-top: 1px solid var(--border); flex-shrink: 0; font-size: 10px; color: var(--text-2); }
.live-log-close:focus-visible, .live-log-controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
