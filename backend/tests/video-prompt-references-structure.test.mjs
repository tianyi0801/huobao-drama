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
    assert.match(source, /说话白名单/)
    assert.match(source, /无任何人声/)
  }
})

test('分镜提示词与技能统一12秒上限，保留默认5秒且不残留8秒上限', () => {
  for (const file of [
    'workspace/prompts/storyboard_breaker.md',
    'workspace/prompts/prompt_generator.md',
    'workspace/skills/storyboard-breaker/SKILL.md',
    'workspace/skills/prompt-generator/video-prompt/SKILL.md',
    'src/agents/index.ts',
    'src/agents/local-contract.ts',
  ]) {
    const text = read(file)
    assert.match(text, /4[-—]12/)
    assert.match(text, /(?:目标|优先)\s*5\s*秒/)
    assert.doesNotMatch(text, /4[-—]8|超过\s*8\s*秒|8秒段落上限/)
  }
})

test('三语言拆分模板与技能不残留旧时长、等分切镜及总量硬指标', () => {
  for (const language of ['en', 'ja', 'ko']) {
    for (const file of [`workspace/prompts/storyboard_breaker.${language}.md`, `workspace/skills/storyboard-breaker/SKILL.${language}.md`]) {
      const text = read(file)
      assert.match(text, /4[-〜]12/)
      assert.doesNotMatch(text, /4[-〜]8|2-3 equal|2〜3等分|2-3등분|with ±20% tolerance|±20%の変動を許容/)
    }
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
