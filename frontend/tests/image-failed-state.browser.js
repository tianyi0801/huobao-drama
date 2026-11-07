async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:theme', 'dark')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '失败态验证', content: '原始', script_content: '## S1 | 内景 · 教室 | 日\n小雨：你好。', resolution: '720p' }
  const characters = [
    { id: 21, name: '老太太子', role: '龙套', appearance: '老年女性', styling: '深色棉袄' },
  ]
  const failedTask = { id: 9001, type: 'image', status: 'failed', character_id: 21, error_msg: '显存不足，ComfyUI 任务失败', created_at: '2026-11-04T12:00:00.000Z' }
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data = {}
    if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '失败态验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/characters')) data = characters
    else if (pathname.endsWith('/scenes')) data = []
    else if (pathname.endsWith('/props')) data = []
    else if (pathname.endsWith('/storyboards')) data = []
    else if (pathname.endsWith('/generation-tasks')) data = { tasks: [failedTask], merges: [] }
    else if (pathname.endsWith('/ai-configs')) data = [{ id: 1, service_type: 'text', name: '测试模型', provider: 'openai', model: ['offline'], is_active: true }]
    else if (pathname.endsWith('/merges')) data = []
    else if (pathname.endsWith('/content-language')) data = { language: 'zh' }
    else if (pathname.endsWith('/tours-seen')) data = { seen: ['workbench', 'episode', 'index', 'settings'] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data }) })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost:3013/drama/1/episode/1')
  await page.locator('.pipe-item').filter({ hasText: '资产制作' }).click()
  const card = page.locator('.asset-card, .asset-item').filter({ hasText: '老太太子' }).first()
  await page.waitForTimeout(1200)
  const badge = await card.locator('.asset-cover-badge').innerText()
  const button = await card.locator('.character-gen-btn').innerText()
  const spinning = await card.locator('.character-gen-btn .animate-spin').count()
  const disabled = await card.locator('.character-gen-btn').isDisabled()
  if (badge.includes('生成中')) throw new Error(`失败任务仍显示生成中：${badge}`)
  if (button.includes('生成中')) throw new Error(`按钮仍显示生成中：${button}`)
  if (spinning) throw new Error('按钮仍有转圈图标')
  if (disabled) throw new Error('失败后按钮仍被禁用，无法重试')
  await page.screenshot({ path: '.playwright-cli/image-failed-state.png', clip: { x: 150, y: 100, width: 700, height: 320 } })
  return { badge: badge.trim(), button: button.trim(), spinning, disabled }
}
