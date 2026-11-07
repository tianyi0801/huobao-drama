async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:theme', 'dark')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
    // 重生成会弹计费确认，测试里直接放行
    window.confirm = () => true
  })
  const episode = { id: 1, episode_number: 1, title: '重试验证', content: '原始', script_content: '## S1 | 内景 | 日\n小雨：你好。', resolution: '720p' }
  const storyboards = [
    { id: 12, storyboard_number: 1, description: '被取消的分镜', duration: 5, scene_id: 21, character_ids: [], prop_ids: [], video_prompt: 'subject_definitions: test' },
  ]
  const tasks = [
    { id: 601, type: 'video', status: 'failed', error_code: 'cancelled', error_msg: '任务已取消', storyboard_id: 12, provider: 'comfyui', task_id: 'gone', created_at: '2026-11-06T09:00:00.000Z' },
  ]
  let submitted = null
  await page.route('**/api/v1/**', async route => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    if (req.method() === 'POST' && pathname.endsWith('/tasks')) {
      submitted = JSON.parse(req.postData() || '{}')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data: { id: 777 } }) })
      return
    }
    if (req.method() === 'GET' && /\/tasks\/\d+$/.test(pathname)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data: { id: 777, status: 'processing' } }) })
      return
    }
    let data = {}
    if (pathname.endsWith('/generation-tasks')) data = { tasks, merges: [] }
    else if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '重试验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/storyboards')) data = storyboards
    else if (pathname.endsWith('/scenes')) data = [{ id: 21, location: '客厅', time: '日', image_url: 'static/images/s.png' }]
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
  await page.waitForTimeout(1500)

  const action = page.locator('.video-inspector-action')
  const label = (await action.innerText()).trim()
  if (!/重新生成/.test(label)) throw new Error(`取消后按钮文案不是重新生成：${label}`)
  await action.click()
  await page.waitForTimeout(1500)
  if (!submitted) throw new Error('点击重新生成后没有发出 POST /tasks')
  if (submitted.force_new !== true) throw new Error(`重新生成未带 force_new：${JSON.stringify(submitted).slice(0, 200)}`)
  return { label, forceNew: submitted.force_new, storyboardId: submitted.storyboard_id }
}
