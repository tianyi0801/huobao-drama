async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:theme', 'dark')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '暗色徽标验证', content: '原始内容', script_content: '## S1 | 内景 · 教室 | 日\n小雨：你好。', resolution: '720p' }
  const scenes = [
    { id: 11, location: '教学楼前楼梯', time: '日', prompt: '楼梯旁的树影', lighting: '日光' },
    { id: 12, location: '小区楼道', time: '夜', prompt: '昏暗走廊', lighting: '声控灯' },
    { id: 13, location: '林墨家客厅', time: '夜', prompt: '客厅', lighting: '暖光' },
  ]
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data = {}
    if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '暗色验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/scenes')) data = scenes
    else if (pathname.endsWith('/characters')) data = []
    else if (pathname.endsWith('/props')) data = []
    else if (pathname.endsWith('/storyboards')) data = []
    else if (pathname.endsWith('/ai-configs')) data = [{ id: 1, service_type: 'text', name: '测试模型', provider: 'openai', model: ['offline'], is_active: true }]
    else if (pathname.endsWith('/generation-tasks')) data = { tasks: [], merges: [] }
    else if (pathname.endsWith('/merges')) data = []
    else if (pathname.endsWith('/content-language')) data = { language: 'zh' }
    else if (pathname.endsWith('/tours-seen')) data = { seen: ['workbench', 'episode', 'index', 'settings'] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data }) })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost:3013/drama/1/episode/1')
  await page.locator('.pipe-item').filter({ hasText: '资产制作' }).click()
  const badge = page.locator('.asset-cover-badge').filter({ hasText: '待生成' }).first()
  await badge.waitFor()

  const parse = color => {
    const m = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
  }
  const lum = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const style = await badge.evaluate(el => {
    const cs = getComputedStyle(el)
    const cover = el.parentElement
    return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor, coverBg: getComputedStyle(cover).backgroundColor }
  })
  const fg = parse(style.color)
  const bg = parse(style.bg)
  const under = parse(style.coverBg)
  // 背景可能带透明度：与缩略图底色合成后再算对比度
  const alpha = bg?.a ?? 1
  const solid = bg && under ? {
    r: bg.r * alpha + under.r * (1 - alpha),
    g: bg.g * alpha + under.g * (1 - alpha),
    b: bg.b * alpha + under.b * (1 - alpha),
  } : bg
  const ratio = (Math.max(lum(fg), lum(solid)) + 0.05) / (Math.min(lum(fg), lum(solid)) + 0.05)
  if (ratio < 4.5) throw new Error(`暗色徽标对比度不足：${ratio.toFixed(2)} | ${JSON.stringify(style)}`)
  await page.screenshot({ path: '.playwright-cli/asset-badge-dark.png', clip: { x: 150, y: 240, width: 800, height: 320 } })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(200)
  const lightStyle = await badge.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
  const lf = parse(lightStyle.color)
  const lb = parse(lightStyle.bg)
  const lightRatio = (Math.max(lum(lf), lum(lb)) + 0.05) / (Math.min(lum(lf), lum(lb)) + 0.05)
  if (lightRatio < 4.5) throw new Error(`浅色徽标对比度不足：${lightRatio.toFixed(2)} | ${JSON.stringify(lightStyle)}`)
  await page.screenshot({ path: '.playwright-cli/asset-badge-light.png', clip: { x: 150, y: 240, width: 800, height: 320 } })
  return { dark: { ratio: +ratio.toFixed(2), ...style }, light: { ratio: +lightRatio.toFixed(2), ...lightStyle } }
}
