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
    assert.match(source, /@小明.*@图片\d+小明/)
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
    // 官方六节：summary / retention_analysis 取代旧 shot_summary / reference_usage
    assert.match(source, /subject_definitions/)
    assert.match(source, /retention_analysis/)
    assert.match(source, /non_diegetic_music/)
    assert.match(source, /available_image_references/)
    assert.match(source, /image_reference/)
    assert.doesNotMatch(source, /reference_usage/)
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
    assert.match(source, /retention_analysis/)
    assert.match(source, /non_diegetic_music/)
  }
})

test('视频提示词正文统一为中文，结构锚点保持英文，防串台词规则各入口一致', () => {
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
    assert.doesNotMatch(text, /正文一律英文|正文用英文|正文英文/, file)
    assert.match(text, /简体中文|中文正文|用中文/, file)
  }
  // 多语言模板同样固定中文正文，只是表述语言不同
  for (const language of ['en', 'ja', 'ko']) {
    for (const file of [
      `workspace/prompts/storyboard_breaker.${language}.md`,
      `workspace/prompts/prompt_generator.${language}.md`,
      `workspace/skills/storyboard-breaker/SKILL.${language}.md`,
    ]) {
      const text = read(file)
      assert.doesNotMatch(text, /written in English|本文はすべて英語|본문은 영어/, file)
      assert.match(text, /Simplified Chinese|簡体字中国語|간체 중국어/, file)
    }
  }
  // 单 Shot 单说话人 + 元指令禁令必须写进所有强制入口
  for (const file of [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
  ]) {
    const text = read(file)
    assert.match(text, /一个 Shot 只允许一个说话人 ID/, file)
    assert.match(text, /元指令/, file)
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
    // 新基线就是「4-12 秒、目标 5 秒、默认 1 个连续镜头、最多 2 个子镜头」，不再按旧 4-8 秒契约断言
    assert.doesNotMatch(text, /4[-—]8|超过\s*8\s*秒|8秒段落上限/)
    // 所有入口统一到 Ref2VA 六节（反打/切镜配额属旧 4-8 秒契约，已由新基线取代）
    assert.match(text, /retention_analysis/)
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
      // 新基线明确「目标 5 秒、默认 1 个连续镜头、最多 2 个各 ≥2 秒」，只禁止旧 4-8 秒与总量硬指标
      assert.doesNotMatch(text, /4[-〜]8|2-3 equal|2〜3等分|2-3등분|with ±20% tolerance|±20%の変動を許容/)
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
    let saved
    runInNewContext(`${source.slice(start, end)}\nonVideoDurationChange(event)`, {
      event,
      selectedSb: { value: { duration: 5 } },
      updateField: (_shot, field, value) => { saved = { field, value } },
    })
    assert.equal(event.target.value, expected)
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
