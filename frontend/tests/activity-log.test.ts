import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupActivityTools, compactActivityLogs } from '../app/utils/activity-log.ts'

 test('一百次写入分镜聚合为一行，驼峰与下划线名同时支持', () => {
  const tools = Array.from({ length: 100 }, (_, i) => ({
    id: `call-${i}`, name: i % 2 ? 'saveStoryboards' : 'save_storyboards', status: 'ok' as const,
  }))
  const groups = groupActivityTools(tools)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 100)
  assert.equal(groups[0].completed, 100)
  assert.equal(groups[0].name, 'save_storyboards')
})

test('失败不能被后续成功遮住，未完成的并行调用保留进行状态', () => {
  const groups = groupActivityTools([
    { id: '1', name: 'saveStoryboards', status: 'error', preview: '写入错误' },
    { id: '2', name: 'save_storyboards', status: 'ok' },
    { id: '3', name: 'save_storyboards', status: 'running' },
  ])
  assert.equal(groups[0].failed, 1)
  assert.equal(groups[0].completed, 1)
  assert.equal(groups[0].running, 1)
  assert.equal(groups[0].latest.id, '3')
})

test('重复提取工具合并，但输出原文和错误不会丢失', () => {
  const entries = [
    { id: 1, at: 10, kind: 'start' },
    { id: 2, at: 20, kind: 'tool', tool: 'readExistingScenes' },
    { id: 3, at: 30, kind: 'tool', tool: 'read_existing_scenes' },
    { id: 4, at: 40, kind: 'text', text: '模型的原始输出' },
    { id: 5, at: 50, kind: 'error', message: '模型输出上限' },
  ]
  const original = JSON.stringify(entries)
  const compacted = compactActivityLogs(entries)
  assert.equal(compacted.length, 4)
  assert.equal(compacted[1].repeats, 2)
  assert.equal(compacted[1].at, 30)
  assert.equal(compacted[2].text, '模型的原始输出')
  assert.equal(compacted[3].message, '模型输出上限')
  assert.equal(JSON.stringify(entries), original)
})

test('不同工具和保存回执不应合并，零新增回执依然保留', () => {
  const entries = [
    { id: 1, at: 10, kind: 'tool', tool: 'read_script_for_extraction' },
    { id: 2, at: 20, kind: 'tool', tool: 'read_existing_props' },
    { id: 3, at: 30, kind: 'saved', created: 0, merged: 0 },
    { id: 4, at: 40, kind: 'saved', created: 1, merged: 1 },
  ]
  assert.equal(compactActivityLogs(entries).length, 4)
})
