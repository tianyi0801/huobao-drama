<template>
  <section class="agent-live" :class="`is-${activity.phase}`">
    <header class="agent-live-head">
      <Loader2 v-if="activity.active" :size="13" class="animate-spin agent-live-spin" />
      <Check v-else-if="activity.phase === 'done'" :size="13" class="agent-live-ok" />
      <X v-else :size="13" class="agent-live-bad" />
      <span class="agent-live-title">{{ title }}</span>
      <span class="agent-live-elapsed mono">{{ elapsedText }}</span>
    </header>

    <div class="agent-live-phase">
      <span class="agent-live-dot" />
      <span>{{ phaseText }}</span>
    </div>

    <!-- 工具流水：读取上下文 / 保存剧本 / 写入分镜… -->
    <ol v-if="activity.tools.length" class="agent-live-tools">
      <li v-for="tool in activity.tools" :key="tool.id" :class="`is-${tool.status}`">
        <Loader2 v-if="tool.status === 'running'" :size="11" class="animate-spin" />
        <Check v-else-if="tool.status === 'ok'" :size="11" />
        <X v-else :size="11" />
        <span class="agent-tool-name">{{ toolLabel(tool.name) }}</span>
        <span v-if="tool.ms != null" class="agent-tool-ms mono">{{ tool.ms }}ms</span>
        <span v-if="tool.preview" class="agent-tool-preview">{{ tool.preview }}</span>
      </li>
    </ol>

    <!-- 实时输出尾部：能直观看到模型确实在产出内容 -->
    <div v-if="tail" class="agent-live-output">
      <div class="agent-live-output-head">
        <span>{{ t('episode.activity.liveOutput') }}</span>
        <span class="mono">{{ t('episode.activity.chars', { n: activity.text.length }) }}</span>
      </div>
      <pre ref="textEl" class="agent-live-pre">{{ tail }}</pre>
    </div>

    <div v-if="activity.error" class="agent-live-error">{{ activity.error }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, X } from 'lucide-vue-next'
import type { AgentActivity } from '~/composables/useAgent'
import { resolveToolLabel } from '../utils/tool-labels'

const props = defineProps<{
  activity: AgentActivity
  agentType?: string | null
}>()

const { t, te } = useI18n()
const textEl = ref<HTMLElement | null>(null)

/** 尾部窗口：只渲染最后一段，长剧本也保持流畅 */
const TAIL_SIZE = 600
const tail = computed(() => props.activity.text.slice(-TAIL_SIZE))

const title = computed(() => {
  if (props.agentType === 'script_rewriter') return t('episode.activity.titleRewrite')
  if (props.agentType === 'storyboard_breaker') return t('episode.activity.titleBreakdown')
  return t('episode.activity.titleGeneric')
})

const elapsedText = computed(() => `${(props.activity.elapsedMs / 1000).toFixed(1)}s`)

/** 工具名 → 人类可读动作（兼容 camelCase 上报，未登记时回退原名便于排障） */
function toolLabel(name: string) {
  return resolveToolLabel(t, te, 'episode.activity', name)
}

const runningTool = computed(() => [...props.activity.tools].reverse().find(tool => tool.status === 'running'))

const phaseText = computed(() => {
  const { phase, text, reasoningChars } = props.activity
  if (phase === 'error') return t('episode.activity.phaseError')
  if (phase === 'done') return t('episode.activity.phaseDone', { s: elapsedText.value })
  if (phase === 'connecting') return t('episode.activity.phaseConnecting')
  if (phase === 'tool') return t('episode.activity.phaseTool', { tool: toolLabel(runningTool.value?.name || '') })
  if (text.length) return t('episode.activity.phaseWriting', { n: text.length })
  if (reasoningChars) return t('episode.activity.phaseReasoning', { n: reasoningChars })
  return t('episode.activity.phaseThinking')
})

// 文本增长时保持滚动到底部，用户不用手动拖
watch(() => props.activity.text.length, async () => {
  await nextTick()
  if (textEl.value) textEl.value.scrollTop = textEl.value.scrollHeight
})
</script>

<style scoped>
.agent-live {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  /* 用主题实色变量：--surface-* 未定义会导致透明看不清 */
  background: var(--bg-2);
  max-width: 100%;
}
.agent-live-head { display: flex; align-items: center; gap: 7px; }
.agent-live-spin { color: var(--accent); flex: 0 0 auto; }
.agent-live-ok { color: var(--success-text, var(--accent)); flex: 0 0 auto; }
.agent-live-bad { color: var(--danger-text, var(--text-1)); flex: 0 0 auto; }
.agent-live-title { font: 600 12.5px var(--font-body); color: var(--text-0); }
.agent-live-elapsed { margin-left: auto; font-size: 11px; color: var(--text-3); }
.agent-live-phase { display: flex; align-items: center; gap: 6px; font: 500 11.5px var(--font-body); color: var(--text-2); }
.agent-live-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent);
  animation: agent-live-pulse 1.1s ease-in-out infinite;
}
.agent-live.is-done .agent-live-dot { background: var(--success-text, var(--accent)); animation: none; }
.agent-live.is-error .agent-live-dot { background: var(--danger-text, var(--text-1)); animation: none; }
@keyframes agent-live-pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }

.agent-live-tools { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.agent-live-tools li {
  display: flex; align-items: baseline; gap: 6px;
  font: 500 11.5px var(--font-body); color: var(--text-2);
  padding: 4px 8px; border-radius: var(--radius-sm, 6px); background: var(--bg-1);
}
.agent-live-tools li.is-running { color: var(--text-1); }
.agent-live-tools li.is-error { color: var(--danger-text, var(--text-1)); }
.agent-tool-name { font-weight: 600; flex: 0 0 auto; }
.agent-tool-ms { font-size: 10.5px; color: var(--text-3); }
.agent-tool-preview {
  font-size: 10.5px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}

.agent-live-output { display: flex; flex-direction: column; gap: 4px; }
.agent-live-output-head {
  display: flex; justify-content: space-between; gap: 8px;
  font: 600 10px var(--font-body); letter-spacing: .05em; text-transform: uppercase; color: var(--text-3);
}
.agent-live-pre {
  margin: 0; max-height: 168px; overflow-y: auto; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm, 6px);
  background: var(--bg-1); color: var(--text-1);
  font: 11.5px/1.65 var(--font-mono, monospace);
  white-space: pre-wrap; word-break: break-word;
}
.agent-live-error {
  font: 500 11.5px var(--font-body); color: var(--danger-text, var(--text-1));
  padding: 6px 8px; border-radius: var(--radius-sm, 6px); background: var(--danger-bg, rgba(220, 53, 69, .08));
}
</style>
