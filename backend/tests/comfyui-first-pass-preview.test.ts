import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseComfyEvent, setPreview, clearPreview, decorateTaskWithPreview, resolveByteRange, FIRST_PASS_NODE,
} from '../src/services/comfyui/live-preview.js'
import { buildSubmission } from '../src/services/comfyui/template.js'
import { normalizeTemplate } from '../src/services/comfyui/config.js'

test('ComfyUI 事件解析：只认进度与一采落盘两类', async t => {
  await t.test('进度事件换算百分比并裁剪到 0-100', () => {
    assert.deepEqual(parseComfyEvent(JSON.stringify({ type: 'progress', data: { value: 3, max: 12 } })), { kind: 'progress', progress: 25 })
    assert.deepEqual(parseComfyEvent(JSON.stringify({ type: 'progress', data: { value: 99, max: 10 } })), { kind: 'progress', progress: 100 })
    assert.deepEqual(parseComfyEvent(JSON.stringify({ type: 'progress', data: { value: -5, max: 10 } })), { kind: 'progress', progress: 0 })
    assert.equal(parseComfyEvent(JSON.stringify({ type: 'progress', data: {} })).kind, 'other')
  })

  await t.test('一采节点执行完成即拿到文件名，二采还在跑也能预览', () => {
    const event = parseComfyEvent(JSON.stringify({
      type: 'executed',
      data: { node: FIRST_PASS_NODE, output: { videos: [{ filename: '1c_00001_.mp4', subfolder: '一采', type: 'output' }] } },
    }))
    assert.equal(event.kind, 'first-pass')
    assert.deepEqual(event.file, { filename: '1c_00001_.mp4', subfolder: '一采', type: 'output' })
  })

  await t.test('其他节点、无文件、坏 JSON 都不触发一采预览', () => {
    assert.equal(parseComfyEvent(JSON.stringify({ type: 'executed', data: { node: '302', output: { videos: [{ filename: 'x.mp4' }] } } })).kind, 'other')
    assert.equal(parseComfyEvent(JSON.stringify({ type: 'executed', data: { node: FIRST_PASS_NODE, output: {} } })).kind, 'other')
    assert.equal(parseComfyEvent('not json').kind, 'other')
    assert.equal(parseComfyEvent(JSON.stringify({ type: 'status', data: {} })).kind, 'other')
  })
})

test('任务响应携带一采预览状态，取消或完成后清理', async t => {
  await t.test('未就绪时不给出地址', () => {
    clearPreview(11)
    const task = decorateTaskWithPreview({ id: 11, status: 'processing' })
    assert.equal(task.firstPassReady, false)
    assert.equal(task.firstPassUrl, null)
    assert.equal(task.previewProgress, null)
  })

  await t.test('一采落盘后立刻可用，进度独立保留', () => {
    setPreview(11, { filename: '1c_00001_.mp4', subfolder: '一采', type: 'output', progress: 40 })
    const task = decorateTaskWithPreview({ id: 11, status: 'processing' })
    assert.equal(task.firstPassReady, true)
    assert.equal(task.firstPassUrl, '/api/v1/tasks/11/first-pass')
    assert.equal(task.previewProgress, 40)
  })

  await t.test('清理后不再返回地址', () => {
    clearPreview(11)
    const task = decorateTaskWithPreview({ id: 11, status: 'completed' })
    assert.equal(task.firstPassReady, false)
    assert.equal(task.firstPassUrl, null)
  })
})

test('一采保存节点必须进入提交图，否则 ComfyUI 不会执行它', () => {
  const api = {
    '8': { class_type: 'Sampler', inputs: {} },
    '11': { class_type: 'CreateVideo', inputs: { frames: ['8', 0] } },
    '12': { class_type: 'FirstPassSave', inputs: { video: ['11', 0] } },
    '293': { class_type: 'SaveChain', inputs: { video: ['11', 0] } },
  } as any
  const context: any = {
    prompt: '测试', resolution: '720P', aspectRatio: '16:9', width: 1280, height: 720,
    durationSeconds: 5, fps: 24, seed: 1, media: [], filenamePrefix: 'test/video',
  }
  const base = { name: 't', api, bindings: [], options: [] } as any

  const withoutPreview = buildSubmission({ ...base, outputNodes: ['293'] }, context, {})
  assert.equal(withoutPreview['12'], undefined, '未声明时必须被剪掉，保持原有行为')

  const withPreview = buildSubmission({ ...base, outputNodes: ['293'], previewOutputNodes: ['12'] }, context, {})
  assert.ok(withPreview['12'], '声明预览节点后一采保存节点必须在提交图里')
  assert.deepEqual(withPreview['12'].inputs.video, ['11', 0])
})

test('已存进数据库的老模板能自动识别一采保存节点', () => {
  const raw = {
    name: 'H3 老配置',
    outputNodes: ['293'],
    bindings: [],
    api: {
      '11': { class_type: 'CreateVideo', inputs: {} },
      '12': { class_type: 'gosick_233_MiniMaxH3ConditionalFirstPassSaveVideo', inputs: { video: ['11', 0] } },
      '293': { class_type: 'gosick_233_SaveChainV114', inputs: { video: ['11', 0] } },
    },
  } as any
  const template = normalizeTemplate(raw)
  assert.ok(template, '模板应可解析')
  assert.deepEqual(template!.previewOutputNodes, ['12'])

  const explicit = normalizeTemplate({ ...raw, previewOutputNodes: [] })
  assert.deepEqual(explicit!.previewOutputNodes, ['12'], '显式空数组也要回退到自动识别')
})

test('一采预览支持 Range：播放器拖动不会黑屏', () => {
  assert.deepEqual(resolveByteRange(1000), { status: 200, start: 0, end: 999 })
  assert.deepEqual(resolveByteRange(1000, 'bytes=0-99'), { status: 206, start: 0, end: 99 })
  assert.deepEqual(resolveByteRange(1000, 'bytes=500-'), { status: 206, start: 500, end: 999 })
  assert.deepEqual(resolveByteRange(1000, 'bytes=-100'), { status: 206, start: 900, end: 999 })
  assert.deepEqual(resolveByteRange(1000, 'bytes=900-2000'), { status: 206, start: 900, end: 999 })
  assert.equal(resolveByteRange(1000, 'bytes=2000-3000').status, 416)
  assert.deepEqual(resolveByteRange(1000, 'garbage'), { status: 200, start: 0, end: 999 })
})
