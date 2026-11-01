/**
 * 本地 ComfyUI 链路测试（无需真实 ComfyUI）
 *
 * 覆盖三件事：
 *   1. 模板引擎：绑定注入、Prompt Enhancer 分支剪枝、可选图槽裁剪
 *   2. 适配器请求构造：提交图结构、素材上传、素材清单顺序
 *   3. 适配器结果解析：/history → 产物 URL
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// SQLite 必须在导入 db 之前改到临时目录，避免污染仓库 data/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-local-'))
process.env.SQLITE_PATH = path.join(tmpRoot, 'test.sqlite3')
process.env.WORKSPACE_PATH = path.resolve(import.meta.dirname, '../workspace')

const { saveComfyConfig, getComfyConfig } = await import('../src/services/comfyui/config.ts')
const { buildTemplateFromPreset } = await import('../src/services/comfyui/presets.ts')
const { buildSubmission } = await import('../src/services/comfyui/template.ts')
const { ComfyUiImageAdapter } = await import('../src/services/adapters/comfyui-image.ts')
const { ComfyUiVideoAdapter } = await import('../src/services/adapters/comfyui-video.ts')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

interface MockCall { route: string; body: any }
interface MockComfy {
  url: string
  calls: MockCall[]
  /** history 只返回一次 completed，用来验证轮询状态机 */
  completeOnPoll: boolean
  close: () => Promise<void>
}

async function startMockComfy(): Promise<MockComfy> {
  const calls: MockCall[] = []
  const state = { completeOnPoll: false, polls: 0 }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = raw
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      calls.push({ route: url.pathname, body })

      if (url.pathname === '/system_stats') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          system: { comfyui_version: '0.3.40', python_version: '3.12.0', os: 'posix' },
          devices: [{ name: 'Mock GPU', type: 'cuda', vram_total: 24 * 1024 ** 3, vram_free: 20 * 1024 ** 3 }],
        }))
        return
      }
      if (url.pathname === '/object_info') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({}))
        return
      }
      if (url.pathname === '/upload/image') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ name: 'uploaded.png', subfolder: 'huobao/img-1', type: 'input' }))
        return
      }
      if (url.pathname === '/prompt') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'mock-prompt-1', number: 1 }))
        return
      }
      if (url.pathname.startsWith('/history/')) {
        state.polls += 1
        res.setHeader('Content-Type', 'application/json')
        if (state.completeOnPoll) {
          res.end(JSON.stringify({
            'mock-prompt-1': {
              status: { status_str: 'success', completed: true, messages: [] },
              outputs: { 461: { images: [{ filename: 'mock_0001.png', subfolder: '', type: 'output' }] } },
            },
          }))
        } else {
          res.end('{}')
        }
        return
      }
      if (url.pathname === '/view') {
        res.setHeader('Content-Type', 'image/png')
        res.end(PNG_1PX)
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    get completeOnPoll() { return state.completeOnPoll },
    set completeOnPoll(value: boolean) { state.completeOnPoll = value },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  } as MockComfy
}

test('文生图模板：prompt 直连 TextEncode，Prompt Enhancer 分支被剪枝', () => {
  const template = buildTemplateFromPreset('qwen-image-2.1-t2i')
  const graph = buildSubmission(template, {
    prompt: '一座赛博朋克城市的雨夜街道',
    width: 1024,
    height: 576,
    filenamePrefix: 'huobao/test',
  }, { prompt_enhancer: false, steps: 30 })

  assert.equal(graph['459:452'].inputs.prompt, '一座赛博朋克城市的雨夜街道')
  assert.equal(graph['459:458'].inputs.steps, 30)
  assert.equal(graph['459:456'].inputs.width, 1024)
  assert.equal(graph['459:456'].inputs.height, 576)
  assert.equal(graph['461'].inputs.filename_prefix, 'huobao/test')
  // 增强分支整条消失：9B 文本模型不会被加载
  for (const id of ['459:471', '459:472', '459:473', '459:474', '459:475']) {
    assert.equal(graph[id], undefined, `节点 ${id} 应被剪枝`)
  }
})

test('文生图模板：开启 Prompt Enhancer 后保留增强链路', () => {
  const template = buildTemplateFromPreset('qwen-image-2.1-t2i')
  const graph = buildSubmission(template, { prompt: '雨夜街道' }, { prompt_enhancer: true })

  assert.equal(graph['459:471'].inputs.prompt, '雨夜街道')
  assert.equal(graph['459:474'].inputs.switch, true)
  // prompt 走开关节点输出，TextEncode 仍保持原连线
  assert.deepEqual(graph['459:452'].inputs.prompt, ['459:472', 0])
  assert.ok(graph['459:473'], '增强用 CLIP 应保留')
})

test('图片编辑模板：只有 1 张参考图时第二个图槽被摘掉', () => {
  const template = buildTemplateFromPreset('qwen-image-2.1-edit')
  const graph = buildSubmission(template, {
    prompt: '把衣服换成蓝色牛仔外套',
    images: ['huobao/img-1/aaa.png'],
  }, { prompt_enhancer: false })

  assert.equal(graph['470'].inputs.image, 'huobao/img-1/aaa.png')
  assert.equal(graph['475'], undefined, '第二张图节点应被移除')
  assert.equal(graph['459:474'].inputs['images.image_2'], undefined, '悬空引用必须一并断开')
  assert.deepEqual(graph['459:474'].inputs['images.image_1'], ['470', 0])
  assert.equal(graph['459:474'].inputs.prompt, '把衣服换成蓝色牛仔外套')
})

test('图片编辑模板：2 张参考图时两个槽位都生效', () => {
  const template = buildTemplateFromPreset('qwen-image-2.1-edit')
  const graph = buildSubmission(template, {
    prompt: '换装',
    images: ['huobao/img-1/a.png', 'huobao/img-1/b.png'],
  }, { prompt_enhancer: false })

  assert.equal(graph['470'].inputs.image, 'huobao/img-1/a.png')
  assert.equal(graph['475'].inputs.image, 'huobao/img-1/b.png')
  assert.deepEqual(graph['459:474'].inputs['images.image_2'], ['475', 0])
})

test('视频模板：素材清单按图片→视频→音频顺序写入且为 JSON 字符串', () => {
  const template = buildTemplateFromPreset('minimax-h3-ref2va')
  const manifest = [
    { id: '1', media_type: 'image', filename: 'a.png', subfolder: 'huobao/vid-1', storage_type: 'input' },
    { id: '2', media_type: 'audio', filename: 'b.wav', subfolder: 'huobao/vid-1', storage_type: 'input' },
  ]
  const graph = buildSubmission(template, {
    prompt: '@图片1小雨走进雨里',
    resolution: '720P',
    aspectRatio: '9:16',
    durationSeconds: 6,
    fps: 24,
    seed: 123,
    media: manifest,
    filenamePrefix: 'huobao/video-1',
  }, { first_pass_steps: 6, second_pass: true, second_pass_steps: 3, second_pass_scale: 1.5 })

  assert.equal(graph['2'].inputs.prompt, '@图片1小雨走进雨里')
  assert.equal(graph['2'].inputs.resolution, '720P')
  assert.equal(graph['2'].inputs.aspect_ratio, '9:16')
  assert.equal(graph['2'].inputs.seconds, 6)
  assert.equal(graph['6'].inputs.noise_seed, 123)
  assert.equal(typeof graph['2'].inputs.media_manifest, 'string')
  assert.deepEqual(JSON.parse(graph['2'].inputs.media_manifest).map((m: any) => m.media_type), ['image', 'audio'])
  assert.equal(graph['191'].inputs.value, 6)
  assert.equal(graph['190'].inputs.value, 3)
  // 输出节点与卸载节点都要保留
  assert.ok(graph['293'], '二采合并保存节点应在执行图里')
  assert.ok(graph['34'], '自动卸载节点应在执行图里')
})

test('图片适配器：提交图结构正确、参考图先上传再写入 LoadImage', async () => {
  const mock = await startMockComfy()
  try {
    saveComfyConfig({
      enabled: true,
      url: mock.url,
      image: buildTemplateFromPreset('qwen-image-2.1-t2i'),
      imageEdit: buildTemplateFromPreset('qwen-image-2.1-edit'),
      optionValues: { prompt_enhancer: false, steps: 25 },
    })

    const adapter = new ComfyUiImageAdapter()
    const reference = `data:image/png;base64,${PNG_1PX.toString('base64')}`
    const request = await adapter.buildGenerateRequest(
      { provider: 'comfyui', baseUrl: mock.url, apiKey: '', model: 'local' },
      { id: 7, prompt: '角色三视图', size: '1280x720', referenceImages: JSON.stringify([reference]) } as any,
    )

    assert.equal(request.url, `${mock.url}/prompt`)
    assert.equal(request.method, 'POST')
    const graph = (request.body as any).prompt
    assert.equal(graph['459:474'].inputs.prompt, '角色三视图')
    assert.equal(graph['459:456'].inputs.width, 1280)
    assert.equal(graph['459:456'].inputs.height, 720)
    // 有参考图 → 走图片编辑模板，参考图已上传并写入 LoadImage
    assert.match(graph['470'].inputs.image, /^huobao\/img-1\//)
    assert.ok(
      mock.calls.some(c => c.route === '/upload/image'),
      '应先把参考图上传到 ComfyUI input',
    )
  } finally {
    await mock.close()
  }
})

test('图片适配器：解析 /history 得到可下载地址', async () => {
  const mock = await startMockComfy()
  try {
    mock.completeOnPoll = true
    saveComfyConfig({
      enabled: true,
      url: mock.url,
      image: buildTemplateFromPreset('qwen-image-2.1-t2i'),
      optionValues: { prompt_enhancer: false },
    })

    const adapter = new ComfyUiImageAdapter()
    const history = await (await fetch(`${mock.url}/history/mock-prompt-1`)).json()
    const poll = adapter.parsePollResponse(history)
    assert.equal(poll.status, 'completed')
    assert.match(String(poll.imageUrl), /\/view\?filename=mock_0001\.png/)
  } finally {
    await mock.close()
  }
})

test('视频适配器：媒体清单顺序与 @图片N 对齐，解析出视频地址', async () => {
  const mock = await startMockComfy()
  try {
    saveComfyConfig({
      enabled: true,
      url: mock.url,
      video: buildTemplateFromPreset('minimax-h3-ref2va'),
      optionValues: { first_pass_steps: 4, second_pass: true },
    })

    const adapter = new ComfyUiVideoAdapter()
    const image = `data:image/png;base64,${PNG_1PX.toString('base64')}`
    const request = await adapter.buildGenerateRequest(
      { provider: 'comfyui', baseUrl: mock.url, apiKey: '', model: 'local' },
      {
        id: 11,
        prompt: '@图片1小雨转身',
        resolution: '720p',
        aspectRatio: '9:16',
        duration: 5,
        seed: 42,
        referenceImageUrls: JSON.stringify([image]),
      } as any,
    )

    const graph = (request.body as any).prompt
    assert.equal(graph['2'].inputs.prompt, '@图片1小雨转身')
    // 界面清晰度是「成片」目标：720P ÷ 二采 1.5x = 一采 480P，宽高同步跟随
    assert.equal(graph['2'].inputs.resolution, '480P', '成片 720P 应按倍率回退到一采 480P')
    // 该用例项目比例是 9:16，短边是宽
    assert.equal(graph['2'].inputs.width, 480, '一采宽度应按档位与比例算出')
    assert.equal(graph['2'].inputs.height, 856)
    const manifest = JSON.parse(graph['2'].inputs.media_manifest)
    assert.equal(manifest.length, 1)
    assert.equal(manifest[0].media_type, 'image')
    assert.equal(manifest[0].storage_type, 'input')

    // 解析一个多产物历史，验证下标选择
    const history = {
      p: {
        status: { completed: true, status_str: 'success' },
        outputs: {
          293: { videos: [{ filename: 'second.mp4', subfolder: '二采合并', type: 'output' }] },
        },
      },
    }
    const poll = adapter.parsePollResponse(history)
    assert.equal(poll.status, 'completed')
    assert.match(String(poll.videoUrl), /filename=second\.mp4/)
  } finally {
    await mock.close()
  }
})

test('本地算力关闭时不再回落云端配置', async () => {
  saveComfyConfig({ enabled: false })
  const config = getComfyConfig()
  assert.equal(config.enabled, false)
  const { getActiveConfig } = await import('../src/services/ai.ts')
  // 没有云端配置时应为 null；关键是本地开关关掉后不吃 comfyui 分支
  const active = await getActiveConfig('image')
  assert.ok(active === null || active.provider !== 'comfyui')
})
