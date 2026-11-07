async page => {
  await page.addInitScript(() => {
    localStorage.setItem('huobao:locale', 'zh')
    localStorage.setItem('huobao:tours', JSON.stringify(['workbench', 'episode', 'index', 'settings']))
  })
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.goto('http://localhost:3013/settings')
  await page.waitForTimeout(1500)
  const url = page.locator('.le-url')
  await url.waitFor({ timeout: 8000 })
  await url.click()
  await url.fill('')
  await url.type('http://192.168.1.9:8188', { delay: 40 })
  const typed = await url.inputValue()
  await page.waitForTimeout(900)
  const afterIdle = await url.inputValue()
  return { typed, afterIdle, stable: typed === afterIdle }
}
