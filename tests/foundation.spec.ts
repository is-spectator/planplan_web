import { expect, test } from '@playwright/test'

test('页面可导航、返回、深链接刷新，并有未找到页面', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page).toHaveURL('/chat')
  await expect(page).toHaveTitle('对话 · PlanPlan')
  await expect(page.getByRole('heading', { name: '你好，想管理点什么？' })).toBeVisible()
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '计划' }).click()
  await expect(page).toHaveURL('/plans')
  await page.reload()
  await expect(page.getByRole('heading', { name: '登录后，开始积累' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/chat')
  await page.goto('/plans/test-plan')
  await expect(page.getByRole('heading', { name: '登录后，开始积累' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '登录后，开始积累' })).toBeVisible()
  await page.goto('/missing')
  await expect(page.getByRole('heading', { name: '这个页面不在这里' })).toBeVisible()
  await page.getByRole('link', { name: '返回对话' }).click()
  await expect(page).toHaveURL('/chat')
  expect(errors).toEqual([])
})

test('示例只填入草稿，不写入后端或本机持久存储', async ({ page }) => {
  const businessRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method())) businessRequests.push(request.url())
  })
  await page.goto('/chat')
  await page.getByRole('button', { name: /我想省钱，帮我记账/ }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('我想省钱，帮我记账')
  await expect(page.getByRole('textbox', { name: '消息' })).toBeFocused()
  await page.getByRole('textbox', { name: '消息' }).fill('午饭 20 元')
  await page.getByRole('textbox', { name: '消息' }).press('Enter')
  await expect(page.getByRole('button', { name: /发送消息/ })).toBeDisabled()
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([])
  await page.reload()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('')
  expect(businessRequests).toEqual([])
})

test('主题持久化、跟随系统，并同步到同源标签页', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/me')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('radio', { name: '深色', exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.getByRole('radio', { name: '深色', exact: true })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const other = await context.newPage()
  await other.goto('/me')
  await other.getByRole('radio', { name: '浅色', exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('radio', { name: '跟随系统', exact: true }).check()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('手机宽度的导航和输入框可用，没有水平溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  const navigation = page.getByRole('navigation', { name: '底部导航' })
  await expect(navigation).toBeVisible()
  await page.getByRole('button', { name: /每周阅读 5 天/ }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('每周阅读 5 天，每天 20 分钟')
  for (const label of ['计划', '我的', '对话']) {
    await navigation.getByRole('link', { name: label, exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 320, height: 640 })
  await expect(navigation.getByRole('link', { name: '我的' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const label of ['对话', '计划', '我的']) {
    const isSingleLine = await navigation.getByRole('link', { name: label, exact: true }).locator('span').evaluate(
      (element) => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) * 1.1,
    )
    expect(isSingleLine).toBe(true)
  }
  await navigation.getByRole('link', { name: '我的' }).click()
  await page.getByRole('radio', { name: '深色', exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('浏览器禁止本机存储时仍能打开页面和切换主题', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError') },
    })
  })
  await page.goto('/me')
  await expect(page.getByRole('heading', { name: '我的', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: '深色', exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
