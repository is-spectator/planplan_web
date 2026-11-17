import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { inflateRawSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Action, OperationResult, PlansResponse, StudyView, TemplatePlanState } from '../src/lib/contracts'

// Explicit isolated account: these tests disable AI and archive only their own plans.
const email = process.env.PLANPLAN_TEMPLATE_E2E_EMAIL
const password = process.env.PLANPLAN_TEMPLATE_E2E_PASSWORD
let state: Awaited<ReturnType<BrowserContext['storageState']>> | null = null

async function screenshot(page: Page, name: string) {
  const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: join(directory, name), fullPage: true })
}

function consoleHealth(page: Page, allowed: number[] = [], disconnected = false) {
  const problems: string[] = []
  page.on('console', (message) => {
    if (!['warning', 'error'].includes(message.type())) return
    const text = message.text()
    const url = message.location().url
    if (url.includes('/v1/auth/web/session') && /\b401\b/.test(text)) return // Anonymous session probe is expected.
    if (allowed.some((status) => new RegExp(`\\b${status}\\b`).test(text)) && url.includes('/v1/operations')) return
    if (disconnected && url.includes('/v1/operations') && /ERR_(?:CONNECTION_)?FAILED|Load failed|cancelled|canceled/i.test(text)) return
    problems.push(text)
  })
  return problems
}

test('公开市场试填与登录返回路径可用，不产生业务写入', async ({ page }, testInfo) => {
  const writes: string[] = []
  const errors: string[] = []
  const consoleProblems = consoleHealth(page)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (request.url().includes('/v1/') && request.method() !== 'GET') writes.push(request.url()) })
  await page.goto('/market')
  await expect(page).toHaveTitle('市场 · PlanPlan')
  await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: '阅读', exact: true }) }).click()
  await expect(page.getByRole('heading', { name: '阅读', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '功能简介', exact: true })).toBeVisible()
  await expect(page.getByLabel('试填阅读时长（分钟）')).toBeHidden()
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByLabel('试填阅读时长（分钟）').fill('60')
  await page.getByRole('button', { name: '加入试填' }).click()
  await expect(page.locator('.template-preview-summary')).toContainText('60')
  await screenshot(page, `${testInfo.project.name}-market-desktop.png`)
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot(page, `${testInfo.project.name}-market-390.png`)
  await page.setViewportSize({ width: 320, height: 720 })
  await screenshot(page, `${testInfo.project.name}-market-320.png`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('navigation', { name: '底部导航' }).getByRole('link', { name: '市场', exact: true })).toBeVisible()
  for (const label of ['对话', '计划', '市场', '我的']) {
    const fits = await page.getByRole('navigation', { name: '底部导航' }).getByRole('link', { name: label, exact: true }).evaluate((link) => {
      const text = link.querySelector('span')!
      const box = text.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.height <= parseFloat(getComputedStyle(text).lineHeight) * 1.1
    })
    expect(fits, `${label} 在 320px 完整单行显示`).toBe(true)
  }
  await page.getByRole('link', { name: '登录后使用' }).click()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/market/official.reading')
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  await page.goBack()
  await expect(page.locator('.template-preview-summary')).toContainText('0 条示例')
  expect(writes).toEqual([])
  expect(errors).toEqual([])
  expect(consoleProblems).toEqual([])
})

test.describe('真实阅读模板手动闭环', () => {
  test.skip(!email || !password, '需要 PLANPLAN_TEMPLATE_E2E_EMAIL/PASSWORD 指定可关闭 AI 的隔离账户')
  test.describe.configure({ mode: 'serial', timeout: 60_000 })
  let created: string[] = []
  let consoleProblems: string[] = []

  async function headers(page: Page) {
    const response = await page.request.get('/v1/auth/web/session')
    expect(response.ok()).toBe(true)
    const session = await response.json() as { userId: string; csrfToken: string }
    return { Origin: new URL(page.url()).origin, 'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrfToken, 'X-PlanPlan-Capabilities': 'reading-template-v1' }
  }
  async function read<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(path, { headers: await headers(page) })
    expect(response.ok()).toBe(true)
    return await response.json() as T
  }
  async function post(page: Page, actions: Action[]) {
    const response = await page.request.post('/v1/operations', { headers: await headers(page), data: { clientOpId: crypto.randomUUID(), inputAt: new Date().toISOString(), actions } })
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json() as OperationResult
  }
  async function operation(page: Page, click: () => Promise<void>, status = 200) {
    const wait = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
    await click()
    const response = await wait
    expect(response.status()).toBe(status)
    return { result: await response.json() as OperationResult, body: response.request().postDataJSON() }
  }
  async function adopt(page: Page) {
    await page.goto('/market/official.reading')
    const { result } = await operation(page, () => page.getByRole('button', { name: '使用模板', exact: true }).click())
    const id = result.templatePlan!.planId
    created.push(id)
    await expect(page).toHaveURL(new RegExp(`/plans/${id}\\?setup=1$`))
    await expect(page.getByRole('heading', { name: '让计划更适合你' })).toBeVisible()
    return id
  }
  async function study(page: Page, id: string) { return read<StudyView>(page, `/v1/plans/${id}/study`) }
  function zipText(zip: Buffer, wanted: string) {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(end).toBeGreaterThanOrEqual(0)
    let cursor = zip.readUInt32LE(end + 16)
    for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
      const length = zip.readUInt16LE(cursor + 28)
      const name = zip.subarray(cursor + 46, cursor + 46 + length).toString()
      if (name === wanted) {
        const local = zip.readUInt32LE(cursor + 42)
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
        const bytes = zip.subarray(start, start + zip.readUInt32LE(cursor + 20))
        const method = zip.readUInt16LE(cursor + 10)
        expect([0, 8]).toContain(method)
        return (method === 8 ? inflateRawSync(bytes) : bytes).toString()
      }
      cursor += 46 + length + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32)
    }
    throw new Error(`ZIP 缺少 ${wanted}`)
  }

  test.beforeEach(async ({ page }, testInfo) => {
    created = []
    consoleProblems = consoleHealth(page, testInfo.title.includes('冲突') ? [409] : [], testInfo.title.includes('丢响应'))
    const statePath = process.env.PLANPLAN_TEMPLATE_E2E_STORAGE_STATE
    if (!state && statePath) {
      try { state = JSON.parse(await readFile(statePath, 'utf8')) as NonNullable<typeof state> }
      catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason }
    }
    if (state) { await page.context().addCookies(state.cookies); await page.goto('/plans') }
    else {
      await page.goto('/login')
      await page.getByLabel('邮箱', { exact: true }).fill(email!)
      await page.getByLabel('密码', { exact: true }).fill(password!)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(page).toHaveURL('/plans')
      const disabled = await page.request.put('/v1/me/ai-consent', { headers: await headers(page), data: { granted: false } })
      expect(disabled.ok(), await disabled.text()).toBe(true)
      state = await page.context().storageState()
      if (statePath) await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
      await page.reload()
    }
    const me = await read<{ aiConsent: boolean }>(page, '/v1/me')
    expect(me.aiConsent).toBe(false)
    if (new URL(page.url()).pathname === '/plans') {
      await expect(page.getByRole('button', { name: '新建计划', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '刷新计划', exact: true })).toBeEnabled()
    }
  })
  test.afterEach(async ({ page }) => {
    for (const id of created) {
      const plans = await read<PlansResponse>(page, '/v1/plans?status=active')
      if (plans.plans.some((item) => item.plan.id === id)) await post(page, [{ type: 'archive_plan', planId: id }])
    }
    expect(consoleProblems).toEqual([])
  })

  test('无AI选用、设置与25→35分钟：原记录备注保留，刷新/导出一致，可删除及归档恢复', async ({ page }, testInfo) => {
    const aiWrites: string[] = []
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/chat' && request.method() === 'POST') aiWrites.push(request.url()) })
    const before = await read<PlansResponse>(page, '/v1/plans?status=active')
    await page.goto('/market/official.reading')
    await page.getByText('试填体验', { exact: true }).click()
    await page.getByLabel('试填阅读时长（分钟）').fill('60')
    await page.getByRole('button', { name: '加入试填' }).click()
    expect((await read<PlansResponse>(page, '/v1/plans?status=active')).plans).toEqual(before.plans)
    const id = await adopt(page)
    const name = `QA阅读${Date.now().toString().slice(-9)}`
    await page.getByLabel('计划名称', { exact: true }).fill(name)
    await page.getByLabel('当前书籍（可留空）').fill('合成阅读书籍')
    await page.getByLabel('每周目标天数（可留空）').fill('5')
    await page.getByLabel('每日目标分钟（可留空）').fill('20')
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    expect((await study(page, id)).records).toHaveLength(0)
    expect((await study(page, id)).stats.totalMinutes).toBe(0)
    await page.getByRole('button', { name: '记录阅读', exact: true }).click()
    await page.getByLabel('阅读时长（分钟）').fill('25')
    await expect(page.getByLabel('书名（可留空）')).toHaveValue('合成阅读书籍')
    await page.getByLabel('阅读位置（可留空）').fill('第 35 页')
    await page.getByLabel('备注（可留空）').fill('QA午休阅读')
    const added = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    const record = added.result.items.find((item) => item.type === 'study_added')!
    expect(record.type).toBe('study_added')
    if (record.type !== 'study_added') throw new Error('没有新增阅读回执')
    await page.locator('.record-row').filter({ hasText: 'QA午休阅读' }).click()
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('阅读时长（分钟）').fill('35')
    const edited = await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    expect(edited.body.actions[0].expectedVersion).toBe(record.record.version)
    await expect(page.locator('.record-inspector')).toHaveCount(0)
    await page.reload()
    const result = await study(page, id)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ id: record.record.id, minutes: 35, note: record.record.note })
    expect(result.stats).toMatchObject({ totalMinutes: 35, recordDays: 1, metDays: 1 })
    await expect(page.getByRole('region', { name: '阅读统计' })).toContainText('35')
    await screenshot(page, `${testInfo.project.name}-reading-35-desktop.png`)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await screenshot(page, `${testInfo.project.name}-reading-35-390.png`)
    await page.setViewportSize({ width: 320, height: 720 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await screenshot(page, `${testInfo.project.name}-reading-35-320.png`)
    const exported = await page.request.get('/v1/export', { headers: await headers(page) })
    expect(exported.ok()).toBe(true)
    const zip = await exported.body()
    const templates = JSON.parse(zipText(zip, 'templates.json')) as { templates: TemplatePlanState[] }
    expect(templates.templates.find((item) => item.planId === id)?.config.currentBook).toBe('合成阅读书籍')
    const csv = zipText(zip, 'study.csv')
    expect(csv).toContain(record.record.id)
    expect(csv).toContain('阅读位置：第 35 页')
    expect(csv).toContain(',35,')
    await page.locator('.record-row').filter({ hasText: 'QA午休阅读' }).click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    expect((await study(page, id)).records).toHaveLength(0)
    await page.getByRole('button', { name: '归档计划', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认归档', exact: true }).click())
    await operation(page, () => page.getByRole('button', { name: '恢复计划', exact: true }).click())
    expect((await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)).config.currentBook).toBe('合成阅读书籍')
    expect(aiWrites).toEqual([])
    expect(errors).toEqual([])
  })

  test('可跳过目标立即记录，撤销记录后不留下完成量', async ({ page }) => {
    const id = await adopt(page)
    await operation(page, () => page.getByRole('button', { name: '暂不设置，开始记录' }).click())
    expect((await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)).config).toMatchObject({ setupStatus: 'ready', daysPerWeek: null, minMinutes: null })
    await page.getByRole('button', { name: '记录阅读', exact: true }).click()
    await page.getByLabel('阅读时长（分钟）').fill('25')
    await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    await page.getByRole('button', { name: '撤销这次更改' }).click()
    const undoResponse = page.waitForResponse((response) => response.url().includes('/undo') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '确认撤销更改' }).click()
    expect((await undoResponse).ok()).toBe(true)
    await expect.poll(async () => (await study(page, id)).stats.totalMinutes).toBe(0)
  })

  test('选用已提交但丢响应，刷新用原ID核对进入唯一计划', async ({ page }) => {
    const before = await read<PlansResponse>(page, '/v1/plans?status=active')
    let originalId = ''
    let planId = ''
    await page.route('**/v1/operations', async (route) => {
      const body = route.request().postDataJSON()
      if (body.actions?.[0]?.type !== 'adopt_template') return route.continue()
      originalId = body.clientOpId
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      const result = await response.json() as OperationResult
      planId = result.templatePlan!.planId
      created.push(planId)
      await route.abort('connectionfailed')
    })
    await page.goto('/market/official.reading')
    await page.getByRole('button', { name: '使用模板', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.unroute('**/v1/operations')
    await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/plans/${planId}\\?setup=1$`))
    const after = await read<PlansResponse>(page, '/v1/plans?status=active')
    expect(after.plans).toHaveLength(before.plans.length + 1)
    expect(after.plans.filter((item) => item.plan.id === planId)).toHaveLength(1)
    const recovered = await read<{ result: OperationResult }>(page, `/v1/operations/${originalId}`)
    expect(recovered.result.templatePlan?.planId).toBe(planId)
  })

  test('设置丢响应后原ID恢复：配置版本只增加一次，不生成记录', async ({ page }) => {
    const id = await adopt(page)
    const before = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    let originalId = ''
    await page.getByLabel('当前书籍（可留空）').fill('QA设置恢复')
    await page.route('**/v1/operations', async (route) => {
      const body = route.request().postDataJSON()
      if (body.actions?.[0]?.type !== 'configure_reading_plan') return route.continue()
      originalId = body.clientOpId
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('connectionfailed')
    })
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.unroute('**/v1/operations')
    await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
    const after = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    expect(after.config).toMatchObject({ currentBook: 'QA设置恢复', version: before.config.version + 1 })
    expect((await read<{ result: OperationResult }>(page, `/v1/operations/${originalId}`)).result.templatePlan?.config.version).toBe(after.config.version)
    expect((await study(page, id)).records).toHaveLength(0)
  })

  test('配置冲突保留草稿不覆盖，并显示下周生效的目标', async ({ page }) => {
    const id = await adopt(page)
    const current = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    await page.getByLabel('当前书籍（可留空）').fill('QA旧页面草稿')
    await post(page, [{ type: 'configure_reading_plan', planId: id, expectedVersion: current.config.version, patch: { currentBook: 'QA其他页面已保存' } }])
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click(), 409)
    await expect(page.getByLabel('当前书籍（可留空）')).toHaveValue('QA旧页面草稿')
    expect((await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)).config.currentBook).toBe('QA其他页面已保存')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '继续设置', exact: true }).click()
    await expect(page.getByLabel('当前书籍（可留空）')).toHaveValue('QA其他页面已保存')
    await page.getByLabel('每周目标天数（可留空）').fill('5')
    await page.getByLabel('每日目标分钟（可留空）').fill('20')
    await page.getByLabel('目标生效范围').selectOption('next_and_future')
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    await page.reload()
    await expect(page.locator('.reading-settings-summary')).toContainText('每周 5 天，每天 20 分钟')
    const configured = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    expect(configured.config).toMatchObject({ daysPerWeek: null, minMinutes: null, nextWeekGoals: { daysPerWeek: 5, minMinutes: 20 } })
    expect((await study(page, id)).stats.totalMinutes).toBe(0)
  })
})
