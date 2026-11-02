import { toSnakeCaseTool } from './tool-labels'

export interface ActivityTool {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  ms?: number
  preview?: string
}

export interface ToolGroup {
  name: string
  count: number
  completed: number
  failed: number
  running: number
  latest: ActivityTool
  lastError?: ActivityTool
}

/** 同一种工具只占一行，驼峰与下划线别名合并，失败不会被后续成功覆盖。 */
export function groupActivityTools(tools: ActivityTool[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const name = toSnakeCaseTool(tool.name)
    const group: ToolGroup = groups.get(name) || { name, count: 0, completed: 0, failed: 0, running: 0, latest: tool }
    group.count++
    if (tool.status === 'ok') group.completed++
    if (tool.status === 'error') { group.failed++; group.lastError = tool }
    if (tool.status === 'running') group.running++
    group.latest = tool
    groups.set(name, group)
  }
  return [...groups.values()]
}

export interface ActivityLogEntry {
  id: number
  at: number
  kind: string
  tool?: string
  text?: string
  message?: string
  created?: number
  merged?: number
  chars?: number
  steps?: number
}

/** 连续相同动作合并，原文与错误各自保留，不凭日志推算不存在的任务百分比。 */
export function compactActivityLogs<T extends ActivityLogEntry>(entries: T[]): Array<T & { repeats: number }> {
  const compacted: Array<T & { repeats: number }> = []
  for (const entry of entries) {
    const previous = compacted[compacted.length - 1]
    const repeatable = entry.kind === 'tool' || entry.kind === 'step'
    if (repeatable && previous?.kind === entry.kind && toSnakeCaseTool(previous.tool) === toSnakeCaseTool(entry.tool)) {
      compacted[compacted.length - 1] = { ...entry, repeats: previous.repeats + 1 }
    } else {
      compacted.push({ ...entry, repeats: 1 })
    }
  }
  return compacted
}
