export const H3_SECTIONS = ['subject_definitions', 'shot_summary', 'reference_usage', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const

type H3Section = typeof H3_SECTIONS[number]

function sectionHeadings(prompt: string) {
  return Array.from(prompt.matchAll(new RegExp(`^(${H3_SECTIONS.join('|')})[\\t ]*[:：][\\t ]*`, 'gm')))
}

export function appendVideoPromptSection(prompt: string, section: H3Section, text: string, legacyPrefix = false): string {
  const headings = sectionHeadings(prompt)
  const valid = headings.length === H3_SECTIONS.length && headings.every((match, index) => match[1] === H3_SECTIONS[index])
  if (!valid) return legacyPrefix ? `${text}，\n${prompt}` : `${prompt}\n${text}`
  const index = H3_SECTIONS.indexOf(section)
  const end = headings[index + 1]?.index ?? prompt.length
  return `${prompt.slice(0, end).trimEnd()}\n${text.trim()}\n${prompt.slice(end)}`.trimEnd()
}

export interface VideoPromptImageReference {
  name: string
  image_reference: string
  usage: 'identity_reference' | 'scene_reference' | 'object_reference'
}

/** 有图素材必须以明确的资源引用进入 H3 提示词，历史纯文本仍兼容。 */
export function validateVideoPromptImageReferences(prompt: string, references: VideoPromptImageReference[], description = ''): void {
  const headings = sectionHeadings(prompt)
  if (!headings.length || !references.length) return
  const section = (name: H3Section) => {
    const index = headings.findIndex(heading => heading[1] === name)
    if (index < 0) return ''
    return prompt.slice(headings[index].index! + headings[index][0].length, headings[index + 1]?.index ?? prompt.length)
  }
  const subjects = section('subject_definitions')
  const detail = section('detailed_description')
  const usage = section('reference_usage')
  const ordered = [...references].sort((a, b) => b.name.length - a.name.length)
  const mentions = (body: string) => new Set(Array.from(body.matchAll(/@([^\s@#]+)/g), match =>
    ordered.find(reference => match[1].startsWith(reference.name))?.image_reference,
  ).filter(Boolean))
  const usageMentions = mentions(usage)
  const subjectMentions = mentions(subjects)
  const detailMentions = mentions(detail)
  const namePattern = new RegExp(ordered.map(reference => reference.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const namesIn = (body: string) => new Set(body.match(namePattern) || [])
  const subjectNames = namesIn(subjects)
  const detailNames = namesIn(detail)
  const usedNames = namesIn(`${subjects}\n${detail}\n${description}`)
  const required = references.filter(reference => reference.usage === 'scene_reference' || usedNames.has(reference.name))
  const missing = required.filter(reference => !usageMentions.has(reference.image_reference)
    || (reference.usage === 'identity_reference' && subjectNames.has(reference.name) && !subjectMentions.has(reference.image_reference))
    || (reference.usage !== 'scene_reference' && detailNames.has(reference.name) && !detailMentions.has(reference.image_reference)))
  if (missing.length || !usageMentions.size) {
    const names = (missing.length ? missing : references).map(reference => reference.image_reference).join('、')
    throw new Error(`H3 视频提示词缺少资源引用：${names}。请在 reference_usage 逐项写明 @资源名及用途；有图人物在 subject_definitions 和画面动作中也使用精确 @名称，不用普通姓名或“角色参考图”等泛称，不手写图片编号。`)
  }
}

/** 兼容历史纯文本提示词；已采用六节结构的提示词必须有正确的时间轴。 */
export function validateVideoPromptTimeline(prompt: string, duration: number): void {
  const headings = sectionHeadings(prompt)
  if (!headings.length) return
  if (headings.length !== H3_SECTIONS.length || headings.some((match, index) => match[1] !== H3_SECTIONS[index])) {
    throw new Error('H3 视频提示词必须包含顺序固定且不重复的六节，请重新生成提示词')
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长必须为正数')
  const detail = headings[3]
  const body = prompt.slice(detail.index! + detail[0].length, headings[4].index)
  const shots = Array.from(body.matchAll(/\[Shot\s+(\d+)\]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～]\s*(\d+(?:\.\d+)?)/gi))
  const labels = body.match(/\[Shot\s+\d+\]/gi) || []
  if (!shots.length || labels.length !== shots.length) throw new Error('H3 提示词缺少有效的 [Shot N] 起止时间，请重新生成提示词')
  let end = 0
  for (const [index, shot] of shots.entries()) {
    const start = Number(shot[2])
    const nextEnd = Number(shot[3])
    if (Number(shot[1]) !== index + 1 || Math.abs(start - end) > 0.01 || nextEnd <= start) {
      throw new Error('H3 镜头编号必须连续，时间轴从0开始且无重叠或空缺，请重新生成提示词')
    }
    end = nextEnd
  }
  if (Math.abs(end - duration) > 0.01) {
    throw new Error(`H3 提示词时间轴为${end}秒，与分镜时长${duration}秒不符；修改时长后请重新生成视频提示词`)
  }
}
