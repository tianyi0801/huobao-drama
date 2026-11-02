import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SSEStreamingApi } from 'hono/streaming'
import { createLiveSSE } from '../src/utils/live-sse.js'
import { consumeAgentSSE } from '../../frontend/app/utils/agent-sse.ts'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('慢日志连接不阻塞生成回调，发送顺序保持一致', async () => {
  const written: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const stream = {
    aborted: false, closed: false, onAbort() {}, abort() {},
    async writeSSE(message: { event: string }) { await gate; written.push(message.event) },
  } as unknown as SSEStreamingApi
  const live = createLiveSSE(stream, () => assert.fail('不应断开'))
  try {
    live.send('start', {})
    live.send('text', { text: '第一轮输出' })
    live.send('done', {})
    assert.deepEqual(written, [])
    release()
    await live.flush()
    assert.deepEqual(written, ['start', 'text', 'done'])
  } finally { live.dispose() }
})

test('没有模型事件时仍发心跳，关闭后释放计时器', async () => {
  const events: string[] = []
  const stream = {
    aborted: false, closed: false, onAbort() {}, abort() {},
    async writeSSE(message: { event: string }) { events.push(message.event) },
  } as unknown as SSEStreamingApi
  const live = createLiveSSE(stream, () => {}, 5)
  await pause(25)
  await live.flush()
  live.dispose()
  assert.ok(events.includes('ping'))
  const count = events.length
  await pause(15)
  assert.equal(events.length, count)
})

test('慢连接队列有界，超限会断开而不是无限积压', async () => {
  let disconnected = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const stream = {
    aborted: false, closed: false, onAbort() {},
    abort() { this.aborted = true },
    async writeSSE() { await gate },
  } as unknown as SSEStreamingApi
  const live = createLiveSSE(stream, () => { disconnected++ })
  for (let i = 0; i < 300; i++) live.send('text', { text: `${i}` })
  assert.equal(disconnected, 1)
  await live.flush()
  release()
  live.dispose()
})

test('SSE 解析支持分块中文与 CRLF，明确收到 done 才完成', async () => {
  const bytes = new TextEncoder().encode('event: text\r\ndata: {"text":"场景：雨夜"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n')
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }))
  const events: Array<[string, any]> = []
  await consumeAgentSSE(response, (event, data) => { events.push([event, data]) })
  assert.equal(events[0][1].text, '场景：雨夜')
  assert.equal(events[1][0], 'done')
  assert.equal(response.body?.locked, false)
})

test('EOF 未收到 done 必须失败，不能假报成功或触发重跑', async () => {
  const response = new Response('event: start\ndata: {}\n\n')
  await assert.rejects(consumeAgentSSE(response, () => {}), /提前结束/)
  assert.equal(response.body?.locked, false)
})

test('错误事件与回调异常都释放 reader', async () => {
  const response = new Response('event: error\ndata: {"message":"模型参数过长"}\n\n')
  await assert.rejects(consumeAgentSSE(response, () => {}), /模型参数过长/)
  assert.equal(response.body?.locked, false)
  const callbackError = new Response('event: text\ndata: {"text":"test"}\n\n')
  await assert.rejects(consumeAgentSSE(callbackError, () => { throw new Error('回调失败') }), /回调失败/)
  assert.equal(callbackError.body?.locked, false)
})

test('真实路由使用兼容生成协议并回放、释放提取日志连接', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'huobao-agent-regression-'))
  process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = temporary
  process.env.WORKSPACE_PATH = path.join(temporary, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { Hono } = await import('hono')
  const { mastra } = await import('../src/mastra/index.js')
  const { default: agentRoute } = await import('../src/routes/agent.js')
  const { default: episodeRoute } = await import('../src/routes/episodes.js')
  const { pushLiveLog, readLiveLog, clearLiveLog } = await import('../src/services/live-log.js')
  const { startExtraction, getExtractionStatus, extractLogKey } = await import('../src/services/extraction.js')
  const { db } = await import('../src/db/index.js')
  const app = new Hono().route('/agent', agentRoute).route('/episodes', episodeRoute)
  const request = () => app.request('/agent/storyboard_breaker/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '测试分镜', drama_id: 1, episode_id: 1 }),
  })

  try {
    await t.test('长工具参数也走 generate，逐轮文本与完成事件可见', async sub => {
      const agent = mastra.getAgent('storyboard_breaker') as any
      sub.mock.method(agent, 'stream', () => { throw new Error('不应调用流式模型接口') })
      sub.mock.method(agent, 'generate', async (_messages: any, options: any) => {
        await pause(15)
        assert.equal(options.maxSteps, 80)
        const receipt = { tool: 'save_storyboards', result: { count: 2 } }
        options.requestContext.get('saveReceipts').push(receipt)
        options.requestContext.get('onSave')?.(receipt)
        options.onStepFinish({
          text: '分镜已整理',
          toolCalls: [{ payload: { toolCallId: 'save-1', toolName: 'saveStoryboards', args: { text: '场景'.repeat(30_000) } } }],
          toolResults: [{ payload: { toolCallId: 'save-1', result: { count: 8 } } }],
        })
        return { text: '完成', finishReason: 'stop' }
      })
      const events: Array<[string, any]> = []
      await consumeAgentSSE(await request(), (event, data) => { events.push([event, data]) })
      assert.deepEqual(events.map(e => e[0]), ['start', 'saved', 'step', 'tool-call', 'tool-result', 'text', 'done'])
      assert.equal(events[1][1].count, 2)
      assert.ok(events[3][1].args.length < 200)
      assert.equal(events[4][1].ok, true)
    })

    await t.test('生成错误、长度截断与轮次耗尽不能发布 done', async sub => {
      const agent = mastra.getAgent('storyboard_breaker') as any
      for (const finishReason of ['error', 'length', 'tool-calls']) {
        const mock = sub.mock.method(agent, 'generate', async () => {
          if (finishReason === 'error') throw new Error('兼容模型执行失败')
          return { text: '', finishReason }
        })
        const events: string[] = []
        await assert.rejects(consumeAgentSSE(await request(), event => { events.push(event) }))
        assert.ok(events.includes('error'))
        assert.ok(!events.includes('done'))
        mock.mock.restore()
      }
    })

    await t.test('关闭实时连接会取消旧 Agent', async sub => {
      const agent = mastra.getAgent('storyboard_breaker') as any
      let started: () => void = () => {}
      let cancelled: () => void = () => {}
      const ready = new Promise<void>(resolve => { started = resolve })
      const ended = new Promise<void>(resolve => { cancelled = resolve })
      sub.mock.method(agent, 'generate', async (_messages: any, options: any) => {
        started()
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => {
            cancelled()
            reject(new Error('已取消'))
          }, { once: true })
        })
      })
      const response = await request()
      await ready
      await response.body?.cancel()
      await Promise.race([ended, pause(1000).then(() => { throw new Error('未取消旧 Agent') })])
    })

    await t.test('提取模型协议不变，已有日志回放后 EOF，打开日志不会再调用模型', async sub => {
      const agent = mastra.getAgent('extractor') as any
      const mock = sub.mock.method(agent, 'generate', async (_messages: any, options: any) => {
        options.requestContext.get('saveReceipts').push({ tool: 'save_dedup_scenes', result: { created: 1, reused: 0 } })
        options.onStepFinish({ text: '已提取场景', toolCalls: [], toolResults: [] })
        return { text: '已提取场景', steps: [{}] }
      })
      const key = extractLogKey(41, 'scenes')
      assert.equal(startExtraction(41, 1, 'scenes'), true)
      for (let i = 0; i < 20 && getExtractionStatus(41).scenes?.status === 'running'; i++) await pause(5)
      assert.equal(getExtractionStatus(41).scenes?.status, 'done')
      const response = await app.request('/episodes/41/extract-log?target=scenes')
      const text = await response.text()
      assert.ok(text.includes('已提取场景'))
      assert.ok(text.includes('"kind":"done"'))
      assert.equal(mock.mock.callCount(), 1)
      clearLiveLog(key)
    })

    await t.test('新日志在回放期间产生也不会丢失', async () => {
      const key = extractLogKey(42, 'characters')
      pushLiveLog(key, { kind: 'start' })
      const response = await app.request('/episodes/42/extract-log?target=characters')
      const text = response.text()
      pushLiveLog(key, { kind: 'text', text: '运行中的角色提取' })
      pushLiveLog(key, { kind: 'done' })
      const result = await text
      assert.ok(result.includes('运行中的角色提取'))
      assert.ok(result.includes('"kind":"done"'))
      assert.equal(readLiveLog(key).length, 3)
      clearLiveLog(key)
    })
  } finally {
    db.$client.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
