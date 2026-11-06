async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '一采预览验证', content: '原始', script_content: '## S1 | 内景 | 日\n小雨：你好。', resolution: '720p' }
  const storyboards = [
    { id: 41, storyboard_number: 1, description: '二采处理中', duration: 5, scene_id: 21, character_ids: [], prop_ids: [], video_prompt: 'subject_definitions: t' },
  ]
  const tasks = [
    {
      id: 901, type: 'video', status: 'processing', stage: 'running', storyboard_id: 41, provider: 'comfyui',
      created_at: '2026-11-06T20:00:00.000Z',
      first_pass_ready: true, first_pass_url: '/api/v1/tasks/901/first-pass', preview_progress: 38,
    },
  ]
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data = {}
    if (pathname.endsWith('/generation-tasks')) data = { tasks, merges: [] }
    else if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '一采预览验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/storyboards')) data = storyboards
    else if (pathname.endsWith('/scenes')) data = [{ id: 21, location: '客厅', time: '日' }]
    else if (pathname.endsWith('/characters')) data = []
    else if (pathname.endsWith('/props')) data = []
    else if (pathname.endsWith('/ai-configs')) data = [{ id: 1, service_type: 'text', name: 't', provider: 'openai', model: ['m'], is_active: true }]
    else if (pathname.endsWith('/merges')) data = []
    else if (pathname.endsWith('/content-language')) data = { language: 'zh' }
    else if (pathname.endsWith('/tours-seen')) data = { seen: ['workbench', 'episode', 'index', 'settings'] }
    else if (pathname.endsWith('/tasks/901')) data = tasks[0]
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data }) })
  })

  await page.setViewportSize({ width: 1512, height: 950 })
  await page.goto('http://localhost:3013/drama/1/episode/1')
  await page.locator('.pipe-item').filter({ hasText: '视频制作' }).click()
  await page.waitForTimeout(1600)

  const video = page.locator('.video-player-video')
  await video.waitFor({ timeout: 6000 })
  const src = await video.getAttribute('src')
  if (!src || !src.includes('/api/v1/tasks/901/first-pass')) throw new Error(`播放器没切到一采地址：${src}`)
  const badge = await page.locator('.video-first-pass-tag').innerText().catch(() => '')
  if (!/一采预览/.test(badge)) throw new Error(`缺少一采预览标记：${badge}`)
  await page.screenshot({ path: '.playwright-cli/first-pass-preview.png' })
  return { src, badge: badge.trim() }
}
