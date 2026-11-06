async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:theme', 'dark')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '状态验证', content: '原始', script_content: '## S1 | 内景 | 日\n小雨：你好。', resolution: '720p' }
  // 分镜 1：已有旧视频，且有一个新的处理中任务（重新生成）
  // 分镜 2：无视频，最新任务被取消
  const storyboards = [
    { id: 11, storyboard_number: 1, description: '已有视频的分镜', duration: 5, scene_id: 21, character_ids: [], prop_ids: [], video_url: 'static/videos/old.mp4', video_prompt: 'subject_definitions: x' },
    { id: 12, storyboard_number: 2, description: '被取消的分镜', duration: 5, scene_id: 21, character_ids: [], prop_ids: [] },
  ]
  const tasks = [
    { id: 501, type: 'video', status: 'processing', stage: 'running', storyboard_id: 11, provider: 'comfyui', created_at: '2026-11-06T10:00:00.000Z' },
    { id: 500, type: 'video', status: 'completed', storyboard_id: 11, provider: 'comfyui', created_at: '2026-11-05T10:00:00.000Z' },
    { id: 601, type: 'video', status: 'failed', error_code: 'cancelled', error_msg: '任务已取消', storyboard_id: 12, provider: 'comfyui', created_at: '2026-11-06T09:00:00.000Z' },
  ]
  let submitted = null
  await page.route('**/api/v1/**', async route => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    let data = {}
    if (req.method() === 'POST' && pathname.endsWith('/tasks')) {
      submitted = JSON.parse(req.postData() || '{}')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data: { id: 777 } }) })
      return
    }
    if (pathname.endsWith('/generation-tasks')) data = { tasks, merges: [] }
    else if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '状态验证', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
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

  // 分镜 1：重新生成中，应显示生成中而不是「重新生成」
  await page.locator('.video-task-row, .video-shot-item, [class*=video-task]').first().waitFor({ timeout: 5000 }).catch(() => {})
  const bodyText = await page.locator('.content-panel').innerText()
  const hasGenerating = /生成中|排队中/.test(bodyText)
  if (!hasGenerating) throw new Error('重新生成中的分镜没有显示生成中：\n' + bodyText.slice(0, 400))

  // 分镜 2：已取消，应显示「重新生成」而不是「恢复」
  const restoreBtn = await page.getByRole('button', { name: '恢复任务' }).count()
  if (restoreBtn > 0) throw new Error('已取消的任务仍显示「恢复」按钮')
  if (/任务已取消/.test(bodyText) && /失败/.test(bodyText)) throw new Error('取消的任务仍按失败展示：\n' + bodyText.slice(0, 300))

  await page.screenshot({ path: '.playwright-cli/video-state-check.png' })
  return { hasGenerating, restoreBtn, sample: bodyText.slice(0, 200) }
}
