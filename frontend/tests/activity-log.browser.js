async page => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:theme', 'light')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  const episode = { id: 1, episode_number: 1, title: '日志界面验证', content: '雨夜，女孩走进教室。', script_content: '## S1 | 内景 · 教室 | 夜\n小雨：（抬头）你听见了吗？', resolution: '720p' }
  const storyboards = [{ id: 1, storyboard_number: 1, description: '窗外下雨，女孩抬头。', duration: 5, character_ids: [], prop_ids: [], video_prompt: 'subject_definitions: N/A\nshot_summary: 窗外雨景' }]
  const sse = []
  const emit = (event, data) => sse.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  emit('start', { agent: 'storyboard_breaker' })
  emit('tool-call', { id: 'read', name: 'read_storyboard_context' })
  emit('tool-result', { id: 'read', ok: true })
  for (let i = 0; i < 70; i++) {
    emit('tool-call', { id: `save-${i}`, name: 'save_storyboards' })
    emit('tool-result', { id: `save-${i}`, ok: true, preview: JSON.stringify({ count: 2, message: '分镜已保存' }) })
    emit('saved', { tool: 'save_storyboards', count: 2 })
  }
  emit('text', { text: '本集分镜已按批次保存，场景与角色绑定已完成。\n'.repeat(30) })
  emit('done', { elapsedMs: 90000 })
  const extractionLogs = [
    { id: 1, at: Date.now() - 15000, kind: 'start' },
    { id: 2, at: Date.now() - 14000, kind: 'tool', tool: 'readScriptForExtraction' },
    { id: 3, at: Date.now() - 13000, kind: 'tool', tool: 'readExistingCharacters' },
    { id: 4, at: Date.now() - 12000, kind: 'saved', tool: 'saveDedupCharacters', created: 2, merged: 3 },
    { id: 5, at: Date.now() - 11000, kind: 'text', chars: 26, text: '已提取小雨与老师，补齐年龄、服装和外貌，并复用已有角色。' },
    { id: 6, at: Date.now() - 1000, kind: 'done', steps: 4 },
  ]
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (pathname.endsWith('/agent/storyboard_breaker/stream')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse.join('') })
      return
    }
    if (pathname.endsWith('/extract-log')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: extractionLogs.map(entry => `event: log\ndata: ${JSON.stringify(entry)}\n\n`).join('') })
      return
    }
    let data = {}
    if (pathname.endsWith('/dramas/1')) data = { id: 1, title: '日志面板测试', style: 'realistic', aspect_ratio: '16:9', episodes: [episode] }
    else if (pathname.endsWith('/storyboards')) data = storyboards
    else if (pathname.endsWith('/characters')) data = [{ id: 1, name: '小雨', appearance: '短发少女', styling: '灰色外套' }]
    else if (pathname.endsWith('/scenes')) data = [{ id: 1, location: '教室', time: '夜' }]
    else if (pathname.endsWith('/props')) data = []
    else if (pathname.endsWith('/ai-configs')) data = [{ id: 1, service_type: 'text', name: '测试模型', provider: 'openai', model: ['offline'], is_active: true }]
    else if (pathname.endsWith('/generation-tasks')) data = { tasks: [], merges: [] }
    else if (pathname.endsWith('/merges')) data = []
    else if (pathname.endsWith('/content-language')) data = { language: 'zh' }
    else if (pathname.endsWith('/tours-seen')) data = { seen: ['workbench', 'episode', 'index', 'settings'] }
    else if (pathname.endsWith('/extract-status')) data = { characters: null, scenes: null, props: null }
    else if (pathname.endsWith('/video-prompts-status')) data = null
    else if (pathname.endsWith('/workspace-notice')) data = { notice: null }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data }) })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost:3013/drama/1/episode/1')
  await page.locator('.pipe-item').filter({ hasText: '视频制作' }).click()
  await page.locator('.prod-section-bar button').filter({ hasText: '重新拆分' }).click()
  await page.locator('.agent-live-metrics').getByText('已写入 140 个分镜', { exact: true }).waitFor()
  const panel = page.locator('.agent-live')
  const collapsed = await panel.boundingBox()
  if (collapsed.height > 130) throw new Error(`折叠日志过高：${collapsed.height}`)
  if (await panel.locator('.agent-live-details').count()) throw new Error('日志不应默认展开')
  await panel.locator('.agent-live-toggle').click()
  const expanded = await panel.boundingBox()
  if (expanded.height > 361) throw new Error(`展开日志超出上限：${expanded.height}`)
  const groupedRows = await panel.locator('.agent-live-tools li').count()
  if (groupedRows > 3) throw new Error(`重复写入未聚合：${groupedRows}行`)
  await panel.getByText('写入分镜', { exact: true }).waitFor()
  await page.screenshot({ path: '.playwright-cli/log-ui-light.png' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: '.playwright-cli/log-ui-dark.png' })
  await page.locator('.pipe-item').filter({ hasText: '资产制作' }).click()
  await page.locator('.live-log-trigger').first().click()
  const popover = page.locator('.live-log-panel')
  await popover.getByText('新增', { exact: true }).waitFor()
  await popover.getByText('已提取小雨与老师，补齐年龄、服装和外貌，并复用已有角色。', { exact: true }).waitFor()
  const logStyle = await popover.evaluate(el => ({ height: el.getBoundingClientRect().height, background: getComputedStyle(el).backgroundColor }))
  if (logStyle.height > 441 || logStyle.background === 'rgba(0, 0, 0, 0)') throw new Error(`浮层无界或透明：${JSON.stringify(logStyle)}`)
  await page.screenshot({ path: '.playwright-cli/log-ui-extraction.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.live-log-trigger').first().click()
  const mobile = await popover.boundingBox()
  if (mobile.x < 0 || mobile.x + mobile.width > 391 || mobile.y < 0 || mobile.y + mobile.height > 845) throw new Error(`移动视口浮层越界：${JSON.stringify(mobile)}`)
  await page.screenshot({ path: '.playwright-cli/log-ui-mobile.png' })
  if (errors.length) throw new Error(errors.join('\n'))
  return { collapsedHeight: collapsed.height, expandedHeight: expanded.height, groupedRows, logStyle, mobileWidth: mobile.width, errors }
}
