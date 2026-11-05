/**
 * MiniMax H3 官方 Ref2VA（Full-Reference）提示词结构。
 *
 * 六节名称与顺序来自 MiniMax 官方 prompt-writing skill
 * （MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/ref-en.txt），
 * 是模型用来识别结构的锚点，不能翻译、改名或调序。
 */
export const H3_SECTIONS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const

type H3Section = typeof H3_SECTIONS[number]

/** 项目旧版自造节名 → 官方节名；用于兼容历史已保存的分镜提示词 */
const LEGACY_SECTION_ALIASES: Record<string, H3Section> = {
  shot_summary: 'summary',
  reference_usage: 'retention_analysis',
}

function headingPattern() {
  return new RegExp(`^(${H3_SECTIONS.join('|')})[\\t ]*[:：][\\t ]*`, 'gm')
}

/** 把历史节名归一为官方节名；已是官方格式时原样返回 */
export function normalizeVideoPromptSections(prompt: string): string {
  const legacy = Object.keys(LEGACY_SECTION_ALIASES).join('|')
  return prompt.replace(
    new RegExp(`^(${legacy})([\\t ]*[:：])`, 'gm'),
    (_, name: string, sep: string) => `${LEGACY_SECTION_ALIASES[name]}${sep}`,
  )
}

function sectionHeadings(prompt: string) {
  return Array.from(prompt.matchAll(headingPattern()))
}

function isOfficialStructure(prompt: string, headings: RegExpMatchArray[]) {
  return headings.length === H3_SECTIONS.length
    && headings.every((match, index) => match[1] === H3_SECTIONS[index])
}

/** detailed_description 正文的起止位置 */
function detailBodyRange(prompt: string, headings: RegExpMatchArray[]) {
  const index = H3_SECTIONS.indexOf('detailed_description')
  const head = headings[index]
  const end = headings[index + 1]?.index ?? prompt.length
  return { bodyStart: (head.index ?? 0) + head[0].length, end }
}

/** 在指定小节末尾追加内容；六节不完整时退回历史纯文本行为 */
export function appendVideoPromptSection(prompt: string, section: H3Section, text: string, legacyPrefix = false): string {
  const normalized = normalizeVideoPromptSections(prompt)
  const headings = sectionHeadings(normalized)
  if (!isOfficialStructure(normalized, headings)) {
    return legacyPrefix ? `${text}，\n${normalized}` : `${normalized}\n${text}`
  }
  const target = LEGACY_SECTION_ALIASES[section as string] ?? section
  const end = headings[H3_SECTIONS.indexOf(target) + 1]?.index ?? normalized.length
  return `${normalized.slice(0, end).trimEnd()}\n${text.trim()}\n${normalized.slice(end)}`.trimEnd()
}

/**
 * 把项目视觉风格压成官方要求的 1 句英文风格句。
 * 预设里的风格词是一长串逗号短语并带大量 avoid 否定句，
 * 官方只允许 [Shot 1] 前 1—2 句，长否定串会压过剧情。
 */
export function toStyleOpening(style: string): string {
  const cleaned = String(style || '')
    .replace(/,?\s*avoid\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;.\s]+$/, '')
  if (!cleaned) return ''
  const phrases = cleaned.split(/,\s*/).slice(0, 4)
  return `The target video uses ${phrases.join(', ')}.`
}

/**
 * 官方规定风格句写在 [Shot 1] 之前，不能追加到 detailed_description 末尾。
 * 重复注入时先剔除旧风格句，保持幂等。
 */
export function injectStyleOpening(prompt: string, style: string): string {
  const opening = toStyleOpening(style)
  if (!opening) return prompt
  const base = normalizeVideoPromptSections(prompt)
    .replace(/^The target video uses [^\n]*\.\n?/m, '')
  const headings = sectionHeadings(base)
  if (!isOfficialStructure(base, headings)) return `${opening}\n${base}`
  const { bodyStart } = detailBodyRange(base, headings)
  const rest = base.slice(bodyStart)
  const shot1 = /\[Shot\s*1\]/i.exec(rest)
  const at = bodyStart + (shot1?.index ?? 0)
  return `${base.slice(0, at).trimEnd()}\n${opening}\n${base.slice(at).trimStart()}`
}

/** 归一化文本用于逐字比对：忽略空白、全半角标点与引号差异 */
function normalizeForCompare(value: string): string {
  return String(value || '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[“”「」『』]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[，。！？；：]/g, ch => ({ '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':' } as Record<string, string>)[ch])
}

/** 提取 <d>[Chinese] 原句</d> 内的台词正文 */
function extractDialogue(prompt: string): string[] {
  return Array.from(prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi))
    .map(match => match[1].replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
}

/**
 * 让 video_prompt 与分镜 description 严格对齐：
 * 1) description 写了几个【镜头N】，就必须生成同样数量的 [Shot N]，不得合并或新增；
 * 2) <d> 里的每句台词都必须逐字来自 description，防止模型自行配音、加旁白。
 * description 没有编号镜头或没有台词时，对应检查跳过。
 */
export function validateVideoPromptAgainstDescription(prompt: string, description: string): void {
  const source = String(description || '')
  const normalizedPrompt = normalizeVideoPromptSections(prompt)
  const headings = sectionHeadings(normalizedPrompt)
  if (!headings.length || !source.trim()) return

  const sourceShots = source.match(/【镜头\s*\d+】/g) || []
  if (sourceShots.length && isOfficialStructure(normalizedPrompt, headings)) {
    const { bodyStart, end } = detailBodyRange(normalizedPrompt, headings)
    const promptShots = normalizedPrompt.slice(bodyStart, end).match(/\[Shot\s+\d+\]/gi) || []
    if (promptShots.length !== sourceShots.length) {
      throw new Error(`description 有 ${sourceShots.length} 个【镜头N】，video_prompt 却只有 ${promptShots.length} 个 [Shot N]；镜头数必须一一对应，不能合并或新增`)
    }
  }

  const dialogues = extractDialogue(normalizedPrompt)
  if (!dialogues.length) {
    if (/[说讲道][：:]\s*[「"“]|旁白[：:]/.test(source)) {
      throw new Error('description 含有台词或旁白，video_prompt 必须用 <d>[Chinese] 原句</d> 保留，不能省略')
    }
    return
  }
  const normalizedSource = normalizeForCompare(source)
  for (const line of dialogues) {
    if (!normalizedSource.includes(normalizeForCompare(line))) {
      throw new Error(`video_prompt 中的台词「${line.slice(0, 40)}」不在 description 原文中，禁止新增配音、旁白或改写台词`)
    }
  }
}

/** 旧格式 [Shot N] 0.0-5.0秒 / 官方格式 [Shot N] At MM:SS.mmm */
const LEGACY_RANGE = /^\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～]\s*(\d+(?:\.\d+)?)/
const OFFICIAL_CUT = /^\s*At\s+(\d{2}):(\d{2})\.(\d{3})\b/i

/**
 * 校验六节结构与镜头时间轴。
 * 历史纯文本跳过；旧版自造节名先归一；旧式起止秒时间轴继续按原规则校验。
 */
export function validateVideoPromptTimeline(prompt: string, duration: number): void {
  const normalized = normalizeVideoPromptSections(prompt)
  const headings = sectionHeadings(normalized)
  if (!headings.length) return
  if (!isOfficialStructure(normalized, headings)) {
    throw new Error('H3 视频提示词必须包含顺序固定且不重复的官方六节（summary / retention_analysis），请重新生成提示词')
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长必须为正数')
  const { bodyStart, end } = detailBodyRange(normalized, headings)
  const shots = Array.from(normalized.slice(bodyStart, end).matchAll(/\[Shot\s+(\d+)\]([^\n]*)/gi))
  if (!shots.length) throw new Error('H3 提示词缺少 [Shot N] 镜头段，请重新生成提示词')
  if (shots.some((shot, index) => Number(shot[1]) !== index + 1)) {
    throw new Error('H3 镜头编号必须连续，请重新生成提示词')
  }

  // 兼容历史提示词：起止秒必须从 0 连续衔接，且总长等于 duration
  if (shots.some(shot => LEGACY_RANGE.test(shot[2]))) {
    let endSec = 0
    for (const shot of shots) {
      const range = LEGACY_RANGE.exec(shot[2])
      if (!range) throw new Error('H3 提示词混用了新旧时间轴格式，请重新生成提示词')
      const start = Number(range[1])
      const nextEnd = Number(range[2])
      if (Math.abs(start - endSec) > 0.01 || nextEnd <= start) {
        throw new Error('H3 镜头时间轴必须从0开始且无重叠或空缺，请重新生成提示词')
      }
      endSec = nextEnd
    }
    if (Math.abs(endSec - duration) > 0.01) {
      throw new Error(`H3 提示词时间轴为${endSec}秒，与分镜时长${duration}秒不符；修改时长后请重新生成视频提示词`)
    }
    return
  }

  // 官方格式：[Shot 1] 不带时间戳，后续镜头用 At MM:SS.mmm 标切镜点
  if (OFFICIAL_CUT.test(shots[0][2])) {
    throw new Error('官方格式中 [Shot 1] 不带时间戳，请重新生成提示词')
  }
  let lastCut = 0
  for (const shot of shots.slice(1)) {
    const cut = OFFICIAL_CUT.exec(shot[2])
    if (!cut) throw new Error('官方格式中 [Shot N] 切镜必须写成 At MM:SS.mmm，请重新生成提示词')
    const seconds = Number(cut[1]) * 60 + Number(cut[2]) + Number(cut[3]) / 1000
    if (seconds <= lastCut || seconds >= duration) {
      throw new Error('H3 切镜时间必须严格递增且落在视频时长内，请重新生成提示词')
    }
    lastCut = seconds
  }
}
