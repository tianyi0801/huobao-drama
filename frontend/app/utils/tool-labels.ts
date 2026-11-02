/**
 * Agent 工具名 → 人类可读文案
 *
 * 背景：i18n 里的工具键用 snake_case（read_existing_scenes），
 * 但 Mastra / agent 侧上报的 toolName 可能是 camelCase（readExistingScenes）。
 * 这里统一归一化后再查文案，避免界面上直接暴露代码里的驼峰标识。
 */

/** camelCase / kebab-case / 混写 → snake_case（已是 snake_case 时原样返回） */
export function toSnakeCaseTool(name?: string | null): string {
  if (!name) return ''
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** 在给定命名空间下查工具文案，未登记则回退原始名 */
export function resolveToolLabel(
  t: (key: string) => string,
  te: (key: string) => boolean,
  namespace: string,
  name?: string | null,
): string {
  if (!name) return ''
  const snake = toSnakeCaseTool(name)
  for (const candidate of [snake, name]) {
    const key = `${namespace}.tool.${candidate}`
    if (te(key)) return t(key)
  }
  return name
}
