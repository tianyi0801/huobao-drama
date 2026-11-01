import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('character image generation uses 16:9 asset size', () => {
  const source = read('src/routes/characters.ts')

  // 素材图固定 16:9，像素改为按集清晰度档（480p/720p/1080p）推导，不再硬编码 1920x1080
  assert.match(source, /CHARACTER_ASPECT_RATIO = '16:9'/)
  assert.match(source, /computeImageSize\(CHARACTER_ASPECT_RATIO, ep\.resolution\)/)
  assert.doesNotMatch(source, /CHARACTER_IMAGE_SIZE/)
  assert.match(source, /16:9 横版角色定妆照/)
  assert.match(source, /半身角色海报构图/)
})
