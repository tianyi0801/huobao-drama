async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '草稿验证', content: '原始', script_content: '## S1 | 内景 | 日\n小雨：你好。', resolution: '720p' }
  // 库里描述保持旧值；有一个处理中任务，会每 4 秒触发一次 refresh
  const storyboards = [
    { id: 31, storyboard_number: 1, description: '数据库里的旧描述', duration: 5, scene_id: 21, character_ids: [], prop_ids: [], video_prompt: 'subject_definitions: test' },
  ]
  const tasks = [
    { id: 901, type: 'video', status: 'processing', stage: 'running', storyboard_id: 31, provider: 'comfyui', created_at: '2026-11-06T10:00:00.000Z' },
  ]
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data = {}
    if (pathname.endsWith('/generation-tasks')) data = { tasks, merges: [] }
    else if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '草稿验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/storyboards')) data = storyboards
    else if (pathname.endsWith('/scenes')) data = [{ id: 21, location: '客厅', time: '日' }]
    else if (pathname.endsWith('/characters')) data = []
    else if (pathname.endsWith('/props')) data = []
    else if (pathname.endsWith('/ai-configs')) data = [{ id: 1, service_type: 'text', name: 't', provider: 'openai', model: ['m'], is_active: true }]
    else if (pathname.endsWith('/merges')) data = []
    else if (pathname.endsWith('/content-language')) data = { language: 'zh' }
    else if (pathname.endsWith('/tours-seen')) data = { seen: ['workbench', 'episode', 'index', 'settings'] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data }) })
  })

  await page.setViewportSize({ width: 1512, height: 950 })
  await page.goto('http://localhost:3013/drama/1/episode/1')
  await page.locator('.pipe-item').filter({ hasText: '视频制作' }).click()
  await page.waitForTimeout(1200)

  const area = page.locator('.video-inspector-section textarea').first()
  await area.click()
  await area.fill('')
  await area.type('正在编辑的新描述，不能被打断', { delay: 30 })
  const typed = await area.inputValue()
  // 等两轮轮询刷新（4 秒一次）
  await page.waitForTimeout(9000)
  const afterRefresh = await area.inputValue()
  if (afterRefresh !== typed) {
    throw new Error(`刷新覆盖了正在编辑的内容：\n输入=${typed}\n刷新后=${afterRefresh}`)
  }
  // 失焦后应写入后端（mock 只记录，不校验库）
  await page.locator('.video-inspector-label').first().click()
  await page.waitForTimeout(600)
  return { typed, afterRefresh, kept: afterRefresh === typed }
}
