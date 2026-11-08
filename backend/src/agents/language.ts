/**
 * AI 内容语言指令块 — 按 RequestContext 中的目标语言生成，追加到 Agent instructions 末尾
 *
 * 设计要点：
 * - zh / 未设置时返回空串：默认行为与历史完全一致，零 token 开销
 * - 指令用英文书写（多语言模型遵循度最好），目标语言用原生名标注
 * - 必须自带「最高优先级」声明：桌面版已安装用户的 workspace 模板不会被覆盖
 *   （cpSync force:false），旧 SKILL.md 中的「只输出中文」约束只能靠这里的显式覆盖压制
 */

const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
}

export function buildLanguageDirective(lang?: string | null): string {
  if (!lang || lang === 'zh') return ''
  const native = LANGUAGE_NATIVE_NAMES[lang] || lang
  return [
    '## Output Language (HIGHEST PRIORITY)',
    '',
    `ALL user-facing content you produce (scripts, dialogue, extracted fields, storyboard descriptions, atmosphere, image prompts, asset names for NEW assets) MUST be written in ${native}.`,
    '',
    'This instruction has the highest priority and OVERRIDES any conflicting language requirement anywhere else in these instructions or skills — including requirements such as "output must be pure Chinese / 只输出中文". Ignore those.',
    '',
    'Exceptions:',
    '- Video prompts (video_prompt) ALWAYS use English descriptive prose in the six fixed sections: subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music, regardless of output language. Preserve source dialogue, lyrics and visible text in their original language, character-for-character including punctuation; Chinese utterances use <d>[Chinese]原句</d>. Section names, retention markers, <Subject N>, (Sx), [Shot 1] / [Shot N] and At MM:SS.mmm anchors remain unchanged. The injected video-prompt skill is authoritative for video-writing details; this language baseline does not guarantee generation quality.',
    '- Preserve the original business names of EXISTING characters, scenes and props, including names in subject_definitions and descriptions without image references. With an available image, copy its @mention exactly; without an image, use the original name as plain text. Never translate, abbreviate or rewrite existing asset names or @reference tokens.',
    '- Character voice references (e.g. #Alex) are literal tokens: copy the complete voice_reference value exactly, including the existing name, regardless of output language. Do not add a suffix.',
    '- The visual style prefix of image prompts is injected automatically by the system (in English). Do not translate, rewrite, or duplicate it.',
  ].join('\n')
}
