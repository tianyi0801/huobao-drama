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
