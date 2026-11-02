import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const backendRoute = read('../backend/src/routes/agent.ts')
const useAgent = read('app/composables/useAgent.ts')
const panel = read('app/components/AgentActivityPanel.vue')
const episode = read('app/views/drama/episode.vue')

test('后端提供 SSE 流式端点，事件覆盖思考 / 工具 / 文本 / 完成 / 错误', () => {
  assert.match(backendRoute, /streamSSE/)
  assert.match(backendRoute, /app\.post\('\/:type\/stream'/)
  assert.match(backendRoute, /agent\.stream\(/)
  for (const event of ['start', 'step', 'text', 'reasoning', 'tool-call', 'tool-result', 'done', 'error']) {
    assert.match(backendRoute, new RegExp(`event: '${event}'`), `缺少 ${event} 事件`)
  }
  // 既有非流式端点保持可用（旧前端/脚本兼容）
  assert.match(backendRoute, /app\.post\('\/:type\/chat'/)
})

test('useAgent 以 SSE 逐块解析并暴露实时活动状态', () => {
  assert.match(useAgent, /export interface AgentActivity/)
  assert.match(useAgent, /export type AgentPhase = 'idle' \| 'connecting' \| 'thinking' \| 'tool' \| 'done' \| 'error'/)
  assert.match(useAgent, /phase: AgentPhase/)
  assert.match(useAgent, /const activity = reactive<AgentActivity>/)
  // 手写 SSE 解析：按空行切事件块，兼容 event/data 字段
  assert.match(useAgent, /indexOf\('\\n\\n'\)/)
  assert.match(useAgent, /line\.startsWith\('event:'\)/)
  assert.match(useAgent, /line\.startsWith\('data:'\)/)
  // 旧后端无流式端点时回退到一次性请求
  assert.match(useAgent, /resp\.status === 404 \|\| resp\.status === 405/)
  assert.match(useAgent, /agent\/\$\{type\}\/chat/)
  // 返回给工作台
  assert.match(useAgent, /return \{ running, runningType, activity, run \}/)
})

test('AI 活动面板展示阶段文案、工具流水与实时输出', () => {
  assert.match(panel, /defineProps<\{\s*activity: AgentActivity/)
  assert.match(panel, /episode\.activity\.phaseTool/)
  assert.match(panel, /episode\.activity\.phaseThinking/)
  assert.match(panel, /episode\.activity\.liveOutput/)
  // 工具名做人类可读映射，未登记时回退原名
  assert.match(panel, /function toolLabel\(name: string\)/)
  assert.match(panel, /resolveToolLabel\(t, te, 'episode\.activity', name\)/)
  // 文本增长时自动滚到底部
  assert.match(panel, /scrollTop = textEl\.value\.scrollHeight/)
})

test('工作台的改写与拆分镜都接入了实时面板', () => {
  assert.match(episode, /activity: agentActivity/)
  assert.match(episode, /<AgentActivityPanel :activity="agentActivity" :agent-type="rt" \/>/)
  assert.match(episode, /<AgentActivityPanel\s+v-if="rt === 'storyboard_breaker'"/)
})

test('四种语言的实时面板文案齐全', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${lang}.json`))
    const activity = json.episode?.activity
    assert.ok(activity, `${lang} 缺少 episode.activity`)
    for (const key of ['titleRewrite', 'titleBreakdown', 'phaseConnecting', 'phaseThinking', 'phaseWriting', 'phaseTool', 'phaseDone', 'phaseError', 'liveOutput', 'chars']) {
      assert.ok(activity[key], `${lang} 缺少 episode.activity.${key}`)
    }
    for (const tool of ['read_episode_script', 'rewrite_to_screenplay', 'save_script', 'read_storyboard_context', 'save_storyboards', 'update_storyboard']) {
      assert.ok(activity.tool?.[tool], `${lang} 缺少 episode.activity.tool.${tool}`)
    }
    assert.ok(json.composables?.agent?.failed, `${lang} 缺少 composables.agent.failed`)
  }
})

test('资产提取提供纯内存实时日志（不落库）', () => {
  const hub = read('../backend/src/services/live-log.ts')
  const extraction = read('../backend/src/services/extraction.ts')
  const episodesRoute = read('../backend/src/routes/episodes.ts')
  const popover = read('app/components/LiveLogPopover.vue')

  // 内存中心：环形缓冲 + 订阅，无 DB 访问
  assert.match(hub, /const MAX_ENTRIES = \d+/)
  assert.match(hub, /export function pushLiveLog/)
  assert.match(hub, /export function subscribeLiveLog/)
  assert.doesNotMatch(hub, /from '\.\.\/db/)

  // 提取过程推送：开始 / 工具 / 写入数量 / 模型输出 / 完成 / 失败
  for (const kind of ['start', 'tool', 'saved', 'text', 'done', 'error']) {
    assert.match(extraction, new RegExp(`kind: '${kind}'`), `提取日志缺少 ${kind}`)
  }
  assert.match(extraction, /clearLiveLog\(logKey\)/)

  // SSE 路由：先回放缓冲再订阅
  assert.match(episodesRoute, /app\.get\('\/:id\/extract-log'/)
  assert.match(episodesRoute, /for \(const entry of readLiveLog\(logKey\)\)/)
  assert.match(episodesRoute, /subscribeLiveLog\(logKey/)

  // 前端：点击展开、EventSource 订阅、关闭即断开
  assert.match(popover, /new EventSource\(url\)/)
  assert.match(popover, /addEventListener\('log'/)
  assert.match(popover, /onBeforeUnmount\(disconnect\)/)
  assert.match(popover, /if \(entry\.kind === 'start'\) entries\.value = \[\]/)
  assert.match(episode, /<LiveLogPopover/)
})

test('工具名兼容驼峰上报，日志展示模型输出原文', () => {
  const labels = read('app/utils/tool-labels.ts')
  const liveLog = read('../backend/src/services/live-log.ts')
  const extraction = read('../backend/src/services/extraction.ts')
  const popover = read('app/components/LiveLogPopover.vue')
  const panel = read('app/components/AgentActivityPanel.vue')

  // 归一化：camelCase → snake_case，供 i18n 键匹配
  assert.match(labels, /export function toSnakeCaseTool/)
  assert.ok(labels.includes('([a-z0-9])([A-Z])'), '缺少 camelCase 拆分规则')
  assert.match(labels, /export function resolveToolLabel/)
  assert.match(popover, /resolveToolLabel\(t, te, 'episode\.liveLog', name\)/)
  assert.match(panel, /resolveToolLabel\(t, te, 'episode\.activity', name\)/)

  // 日志条目携带模型输出原文，面板单独成块渲染
  assert.match(liveLog, /text\?: string/)
  assert.match(extraction, /kind: 'text', chars: text\.length, text: text\.slice\(0, 400\)/)
  assert.match(popover, /class="live-log-quote"/)
  assert.match(popover, /entry\.text/)

  // 失败行独立展示原文 + 文案键齐全
  assert.match(popover, /episode\.liveLog\.failedLabel/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(json.episode.liveLog.failedLabel, `${lang} 缺少 failedLabel`)
  }
})
