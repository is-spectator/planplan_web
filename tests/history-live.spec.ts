import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { GenericView, PlanView, PlansResponse, TemplatePlanState } from '../src/lib/contracts'

const statePath = process.env.PLANPLAN_E2E_STORAGE_STATE
const email = process.env.PLANPLAN_E2E_EMAIL
const password = process.env.PLANPLAN_E2E_PASSWORD
const output = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
const capabilities = 'reading-template-v1,ledger-template-v1,generic-record-v1,private-template-v1,generic-template-v2,community-template-v1'

test.describe('既有合成计划的真实历史只读核对', () => {
  test.skip(!statePath || !email || !password, '需要既有合成账户及受保护的本轮正常登录会话路径')
  test.describe.configure({ mode: 'serial', timeout: 90000 })
  let context: BrowserContext, page: Page, headers: Record<string, string>, today: string
  let water: PlanView, privatePlan: PlanView, historic: GenericView
  const forbiddenWrites: string[] = [], errors: string[] = []
  async function read<T>(path: string): Promise<T> { const response = await page.request.get(path, { headers }); expect(response.ok()).toBe(true); return response.json() }
  test.beforeAll(async ({ browser }) => {
    let stored: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
    try { stored = JSON.parse(await readFile(statePath!, 'utf8')) } catch { /* A first normal UI login creates the protected state. */ }
    context = await browser.newContext({ storageState: stored, timezoneId: 'America/Los_Angeles', viewport: { width: 1280, height: 900 } })
    await context.route('**/v1/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() !== 'GET' && path !== '/v1/auth/web/email/login') { forbiddenWrites.push(path); return route.abort('blockedbyclient') }
      return route.fallback()
    })
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
    if (stored) await page.goto('/plans')
    else {
      await page.goto('/login')
      await page.getByLabel('邮箱', { exact: true }).fill(email!)
      await page.getByLabel('密码', { exact: true }).fill(password!)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: '新建计划', exact: true })).toBeVisible()
    await writeFile(statePath!, JSON.stringify(await context.storageState()), { mode: 0o600 })
    const session = await (await page.request.get('/v1/auth/web/session')).json()
    headers = { 'X-PlanPlan-Expected-User': session.userId, 'X-PlanPlan-Capabilities': capabilities }
    today = (await read<{ today: string }>('/v1/me')).today
    const plans = [...(await read<PlansResponse>('/v1/plans?status=active')).plans, ...(await read<PlansResponse>('/v1/plans?status=archived')).plans]
    const generic = plans.filter(item => item.plan.kind === 'generic').map(item => item.plan)
    // Read only existing synthetic plans. No new records are needed for the large-list check.
    for (const plan of generic.slice(0, 60)) {
      const template = await read<TemplatePlanState>(`/v1/plans/${plan.id}/template`)
      if (!privatePlan && template.source === 'private') privatePlan = plan
      if (template.templateId === 'official.water') {
        const view = await read<GenericView>(`/v1/plans/${plan.id}/generic?from=${today.slice(0, 7)}-01&to=${today}&limit=20&offset=0`)
        if (view.totalRecords > 20) { water = plan; historic = view }
      }
      if (water && privatePlan) break
    }
    expect(water, '已有饮水合成计划必须包含超过一页的记录').toBeTruthy()
    expect(privatePlan, '已有私人模板计划').toBeTruthy()
  })
  test.afterEach(() => { expect(forbiddenWrites).toEqual([]); expect(errors).toEqual([]) })
  test.afterAll(async () => { await context?.close() })

  for (const source of ['water', 'private'] as const) test(`${source}计划实际日周月统计切换返回200，展示与服务端范围相同`, async ({ browserName }) => {
    const plan = source === 'water' ? water : privatePlan
    const evidence: { range: string; status: number; query: string; total: number }[] = []
    await page.goto(`/plans/${plan.id}`)
    await expect(page.getByRole('combobox', { name: '统计范围', exact: true })).toBeVisible()
    await expect(page.getByLabel('查看日期', { exact: true })).toHaveValue(today)
    await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText(/^按[日周月] ·/)
    for (const range of ['day', 'week', 'month']) {
      const wait = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/generic') && new URL(response.url()).searchParams.has('from'))
      await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption(range)
      const response = await wait, query = new URL(response.url()).searchParams
      expect(response.status()).toBe(200)
      expect(query.has('date')).toBe(false)
      const view = await response.json() as GenericView
      expect(view.summary.from).toBe(query.get('from')); expect(view.summary.to).toBe(query.get('to'))
      await expect(page.locator('.record-row')).toHaveCount(Math.min(20, view.totalRecords))
      await expect(page.getByRole('region', { name: '记录列表' })).toContainText(`${view.totalRecords} 条`)
      await expect(page.getByRole('combobox', { name: '统计范围', exact: true })).toHaveValue(range)
      await expect(page.locator('.plan-form-error')).toHaveCount(0)
      await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText('所选范围')
      if (view.summary.metrics.some(metric => metric.operation === 'goal_progress' && metric.target === null)) {
        await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('所选范围暂无可对比的目标，记录照常统计。')
        await expect(page.getByRole('region', { name: '目标进度', exact: true })).not.toContainText('未设置目标')
      }
      for (const metric of view.summary.metrics.filter(item => item.operation !== 'goal_progress' && item.unit !== 'CNY_cent')) {
        const row = page.locator('.generic-metric-grid > div').filter({ has: page.locator('dt').filter({ hasText: metric.label.replace(/^今日/, '当日') }) })
        await expect(row.locator('strong').first()).toContainText(metric.value === null ? '—' : metric.value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }))
      }
      evidence.push({ range, status: response.status(), query: query.toString(), total: view.totalRecords })
    }
    if (output) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: `${output}/${browserName}-${source}-ranges-live.png`, fullPage: true })
      await writeFile(`${output}/${browserName}-${source}-ranges-live.json`, JSON.stringify({ planId: plan.id, evidence, writes: forbiddenWrites, runtimeErrors: errors }, null, 2))
    }
    const metrics = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/generic') && new URL(response.url()).searchParams.has('date'))
    await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('metrics')
    expect((await metrics).status()).toBe(200)
    await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText(/^按[日周月] ·/)
  })

  test('超过20条的真实历史记录翻页不重不漏，返回刷新与记录详情保持正确页', async ({ browserName }) => {
    await page.goto(`/plans/${water.id}`)
    const wait = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/generic') && new URL(response.url()).searchParams.has('from'))
    await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('month')
    const initial = await (await wait).json() as GenericView
    expect(initial.totalRecords).toBe(historic.totalRecords)
    const seen = initial.records.map(record => record.id)
    await expect(page.locator('.record-row')).toHaveCount(20)
    let last = initial
    while (seen.length < initial.totalRecords) {
      const next = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/generic') && Number(new URL(response.url()).searchParams.get('offset')) === seen.length)
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      last = await (await next).json() as GenericView
      await expect(page.locator('.record-row')).toHaveCount(last.records.length)
      seen.push(...last.records.map(record => record.id))
    }
    expect(new Set(seen).size).toBe(initial.totalRecords)
    const lastPage = Math.ceil(initial.totalRecords / 20)
    await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText(`第 ${lastPage} / ${lastPage} 页`)
    await page.reload()
    await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText(`第 ${lastPage} / ${lastPage} 页`)
    await expect(page.locator('.record-row')).toHaveCount(last.records.length)
    await page.locator('.record-row').first().click()
    await expect(page.locator('.record-inspector')).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText(`第 ${lastPage} / ${lastPage} 页`)
    // Closing the detail replaces its history entry; first return visits the same last page, then the original scope.
    await page.goBack(); await page.goBack()
    await expect(page.getByRole('combobox', { name: '统计范围', exact: true })).toHaveValue('metrics')
    await expect(page).not.toHaveURL(/page=/)
    await page.goForward()
    await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText(`第 ${lastPage} / ${lastPage} 页`)
    if (output) {
      await page.setViewportSize({ width: 375, height: 812 })
      await page.getByRole('navigation', { name: '记录分页' }).scrollIntoViewIfNeeded()
      await page.getByRole('button', { name: '上一页', exact: true }).click()
      await expect(page.locator('.record-row')).toHaveCount(20)
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(page.locator('.record-row')).toHaveCount(last.records.length)
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${browserName}-history-live-last-page-mobile.png` })
      await writeFile(`${output}/${browserName}-history-live.json`, JSON.stringify({ planId: water.id, totalRecords: initial.totalRecords, uniqueRecordIds: seen, pageCount: lastPage, refreshPreservedPage: true, backForwardPreservedScope: true, businessWrites: forbiddenWrites, runtimeErrors: errors }, null, 2))
    }
  })
})
