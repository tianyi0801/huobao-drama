/**
 * ComfyUI HTTP 客户端 — 只用 5 个端点，零 SDK 依赖：
 *   GET  /system_stats      服务与 GPU 信息
 *   GET  /object_info       全部节点定义（校验工作流、还原控件）
 *   POST /prompt            提交一次生成 → prompt_id
 *   GET  /queue             队列快照（等待空闲 / 判断任务是否蒸发）
 *   GET  /history/{id}      执行结果（outputs + status）
 *   GET  /view              下载产物
 *   POST /upload/image      素材上传到 input 目录
 *
 * 所有请求都用 AbortSignal 超时，避免服务挂死拖住整个生成任务。
 */

export interface ComfySystemStats {
  system?: {
    os?: string
    comfyui_version?: string
    python_version?: string
    ram_total?: number
    ram_free?: number
  }
  devices?: {
    name?: string
    type?: string
    vram_total?: number
    vram_free?: number
    torch_vram_total?: number
    torch_vram_free?: number
  }[]
}

export interface ComfyObjectInfo {
  [classType: string]: {
    input?: { required?: Record<string, any>; optional?: Record<string, any> }
    output?: string[]
    output_node?: boolean
    description?: string
  }
}

export interface ComfyQueueSnapshot {
  queue_running: any[][]
  queue_pending: any[][]
}

export interface ComfyHistoryEntry {
  status?: {
    status_str?: string
    completed?: boolean
    messages?: any[]
  }
  outputs?: Record<string, any>
}

export interface ComfyPromptResponse {
  prompt_id?: string
  number?: number
  error?: any
  node_errors?: Record<string, any>
}

export interface ComfyUploadedFile {
  name: string
  subfolder: string
  type: string
}

export class ComfyError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'ComfyError'
  }
}

function trimBase(url: string) {
  return (url || '').replace(/\/+$/, '')
}

export class ComfyClient {
  readonly baseUrl: string

  constructor(url: string, private readonly requestTimeoutMs = 30_000) {
    const base = trimBase(url)
    if (!base) throw new ComfyError('ComfyUI 服务地址为空')
    this.baseUrl = base
  }

  private async request(pathname: string, init: RequestInit = {}, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const url = `${this.baseUrl}${pathname}`
    let resp: Response
    try {
      resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        // 本地服务不该走系统代理；Node 内置 fetch 默认不读 HTTP_PROXY，这里显式兜底
        headers: { ...(init.headers || {}) },
      })
    } catch (error: any) {
      const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.cause?.code || error?.message || '连接失败')
      throw new ComfyError(`无法连接 ComfyUI（${url}）：${reason}`, error)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new ComfyError(`ComfyUI 返回 ${resp.status}：${text.slice(0, 500) || resp.statusText}`, text)
    }
    return resp
  }

  private async json<T>(pathname: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const resp = await this.request(pathname, init, timeoutMs)
    try {
      return await resp.json() as T
    } catch {
      throw new ComfyError(`ComfyUI 返回了非 JSON 响应：${pathname}`)
    }
  }

  async systemStats(): Promise<ComfySystemStats> {
    return this.json<ComfySystemStats>('/system_stats')
  }

  async objectInfo(): Promise<ComfyObjectInfo> {
    return this.json<ComfyObjectInfo>('/object_info', {}, 60_000)
  }

  async queue(): Promise<ComfyQueueSnapshot> {
    const snapshot = await this.json<ComfyQueueSnapshot>('/queue')
    return {
      queue_running: Array.isArray(snapshot.queue_running) ? snapshot.queue_running : [],
      queue_pending: Array.isArray(snapshot.queue_pending) ? snapshot.queue_pending : [],
    }
  }

  /** 提交执行图；返回 prompt_id。node_errors 会被展开成可读报错 */
  async submit(graph: Record<string, any>, clientId: string, extraWorkflow?: unknown): Promise<string> {
    const body: Record<string, any> = { prompt: graph, client_id: clientId }
    if (extraWorkflow) body.extra_data = { extra_pnginfo: { workflow: extraWorkflow } }
    const result = await this.json<ComfyPromptResponse>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60_000)

    if (result.error) {
      throw new ComfyError(`ComfyUI 拒绝执行：${describeError(result.error)}`, result.error)
    }
    if (result.node_errors && Object.keys(result.node_errors).length) {
      throw new ComfyError(`ComfyUI 节点校验失败：${describeNodeErrors(result.node_errors)}`, result.node_errors)
    }
    if (!result.prompt_id) throw new ComfyError('ComfyUI 未返回任务编号', result)
    return result.prompt_id
  }

  async history(promptId: string): Promise<Record<string, ComfyHistoryEntry>> {
    return this.json<Record<string, ComfyHistoryEntry>>(`/history/${encodeURIComponent(promptId)}`)
  }

  /** 产物下载地址（/view 需要 filename + subfolder + type 三个参数） */
  viewUrl(item: { filename?: string; subfolder?: string; type?: string }): string {
    const params = new URLSearchParams({
      filename: String(item.filename || ''),
      subfolder: String(item.subfolder || ''),
      type: String(item.type || 'output'),
    })
    return `${this.baseUrl}/view?${params.toString()}`
  }

  /** 把产物下载到本地文件；返回写入的字节数 */
  async download(item: { filename?: string; subfolder?: string; type?: string }, destination: string, timeoutMs = 300_000): Promise<number> {
    const resp = await this.request(
      `/view?${new URLSearchParams({
        filename: String(item.filename || ''),
        subfolder: String(item.subfolder || ''),
        type: String(item.type || 'output'),
      }).toString()}`,
      {},
      timeoutMs,
    )
    const { writeFile } = await import('node:fs/promises')
    const buffer = Buffer.from(await resp.arrayBuffer())
    await writeFile(destination, buffer)
    return buffer.length
  }

  /** 上传素材到 input 目录（图片/视频/音频都走这个端点） */
  async upload(filename: string, data: Buffer | Uint8Array, subfolder = '', mimeType = 'application/octet-stream'): Promise<ComfyUploadedFile> {
    const form = new FormData()
    form.append('image', new Blob([data as any], { type: mimeType }), filename)
    form.append('overwrite', 'true')
    if (subfolder) form.append('subfolder', subfolder)
    form.append('type', 'input')
    const result = await this.json<ComfyUploadedFile>('/upload/image', {
      method: 'POST',
      body: form,
    }, 300_000)
    return {
      name: result.name || filename,
      subfolder: result.subfolder ?? subfolder,
      type: result.type || 'input',
    }
  }

  /** 中断当前执行（清理用，非必需） */
  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' }).catch(() => undefined)
  }

  /**
   * 从队列里移除指定 prompt（排队中未执行的任务）。
   * ComfyUI 只支持按 prompt_id 精准删除，正在执行的用 interrupt。
   */
  async deleteQueued(promptIds: string[]): Promise<void> {
    const ids = promptIds.filter(Boolean)
    if (!ids.length) return
    await this.json('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: ids }),
    }).catch(() => undefined)
  }

  /** 该 prompt 是否正在执行（用于决定 interrupt 还是仅出队） */
  async isRunning(promptId: string): Promise<boolean> {
    const snapshot = await this.queue()
    return snapshot.queue_running.some(entry => String((entry as any)?.[1] ?? '') === promptId)
  }

  /**
   * 列出 ComfyUI 用户的 Workflows 目录（界面左侧「工作流」面板里的文件）
   * 返回相对路径，如 ["huobao-qwen-t2i.workflow.json", "入门示例/basic.json"]
   */
  async listUserWorkflows(): Promise<string[]> {
    const resp = await this.request('/userdata?dir=workflows&recurse=true')
    try {
      const list = await resp.json()
      return Array.isArray(list) ? list.map(String) : []
    } catch {
      return []
    }
  }

  /** 读取一个用户工作流；不存在返回 null（不抛错） */
  async readUserWorkflow(filename: string): Promise<string | null> {
    const url = `${this.baseUrl}/userdata/${encodeURIComponent(`workflows/${filename}`)}`
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(this.requestTimeoutMs) })
      if (!resp.ok) return null
      return await resp.text()
    } catch {
      return null
    }
  }

  /**
   * 写入用户工作流，使 ComfyUI 界面「工作流」面板能直接打开。
   * 走 ComfyUI 的 /userdata 接口（前端保存工作流用的同一个端点），远程部署同样有效。
   */
  async writeUserWorkflow(filename: string, content: string): Promise<void> {
    const encoded = encodeURIComponent(`workflows/${filename}`)
    await this.request(`/userdata/${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
    }, 60_000)
  }

  /** 删除一个用户工作流（已存在时清理用） */
  async deleteUserWorkflow(filename: string): Promise<void> {
    const encoded = encodeURIComponent(`workflows/${filename}`)
    await this.request(`/userdata/${encoded}`, { method: 'DELETE' }, 30_000)
  }
}

export function describeError(error: any): string {
  if (typeof error === 'string') return error
  if (error?.message) return String(error.message)
  try { return JSON.stringify(error) } catch { return String(error) }
}

export function describeNodeErrors(nodeErrors: Record<string, any>): string {
  const parts: string[] = []
  for (const [nodeId, detail] of Object.entries(nodeErrors || {})) {
    const errors = Array.isArray(detail?.errors) ? detail.errors : []
    const message = errors.map((e: any) => [e?.message, e?.details].filter(Boolean).join('：')).filter(Boolean).join('；')
    parts.push(`节点 ${nodeId}：${message || describeError(detail)}`)
  }
  return parts.join(' | ') || '未知节点错误'
}

/** 从 history 的 outputs 里递归找指定扩展名的文件（不依赖任何 Saver 节点实现） */
export function collectFiles(
  history: ComfyHistoryEntry | undefined,
  outputNodeIds: string[],
  extensions: string[],
): { filename: string; subfolder?: string; type?: string }[] {
  const found: { filename: string; subfolder?: string; type?: string }[] = []
  const wanted = extensions.map(e => e.toLowerCase())
  const walk = (value: any) => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!value || typeof value !== 'object') return
    const filename = typeof value.filename === 'string' ? value.filename : ''
    if (filename && wanted.some(ext => filename.toLowerCase().endsWith(ext))) {
      if (!found.some(f => f.filename === filename && f.subfolder === value.subfolder)) {
        found.push({ filename, subfolder: value.subfolder, type: value.type })
      }
      return
    }
    Object.values(value).forEach(walk)
  }
  const outputs = history?.outputs || {}
  const scoped = outputNodeIds.length
    ? outputNodeIds.map(id => outputs[id]).filter(Boolean)
    : Object.values(outputs)
  scoped.forEach(walk)
  return found
}
