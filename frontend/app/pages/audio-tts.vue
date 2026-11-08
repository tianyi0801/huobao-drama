<template>
  <div class="page tts-page">
    <header class="tts-topbar">
      <div class="tts-brand">
        <h1 class="tts-title">
          <AudioLines :size="17" :stroke-width="2.1" />
          {{ t('localTts.title') }}
        </h1>
        <span class="tts-sub">{{ t('localTts.sub') }}</span>
      </div>
      <span class="tts-status" :class="statusClass">
        <i class="tts-dot" />
        {{ statusText }}
      </span>
    </header>

    <!-- 平台硬门槛：非 Windows 只展示说明，安装与生成按钮全部停用 -->
    <div v-if="loaded && !supported" class="tts-notice">
      <MonitorOff :size="18" :stroke-width="1.9" />
      <div>
        <strong>{{ t('localTts.winOnly.title') }}</strong>
        <p>{{ t('localTts.winOnly.desc', { platform }) }}</p>
      </div>
    </div>

    <div class="tts-layout">
      <!-- ===== 左列：环境配置 + 检测结果 ===== -->
      <aside class="tts-col">
        <section class="card tts-card">
          <!-- 配置不常改：环境就绪后自动收起，折叠状态跨页面记住 -->
          <button type="button" class="tts-collapse-head" @click="toggleConfig">
            <div>
              <h2><Settings2 :size="14" /> {{ t('localTts.env.title') }}</h2>
              <p v-if="configOpen">{{ t('localTts.env.desc') }}</p>
              <p v-else class="tts-collapse-summary" :title="cfg.projectDir">{{ cfg.projectDir || '—' }}</p>
            </div>
            <span class="tts-collapse-side">
              <span v-if="!configOpen && loaded" class="tag" :class="ready ? 'tag-success' : 'tag-error'">
                {{ ready ? t('localTts.status.ready') : t('localTts.status.notReady') }}
              </span>
              <ChevronDown :size="15" :class="{ rotated: configOpen }" />
            </span>
          </button>

          <template v-if="configOpen">
          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.env.projectDir') }}</span>
            <input v-model="cfg.projectDir" class="input" :placeholder="t('localTts.env.projectDirHint')" />
            <small>{{ t('localTts.env.projectDirHint') }}</small>
          </label>

          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.env.gitUrl') }}</span>
            <input v-model="cfg.gitUrl" class="input" placeholder="https://github.com/breezeblue-ai/breeze-tts.git" />
          </label>

          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.env.pythonPath') }}</span>
            <input v-model="cfg.pythonPath" class="input" :placeholder="t('localTts.env.pythonPathHint')" />
            <small>{{ t('localTts.env.pythonPathHint') }}</small>
          </label>

          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.env.modelDir') }}</span>
            <input v-model="cfg.modelDir" class="input" :placeholder="t('localTts.env.modelDirHint')" />
            <small>{{ t('localTts.env.modelDirHint') }}</small>
          </label>

          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.env.pipArgs') }}</span>
            <input v-model="cfg.pipArgs" class="input" placeholder="-i https://pypi.tuna.tsinghua.edu.cn/simple" />
            <small>{{ t('localTts.env.pipArgsHint') }}</small>
          </label>

          <label class="tts-switch">
            <input v-model="cfg.useVenv" type="checkbox" />
            <span>{{ t('localTts.env.useVenv') }}</span>
          </label>

          <div class="tts-actions">
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveConfig">
              <Loader2 v-if="saving" :size="13" class="tts-spin" />
              <Save v-else :size="13" />
              {{ t('localTts.env.save') }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="checking || !supported" @click="check(false)">
              <Loader2 v-if="checking" :size="13" class="tts-spin" />
              <RefreshCw v-else :size="13" />
              {{ t('localTts.env.detect') }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="deepChecking || !supported" @click="check(true)">
              <Loader2 v-if="deepChecking" :size="13" class="tts-spin" />
              <Cpu v-else :size="13" />
              {{ t('localTts.env.deepDetect') }}
            </button>
          </div>

          <div class="tts-install">
            <button class="btn btn-primary tts-install-btn" :disabled="!supported || busy" @click="startInstall">
              <Download :size="14" />
              {{ t('localTts.env.install') }}
            </button>
            <p>{{ t('localTts.env.installHint') }}</p>
          </div>
          </template>
        </section>

        <section class="card tts-card">
          <div class="tts-card-head">
            <div>
              <h2><ClipboardCheck :size="14" /> {{ t('localTts.report.title') }}</h2>
              <p v-if="report">{{ t('localTts.report.checkedAt') }}：{{ formatTime(report.checkedAt) }}</p>
              <p v-else>{{ t('localTts.report.untouched') }}</p>
            </div>
            <span v-if="report" class="tag" :class="report.ready ? 'tag-success' : 'tag-error'">
              {{ report.ready ? t('localTts.status.ready') : t('localTts.status.notReady') }}
            </span>
          </div>

          <div v-if="report?.blockers?.length" class="tts-issues bad">
            <div v-for="(b, i) in report.blockers" :key="`b${i}`"><TriangleAlert :size="12" /> {{ b }}</div>
          </div>
          <div v-if="report?.warnings?.length" class="tts-issues warn">
            <div v-for="(w, i) in report.warnings" :key="`w${i}`"><Info :size="12" /> {{ w }}</div>
          </div>
          <p v-if="report?.ready" class="tts-allgood"><CheckCircle2 :size="13" /> {{ t('localTts.report.allGood') }}</p>

          <div v-if="report" class="tts-checks">
            <div v-for="item in report.checks" :key="item.key" class="tts-check">
              <CheckCircle2 v-if="item.ok" :size="13" class="tts-ck ok" />
              <CircleX v-else-if="item.level === 'blocker'" :size="13" class="tts-ck bad" />
              <Info v-else :size="13" class="tts-ck warn" />
              <span class="tts-check-label">{{ item.label }}</span>
              <span class="tts-check-detail" :title="item.detail">{{ item.detail }}</span>
            </div>
          </div>

          <div v-if="report && (report.gpu || report.diskFreeGiB !== null)" class="tts-facts">
            <span v-if="report?.gpu">GPU：{{ report.gpu.name }} · {{ report.gpu.memoryUsedMiB }}/{{ report.gpu.memoryTotalMiB }} MiB</span>
            <span v-if="report && report.diskFreeGiB !== null">{{ t('localTts.report.disk') }}：{{ report.diskFreeGiB }} GiB</span>
          </div>
        </section>
      </aside>

      <!-- ===== 右列：生成表单 / 结果 / 日志 / 历史 ===== -->
      <div class="tts-col">
        <section class="card tts-card">
          <div class="tts-card-head">
            <div>
              <h2><Mic2 :size="14" /> {{ t('localTts.form.title') }}</h2>
              <p>{{ t('localTts.license') }}</p>
            </div>
          </div>

          <div v-if="!ready" class="tts-lock">
            <TriangleAlert :size="14" /> {{ t('localTts.form.locked') }}
          </div>

          <div class="tts-modes">
            <button
              v-for="m in MODES" :key="m.value"
              class="tts-mode" :class="{ active: voice.mode === m.value }"
              :disabled="busy" @click="setMode(m.value)"
            >{{ t(m.labelKey) }}</button>
          </div>

          <label class="tts-field">
            <span class="tts-label">{{ t('localTts.form.text') }}</span>
            <textarea
              v-model="voice.text" class="textarea" rows="4"
              :placeholder="t('localTts.form.textPlaceholder')" :disabled="!ready || busy"
            />
          </label>

          <div v-if="voice.mode !== 'clone'" class="tts-field">
            <span class="tts-label">{{ t('localTts.form.instruction') }}</span>
            <textarea
              v-model="voice.instruction" class="textarea" rows="2"
              :placeholder="t('localTts.form.instructionPlaceholder')" :disabled="!ready || busy"
            />
            <div class="tts-presets">
              <span class="tts-presets-label">{{ t('localTts.form.presets') }}</span>
              <button
                v-for="p in VOICE_PRESETS" :key="p.label" class="tag tts-preset"
                :disabled="!ready || busy" @click="voice.instruction = p.value"
              >{{ p.label }}</button>
            </div>
          </div>

          <div v-if="voice.mode !== 'design'" class="tts-field">
            <span class="tts-label">{{ t('localTts.form.refAudio') }}</span>
            <div class="tts-upload">
              <label class="btn btn-ghost btn-sm tts-upload-btn" :class="{ disabled: !ready || busy }">
                <Upload :size="13" /> {{ voice.refAudioName || t('localTts.form.refAudioPick') }}
                <input type="file" accept=".wav,.mp3,.m4a,.aac" :disabled="!ready || busy" @change="onRefAudio" />
              </label>
              <small>{{ t('localTts.form.refAudioHint') }}</small>
            </div>
            <textarea
              v-model="voice.refText" class="textarea" rows="2"
              :placeholder="t('localTts.form.refTextPlaceholder')" :disabled="!ready || busy"
            />
          </div>

          <div class="tts-params">
            <label class="tts-field">
              <span class="tts-label">cfg_scale</span>
              <input v-model.number="voice.cfgScale" class="input" type="number" min="0.5" max="10" step="0.5" :disabled="!ready || busy" />
            </label>
            <label class="tts-field">
              <span class="tts-label">seed</span>
              <input v-model.number="voice.seed" class="input" type="number" min="0" step="1" :disabled="!ready || busy" />
            </label>
            <label class="tts-field">
              <span class="tts-label">{{ t('localTts.form.name') }}</span>
              <input v-model="voice.name" class="input" placeholder="narration" :disabled="!ready || busy" />
            </label>
          </div>

          <div class="tts-actions">
            <button class="btn btn-primary" :disabled="!ready || busy || !voice.text.trim()" @click="submit">
              <Loader2 v-if="busy" :size="14" class="tts-spin" />
              <Sparkles v-else :size="14" />
              {{ busy ? t('localTts.form.generating') : t('localTts.form.submit') }}
            </button>
            <button v-if="busy" class="btn btn-danger btn-sm" @click="cancelJob">
              <Square :size="12" /> {{ t('localTts.env.stop') }}
            </button>
          </div>
        </section>

        <section class="card tts-card">
          <div class="tts-card-head">
            <div><h2><FileAudio :size="14" /> {{ t('localTts.result.title') }}</h2></div>
          </div>
          <!-- 试听独立于「本次结果」：只点历史记录时也能播放 -->
          <audio v-if="playingUrl" controls class="tts-audio" :src="playingUrl" />
          <div v-if="result" class="tts-result">
            <div class="tts-metrics">
              <span class="tag" :class="result.metrics.verdict === 'PASS' ? 'tag-success' : 'tag-warning'">
                {{ result.metrics.verdict }}
              </span>
              <span>{{ t('localTts.result.metrics', {
                duration: result.metrics.duration,
                peak: result.metrics.peak,
                rms: result.metrics.rms,
                silence: (result.metrics.silenceRatio * 100).toFixed(1),
              }) }}</span>
            </div>
            <p class="tts-reason">{{ result.metrics.reason }}</p>
            <div class="tts-path">
              <span class="tts-path-label">{{ t('localTts.result.filePath') }}</span>
              <code class="tts-path-value" :title="result.absolutePath || result.path">{{ result.absolutePath || result.path }}</code>
              <button class="btn btn-ghost btn-sm" @click="copyPath(result.absolutePath || result.path)">
                <Copy :size="12" /> {{ t('localTts.result.copy') }}
              </button>
            </div>
            <div class="tts-actions">
              <a class="btn btn-ghost btn-sm" :href="result.url" :download="result.name">
                <Download :size="13" /> {{ t('localTts.result.download') }}
              </a>
            </div>
          </div>
          <p v-else-if="!playingUrl" class="tts-empty">{{ t('localTts.result.empty') }}</p>
          <p v-else class="tts-playing-name">{{ playingName }}</p>
        </section>

        <section class="card tts-card tts-log-card">
          <div class="tts-card-head">
            <div>
              <h2><ScrollText :size="14" /> {{ t('localTts.job.title') }}</h2>
              <p v-if="logs.length">{{ t('localTts.job.lines', { n: logs.length }) }}</p>
            </div>
            <div class="tts-log-tools">
              <span v-if="jobStatus" class="tag" :class="jobStatus === 'done' ? 'tag-success' : jobStatus === 'failed' ? 'tag-error' : 'tag-warning'">
                {{ t(`localTts.job.${jobStatus}`) }}
              </span>
              <button class="btn btn-ghost btn-sm" @click="toggleLog">
                <Minimize2 v-if="logExpanded" :size="12" />
                <Maximize2 v-else :size="12" />
                {{ logExpanded ? t('localTts.job.collapse') : t('localTts.job.expand') }}
              </button>
            </div>
          </div>
          <div ref="logBox" class="tts-log" :class="{ expanded: logExpanded }" @scroll="onLogScroll">
            <div v-if="!logs.length" class="tts-empty">{{ t('localTts.job.idle') }}</div>
            <div v-for="(line, i) in logs" :key="i" class="tts-log-line" :class="{ err: line.includes('❌'), ok: line.includes('✅') }">{{ line }}</div>
          </div>
        </section>

        <section class="card tts-card">
          <div class="tts-card-head">
            <div><h2><History :size="14" /> {{ t('localTts.result.history') }}</h2></div>
            <button class="btn btn-ghost btn-sm" @click="loadOutputs"><RefreshCw :size="12" /></button>
          </div>
          <p v-if="!outputs.length" class="tts-empty">{{ t('localTts.result.noHistory') }}</p>
          <div v-else class="tts-history">
            <div v-for="item in outputs" :key="item.name" class="tts-history-row">
              <button class="tts-history-play" :title="t('localTts.result.play')" @click="playOutput(item)">
                <Play :size="12" />
              </button>
              <div class="tts-history-info">
                <span class="tts-history-name" :title="item.name">{{ item.name }}</span>
                <span class="tts-history-path" :title="item.absolutePath || item.path">{{ item.absolutePath || item.path }}</span>
              </div>
              <span class="tts-history-size">{{ (item.size / 1024).toFixed(0) }} KB</span>
              <button class="tts-history-dl" :title="t('localTts.result.copy')" @click="copyPath(item.absolutePath || item.path)"><Copy :size="12" /></button>
              <a :href="item.url" :download="item.name" class="tts-history-dl" :title="t('localTts.result.download')"><Download :size="12" /></a>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  AudioLines, CheckCircle2, ChevronDown, CircleX, ClipboardCheck, Copy, Cpu,
  Download, FileAudio, History, Info, Loader2, Maximize2, Mic2, Minimize2,
  MonitorOff, Play, RefreshCw, Save, ScrollText, Settings2, Sparkles, Square,
  TriangleAlert, Upload,
} from 'lucide-vue-next'
import { localTtsAPI, uploadAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

// 只持久化 UI 会话状态：音频文件本身在磁盘，日志权威副本在后端任务里
const CONFIG_OPEN_KEY = 'huobao:localTts.configOpen'
const LAST_JOB_KEY = 'huobao:localTts.lastJob'
const LAST_RESULT_KEY = 'huobao:localTts.lastResult'

const MODES = [
  { value: 'design', labelKey: 'localTts.form.modeDesign' },
  { value: 'clone', labelKey: 'localTts.form.modeClone' },
  { value: 'direction', labelKey: 'localTts.form.modeDirection' },
]

/** 实测自然的音色模板：描述越克制越自然，程度词堆多了模型会过度表演 */
const VOICE_PRESETS = [
  { label: '御姐', value: '二十岁出头、甜软、一点鼻音、细腻的气声、轻轻上挑' },
  { label: '成熟御姐', value: '三十岁左右的成熟女声，音色偏低，慵懒，语速中等，尾音放松' },
  { label: '少女', value: '十六七岁少女，声音清亮偏细，说话轻快' },
  { label: '温柔男声', value: '二十五六岁男声，温和，中低音，气声少，语速稍慢' },
  { label: '大叔', value: '四十岁男性，低沉，胸腔共鸣明显，语速慢，结尾略微下沉' },
  { label: '播音', value: '专业播音女声，字正腔圆，语速均匀，无明显情绪起伏' },
]

const loaded = ref(false)
const supported = ref(false)
const platform = ref('')
const saving = ref(false)
const checking = ref(false)
const deepChecking = ref(false)
const busy = ref(false)
const report = ref(null)

const cfg = reactive({ projectDir: '', modelDir: '', pythonPath: '', gitUrl: '', useVenv: true, pipArgs: '' })
const voice = reactive({
  mode: 'design', text: '', instruction: '', refAudio: '', refText: '', refAudioName: '',
  cfgScale: 4, seed: 42, name: '',
})

const logs = ref([])
const jobStatus = ref('')
const jobId = ref('')
const jobKind = ref('')
const logBox = ref(null)
const logExpanded = ref(false)
const followLog = ref(true)
const configOpen = ref(true)
const configUserSet = ref(false)
const result = ref(null)
const playingUrl = ref('')
const playingName = ref('')
const outputs = ref([])
let since = 0
let timer = null

const ready = computed(() => supported.value && report.value?.ready === true)
const statusText = computed(() => {
  if (!loaded.value) return t('localTts.status.checking')
  if (!supported.value) return t('localTts.status.unsupported')
  if (busy.value) return t('localTts.job.running')
  return ready.value ? t('localTts.status.ready') : t('localTts.status.notReady')
})
const statusClass = computed(() => ({
  ok: loaded.value && supported.value && ready.value && !busy.value,
  warn: loaded.value && (!supported.value || (supported.value && !ready.value) || busy.value),
}))

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString()
}

function readStore(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 隐私模式下忽略 */ }
}

function toggleConfig() {
  configOpen.value = !configOpen.value
  configUserSet.value = true
  try { localStorage.setItem(CONFIG_OPEN_KEY, configOpen.value ? '1' : '0') } catch {}
}
function restoreConfigOpen() {
  try {
    const saved = localStorage.getItem(CONFIG_OPEN_KEY)
    if (saved !== null) { configOpen.value = saved === '1'; configUserSet.value = true }
  } catch {}
}
async function toggleLog() {
  logExpanded.value = !logExpanded.value
  await nextTick()
  // 展开后把日志卡滚到顶部（避开固定顶栏）：小屏下卡片头与「收起」按钮始终可见
  if (logExpanded.value) {
    logBox.value?.closest('.tts-log-card')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
}

function onLogScroll() {
  const el = logBox.value
  if (!el) return
  // 用户往上翻看历史时暂停自动跟随，避免被反复拉回底部
  followLog.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}
function scrollLog(force = false) {
  const el = logBox.value
  if (!el) return
  if (force || followLog.value) {
    el.scrollTop = el.scrollHeight
    followLog.value = true
  }
}

function persistJob() {
  writeStore(LAST_JOB_KEY, {
    id: jobId.value,
    kind: jobKind.value,
    status: jobStatus.value,
    logs: logs.value.slice(-300),
  })
}

async function copyPath(value) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast.success(t('localTts.result.copied'))
  } catch {
    // 剪贴板不可用时把路径直接显示出来，用户仍可手动选中复制
    toast.info(value, { duration: 8000 })
  }
}
function playOutput(item) {
  playingUrl.value = item.url
  playingName.value = item.name
}

async function loadStatus() {
  try {
    const state = await localTtsAPI.status()
    supported.value = state.supported
    platform.value = state.platform
    const c = state.config || {}
    cfg.projectDir = c.projectDir || ''
    cfg.modelDir = c.modelDir || ''
    cfg.pythonPath = c.pythonPath || ''
    cfg.gitUrl = c.gitUrl || ''
    cfg.useVenv = c.useVenv !== false
    cfg.pipArgs = c.pipArgs || ''
    voice.instruction = c.instruction || ''
    voice.cfgScale = c.cfgScale ?? 4
    voice.seed = c.seed ?? 42
  } catch (err) {
    toastError(err)
  } finally {
    loaded.value = true
  }
}

async function check(deep = false) {
  // 非 Windows 也返回一份带平台阻断项的报告，页面能明确说明「为什么不能用」
  if (deep) deepChecking.value = true
  else checking.value = true
  try {
    report.value = await localTtsAPI.test(deep)
    // 用户没手动折叠过时：环境就绪自动收起配置，未就绪则展开引导修复
    if (!configUserSet.value) configOpen.value = !report.value?.ready
  } catch (err) {
    toastError(err)
  } finally {
    checking.value = false
    deepChecking.value = false
  }
}

/** 保存后立刻复检：用户改了工程目录 / Python，结果必须跟着变 */
async function saveConfig() {
  saving.value = true
  try {
    await localTtsAPI.saveConfig({
      projectDir: cfg.projectDir,
      modelDir: cfg.modelDir,
      pythonPath: cfg.pythonPath,
      gitUrl: cfg.gitUrl,
      useVenv: cfg.useVenv,
      pipArgs: cfg.pipArgs,
    })
    toast.success(t('localTts.env.saved'))
    await check(false)
  } catch (err) {
    toastError(err)
  } finally {
    saving.value = false
  }
}

function stopWatch() {
  if (timer) { clearInterval(timer); timer = null }
  busy.value = false
}

/** 长任务轮询：断线重连安全，日志按 since 增量拉取；每次变化都写入本地会话快照 */
async function pollJob(kind) {
  const id = jobId.value
  if (!id) return
  let job
  try {
    job = await localTtsAPI.job(id, since)
  } catch (err) {
    stopWatch()
    toastError(err)
    return
  }
  since = job.nextSince ?? since
  if (job.logs?.length) {
    logs.value.push(...job.logs)
    persistJob()
    await nextTick()
    scrollLog()
  }
  jobStatus.value = job.status
  persistJob()
  if (job.status === 'done') {
    stopWatch()
    if (kind === 'install') {
      toast.success(t('localTts.job.done'))
      await check(false)
    } else if (job.result) {
      result.value = job.result
      playingUrl.value = job.result.url
      playingName.value = job.result.name
      writeStore(LAST_RESULT_KEY, job.result)
      await loadOutputs()
    }
    return
  }
  if (job.status === 'failed') {
    stopWatch()
    toast.error(job.error || t('localTts.job.failed'))
  }
}

async function watchJob(id, kind) {
  stopWatch()
  logs.value = []
  since = 0
  jobId.value = id
  jobKind.value = kind
  jobStatus.value = 'running'
  followLog.value = true
  busy.value = true
  persistJob()
  await pollJob(kind)
  if (jobStatus.value === 'running') timer = setInterval(() => pollJob(kind), 1200)
  await nextTick()
  scrollLog(true)
}

/**
 * 切换页面回来后恢复会话：结果、日志与仍在跑的任务。
 * 优先用后端任务的全量日志覆盖本地快照（快照只留最近 300 行）；
 * 后端重启导致任务丢失时，退回本地日志，至少保留过程记录与结果路径。
 */
async function restoreSession() {
  restoreConfigOpen()
  const savedResult = readStore(LAST_RESULT_KEY)
  if (savedResult?.url) {
    result.value = savedResult
    playingUrl.value = savedResult.url
    playingName.value = savedResult.name || ''
  }
  const saved = readStore(LAST_JOB_KEY)
  if (!saved?.id) return
  logs.value = Array.isArray(saved.logs) ? saved.logs : []
  jobId.value = saved.id
  jobKind.value = saved.kind || 'generate'
  jobStatus.value = saved.status || 'done'
  since = logs.value.length
  // 已完成任务的日志与结果在 done 时已写进本地快照，直接用即可：
  // 后端重启后任务不在内存，再查只会得到无意义的 404
  if (saved.status !== 'running') {
    await nextTick()
    scrollLog(true)
    return
  }
  try {
    const job = await localTtsAPI.job(saved.id, 0)
    if (Array.isArray(job.logs) && job.logs.length) logs.value = job.logs
    since = job.nextSince ?? logs.value.length
    jobStatus.value = job.status
    if (job.status === 'running') {
      busy.value = true
      timer = setInterval(() => pollJob(jobKind.value), 1200)
    } else {
      stopWatch()
      if (job.status === 'done' && job.result && !result.value) {
        result.value = job.result
        playingUrl.value = job.result.url
        playingName.value = job.result.name
        writeStore(LAST_RESULT_KEY, job.result)
      }
    }
  } catch {
    // 后端已重启：任务不在内存，保留本地日志快照，不再继续轮询
    jobStatus.value = 'done'
    jobId.value = ''
  }
  await nextTick()
  scrollLog(true)
}

async function startInstall() {
  try {
    const { id } = await localTtsAPI.install()
    await watchJob(id, 'install')
  } catch (err) {
    toastError(err)
  }
}

async function cancelJob() {
  if (!jobId.value) return
  try {
    await localTtsAPI.cancel(jobId.value)
    toast.success(t('localTts.env.cancelDone'))
  } catch (err) {
    toastError(err)
  }
}

function setMode(mode) {
  voice.mode = mode
  // 纯克隆 cfg 低才贴原声；带音色描述时需要更高引导强度
  voice.cfgScale = mode === 'clone' ? 1 : 4
}

async function onRefAudio(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const uploaded = await uploadAPI.audio(file)
    voice.refAudio = uploaded.path
    voice.refAudioName = file.name
  } catch (err) {
    toastError(err)
  } finally {
    event.target.value = ''
  }
}

async function submit() {
  if (!voice.text.trim()) return
  if (voice.mode !== 'design' && (!voice.refAudio || !voice.refText.trim())) {
    toast.error(t('localTts.form.refRequired'))
    return
  }
  const payload = {
    text: voice.text.trim(),
    cfgScale: Number(voice.cfgScale) || (voice.mode === 'clone' ? 1 : 4),
    seed: Number(voice.seed) || 0,
    name: voice.name,
  }
  if (voice.mode !== 'clone' && voice.instruction.trim()) payload.instruction = voice.instruction.trim()
  if (voice.mode !== 'design') {
    payload.refAudio = voice.refAudio
    payload.refText = voice.refText.trim()
  }
  try {
    const { id } = await localTtsAPI.generate(payload)
    await watchJob(id, 'generate')
  } catch (err) {
    toastError(err)
  }
}

async function loadOutputs() {
  try {
    outputs.value = await localTtsAPI.outputs()
  } catch (err) {
    toastError(err)
  }
}

onMounted(async () => {
  // 先把上次的音频结果、文件路径与日志放回界面，再请求后端刷新环境状态
  await restoreSession()
  await loadStatus()
  await check(false)
  await loadOutputs()
})
onUnmounted(stopWatch)
</script>

<style scoped>
/* 外层 .content 是 overflow:hidden 的固定高度 flex 容器，页面必须自己承担纵向滚动，
   否则右列下方的「本次结果」/ 日志 / 历史会被直接裁掉且无法滚动查看 */
.tts-page { display: flex; flex-direction: column; gap: 16px; padding: 20px 24px 40px; height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.tts-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.tts-brand { display: flex; align-items: baseline; gap: 12px; }
.tts-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: var(--text-0); }
.tts-sub { font-size: 12px; color: var(--text-3); }
.tts-status { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: var(--bg-1); color: var(--text-2); }
.tts-status.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, transparent); }
.tts-status.warn { color: var(--accent-text); border-color: var(--accent-bg); }
.tts-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

.tts-notice { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--accent-bg); background: var(--accent-bg); color: var(--accent-text); }
.tts-notice strong { font-size: 13px; }
.tts-notice p { margin-top: 4px; font-size: 12px; line-height: 1.6; opacity: .9; }

/* 不参与纵向 flex 收缩：两列按内容撑开，由 .tts-page 统一滚动 */
.tts-layout { display: grid; grid-template-columns: minmax(330px, 400px) minmax(0, 1fr); gap: 16px; align-items: start; flex: none; }
.tts-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.tts-card { padding: 16px; display: flex; flex-direction: column; gap: 13px; }
.tts-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.tts-card-head h2 { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; color: var(--text-0); }
.tts-card-head p { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--text-3); }
.tts-collapse-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; width: 100%; padding: 0; border: none; background: transparent; text-align: left; cursor: pointer; }
.tts-collapse-head h2 { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; color: var(--text-0); }
.tts-collapse-head p { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--text-3); }
.tts-collapse-summary { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tts-collapse-side { display: flex; align-items: center; gap: 8px; flex: none; color: var(--text-3); }
.tts-collapse-side svg { transition: transform .18s ease; }
.tts-collapse-side svg.rotated { transform: rotate(180deg); }

.tts-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.tts-label { font-size: 11px; font-weight: 600; color: var(--text-2); }
.tts-field small { font-size: 10px; line-height: 1.5; color: var(--text-3); }
.tts-field .input, .tts-field .textarea { width: 100%; font-size: 12px; }
.tts-field .textarea { resize: vertical; min-height: 56px; }
.tts-switch { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); cursor: pointer; }
.tts-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tts-install { border-top: 1px solid var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 7px; }
.tts-install-btn { width: 100%; justify-content: center; }
.tts-install p { font-size: 10px; line-height: 1.6; color: var(--text-3); }

.tts-issues { display: flex; flex-direction: column; gap: 5px; font-size: 11px; line-height: 1.5; }
.tts-issues > div { display: flex; align-items: flex-start; gap: 6px; }
.tts-issues.bad { color: var(--action-danger); }
.tts-issues.warn { color: var(--accent-text); }
.tts-issues svg { flex: none; margin-top: 2px; }
.tts-allgood { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--success); }
.tts-checks { display: flex; flex-direction: column; gap: 1px; }
.tts-check { display: grid; grid-template-columns: 14px 76px minmax(0, 1fr); align-items: start; gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
.tts-check:last-child { border-bottom: none; }
.tts-ck { margin-top: 1px; }
.tts-ck.ok { color: var(--success); }
.tts-ck.bad { color: var(--action-danger); }
.tts-ck.warn { color: var(--accent-text); }
.tts-check-label { color: var(--text-2); font-weight: 600; }
.tts-check-detail { color: var(--text-3); word-break: break-all; line-height: 1.5; }
.tts-facts { display: flex; flex-wrap: wrap; gap: 10px; font-size: 10px; color: var(--text-3); }

.tts-lock { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; background: var(--accent-bg); color: var(--accent-text); font-size: 11px; }
.tts-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.tts-mode { padding: 6px 13px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-1); color: var(--text-2); font-size: 11px; cursor: pointer; }
.tts-mode.active { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); font-weight: 600; }
.tts-mode:disabled { opacity: .55; cursor: not-allowed; }
.tts-presets { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.tts-presets-label { font-size: 10px; color: var(--text-3); margin-right: 2px; }
.tts-preset { cursor: pointer; border: 1px solid var(--border); background: var(--bg-1); }
.tts-preset:disabled { opacity: .5; cursor: not-allowed; }
.tts-upload { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.tts-upload-btn { position: relative; overflow: hidden; cursor: pointer; }
.tts-upload-btn.disabled { opacity: .55; cursor: not-allowed; }
.tts-upload-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.tts-upload small { font-size: 10px; color: var(--text-3); }
.tts-params { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }

.tts-result { display: flex; flex-direction: column; gap: 10px; }
.tts-audio { width: 100%; height: 38px; }
.tts-metrics { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-2); }
.tts-reason { font-size: 11px; color: var(--text-3); }
.tts-playing-name { font-size: 11px; color: var(--text-3); }
.tts-path { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); }
.tts-path-label { font-size: 10px; color: var(--text-3); flex: none; }
.tts-path-value { flex: 1; min-width: 0; font-size: 11px; color: var(--text-2); word-break: break-all; user-select: all; }
.tts-empty { font-size: 11px; color: var(--text-3); padding: 6px 0; }
.tts-log-card { scroll-margin-top: 72px; }
.tts-log-tools { display: flex; align-items: center; gap: 8px; flex: none; min-width: 0; }
/* 高度随视口自适应：720 高的小屏收起约 216px、展开约 396px，卡片不会顶出视口；
   大屏保留 240px / 560px 上限。固定 240px / 70vh 在矮屏会形成整屏嵌套滚动 */
.tts-log { min-width: 0; min-height: 0; max-height: clamp(140px, 30vh, 240px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 10px; border-radius: 8px; background: var(--bg-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.65; }
.tts-log.expanded { max-height: clamp(240px, 55vh, 560px); }
.tts-log-line { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; color: var(--text-2); }
.tts-log-line.err { color: var(--action-danger); }
.tts-log-line.ok { color: var(--success); }
.tts-history { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.tts-history-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto 22px 22px; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--border); font-size: 11px; }
.tts-history-info { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.tts-history-path { font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tts-history-play, .tts-history-dl { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 6px; background: transparent; color: var(--text-3); cursor: pointer; }
.tts-history-play:hover, .tts-history-dl:hover { background: var(--bg-hover); color: var(--accent-text); }
.tts-history-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.tts-history-size { color: var(--text-3); font-size: 10px; }
.tts-spin { animation: tts-rotate 1s linear infinite; }
@keyframes tts-rotate { to { transform: rotate(360deg); } }

@media (max-width: 1000px) {
  .tts-layout { grid-template-columns: minmax(0, 1fr); }
  .tts-params { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* 窄屏：日志卡片头部的状态与展开按钮换行，别把标题挤成竖排 */
@media (max-width: 720px) {
  .tts-page { padding: 14px 12px 32px; }
  .tts-log-card .tts-card-head { flex-wrap: wrap; }
  .tts-log-card .tts-log-tools { width: 100%; justify-content: flex-start; }
  .tts-log { padding: 8px; }
}
</style>
