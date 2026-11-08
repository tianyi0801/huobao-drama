import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('视频引用规范使用资产名称，恢复默认从后端读取而非过时前端副本', () => {
  const agents = read('src/agents/index.ts')
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')
  const settings = read('../frontend/app/pages/settings.vue')
  for (const source of [agents, skill]) {
    assert.match(source, /@场景名/)
    assert.match(source, /@角色名/)
    assert.match(source, /系统.{0,60}编号[\s\S]*@图片N名字|@小明.*@图片\d+小明/)
    assert.doesNotMatch(source, /<location>|<role>/)
  }
  assert.match(settings, /await promptAPI\.reset\(type, editLang\.value\)/)
  assert.match(settings, /await promptAPI\.get\(type, editLang\.value\)/)
})

test('单条和批量重写入口按 Ref2VA 六节生成并复制资源引用', () => {
  const frontend = read('../frontend/app/views/drama/episode.vue')
  const start = frontend.indexOf('async function genVideoPrompt(sb) {')
  const end = frontend.indexOf('toast.success(', start)
  assert.ok(start >= 0 && end > start)
  for (const source of [frontend.slice(start, end), read('src/services/video-prompts.ts')]) {
    // 入口读取事实并引用已注入技能，不重复整份视频格式契约。
    assert.match(source, /video-prompt/)
    assert.match(source, /六节.*英文|英文.*六节/)
    assert.match(source, /description/)
    assert.match(source, /duration/)
    assert.match(source, /available_image_references/)
    assert.match(source, /image_reference/)
    assert.match(source, /available_voice_references/)
    assert.match(source, /storyboard_id/)
    assert.match(source, /video_prompt/)
    assert.match(source, /原句|源台词|源对白/)
    assert.match(source, /不新增/)
    assert.doesNotMatch(source, /reference_usage|正文一律用简体中文/)
    assert.match(source, /@角色的?名|@角色名/)
  }
})

test('中文生产模板、技能、默认及批量消息不再强制短视频多切镜或400字上限', () => {
  for (const file of [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/prompts/prompt_generator.md',
    'workspace/skills/storyboard-breaker/SKILL.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
    'src/services/video-prompts.ts',
  ]) {
    const source = read(file)
    assert.doesNotMatch(source, /≤\s*5\s*秒.{0,6}(?:写\s*)?2\s*个/)
    assert.doesNotMatch(source, /内部承载.{0,4}2-3\s*个子镜头/)
    assert.doesNotMatch(source, /控制在\s*400\s*字以内/)
    assert.match(source, /video-prompt/)
    // 六节名只要求权威视频技能和运行时兜底完整，其他层引用技能即可。
    if (['workspace/skills/prompt-generator/video-prompt/SKILL.md', 'src/agents/index.ts', 'src/agents/local-contract.ts'].includes(file)) {
      for (const section of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
        assert.ok(source.includes(section), `${file}: ${section}`)
      }
    }
  }
})

test('视频提示词使用英文六节并逐句保留源对白，新分段策略不改已有多话者', () => {
  const zhFiles = [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/prompts/prompt_generator.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'workspace/skills/storyboard-breaker/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
    'src/services/video-prompts.ts',
  ]
  for (const file of zhFiles) {
    const text = read(file)
    assert.match(text, /英文/, file)
    assert.match(text, /video-prompt/, file)
    assert.match(text, /description/, file)
    assert.match(text, /原句|原文|源台词/, file)
    assert.doesNotMatch(text, /正文一律用简体中文|一个 Shot 只允许一个说话人 ID/, file)
  }
  // 模板的说明语言可不同，视频正文仍以英文六节技能为权威。
  for (const language of ['en', 'ja', 'ko']) {
    for (const file of [
      `workspace/prompts/storyboard_breaker.${language}.md`,
      `workspace/prompts/prompt_generator.${language}.md`,
      `workspace/skills/storyboard-breaker/SKILL.${language}.md`,
    ]) {
      const text = read(file)
      assert.match(text, /English|英語|영어/, file)
      assert.match(text, /video-prompt/, file)
      if (file.includes('/prompts/')) assert.match(text, /says/, file)
      else assert.match(text, /Subject\/Sx/, file)
      assert.doesNotMatch(text, /with a Simplified Chinese body|本文はすべて簡体字中国語|본문은 모두 간체 중국어/, file)
    }
  }
  // 新分段的单主要话者策略不是官方每Shot人数硬禁；重写保留已有多话者。
  for (const file of [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/skills/storyboard-breaker/SKILL.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
  ]) {
    const text = read(file)
    assert.match(text, /(?:每.{0,12}片段|片段.{0,12}优先).{0,12}一个主要说话人/, file)
    assert.match(text, /换人.{0,12}新片段/, file)
    assert.match(text, /不是官方/, file)
    assert.match(text, /已有.{0,8}(?:多|多个)(?:说话人|话者)/, file)
  }
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')
  assert.match(skill, /<Subject 1> \(S1\) says, <d>\[Chinese\]/)
  assert.match(skill, /says in an off-screen voiceover/)
  for (const file of ['workspace/skills/prompt-generator/video-prompt/SKILL.md', 'src/agents/local-contract.ts', 'src/agents/index.ts', 'src/agents/voice-reference-instructions.ts']) {
    const text = read(file)
    assert.match(text, /\[Shot (?:1|N)\]/, file)
    assert.doesNotMatch(text, /\[Shot(?:\d+|N)\]/, file)
  }
  assert.match(skill, /声音节|overall_soundscape/)
  assert.match(skill, /不.{0,10}(?:列|写).{0,10}(?:说话白名单|白名单|否定要求)/)
  assert.match(skill, /不.{0,30}(?:因果规划|质量要求).{0,30}正文/)
  // 示例中的最终声音节必须是实际声音描写，不包含许可、绑定或质量元指令。
  const soundExamples = [...skill.matchAll(/```text\n[\s\S]*?```/g)]
    .map(([example]) => example.match(/overall_soundscape:\n([\s\S]*?)\n\s*non_diegetic_music:/)?.[1])
    .filter(Boolean)
  assert.ok(soundExamples.length >= 2)
  for (const sound of soundExamples) {
    assert.doesNotMatch(sound, /<d>|#|\(S\d+\)|allowed to speak|no dialogue|no subtitles|must|only|4K|白名单/i)
    assert.match(sound, /[A-Za-z]/)
  }
})

test('分镜模板和所有入口按内容确定时长，支持多子镜头且保留原切镜', () => {
  for (const file of [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/prompts/prompt_generator.md',
    'workspace/skills/storyboard-breaker/SKILL.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
    'src/services/video-prompts.ts',
  ]) {
    const text = read(file)
    if (file !== 'src/services/video-prompts.ts') assert.match(text, /4[-—]12/)
    // 新拆分按实际内容分配4—12整数秒；重写保留原有时长与全部镜头。
    assert.doesNotMatch(text, /4[-—]8|超过\s*8\s*秒|8秒段落上限|目标\s*5\s*秒|5秒优先/)
    assert.match(text, /duration/)
    assert.match(text, /镜头数|镜头数量/)
    assert.match(text, /保留/)
    assert.match(text, /video-prompt/)
  }
})

test('三语言模板和技能统一 Ref2VA 基线且不残留旧 4-8 秒与总量硬指标', () => {
  for (const language of ['en', 'ja', 'ko']) {
    // 时长基线写在分镜模板与技能里；prompt_generator 只引用分镜已有 duration
    for (const file of [
      `workspace/prompts/storyboard_breaker.${language}.md`,
      `workspace/skills/storyboard-breaker/SKILL.${language}.md`,
    ]) {
      const text = read(file)
      assert.match(text, /4[-〜]12/)
      // 多语言说明保持内容驱动时长与单主要话者经验策略，不恢复旧配额。
      assert.match(text, /main speaker|主要話者|주요 화자/)
      assert.doesNotMatch(text, /4[-〜]8|2-3 equal|2〜3等分|2-3등분|with ±20% tolerance|±20%の変動を許容|target\s*:?\s*5\s*s|5-second-first/)
    }
    assert.doesNotMatch(read(`workspace/prompts/prompt_generator.${language}.md`), /4[-〜]8|2-3 equal|2〜3等分|2-3등분/)
  }
})

const source = read('../frontend/app/views/drama/episode.vue')
test('时长输入与保存允许12秒，超过12秒截断且保留原最小值', () => {
  assert.match(source, /max="12"\s+class="input video-duration-input"/)
  const start = source.indexOf('function onVideoDurationChange(e) {')
  const end = source.indexOf('function pickFile(', start)
  assert.ok(start >= 0 && end > start)
  for (const [input, expected] of [[8, 8], [12, 12], [15, 12], [1, 2], ['无效', 5]]) {
    const event = { target: { value: input } }
    const fieldDrafts = {}
    let saved
    runInNewContext(`${source.slice(start, end)}\nonVideoDurationChange(event)`, {
      event,
      fieldDrafts,
      draftKey: (sb, field) => `${sb?.id}:${field}`,
      selectedSb: { value: { id: 1, duration: 5 } },
      updateField: (_shot, field, value) => { saved = { field, value } },
    })
    assert.equal(event.target.value, expected)
    assert.equal(fieldDrafts['1:duration'], expected)
    assert.deepEqual(saved, { field: 'duration', value: expected })
  }
  for (const language of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`../frontend/app/locales/${language}.json`))
    assert.match(messages.episode.inspector.durationUnit, /2-12/)
  }
})

const start = source.indexOf('function getShotReferenceIndexMap(sb) {')
const end = source.indexOf('// 分镜时长', start)
assert.ok(start >= 0 && end > start)
const referenceFunctions = source.slice(start, end)
const resolve = (sb, limit = 9) => runInNewContext(`${referenceFunctions}\nresolveVideoPromptRefs(sb)`, {
  sb,
  refImageLimit: { value: limit },
  getStoryboardScene: (shot) => shot.scene,
  getStoryboardCharacters: (shot) => shot.characters || [],
  getStoryboardProps: (shot) => shot.props || [],
  t: (key, values) => `${key}: ${values.reference}`,
})

test('双人分镜按场景、主角、配角的实际顺序解析每个身份参考', () => {
  const sb = {
    scene: { location: '咖啡馆', image_url: 'scene.png' },
    characters: [{ name: '小明', image_url: 'a.png' }, { name: '小红', image_url: 'b.png' }],
    video_prompt: '@咖啡馆：@小明在左，@小红在右，两人均清晰。',
  }
  assert.equal(resolve(sb), '@图片1咖啡馆：@图片2小明在左，@图片3小红在右，两人均清晰。')
})

test('缺图、重复和超限配角不可静默丢失，长名字不可误匹配为短名字', () => {
  for (const [characters, limit] of [
    [[{ name: '小明', image_url: 'a.png' }, { name: '小明老师' }], 9],
    [[{ name: '小明', image_url: 'a.png' }, { name: '小明老师', image_url: 'a.png' }], 9],
    [[{ name: '小明', image_url: 'a.png' }, { name: '小明老师', image_url: 'b.png' }], 1],
  ]) {
    assert.throws(() => resolve({ characters, video_prompt: '@小明老师点头。' }, limit), /missingReference: 小明老师/)
  }
  assert.throws(() => resolve({ video_prompt: '@未绑定人物点头。' }), /missingReference/)
  assert.throws(() => resolve({ characters: [{ name: '同名', image_url: 'a.png' }, { name: '同名', image_url: 'b.png' }], video_prompt: '@同名点头。' }), /missingReference/)
  assert.equal(resolve({ video_prompt: '固定机位，无人物。' }), '固定机位，无人物。')
})
