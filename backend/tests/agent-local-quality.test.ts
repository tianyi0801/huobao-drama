import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { appendVideoPromptSection, injectStyleOpening, validateVideoPromptTimeline } from '../src/services/video-prompt-structure.js'

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
const { resolvePreviousShotFrame, buildContinuityPromptSuffix } = await import('../src/services/storyboard-continuity.js')
const { saveComfyConfig } = await import('../src/services/comfyui/config.js')
const { buildTemplateFromPreset } = await import('../src/services/comfyui/presets.js')
const ts = new Date().toISOString()
const times = { createdAt: ts, updatedAt: ts }
const drama = db.insert(schema.dramas).values({ title: '本地质量回归', ...times }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: '测试集', ...times }).returning().get()
const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id })
const prompt = (timeline = '[Shot 1] A fixed medium shot frames rain on the window.') => [
  'subject_definitions: N/A',
  'summary: [reference generation] The target video shows rain on a window in one continuous shot.',
  'retention_analysis: N/A',
  `detailed_description:\n${timeline}`,
  'overall_soundscape: Soft rain patters against the window throughout the shot.',
  'non_diegetic_music: N/A',
].join('\n')
const call = (tool: any, input: any, requestContext = rc) => tool.execute(input, { requestContext })
const makeShot = (number: number, fields: any = {}) => db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: number, description: '窗边雨景', videoPrompt: prompt(), duration: 5, ...times, ...fields,
}).returning().get()
const a = makeShot(1)
const b = makeShot(2)

test('官方六节的风格与衔接注入保持声音节干净，时间轴不受影响', () => {
  const style = 'high-quality 3D CG animation still, modern game-engine cinematic render, crisp detailed textures, volumetric lighting, avoid flat lighting, avoid anime line art'
  const styled = injectStyleOpening(prompt(), style)
  assert.ok(styled.startsWith('subject_definitions:'))
  assert.match(styled, /Visual style: 3D CG animation, modern game-engine cinematic render/)
  assert.ok(styled.indexOf('Visual style:') < styled.indexOf('[Shot 1]'))
  assert.doesNotMatch(styled, /avoid|high-quality|still|grade quality/)
  // 重复注入只保留一句风格句，历史中英文风格句也会被替换
  assert.equal(injectStyleOpening(styled, style).match(/Visual style:/g).length, 1)
  assert.doesNotMatch(injectStyleOpening(`The target video uses old style.\n${prompt()}`, style), /The target video uses/)
  assert.doesNotMatch(injectStyleOpening(prompt().replace('[Shot 1]', '画面风格：旧风格\n[Shot 1]'), style), /旧风格/)
  const text = appendVideoPromptSection(styled, 'retention_analysis', buildContinuityPromptSuffix(1).trim())
  assert.ok(text.indexOf('weak_reference') < text.indexOf('detailed_description:'))
  assert.ok(!text.slice(text.indexOf('overall_soundscape:')).includes('weak_reference'))
  assert.doesNotThrow(() => validateVideoPromptTimeline(text, 5))
  assert.equal(appendVideoPromptSection('历史纯文本', 'detailed_description', '风格', true), '风格，\n历史纯文本')
})

test('官方时间轴拒绝错误切镜与重复小节，兼容旧式起止秒及纯文本', () => {
  assert.doesNotThrow(() => validateVideoPromptTimeline(prompt(), 5))
  for (const timeline of [
    '[Shot 1] A fixed medium shot.\n[Shot 2] At 00:02.000, the shot cuts to a close-up.\n[Shot 3] At 00:01.000, the shot cuts back.',
    '[Shot 2] At 00:02.000, the shot cuts to a close-up.',
    '[Shot 1] At 00:01.000, the shot cuts to a close-up.',
    '[Shot 1] A fixed medium shot.\n[Shot 2] the shot cuts to a close-up.',
    '[Shot 1] A fixed medium shot.\n[Shot 2] At 00:06.000, the shot cuts away.',
  ]) {
    assert.throws(() => validateVideoPromptTimeline(prompt(timeline), 5), /时间|编号|切镜|时间戳/)
  }
  assert.throws(() => validateVideoPromptTimeline(`${prompt()}\noverall_soundscape: rain`, 5), /六节/)
  // 中文正文里模型可能在 [Shot 1] 开头补段内时间段，不能因此把整篇误判成旧格式
  assert.doesNotThrow(() => validateVideoPromptTimeline(prompt('[Shot 1] 0-3秒：小明抬头。\n[Shot 2] At 00:03.000, 镜头切至近景。'), 5))
  const legacy = ['subject_definitions: N/A', 'shot_summary: 窗边雨景', 'reference_usage: N/A',
    'detailed_description:\n[Shot 1] 0-2.5: 雨。\n[Shot 2] 2.5-5: 雨。', 'overall_soundscape: 雨声。', 'non_diegetic_music: N/A'].join('\n')
  assert.doesNotThrow(() => validateVideoPromptTimeline(legacy, 5))
  assert.throws(() => validateVideoPromptTimeline(legacy, 12), /修改时长后/)
  assert.doesNotThrow(() => validateVideoPromptTimeline('历史纯文本', 15))
})

test('视频提示词镜头数与description一一对应，台词必须逐字来自description', async () => {
  const target = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id, targetStoryboardId: a.id })
  const tools = registerAgentTools({ updateVideoPrompt })
  const description = '【镜头1】小明抬头看向门口。\n【镜头2】小明说：「你来了。」随后闭口。'
  db.update(schema.storyboards).set({ description, duration: 6 }).where(eq(schema.storyboards.id, a.id)).run()

  const oneShot = prompt('[Shot 1] 0.0-6.0秒：小明抬头看向门口。')
  await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: oneShot }, target), /镜头数必须一一对应/)

  const invented = prompt('[Shot 1] 0.0-3.0秒：小明抬头。\n[Shot 2] 3.0-6.0秒：小明说，<d>[Chinese] 你怎么现在才来。</d>')
  await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: invented }, target), /description.*改写/)

  const dropped = prompt('[Shot 1] 0.0-3.0秒：小明抬头。\n[Shot 2] 3.0-6.0秒：小明保持沉默。')
  await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: dropped }, target), /<d>.*不能省略/)

  const valid = prompt('[Shot 1] 0.0-3.0秒：小明抬头看向门口。\n[Shot 2] 3.0-6.0秒：小明(S1)说，<d>[Chinese] 你来了。</d>随后闭口。')
  const saved = await call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: valid }, target)
  assert.equal(saved.storyboard_id, a.id)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, a.id)).get()!.videoPrompt, valid)

  const noDialogue = '【镜头1】小明看向窗外。\n【镜头2】雨打在玻璃上。'
  db.update(schema.storyboards).set({ description: noDialogue, duration: 5 }).where(eq(schema.storyboards.id, a.id)).run()
  await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: prompt() }, target), /镜头数必须一一对应/)
  const twoSilentShots = prompt('[Shot 1] 0-2.5秒：小明看向窗外。\n[Shot 2] 2.5-5秒：雨打在玻璃上。')
  await call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: twoSilentShots }, target)
  // 还原共享夹具，避免影响后续用例
  db.update(schema.storyboards).set({ description: a.description, duration: a.duration, videoPrompt: a.videoPrompt })
    .where(eq(schema.storyboards.id, a.id)).run()
})

test('逐句台词拒绝漏句、截句、重复、错镜头、错主体与说话人串用', async () => {
  const target = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id, targetStoryboardId: a.id })
  const tools = registerAgentTools({ updateVideoPrompt })
  const description = '【镜头1】小明说：「钥匙在这里。」小红说：「给我吧。」\n【镜头2】小明说：「拿好了。」'
  db.update(schema.storyboards).set({ description, duration: 10 }).where(eq(schema.storyboards.id, a.id)).run()
  const first = '<Subject 1> (S1) says, <d>[Chinese] 钥匙在这里。</d>'
  const second = '<Subject 2> (S2) says, <d>[Chinese] 给我吧。</d>'
  const last = '<Subject 1> (S1) says, <d>[Chinese] 拿好了。</d>'
  const text = prompt(`[Shot 1] ${first} ${second}\n[Shot 2] At 00:06.000, ${last}`)
    .replace('subject_definitions: N/A', 'subject_definitions:\n<Subject 1> is @小明, a man in a blue jacket.\n<Subject 2> is @小红, a woman in a red coat.')
  try {
    await call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: text }, target)
    for (const bad of [
      text.replace(second, ''),
      text.replace('钥匙在这里。', '在这里。'),
      text.replace('钥匙在这里。', '钥匙在这里!'),
      text.replace(second, `${second} ${second}`),
      text.replace(first, second).replace(`${second} ${second}`, `${second} ${first}`),
      text.replace(second, second.replace('<Subject 2>', '<Subject 1>')),
      text.replace(second, second.replace('(S2)', '(S1)')),
      text.replace(last, last.replace('(S1)', '(S3)')),
      text.replace(first, first.replace('(S1)', '')),
      text.replace(first, '<Subject 1> (S1) listens. <Subject 2> says, <d>[Chinese] 钥匙在这里。</d>'),
      text.replace(`${first} ${second}`, `${first} ${last}`).replace(`00:06.000, ${last}`, `00:06.000, ${second}`),
    ]) await assert.rejects(call(tools.update_storyboard, { storyboard_id: a.id, video_prompt: bad }, target), /台词|说话人/)
    assert.throws(() => validateVideoPromptTimeline(text.replace('non_diegetic_music: N/A', 'non_diegetic_music: 只有 (S1) 出声。'), 10), /声音节/)
    assert.throws(() => validateVideoPromptTimeline(text.replace(first, '<d>缺少语言标签</d>'), 10), /标签/)
    // 用户原台词中的否定词不属于写作元指令。
    const quoted = prompt('[Shot 1] 小明 (S1) says, <d>[Chinese] 不要说话。</d>')
    assert.doesNotThrow(() => validateVideoPromptTimeline(quoted, 4))
    assert.throws(() => validateVideoPromptTimeline(prompt('[Shot 1] Rain falls. No subtitles.'), 4), /元指令/)
    const quotedStyle = prompt('[Shot 1] 小明 (S1) says, <d>[English]\nVisual style: noir.\n</d>')
    const styledDialogue = injectStyleOpening(quotedStyle, 'cinematic lighting')
    assert.ok(styledDialogue.includes('<d>[English]\nVisual style: noir.\n</d>'))
    assert.doesNotThrow(() => validateVideoPromptTimeline(styledDialogue, 4))
  } finally {
    db.update(schema.storyboards).set({ description: a.description, duration: a.duration, videoPrompt: a.videoPrompt }).where(eq(schema.storyboards.id, a.id)).run()
  }
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
    const count = db.select().from(schema.sysTask).all().length
    await assert.rejects(generateVideo({ storyboardId: current.id, dramaId: drama.id,
      prompt: prompt('[Shot 1] 小明 (S1) says, <d>[Chinese] 临时新增的配音。</d>'), duration: 5 }), /不能省略、重复或新增/)
    assert.equal(db.select().from(schema.sysTask).all().length, count)
    assert.equal(submitted, undefined)
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
    assert.match(submitted['2'].inputs.prompt, /@图片1: weak_reference/)
    assert.ok(submitted['2'].inputs.prompt.indexOf('weak_reference') < submitted['2'].inputs.prompt.indexOf('detailed_description:'))
    const snapshot = JSON.parse(saved.requestSnapshot!)
    assert.equal(snapshot.provider, 'comfyui')
    assert.equal(snapshot.prompt, submitted['2'].inputs.prompt)
    assert.equal(snapshot.promptTruncated, undefined)
    assert.doesNotMatch(snapshot.prompt, /保持同一|不重置构图/)
    db.update(schema.sysTask).set({ status: 'failed' }).where(eq(schema.sysTask.id, before.id)).run()
    assert.equal(await resolvePreviousShotFrame(current.id), null)
    db.update(schema.sysTask).set({ status: 'completed' }).where(eq(schema.sysTask.id, before.id)).run()
    makeShot(12, { sceneId: null })
    const returnedScene = makeShot(13, { sceneId: scene.id })
    assert.equal(await resolvePreviousShotFrame(returnedScene.id), null)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test.after(async () => { db.$client.close(); await fs.rm(root, { recursive: true, force: true }) })
