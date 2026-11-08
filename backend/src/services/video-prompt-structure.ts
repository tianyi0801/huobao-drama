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

/** 从生图预设中保留媒介、造型、材质与光线，去掉静帧和画质命令；自定义风格不擅自翻译。 */
export function toStyleOpening(style: string): string {
  const phrases = String(style || '')
    .replace(/,?\s*avoid\b[\s\S]*$/i, '')
    .split(/[,，;；\n]+/)
    .map(phrase => phrase
      .replace(/\b(?:high[- ]quality|still|\d+k|\d+p)\b/gi, '')
      .replace(/(?:高清|高质量|画质|细节拉满|保持一致)/g, '')
      .replace(/\s+/g, ' ').trim().replace(/[.。\s]+$/, ''))
    .filter(phrase => phrase && !/\b(?:quality|consistent|must|only|no|do not)\b|必须|禁止|不要|只能/i.test(phrase))
    .slice(0, 4)
  return phrases.length ? `Visual style: ${phrases.join(', ')}.` : ''
}

/** 兼容历史风格句，重复注入只保留本次的视觉描述。 */
const STYLE_OPENING_PATTERN = /^(?:The target video uses [^\n]*|画面风格[：:][^\n]*|Visual style:[^\n]*)\n?/gm

/**
 * 官方规定风格句写在 [Shot 1] 之前，不能追加到 detailed_description 末尾。
 * 重复注入时先剔除旧风格句，保持幂等。
 */
export function injectStyleOpening(prompt: string, style: string): string {
  const opening = toStyleOpening(style)
  if (!opening) return prompt
  const normalized = normalizeVideoPromptSections(prompt)
  const protectedStyles = new RegExp(`<d>[^]*?<\\/d>|${STYLE_OPENING_PATTERN.source}`, 'gmi')
  const base = normalized.replace(protectedStyles, block => /^<d>/i.test(block) ? block : '')
  const headings = sectionHeadings(base)
  if (!isOfficialStructure(base, headings)) return `${opening}\n${base}`
  const { bodyStart } = detailBodyRange(base, headings)
  const rest = base.slice(bodyStart)
  const shot1 = /\[Shot\s*1\]/i.exec(rest)
  const at = bodyStart + (shot1?.index ?? 0)
  return `${base.slice(0, at).trimEnd()}\n${opening}\n${base.slice(at).trimStart()}`
}

/** 仅忽略排版空白，台词文字和标点均不允许擅改。 */
function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, '')
}

function splitShots(text: string, pattern: RegExp): string[] {
  const markers = Array.from(text.matchAll(pattern))
  return markers.length
    ? markers.map((marker, index) => text.slice((marker.index ?? 0) + marker[0].length, markers[index + 1]?.index ?? text.length))
    : [text]
}

/** 读取规范 description 中的「角色名说：引号台词」及独占一行的旁白。 */
function sourceDialogue(text: string) {
  const pattern = /(?:^|(?<=[\n。！？；，,.!?;」”"』]))\s*(?:([^\n。！？；，,.!?;：:「」『』“”"<>]{1,60}?)(?:说|讲|道|\s+says|\s+said|が言う|は言う|\s+말한다)|((?:旁白|画外音|Narration|Voiceover)))[：:]\s*(?:「([^]*?)」|“([^]*?)”|"([^]*?)"|『([^]*?)』|([^\n]+))/gi
  return Array.from(text.matchAll(pattern)).map(match => ({
    speaker: (match[1] || match[2]).trim().replace(/(?:轻声|低声|小声|大声|柔声|急忙|平静地|轻轻地|缓缓地)$/, ''),
    text: (match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7]).trim(),
    narration: Boolean(match[2]),
  }))
}

function promptDialogue(text: string) {
  let previousEnd = 0
  return Array.from(text.matchAll(/<d>\s*\[([^\]]+)\]\s*([^]*?)<\/d>/gi)).map(match => {
    const prefix = text.slice(previousEnd, match.index)
    previousEnd = (match.index ?? 0) + match[0].length
    const ids = Array.from(prefix.matchAll(/\(S(\d+)\)/g))
    const id = ids.at(-1)
    const beforeId = id ? prefix.slice(0, id.index) : prefix
    const subjects = Array.from(beforeId.matchAll(/<Subject\s+(\d+)>/gi))
    const afterId = id ? prefix.slice((id.index ?? 0) + id[0].length) : ''
    const interveningSubject = /<Subject\s+\d+>/i.test(afterId)
    return { text: match[2].trim(), prefix, id: interveningSubject ? undefined : id?.[1], subject: subjects.at(-1)?.[1] }
  })
}

/** 检查台词边界和声音节，禁止把写作要求混入模型的声音内容。 */
export function validateVideoPromptContent(prompt: string): void {
  const normalized = normalizeVideoPromptSections(prompt)
  const headings = sectionHeadings(normalized)
  if (!isOfficialStructure(normalized, headings)) return
  const { bodyStart, end } = detailBodyRange(normalized, headings)
  const detail = normalized.slice(bodyStart, end)
  const dialogueCount = (normalized.match(/<d>/gi) || []).length
  if (dialogueCount !== promptDialogue(detail).length || dialogueCount !== (normalized.match(/<\/d>/gi) || []).length) {
    throw new Error('对白必须只在 detailed_description 中使用完整的 <d>[语言] 原句</d> 标签')
  }
  const sound = normalized.slice(end)
  if (/\(S\d+\)|本段无对白|闭口不出声|只有.{0,40}(?:出声|发声)|不要(?:说话|配音|字幕)|无字幕|no (?:dialogue|speech|human voices|subtitles)|do not (?:speak|talk)|only.{0,40}(?:speaks|vocalizes)/i.test(sound)) {
    throw new Error('声音节只描述环境声、物理声与配乐，不写说话白名单、字幕或禁止发声等元指令')
  }
  const body = normalized.replace(/<d>[^]*?<\/d>/gi, '')
  if (/不要说话|禁止说话|不要复述提示词|无字幕|no (?:on-screen text|subtitles|watermark)|do not (?:speak|read the prompt)/i.test(body)) {
    throw new Error('最终提示词不能包含禁止说话、无字幕等写作元指令；改写为实际可见或可听内容')
  }
}

/** 逐镜头、逐句核对完整台词、顺序和说话人；旧无结构文本仍由兼容入口处理。 */
export function validateVideoPromptAgainstDescription(prompt: string, description: string): void {
  const source = String(description || '')
  const normalized = normalizeVideoPromptSections(prompt)
  const headings = sectionHeadings(normalized)
  if (!isOfficialStructure(normalized, headings) || !source.trim()) return
  validateVideoPromptContent(normalized)
  const { bodyStart, end } = detailBodyRange(normalized, headings)
  const sourceShots = splitShots(source, /【镜头\s*\d+】/g)
  const targetShots = splitShots(normalized.slice(bodyStart, end), /\[Shot\s+\d+\]/gi)
  const hasSourceShots = /【镜头\s*\d+】/.test(source)
  if (hasSourceShots && sourceShots.length !== targetShots.length) {
    throw new Error(`description 有 ${sourceShots.length} 个【镜头N】，video_prompt 却只有 ${targetShots.length} 个 [Shot N]；镜头数必须一一对应，不能合并或新增`)
  }
  const definitions = normalized.slice(0, headings[1].index)
  const speakerNames = sourceShots.flatMap(shot => sourceDialogue(shot)).filter(line => !line.narration).map(line => line.speaker)
  const subjectNames = new Map<string, string[]>()
  for (const match of definitions.matchAll(/<Subject\s+(\d+)>[^\n]*/gi)) {
    const references = Array.from(match[0].matchAll(/@(?:图片\d+)?([^\s@#，。；,:;<>()[\]「」“”"]+)/g)).map(item => item[1].replace(/[.!?]+$/, ''))
    const names = references.length ? references : speakerNames.filter(name => match[0].includes(name))
    subjectNames.set(match[1], names)
  }
  const idOwners = new Map<string, string>()
  const actorIds = new Map<string, string>()
  const actorSubjects = new Map<string, string>()
  const subjectOwners = new Map<string, string>()
  const compare = (expected: ReturnType<typeof sourceDialogue>, actual: ReturnType<typeof promptDialogue>) => {
    if (expected.length !== actual.length) {
      throw new Error('description 的每句台词或旁白必须用 <d>[语言] 原句</d> 完整保留一次，不能省略、重复或新增')
    }
    for (let index = 0; index < expected.length; index++) {
      const line = expected[index]
      const spoken = actual[index]
      if (normalizeForCompare(line.text) !== normalizeForCompare(spoken.text)) {
        throw new Error(`video_prompt 台词「${spoken.text.slice(0, 40)}」与 description 不在同一原文顺序或被改写；必须逐字完整保留`)
      }
      if (!spoken.id) throw new Error(`台词「${line.text.slice(0, 30)}」缺少明确的说话人 (Sx)`)
      const names = spoken.subject ? subjectNames.get(spoken.subject) || [] : []
      if (!line.narration && (spoken.subject ? !names.includes(line.speaker) : !spoken.prefix.includes(line.speaker))) {
        throw new Error(`台词「${line.text.slice(0, 30)}」的说话人应为 ${line.speaker}，不能挂到其他主体名下`)
      }
      const owner = line.speaker
      if ((idOwners.has(spoken.id) && idOwners.get(spoken.id) !== owner) || (actorIds.has(owner) && actorIds.get(owner) !== spoken.id)) {
        throw new Error(`说话人 ${owner} 与 (S${spoken.id}) 的绑定发生变化，同一目标视频内必须稳定复用`)
      }
      if (spoken.subject) {
        if ((actorSubjects.has(owner) && actorSubjects.get(owner) !== spoken.subject)
          || (subjectOwners.has(spoken.subject) && subjectOwners.get(spoken.subject) !== owner)) {
          throw new Error(`说话人 ${owner} 的 <Subject ${spoken.subject}> 身份发生变化，不能混用主体`)
        }
        actorSubjects.set(owner, spoken.subject)
        subjectOwners.set(spoken.subject, owner)
      }
      idOwners.set(spoken.id, owner)
      actorIds.set(owner, spoken.id)
    }
  }
  if (hasSourceShots) sourceShots.forEach((shot, index) => compare(sourceDialogue(shot), promptDialogue(targetShots[index])))
  else compare(sourceDialogue(source), promptDialogue(normalized.slice(bodyStart, end)))
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
  validateVideoPromptContent(normalized)
  const { bodyStart, end } = detailBodyRange(normalized, headings)
  const shots = Array.from(normalized.slice(bodyStart, end).matchAll(/\[Shot\s+(\d+)\]([^\n]*)/gi))
  if (!shots.length) throw new Error('H3 提示词缺少 [Shot N] 镜头段，请重新生成提示词')
  if (shots.some((shot, index) => Number(shot[1]) !== index + 1)) {
    throw new Error('H3 镜头编号必须连续，请重新生成提示词')
  }

  // 兼容历史提示词：只有「全部镜头」都是 0.0-5.0秒 旧格式才按旧规则校验。
  // 中文正文里模型可能只在 [Shot 1] 开头补了段内时间段（如 0-3秒：抬头），
  // 若按 any 判定会把整篇误当成旧格式，官方格式的合法提示词会被误杀。
  if (shots.every(shot => LEGACY_RANGE.test(shot[2]))) {
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
