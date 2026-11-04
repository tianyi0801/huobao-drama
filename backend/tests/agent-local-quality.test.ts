import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { appendVideoPromptSection, validateVideoPromptImageReferences, validateVideoPromptTimeline } from '../src/services/video-prompt-structure.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-local-quality-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.resolve(import.meta.dirname, '../workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { registerAgentTools, assertAgentSaved } = await import('../src/agents/execution.js')
const { storyboardTools, updateVideoPrompt } = await import('../src/agents/tools/storyboard-tools.js')
const { imagePromptTools } = await import('../src/agents/tools/image-prompt-tools.js')
const { extractTools } = await import('../src/agents/tools/extract-tools.js')
const { normalizeVideoReferenceUrls, generateVideo } = await import('../src/services/generation.js')
const { resolvePreviousShotFrame } = await import('../src/services/storyboard-continuity.js')
const { saveComfyConfig } = await import('../src/services/comfyui/config.js')
const { buildTemplateFromPreset } = await import('../src/services/comfyui/presets.js')
const ts = new Date().toISOString()
const times = { createdAt: ts, updatedAt: ts }
const drama = db.insert(schema.dramas).values({ title: '本地质量回归', ...times }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: '测试集', ...times }).returning().get()
const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id })
const prompt = (timeline = '[Shot 1] 0.0-5.0秒：固定窗边中景。') => [
  'subject_definitions: N/A', 'shot_summary: 窗边雨景', 'reference_usage: N/A',
  `detailed_description:\n${timeline}`, 'overall_soundscape: 无任何人声，仅雨声。', 'non_diegetic_music: 无背景配乐、无歌声。',
].join('\n')
const call = (tool: any, input: any, requestContext = rc) => tool.execute(input, { requestContext })
const makeShot = (number: number, fields: any = {}) => db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: number, description: '窗边雨景', videoPrompt: prompt(), duration: 5, ...times, ...fields,
}).returning().get()
const a = makeShot(1)
const b = makeShot(2)

test('六节风格与衔接注入保持声音节干净，时间轴不受影响', () => {
  let text = appendVideoPromptSection(prompt(), 'detailed_description', '柔和写实色彩')
  text = appendVideoPromptSection(text, 'reference_usage', 'continuity_reference: @图片1为上一镜头尾帧')
  assert.ok(text.startsWith('subject_definitions:'))
  assert.ok(text.indexOf('continuity_reference:') < text.indexOf('detailed_description:'))
  assert.ok(text.indexOf('柔和写实色彩') < text.indexOf('overall_soundscape:'))
  assert.ok(!text.slice(text.indexOf('non_diegetic_music:')).includes('尾帧'))
  assert.doesNotThrow(() => validateVideoPromptTimeline(text, 5))
  assert.equal(appendVideoPromptSection('历史纯文本', 'detailed_description', '风格', true), '风格，\n历史纯文本')
})

test('专业多子镜头示例保持非等分时间轴、原句单次发声与声音边界', async () => {
  const skill = await fs.readFile(new URL('../workspace/skills/prompt-generator/video-prompt/SKILL.md', import.meta.url), 'utf8')
  const example = skill.match(/```\n(subject_definitions:[\s\S]*?)\n```/)?.[1]
  assert.ok(example)
  assert.doesNotThrow(() => validateVideoPromptTimeline(example, 8))
  assert.equal([...example.matchAll(/\[Shot \d+\]/g)].length, 4)
  assert.match(example, /4\.5-5\.5秒/)
  assert.equal(example.split('你终于来了。').length - 1, 1)
  assert.doesNotMatch(example.split('overall_soundscape:')[1], /你终于来了/)
  assert.match(example, /说话白名单/)
})

test('图片引用区分人物与音色，兼容无图和未出镜资源，重名按最长名称匹配', () => {
  const references = [
    { name: '林墨家客厅', image_reference: '@林墨家客厅', usage: 'scene_reference' as const },
    { name: '林墨', image_reference: '@林墨', usage: 'identity_reference' as const },
    { name: '林墨老师', image_reference: '@林墨老师', usage: 'identity_reference' as const },
  ]
  const emptyScene = prompt('[Shot 1] 0-5秒：@林墨家客厅空镜。').replace('reference_usage: N/A', 'reference_usage: @林墨家客厅: scene_reference')
  assert.doesNotThrow(() => validateVideoPromptImageReferences(emptyScene, references))
  assert.doesNotThrow(() => validateVideoPromptImageReferences(prompt(), []))
  assert.doesNotThrow(() => validateVideoPromptImageReferences('历史纯文本', references))
  const teacher = emptyScene.replace('subject_definitions: N/A', 'subject_definitions: <Subject 1> 是 @林墨老师：短发。')
    .replace('reference_usage: @林墨家客厅: scene_reference', 'reference_usage: @林墨家客厅: scene_reference；@林墨老师: identity_reference')
    .replace('客厅空镜', '客厅，@林墨老师坐下')
  assert.doesNotThrow(() => validateVideoPromptImageReferences(teacher, references))
  const missing = teacher.replace('<Subject 1> 是 @林墨老师', '<Subject 1> 是 林墨')
  assert.throws(() => validateVideoPromptImageReferences(missing, references), /缺少资源引用：@林墨。/)
  assert.throws(() => validateVideoPromptImageReferences(prompt().replace('reference_usage: N/A', 'reference_usage: #林墨'), references), /缺少资源引用/)
  assert.throws(() => validateVideoPromptImageReferences(prompt().replace('reference_usage: N/A', 'reference_usage: @图片1'), references), /缺少资源引用/)
})

test('时间轴拒绝时长不符、重叠、空缺、错号及重复小节，兼容历史纯文本', () => {
  assert.throws(() => validateVideoPromptTimeline(prompt(), 12), /修改时长后/)
  for (const timeline of ['[Shot 1] 0-3秒：雨。\n[Shot 2] 2-5秒：雨。', '[Shot 1] 1-5秒：雨。',
    '[Shot 2] 0-5秒：雨。', '[Shot 1] 0-2秒：雨。\n[Shot 2] 3-5秒：雨。', '[Shot 1] 没有时间']) {
    assert.throws(() => validateVideoPromptTimeline(prompt(timeline), 5), /时间|编号/)
  }
  assert.throws(() => validateVideoPromptTimeline(`${prompt()}\noverall_soundscape: 雨声`, 5), /六节/)
  assert.doesNotThrow(() => validateVideoPromptTimeline(prompt('[Shot 1] 0-2.5: 雨。\n[Shot 2] 2.5-5: 雨。'), 5))
  assert.doesNotThrow(() => validateVideoPromptTimeline('历史纯文本', 15))
})

test('提示词窄工具保护目标分镜与字段，保存回执不能用旧值冒充', async () => {
  const target = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id, targetStoryboardId: a.id })
  const tools = registerAgentTools({ updateVideoPrompt, ...imagePromptTools })
  assert.equal(updateVideoPrompt.inputSchema.safeParse({ storyboard_id: a.id, video_prompt: prompt(), duration: 12 }).success, false)
  assert.ok((await call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: prompt(), description: '错误覆盖' }, target)).error)
  assert.ok((await call(tools.update_storyboard, { storyboard_id: b.id, video_prompt: prompt() }, target)).error)
  assert.ok((await call(tools.save_character_final_prompt, { character_id: 1, prompt: '误调用' }, target)).error)
  assert.throws(() => assertAgentSaved('prompt_generator', {}, target), /没有成功/)
  await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: prompt('[Shot 1] 0-12秒：雨。') }, target), /时长/)
  const saved = await call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: prompt() }, target)
  assert.equal(saved.storyboard_id, a.id)
  assert.doesNotThrow(() => assertAgentSaved('prompt_generator', {}, target))
  const after = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, a.id)).get()!
  assert.equal(after.description, a.description)
  assert.equal(after.duration, a.duration)
  const incremental = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id })
  await call(registerAgentTools(storyboardTools).update_storyboard, { storyboard_id: b.id, atmosphere: '柔和' }, incremental)
  assert.doesNotThrow(() => assertAgentSaved('storyboard_breaker', {}, incremental))
})

test('新拆分与定向重写允许非五秒任务、四子镜头及短促反应而不改业务字段', async () => {
  for (const duration of [4, 6, 7, 8, 10, 12]) {
    assert.equal(storyboardTools.saveStoryboards.inputSchema.safeParse({ storyboards: [{ shot_number: 3, duration }] }).success, true)
  }
  const timeline = '[Shot 1] 0-1秒：窗边中景。\n[Shot 2] 1-3.5秒：雨滴特写。\n[Shot 3] 3.5-4.2秒：窗沿近景。\n[Shot 4] 4.2-7秒：回到窗边中景。'
  const description = '【镜头1】窗边中景。【镜头2】雨滴特写。【镜头3】窗沿近景。【镜头4】回到窗边中景。'
  const result = await call(storyboardTools.saveStoryboards, { storyboards: [{ shot_number: 3, duration: 7, description, video_prompt: prompt(timeline) }] })
  assert.equal(result.error, undefined)
  const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all().find(row => row.storyboardNumber === 3)!
  assert.ok(shot)
  assert.equal(shot.duration, 7)
  assert.equal(shot.videoPrompt, prompt(timeline))
  const target = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id, targetStoryboardId: shot.id })
  await call(updateVideoPrompt, { storyboard_id: shot.id, video_prompt: prompt(timeline) }, target)
  const updated = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(updated.description, description)
  assert.equal(updated.duration, 7)
  assert.equal(updated.videoPrompt, prompt(timeline))
})

test('衔接尾帧仅保持空间与动作逻辑，不锁死反打、景别及构图', async () => {
  const { buildContinuityPromptSuffix } = await import('../src/services/storyboard-continuity.js')
  const suffix = buildContinuityPromptSuffix(3)
  assert.match(suffix, /@图片3/)
  assert.match(suffix, /轴线和视线匹配/)
  assert.match(suffix, /允许反打、换景别、换机位与构图/)
  assert.doesNotMatch(suffix, /不要更换场景朝向或重置构图/)
})

test('目标分镜直接提供有图资源标记，遗漏引用不能保存或清空旧分镜', async () => {
  const ep = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 2, title: '素材引用', scriptContent: '林墨把钥匙放在桌上。', ...times }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '林墨', appearance: '短发', imageUrl: 'static/characters/lin.png', ...times }).returning().get()
  const noImage = db.insert(schema.characters).values({ dramaId: drama.id, name: '无图配角', ...times }).returning().get()
  const unrelated = db.insert(schema.characters).values({ dramaId: drama.id, name: '其他镜头人物', imageUrl: 'static/characters/other.png', ...times }).returning().get()
  const deleted = db.insert(schema.characters).values({ dramaId: drama.id, name: '已删除人物', imageUrl: 'static/characters/deleted.png', deletedAt: ts, ...times }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '林墨家客厅', time: '日', prompt: '窗在左侧', imageUrl: 'static/scenes/living.png', ...times }).returning().get()
  const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '钥匙', imageUrl: 'static/props/key.png', ...times }).returning().get()
  const unused = db.insert(schema.props).values({ dramaId: drama.id, name: '未出镜道具', imageUrl: 'static/props/unused.png', ...times }).returning().get()
  db.insert(schema.episodeCharacters).values({ episodeId: ep.id, characterId: noImage.id, createdAt: ts }).run()
  const shot = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 1, duration: 5, sceneId: scene.id,
    description: '【镜头1】林墨在客厅把钥匙放在桌上，无图配角点头。', videoPrompt: '已有提示词', ...times }).returning().get()
  for (const id of [character.id, noImage.id, deleted.id]) db.insert(schema.storyboardCharacters).values({ storyboardId: shot.id, characterId: id }).run()
  for (const id of [prop.id, unused.id]) db.insert(schema.storyboardProps).values({ storyboardId: shot.id, propId: id }).run()
  const sibling = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 2, duration: 5, ...times }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: sibling.id, characterId: unrelated.id }).run()
  const target = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id, targetStoryboardId: shot.id })
  const context = await call(storyboardTools.readStoryboardContext, {}, target)
  assert.equal(context.target_storyboard.id, shot.id)
  assert.deepEqual(context.existing_storyboards.map((sb: any) => sb.id), [shot.id])
  assert.equal(context.script, '')
  assert.deepEqual(context.characters.map((c: any) => c.name), ['林墨', '无图配角'])
  assert.equal(context.characters[0].image_reference, '@林墨')
  assert.equal(context.characters[1].image_reference, null)
  assert.deepEqual(context.target_storyboard.available_image_references.map((ref: any) => [ref.image_reference, ref.usage]), [
    ['@林墨家客厅', 'scene_reference'], ['@林墨', 'identity_reference'], ['@钥匙', 'object_reference'], ['@未出镜道具', 'object_reference'],
  ])
  assert.equal(context.target_storyboard.scenes[0].image_url, scene.imageUrl)
  assert.doesNotMatch(JSON.stringify(context), /其他镜头人物|已删除人物/)
  db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.characterId, deleted.id)).run()
  const bad = prompt('[Shot 1] 0-5秒：林墨在客厅把钥匙放在桌上，无图配角点头。')
    .replace('subject_definitions: N/A', 'subject_definitions: <Subject 1> 是 林墨：短发。')
    .replace('reference_usage: N/A', 'reference_usage: 角色参考图提供身份，场景参考图提供空间。')
  const good = bad.replace('<Subject 1> 是 林墨', '<Subject 1> 是 @林墨')
    .replace('reference_usage: 角色参考图提供身份，场景参考图提供空间。', 'reference_usage:\n@林墨家客厅: scene_reference\n<Subject 1>（@林墨）: identity_reference\n@钥匙: object_reference')
    .replace('0-5秒：林墨在客厅把钥匙', '0-5秒：@林墨在@林墨家客厅把@钥匙')
  const tools = registerAgentTools({ updateVideoPrompt })
  for (const invalid of [bad, bad.replace('林墨：短发', '#林墨：短发'), good.replace('@林墨家客厅: scene_reference', '场景参考图提供空间'),
    good.replace('<Subject 1> 是 @林墨', '<Subject 1> 是 林墨'), good.replace('0-5秒：@林墨', '0-5秒：林墨')]) {
    await assert.rejects(call(tools.update_storyboard, { storyboard_id: shot.id, video_prompt: invalid }, target), /资源引用|音色/)
    assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!.videoPrompt, '已有提示词')
    assert.throws(() => assertAgentSaved('prompt_generator', {}, target), /没有成功/)
  }
  await assert.rejects(call(storyboardTools.saveStoryboards, { replace_existing: true, storyboards: [{ shot_number: 1, duration: 5,
    scene_id: scene.id, character_ids: [character.id], prop_ids: [prop.id], video_prompt: bad }] }, buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id })), /缺少资源引用/)
  assert.ok(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sibling.id)).get())
  await call(tools.update_storyboard, { storyboard_id: shot.id, video_prompt: good }, target)
  assert.doesNotThrow(() => assertAgentSaved('prompt_generator', {}, target))
  const after = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(after.videoPrompt, good)
  assert.equal(after.description, shot.description)
  assert.equal(after.duration, shot.duration)
  const unavailable = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id, targetStoryboardId: a.id })
  assert.match((await call(storyboardTools.readStoryboardContext, {}, unavailable)).error, /不属于当前集/)
})

test('新拆分非法时长在清除旧分镜之前被拒绝', async () => {
  for (const duration of [3, 13, 5.5]) {
    assert.equal(storyboardTools.saveStoryboards.inputSchema.safeParse({ storyboards: [{ shot_number: 1, duration }] }).success, false)
    const result = await call(storyboardTools.saveStoryboards, { replace_existing: true, storyboards: [{ shot_number: 1, duration }] })
    assert.ok(result.error, '框架schema校验失败应返回错误回执')
  }
  assert.ok(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, a.id)).get())
})

test('重提三类资产只补空字段，不覆盖既有身份、不把背景故事当妆造', async () => {
  const char = db.insert(schema.characters).values({ name: '小明', dramaId: drama.id, appearance: '短发', styling: '蓝外套', finalPrompt: '已保存角色图提示词', ...times }).returning().get()
  const scene = db.insert(schema.scenes).values({ location: '书房', time: '日', dramaId: drama.id, prompt: '窗在左侧', lighting: '自然光', finalPrompt: '已保存场景图提示词', ...times }).returning().get()
  const prop = db.insert(schema.props).values({ name: '钥匙', dramaId: drama.id, description: '铜制', finalPrompt: '已保存道具图提示词', ...times }).returning().get()
  await call(extractTools.saveDedupCharacters, { characters: [{ name: '小明', appearance: '长发', styling: '红外套', description: '人物背景' }, { name: '小红', description: '人物背景' }] })
  await call(extractTools.saveDedupScenes, { scenes: [{ location: '书房', time: '日', prompt: '窗在右侧', lighting: '灯光' }] })
  await call(extractTools.saveDedupProps, { props: [{ name: '钥匙', description: '银制' }] })
  const after = db.select().from(schema.characters).where(eq(schema.characters.id, char.id)).get()!
  assert.equal(after.appearance, '短发'); assert.equal(after.styling, '蓝外套'); assert.equal(after.finalPrompt, char.finalPrompt)
  const added = db.select().from(schema.characters).all().find(row => row.name === '小红')!
  assert.equal(added.styling, '')
  assert.equal(db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id)).get()!.finalPrompt, scene.finalPrompt)
  assert.equal(db.select().from(schema.props).where(eq(schema.props.id, prop.id)).get()!.finalPrompt, prop.finalPrompt)
})

test('指定角色提取不能跨类型写入或读取场景道具', async () => {
  const scoped = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id, extractTarget: 'characters' })
  const tools = registerAgentTools(extractTools)
  assert.ok((await call(tools.save_dedup_props, { props: [{ name: '禁止新增物品' }] }, scoped)).error)
  assert.ok((await call(tools.read_existing_scenes, {}, scoped)).error)
  assert.equal(db.select().from(schema.props).all().some(row => row.name === '禁止新增物品'), false)
  await call(tools.save_dedup_characters, { characters: [] }, scoped)
  assert.doesNotThrow(() => assertAgentSaved('extractor', {}, scoped))
})

test('资产最终提示词拒绝跨项目及已删除资产保存', async () => {
  const other = db.insert(schema.dramas).values({ title: '其他项目', ...times }).returning().get()
  for (const [table, tool, key, fields] of [
    [schema.characters, imagePromptTools.saveCharacterFinalPrompt, 'character_id', { name: '其他角色' }],
    [schema.scenes, imagePromptTools.saveSceneFinalPrompt, 'scene_id', { location: '其他场景', time: '日', prompt: '无人物场景' }],
    [schema.props, imagePromptTools.savePropFinalPrompt, 'prop_id', { name: '其他道具' }],
  ] as const) {
    for (const deleted of [false, true]) {
      const row = db.insert(table as any).values({ ...fields, dramaId: deleted ? drama.id : other.id, deletedAt: deleted ? ts : null, ...times }).returning().get() as any
      assert.ok((await call(tool, { [key]: row.id, prompt: '不能保存' })).error)
    }
  }
})

test('本地参考图归一化禁止缺图删项和重复去重，保持顺序', async () => {
  const image = 'data:image/png;base64,YQ=='
  const second = 'data:image/png;base64,Yg=='
  assert.deepEqual(await normalizeVideoReferenceUrls([image, second], true), [image, second])
  await assert.rejects(normalizeVideoReferenceUrls(['static/missing.png', image, second], true), /读取失败/)
  await assert.rejects(normalizeVideoReferenceUrls([image, '', second], true), /空项/)
  await assert.rejects(normalizeVideoReferenceUrls([image, image, second], true), /重复/)
})

test('镜头衔接等待前段完成后才取新尾帧，跨场景或失败不复用旧图', { timeout: 10_000 }, async () => {
  const scene = db.insert(schema.scenes).values({ location: '窗边', time: '日', prompt: '窗在左侧，无人物', dramaId: drama.id, ...times }).returning().get()
  const previous = makeShot(10, { sceneId: scene.id, videoUrl: 'static/videos/old.mp4' })
  const current = makeShot(11, { sceneId: scene.id })
  const before = db.insert(schema.sysTask).values({ type: 'video', storyboardId: previous.id, status: 'processing', ...times }).returning().get()
  await fs.mkdir(path.join(root, 'static/videos'), { recursive: true })
  await fs.writeFile(path.join(root, 'static/videos/new_lastframe.jpg'), Buffer.alloc(2048, 1))
  let submitted: any
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/upload/image') {
      res.end(JSON.stringify({ name: 'reference.png', subfolder: 'test', type: 'input' }))
    } else if (req.url === '/prompt') {
      submitted = JSON.parse(Buffer.concat(chunks).toString()).prompt
      res.writeHead(400).end('{"error":"离线测试完成"}')
    } else res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    saveComfyConfig({ enabled: true, url: `http://127.0.0.1:${(server.address() as any).port}`, video: buildTemplateFromPreset('minimax-h3-ref2va'), continuityReference: true })
    const id = await generateVideo({ storyboardId: current.id, dramaId: drama.id, prompt: prompt(), duration: 5 })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(submitted, undefined)
    db.update(schema.storyboards).set({ videoUrl: 'static/videos/new.mp4' }).where(eq(schema.storyboards.id, previous.id)).run()
    db.update(schema.sysTask).set({ status: 'completed' }).where(eq(schema.sysTask.id, before.id)).run()
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()?.status === 'processing') {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(submitted)
    const saved = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    assert.match(saved.params!, /new_lastframe/)
    assert.doesNotMatch(saved.params!, /old_lastframe/)
    assert.match(submitted['2'].inputs.prompt, /continuity_reference:.*@图片1/)
    assert.ok(submitted['2'].inputs.prompt.indexOf('continuity_reference:') < submitted['2'].inputs.prompt.indexOf('detailed_description:'))
    db.update(schema.sysTask).set({ status: 'failed' }).where(eq(schema.sysTask.id, before.id)).run()
    assert.equal(await resolvePreviousShotFrame(current.id), null)
    db.update(schema.sysTask).set({ status: 'completed' }).where(eq(schema.sysTask.id, before.id)).run()
    makeShot(12, { sceneId: null })
    const returnedScene = makeShot(13, { sceneId: scene.id })
    assert.equal(await resolvePreviousShotFrame(returnedScene.id), null)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test.after(async () => { db.$client.close(); await fs.rm(root, { recursive: true, force: true }) })
