/**
 * 视频工作台独立 API 与项目路由映射。
 * 复用通用上传 / 任务接口，但不改动 useApi.ts 中短剧主流程的任何封装。
 */
import { api } from './useApi'

export const STUDIO_MODES = ['character_swap', 'transition'] as const
export type StudioMode = (typeof STUDIO_MODES)[number]

export function isStudioMode(value: unknown): value is StudioMode {
  return typeof value === 'string' && (STUDIO_MODES as readonly string[]).includes(value)
}

/** 项目按类型进入不同页面：短剧仍是原详情页，两种新模式走独立工作台。 */
export function projectPath(type: string | undefined, id: number | string): string {
  return isStudioMode(type) ? `/studio/${type}/${id}` : `/drama/${id}`
}

export const studioAPI = {
  modes: () => api.get<{ id: StudioMode; slots: any[]; default_prompt: string }[]>('/studio/modes'),
  materials: (projectId: number) => api.get<any[]>(`/studio/projects/${projectId}/materials`),
  addMaterial: (projectId: number, data: any) => api.post(`/studio/projects/${projectId}/materials`, data),
  delMaterial: (materialId: number) => api.del(`/studio/materials/${materialId}`),
  // 分段预览：源视频时长、镜头切点与预计生成次数
  plan: (projectId: number, configId?: number | string) => api.get<any>(
    `/studio/projects/${projectId}/plan${configId ? `?config_id=${configId}` : ''}`,
  ),
  // 返回 {task_id}（转场）或 {batch_id, segment_count}（人物替换）
  generate: (projectId: number, data: any) => api.post<any>(`/studio/projects/${projectId}/generate`, data),
  batches: (projectId: number) => api.get<any[]>(`/studio/projects/${projectId}/batches`),
  generations: (projectId: number) => api.get<any[]>(`/studio/projects/${projectId}/generations`),
  videoConfigs: () => api.get<any[]>('/ai-configs?service_type=video'),
}
