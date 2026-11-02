import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createWorkbenchRefresh } from '../../frontend/app/utils/workbench-refresh.ts'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('并发刷新跳过旧快照，所有完成回调等最新数据应用后才返回', async () => {
  let version = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const applied: number[] = []
  const refresh = createWorkbenchRefresh(async () => {
    const snapshot = ++version
    if (snapshot === 1) await gate
    return snapshot
  }, snapshot => { applied.push(snapshot) })
  const beforeSave = refresh()
  const afterSave = refresh()
  release()
  await Promise.all([beforeSave, afterSave])
  assert.deepEqual(applied, [2])
})

test('刷新失败不覆盖已有数据，后续重试仍可加载新列表', async () => {
  let fail = true
  let current = ['旧分镜']
  const refresh = createWorkbenchRefresh(async () => {
    if (fail) throw new Error('读取失败')
    return ['新分镜1', '新分镜2']
  }, snapshot => { current = snapshot })
  await assert.rejects(refresh(), /读取失败/)
  assert.deepEqual(current, ['旧分镜'])
  fail = false
  await refresh()
  assert.deepEqual(current, ['新分镜1', '新分镜2'])
})

test('真实 Agent 使用原文本协议、小批工具调用、保存通知与本次回执', { timeout: 30_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'huobao-save-contract-'))
  process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = temporary
  process.env.WORKSPACE_PATH = path.join(temporary, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { db, schema } = await import('../src/db/index.js')
  const { agentRegistry, createThinkingOffFetch } = await import('../src/agents/index.js')
  const { buildAgentRequestContext } = await import('../src/agents/context.js')
  const { assertAgentSaved, registerAgentTools } = await import('../src/agents/execution.js')
  const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
  const { extractTools } = await import('../src/agents/tools/extract-tools.js')
  const { buildLocalAgentContract, STORYBOARD_BATCH_SIZE } = await import('../src/agents/local-contract.js')
  const { buildSubmission } = await import('../src/services/comfyui/template.js')
  const now = new Date().toISOString()
  db.insert(schema.dramas).values({ id: 1, title: '离线测试', createdAt: now, updatedAt: now }).run()
  db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: '测试集', scriptContent: '教室，日。女孩抬头看向窗外。', createdAt: now, updatedAt: now }).run()
  const output = ['subject_definitions: N/A', 'shot_summary: 窗外雨景', 'reference_usage: N/A', 'detailed_description: [Shot 1] 0-2.5: 固定窗外雨景\n[Shot 2] 2.5-5: 雨滴特写', 'overall_soundscape: 雨声', 'non_diegetic_music: N/A'].join('\n')
  const shot = (n: number) => ({ shot_number: n, description: '【镜头1】窗外雨景【镜头2】雨滴特写', video_prompt: output, duration: 5, character_ids: [], prop_ids: [] })
  const plan = [
    { name: 'read_storyboard_context', args: {} },
    { name: 'save_storyboards', args: { replace_existing: true, storyboards: [shot(1), shot(2)] } },
    { name: 'save_storyboards', args: { storyboards: [shot(3)] } },
  ]
  const requests: any[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const round = body.messages.filter((message: any) => message.role === 'tool').length
    const toolNames = body.tools.map((tool: any) => tool.function.name)
    const lastUser = [...body.messages].reverse().find((message: any) => message.role === 'user')?.content || ''
    const extractionTarget = lastUser.includes('本次只提取角色') ? 'characters' : lastUser.includes('本次只提取场景') ? 'scenes' : 'props'
    const extractionValues = {
      characters: [{ name: '小雨', appearance: '年轻，短发', styling: '灰色外套' }],
      scenes: [{ location: '教室', time: '日', prompt: '整齐课桌，无人物', lighting: '窗外自然光' }],
      props: [],
    }
    const currentPlan = toolNames.includes('save_script') ? [
      { name: 'read_episode_script', args: {} },
      { name: 'save_script', args: { content: '## S1 | 内景 · 教室 | 日\n小雨：（抬头）雨停了。' } },
    ] : toolNames.includes('save_dedup_characters') ? [
      { name: 'read_script_for_extraction', args: {} },
      { name: `read_existing_${extractionTarget}`, args: {} },
      { name: `save_dedup_${extractionTarget}`, args: { [extractionTarget]: extractionValues[extractionTarget] } },
    ] : plan
    const next = currentPlan[round]
    const message = next
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${round}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
      : { role: 'assistant', content: '全部分镜已保存' }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: 'offline-model',
      choices: [{ index: 0, message, finish_reason: next ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  db.insert(schema.aiServiceConfigs).values({ id: 1, serviceType: 'text', provider: 'openai', name: '离线假服务',
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'offline-placeholder', model: '["offline-model"]', isActive: true,
    createdAt: now, updatedAt: now }).run()

  try {
    await t.test('DeepSeek 官方发送关思考字段，不夹带其他厂商参数，旧 openai 配置也生效', async sub => {
      const captured: any[] = []
      sub.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
        captured.push(JSON.parse(init.body))
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      })
      for (const provider of ['openai', 'deepseek']) {
        const patched = createThinkingOffFetch(provider, 'https://api.deepseek.com/v1')
        assert.ok(patched, 'DeepSeek 官方不能跳过思考补丁')
        await patched('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 16384, messages: [{ role: 'user', content: '离线测试' }] }),
        })
      }
      for (const body of captured) {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.equal(body.enable_thinking, undefined)
        assert.equal(body.reasoning_effort, undefined)
        assert.equal(body.max_tokens, 16384)
        assert.equal(body.model, 'deepseek-flash')
      }
      assert.equal(createThinkingOffFetch('openai', 'https://api.openai.com/v1'), undefined)
      assert.equal(createThinkingOffFetch('gemini', 'https://generativelanguage.googleapis.com/v1beta'), undefined)
      captured.length = 0
      for (const provider of ['xiaomi-mimo', 'openai']) {
        const patched = createThinkingOffFetch(provider, 'https://api.xiaomimimo.com/v1')
        assert.ok(patched, 'MiMo 官方不能跳过思考补丁')
        await patched('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST', body: JSON.stringify({ model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: '离线测试' }] }),
        })
      }
      for (const body of captured) {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.equal(body.enable_thinking, undefined)
        assert.equal(body.reasoning_effort, undefined)
        assert.equal(body.model, 'mimo-v2.6-flash')
      }
    })

    await t.test('分镜 schema 限制两段，超过批量不能进入保存工具', () => {
      assert.equal(STORYBOARD_BATCH_SIZE, 2)
      const tool = registerAgentTools(storyboardTools).save_storyboards
      assert.equal(tool.inputSchema.safeParse({ storyboards: [shot(1), shot(2)] }).success, true)
      assert.equal(tool.inputSchema.safeParse({ storyboards: [shot(1), shot(2), shot(3)] }).success, false)
    })

    await t.test('原模型协议参数未缩小，真实工具每批写入即可通知刷新', async () => {
      const savedCounts: number[] = []
      const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: 1, modelOverride: 'offline-model',
        onSave: () => { savedCounts.push(db.select().from(schema.storyboards).all().length) } })
      const result = await agentRegistry.storyboard_breaker.generate('拆分当前集分镜并保存全部批次', {
        maxSteps: 80, requestContext: rc, abortSignal: AbortSignal.timeout(15_000),
      })
      assertAgentSaved('storyboard_breaker', result, rc)
      assert.deepEqual(savedCounts, [2, 3])
      assert.equal(requests.length, 4)
      for (const request of requests) {
        assert.notEqual(request.stream, true)
        assert.equal(request.max_tokens, Number(process.env.AI_MAX_TOKENS || 16384))
        const names = request.tools.map((tool: any) => tool.function.name)
        assert.ok(names.includes('save_storyboards'))
        assert.ok(!names.includes('saveStoryboards'))
      }
    })

    await t.test('改写与三类提取的每轮官方 DeepSeek 请求都关闭思考，保存后才能完成', async sub => {
      const { startExtraction, getExtractionStatus } = await import('../src/services/extraction.js')
      db.insert(schema.aiServiceConfigs).values({ id: 2, serviceType: 'text', provider: 'openai', name: '离线 DeepSeek 协议测试',
        baseUrl: 'https://api.deepseek.com/v1', apiKey: 'offline-placeholder', model: '["deepseek-flash"]', isActive: true,
        createdAt: now, updatedAt: now }).run()
      const originalFetch = globalThis.fetch
      const forwarded: any[] = []
      sub.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
        const remote = new URL(String(typeof url === 'string' ? url : url.url))
        assert.equal(remote.hostname, 'api.deepseek.com')
        const body = JSON.parse(init.body)
        forwarded.push(body)
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.notEqual(body.stream, true)
        assert.equal(body.enable_thinking, undefined)
        assert.equal(body.reasoning_effort, undefined)
        return originalFetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init)
      })
      const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: 2, modelOverride: 'deepseek-flash' })
      const rewritten = await agentRegistry.script_rewriter.generate('读取并改写本集剧本，保存最终结果', {
        maxSteps: 20, requestContext: rc, abortSignal: AbortSignal.timeout(10_000),
      })
      assertAgentSaved('script_rewriter', rewritten, rc)
      assert.ok(db.select().from(schema.episodes).all()[0].scriptContent?.includes('雨停了'))
      for (const target of ['characters', 'scenes', 'props'] as const) {
        assert.equal(startExtraction(1, 1, target, { configId: 2, model: 'deepseek-flash' }), true)
        for (let i = 0; i < 200 && getExtractionStatus(1)[target]?.status === 'running'; i++) await pause(10)
        const task = getExtractionStatus(1)[target]
        assert.equal(task?.status, 'done', task?.error)
      }
      assert.ok(db.select().from(schema.characters).all().some(row => row.name === '小雨'))
      assert.ok(db.select().from(schema.scenes).all().some(row => row.location === '教室'))
      assert.equal(forwarded.length, 15)
    })

    await t.test('无保存和输出截断都不能宣布成功，但有效的空道具保存算完成', async () => {
      const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1 })
      assert.throws(() => assertAgentSaved('storyboard_breaker', { finishReason: 'stop' }, rc), /没有成功调用保存工具/)
      assert.throws(() => assertAgentSaved('storyboard_breaker', { finishReason: 'length' }, rc), /输出达到长度上限/)
      const props = registerAgentTools(extractTools).save_dedup_props
      await props.execute({ props: [] }, { requestContext: rc })
      assert.doesNotThrow(() => assertAgentSaved('extractor', { finishReason: 'stop' }, rc, 'props'))
      assert.throws(() => assertAgentSaved('extractor', { finishReason: 'stop' }, rc, 'scenes'), /没有成功调用保存工具/)
    })

    await t.test('本地 H3 契约完整且空 media 不残留演示参考图', () => {
      const contract = buildLocalAgentContract('storyboard_breaker')
      for (const section of ['subject_definitions', 'shot_summary', 'reference_usage', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) assert.ok(contract.includes(section))
      assert.ok(contract.includes('每批最多2段'))
      const graph = buildSubmission({ name: '媒体测试', api: { '1': { class_type: 'MediaNode', inputs: { media_manifest: '["old.png"]' } } },
        bindings: [{ source: 'media', encoding: 'json', targets: [{ node: '1', input: 'media_manifest' }] }], outputNodes: ['1'],
      }, { media: [] } as any, {})
      assert.equal(graph['1'].inputs.media_manifest, '[]')
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
