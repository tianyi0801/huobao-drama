<template>
  <section class="agent-live" :class="`is-${activity.phase}`" aria-live="polite">
    <header class="agent-live-head">
      <span class="agent-live-icon">
        <Loader2 v-if="activity.active" :size="15" class="animate-spin" />
        <Check v-else-if="activity.phase === 'done'" :size="15" />
        <AlertCircle v-else :size="15" />
      </span>
      <div class="agent-live-heading">
        <span class="agent-live-title">{{ title }}</span>
        <span class="agent-live-phase">{{ phaseText }}</span>
      </div>
      <span class="agent-live-elapsed">{{ elapsedText }}</span>
      <button v-if="activity.active" class="agent-live-stop" type="button" @click="emit('cancel')">
        <Square :size="11" />{{ t('episode.logUi.stop') }}
      </button>
      <button class="agent-live-toggle" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
        <ScrollText :size="13" />
        {{ t(expanded ? 'episode.logUi.hideDetails' : 'episode.logUi.showDetails') }}
        <ChevronDown :size="12" :class="{ rotated: expanded }" />
      </button>
    </header>

    <div class="agent-live-metrics">
      <span v-if="activity.savedBatches"><Check :size="11" />{{ t('episode.logUi.savedBatches', { n: activity.savedBatches }) }}</span>
      <span v-if="activity.savedCount">{{ t('episode.logUi.savedShots', { n: activity.savedCount }) }}</span>
      <span>{{ t('episode.logUi.calls', { n: activity.toolCount ?? activity.tools.length }) }}</span>
      <span v-if="activity.text.length">{{ t('episode.activity.chars', { n: activity.text.length }) }}</span>
      <span v-if="failedCount" class="is-error">{{ t('episode.logUi.failures', { n: failedCount }) }}</span>
    </div>

    <div v-if="activity.error" class="agent-live-error" role="alert">
      <AlertCircle :size="14" /><span>{{ activity.error }}</span>
    </div>

    <div v-if="expanded" class="agent-live-details">
      <div class="agent-live-section-head">
        <span>{{ t('episode.logUi.actions') }}</span>
        <span>{{ t('episode.logUi.grouped') }}</span>
      </div>
      <ol class="agent-live-tools">
        <li v-for="group in groups" :key="group.name" :class="{ 'is-error': group.failed, 'is-running': group.running }">
          <Loader2 v-if="group.running" :size="12" class="animate-spin" />
          <AlertCircle v-else-if="group.failed" :size="12" />
          <Check v-else :size="12" />
          <span class="agent-tool-name">{{ toolLabel(group.name) }}</span>
          <span class="agent-tool-count">× {{ group.count }}</span>
          <span v-if="group.failed" class="agent-tool-failed">{{ t('episode.logUi.failures', { n: group.failed }) }}</span>
          <span v-if="group.latest.ms != null" class="agent-tool-ms">{{ (group.latest.ms / 1000).toFixed(1) }}s</span>
          <details v-if="group.lastError?.preview" class="agent-tool-result agent-tool-failed">
            <summary>{{ t('episode.activity.phaseError') }}</summary>
            <pre>{{ resultText(group.lastError.preview) }}</pre>
          </details>
          <details v-if="group.latest.preview" class="agent-tool-result">
            <summary>{{ t('episode.logUi.result') }}</summary>
            <pre>{{ resultText(group.latest.preview) }}</pre>
          </details>
        </li>
      </ol>
      <div v-if="!groups.length" class="agent-live-empty">{{ t('episode.logUi.waiting') }}</div>
      <details v-if="reasoningTail" class="agent-live-reasoning">
        <summary>{{ t('episode.logUi.reasoning') }}<span class="dim"> · {{ activity.reasoning.length }}</span></summary>
        <pre class="agent-live-pre agent-live-pre-reasoning">{{ reasoningTail }}</pre>
      </details>
      <div v-if="tail" class="agent-live-output">
        <div class="agent-live-section-head">
          <span>{{ t('episode.activity.liveOutput') }}</span>
          <button type="button" class="agent-live-text-toggle" @click="fullText = !fullText">
            {{ t(fullText ? 'episode.logUi.tailOnly' : 'episode.logUi.fullOutput') }}
          </button>
        </div>
        <pre ref="textEl" class="agent-live-pre">{{ tail }}</pre>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, ChevronDown, Loader2, ScrollText, Square } from 'lucide-vue-next'
import type { AgentActivity } from '~/composables/useAgent'
import { resolveToolLabel } from '../utils/tool-labels'
import { groupActivityTools } from '../utils/activity-log'

const props = defineProps<{
  activity: AgentActivity
  agentType?: string | null
}>()
const emit = defineEmits<{ cancel: [] }>()
const reasoningTail = computed(() => {
  const text = props.activity.reasoning || ''
  // 思考内容可能很长：只保留尾部，避免刷屏和占用内存
  return text.length > 4000 ? text.slice(-4000) : text
})

const { t, te } = useI18n()
const textEl = ref<HTMLElement | null>(null)
const expanded = ref(false)
const fullText = ref(false)
const tail = computed(() => fullText.value ? props.activity.text : props.activity.text.slice(-600))
const groups = computed(() => groupActivityTools(props.activity.tools))
const failedCount = computed(() => groups.value.reduce((sum, group) => sum + group.failed, 0))
const title = computed(() => {
  if ((props.agentType || props.activity.type) === 'script_rewriter') return t('episode.activity.titleRewrite')
  if ((props.agentType || props.activity.type) === 'storyboard_breaker') return t('episode.activity.titleBreakdown')
  return t('episode.activity.titleGeneric')
})
const elapsedText = computed(() => {
  const seconds = Math.floor(props.activity.elapsedMs / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})
function toolLabel(name: string) {
  return resolveToolLabel(t, te, 'episode.activity', name)
}
function resultText(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}
const runningTool = computed(() => [...props.activity.tools].reverse().find(tool => tool.status === 'running'))
const phaseText = computed(() => {
  const { phase, reasoningChars } = props.activity
  if (phase === 'error') return t('episode.activity.phaseError')
  if (phase === 'done' && !props.activity.active) return t('episode.activity.phaseDone', { s: elapsedText.value })
  if (phase === 'done') return t('episode.logUi.syncing')
  if (phase === 'connecting') return t('episode.activity.phaseConnecting')
  if (phase === 'tool' && runningTool.value) return t('episode.activity.phaseTool', { tool: toolLabel(runningTool.value.name) })
  if (props.activity.savedBatches) return t('episode.logUi.nextBatch')
  if (reasoningChars) return t('episode.activity.phaseReasoning', { n: reasoningChars })
  return t('episode.logUi.processing')
})
watch(() => props.activity.startedAt, () => { expanded.value = false; fullText.value = false })
watch(() => props.activity.text.length, async () => {
  if (!expanded.value || fullText.value) return
  await nextTick()
  if (textEl.value) textEl.value.scrollTop = textEl.value.scrollHeight
})
</script>

<style scoped>
.agent-live { display: flex; flex-direction: column; flex: 0 0 auto; min-width: 0; max-height: 360px; overflow: hidden; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.agent-live-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-live-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; border-radius: 10px; background: var(--accent-bg); color: var(--accent-text); }
.agent-live.is-done .agent-live-icon { color: var(--success); background: var(--success-bg); }
.agent-live.is-error .agent-live-icon { color: var(--error); background: var(--error-bg); }
.agent-live-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.agent-live-title { color: var(--text-0); font-size: 12px; font-weight: 650; }
.agent-live-phase { font-size: 11px; color: var(--text-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-live-elapsed { font: 11px var(--font-mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
.agent-live-toggle, .agent-live-text-toggle { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; padding: 5px 7px; border: 0; border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text-2); font: 11px var(--font-body); cursor: pointer; }
.agent-live-toggle:hover, .agent-live-text-toggle:hover { color: var(--text-0); background: var(--bg-3); }
.agent-live-stop { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-1); color: var(--text-1); font: 11px var(--font-body); cursor: pointer; }
.agent-live-stop:hover { color: var(--error); border-color: var(--error); }
.agent-live-stop:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.agent-live-toggle:focus-visible, .agent-live-text-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rotated { transform: rotate(180deg); }
.agent-live-metrics { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 8px 0 0 42px; font-size: 10px; color: var(--text-2); }
.agent-live-metrics > span { display: inline-flex; align-items: center; gap: 4px; }
.agent-live-metrics .is-error { color: var(--error); }
.agent-live-details { min-height: 0; flex: 0 1 auto; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
.agent-live-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--text-2); margin-bottom: 6px; }
.agent-live-section-head > span:first-child { font-weight: 650; color: var(--text-1); }
.agent-live-tools { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.agent-live-tools li { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 7px 9px; border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text-2); font-size: 11px; }
.agent-live-tools li > svg { flex-shrink: 0; color: var(--success); }
.agent-live-tools li.is-running > svg { color: var(--accent); }
.agent-live-tools li.is-error > svg, .agent-tool-failed { color: var(--error); }
.agent-tool-name { color: var(--text-1); font-weight: 550; }
.agent-tool-count { color: var(--text-2); font: 10px var(--font-mono); padding: 2px 5px; background: var(--bg-1); border-radius: 4px; }
.agent-tool-ms { margin-left: auto; font: 10px var(--font-mono); }
.agent-tool-result { margin-left: auto; max-width: 100%; }
.agent-tool-result[open] { width: 100%; margin: 0; }
.agent-tool-result summary { cursor: pointer; font-size: 10px; color: var(--text-2); }
.agent-tool-result pre { margin: 6px 0 0; font: 10px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 100px; overflow: auto; }
.agent-live-output { margin-top: 12px; }
.agent-live-reasoning { margin: 8px 0 0; }
.agent-live-reasoning summary { cursor: pointer; font-size: 11px; color: var(--text-2); padding: 4px 0; }
.agent-live-pre-reasoning { max-height: 120px; color: var(--text-2); background: var(--bg-1); font-style: italic; }
.agent-live-pre { margin: 0; max-height: 144px; overflow-y: auto; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text-1); font: 11px/1.7 var(--font-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-live-error { display: flex; align-items: flex-start; gap: 7px; margin-top: 10px; padding: 8px 10px; max-height: 74px; overflow-y: auto; border-radius: var(--radius-sm); color: var(--error); background: var(--error-bg); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.agent-live-error > svg { flex-shrink: 0; margin-top: 2px; }
.agent-live-empty { padding: 8px; font-size: 11px; color: var(--text-2); }
@media (max-width: 600px) { .agent-live { padding: 10px; } .agent-live-head { gap: 7px; } .agent-live-toggle { font-size: 0; } .agent-live-toggle > svg { width: 14px; height: 14px; } .agent-live-metrics { padding-left: 0; gap: 6px 10px; } }
</style>
