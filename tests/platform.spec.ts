import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Action, LedgerMonthStats, PlanView, TemplateDefinition, TemplatePlanState } from '../src/lib/contracts'

const today = '2026-11-16'
async function managementFixture(page: Page, study = false) {
  const userId = randomUUID(), planId = randomUUID()
  const plan: PlanView = { id: planId, kind: study ? 'study' : 'ledger', name: study ? '英语学习' : '日常开销', activity: study ? '学习' : null, status: 'active', startDate: '2026-11-01', hidden: [], order: [], lastActivityAt: new Date().toISOString() }
  const definition: TemplateDefinition = { schemaVersion: 1, id: study ? 'legacy.study' : 'official.ledger', version: 1, name: study ? '学习' : '记账', description: '记录自己的日常。', engine: plan.kind, source: 'official', requiredCapabilities: [study ? 'reading-template-v1' : 'ledger-template-v1'], configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'budgetCents', label: '月预算', type: 'money', required: false, unit: 'CNY_cent', min: 1, max: 99999999 }], recordFields: [], metrics: [], components: ['summary', 'records'], example: { config: {}, record: {} } }
  const state: TemplatePlanState = { planId, templateId: definition.id, templateVersion: 1, source: study ? 'legacy' : 'official', engine: plan.kind, definition, config: { version: 1, setupStatus: 'ready', name: plan.name, startDate: plan.startDate, currentBook: null, daysPerWeek: 3, minMinutes: 20, goalEffectiveFrom: { daysPerWeek: '2026-11-16', minMinutes: '2026-11-16' }, nextWeekGoals: { startsOn: '2026-11-23', daysPerWeek: 3, minMinutes: 20 }, budgetCents: 300000, canChangeStartDate: false } }
  const ledger: LedgerMonthStats = { month: '2026-11', spendCents: 2000, refundCents: 5000, netCents: -3000, budgetCents: 300000, remainingCents: 303000, usagePct: -1, overCents: null, expenseCount: 1, refundCount: 2, byCategory: [{ category: '餐饮', spendCents: 2000, refundCents: 5000, netCents: -3000 }], daily: [{ date: '2026-11-14', netCents: -3000 }, { date: '2026-11-15', netCents: 2000 }, { date: '2026-11-16', netCents: -2000 }] }
  const actions: Action[] = []
  let conflict = false
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'management-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: userId, today, timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: state.config.version, signInMethod: 'email' } })
    if (path === '/v1/plans') return route.fulfill({ json: { plans: url.searchParams.get('status') === 'archived' ? [] : [{ plan }], dataVersion: state.config.version } })
    if (path.endsWith('/template')) return route.fulfill({ json: state })
    if (path.endsWith('/ledger')) return route.fulfill({ json: { plan, month: ledger.month, stats: ledger, records: [], months: [ledger.month], dataVersion: state.config.version } })
    if (path.endsWith('/study')) return route.fulfill({ json: { plan, week: '2026-11-16', today, stats: { week: '2026-11-16', daysPerWeek: state.config.daysPerWeek, minMinutes: state.config.minMinutes, goalComplete: true, targetDays: state.config.daysPerWeek, metDays: 0, exceededDays: 0, recordDays: 0, totalMinutes: 0, interrupted: false, days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${16 + i}`, minutes: 0, sessions: 0, status: i ? 'future' : 'none' })) }, previous: null, records: [], weeks: ['2026-11-16'], dataVersion: state.config.version } })
    if (path === '/v1/operations') {
      const input = route.request().postDataJSON(); const action = input.actions[0]; actions.push(action)
      if (conflict) return route.fulfill({ status: 409, json: { error: { code: 'version_conflict', message: '计划设置已在别处更改。', details: { templatePlan: state } } } })
      if (action.patch.name) { plan.name = action.patch.name; state.config.name = action.patch.name }
      if (action.goalScope === 'next_and_future') { if (action.patch.daysPerWeek !== undefined) state.config.nextWeekGoals!.daysPerWeek = action.patch.daysPerWeek; if (action.patch.minMinutes !== undefined) state.config.nextWeekGoals!.minMinutes = action.patch.minMinutes }
      else { if (action.patch.daysPerWeek !== undefined) state.config.daysPerWeek = action.patch.daysPerWeek; if (action.patch.minMinutes !== undefined) state.config.minMinutes = action.patch.minMinutes }
      if (action.patch.budgetCents !== undefined) state.config.budgetCents = action.patch.budgetCents
      state.config.version++
      return route.fulfill({ json: { operationId: randomUUID(), clientOpId: input.clientOpId, kind: 'batch', items: [], dataVersion: state.config.version, createdAt: new Date().toISOString(), undoable: false, templatePlan: state } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  return { plan, state, actions, setConflict: () => { conflict = true } }
}

async function screenshot(page: Page, name: string) { const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR; if (directory) { await mkdir(directory, { recursive: true }); await page.screenshot({ path: join(directory, name), fullPage: true }) } }
const issues = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => { const problems: string[] = []; issues.set(page, problems); page.on('pageerror', error => problems.push(error.message)); page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !/Failed to load resource.*409/.test(message.text())) problems.push(message.text()) }) })
test.afterEach(async ({ page }) => { expect(issues.get(page)).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0) })

test('P02协议：分类同时展示支出退款净额，趋势保留负值与零线，窄屏可读', async ({ page }, info) => {
  const { plan } = await managementFixture(page)
  await page.goto(`/plans/${plan.id}`)
  const row = page.getByRole('row', { name: '餐饮 ¥20.00 ¥50.00 −¥30.00', exact: true })
  await expect(row).toBeVisible()
  await expect(page.getByRole('img', { name: /每日净支出，最低−¥30.00，最高¥20.00/ })).toBeVisible()
  expect(await page.locator('.trend-point.negative').count()).toBe(2)
  expect(await page.locator('.trend-zero').getAttribute('y1')).not.toBe('190')
  expect(await page.locator('.trend-zero').evaluate((line) => getComputedStyle(line).stroke)).not.toBe('none')
  await page.getByText('查看每日数据', { exact: true }).click()
  await expect(page.getByRole('row', { name: '2026-11-14 −¥30.00', exact: true })).toBeVisible()
  await screenshot(page, `${info.project.name}-management-trend.png`)
  await page.setViewportSize({ width: 320, height: 720 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(row).toBeVisible()
  await screenshot(page, `${info.project.name}-management-trend-320.png`)
})

test('P02协议：计划改名沿用配置版本且不覆盖预算，冲突保留输入', async ({ page }) => {
  const fixture = await managementFixture(page)
  await page.goto(`/plans/${fixture.plan.id}`)
  await page.getByRole('button', { name: '修改计划名称', exact: true }).click()
  await page.getByLabel('计划名称', { exact: true }).fill('生活计划')
  await page.getByRole('button', { name: '保存预算', exact: true }).click()
  await expect(page.getByRole('heading', { name: '生活计划', exact: true })).toBeVisible()
  expect(fixture.actions[0]).toMatchObject({ type: 'configure_ledger_plan', expectedVersion: 1, patch: { name: '生活计划' } })
  expect(fixture.state.config.budgetCents).toBe(300000)
  await page.getByRole('button', { name: '修改计划名称', exact: true }).click()
  await page.getByLabel('计划名称', { exact: true }).fill('保留我的修改')
  fixture.setConflict()
  await page.getByRole('button', { name: '保存预算', exact: true }).click()
  await expect(page.getByText('计划设置已被修改。请查看最新内容，再决定如何调整。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('计划名称', { exact: true })).toHaveValue('保留我的修改')
  expect(fixture.state.config.name).toBe('生活计划')
})

test('P02协议：旧学习计划可调整下周目标和名称，不伪装阅读、不写完成记录', async ({ page }) => {
  const fixture = await managementFixture(page, true)
  await page.goto(`/plans/${fixture.plan.id}`)
  await page.getByRole('button', { name: '调整设置', exact: true }).click()
  await expect(page.getByLabel('当前书籍（可留空）')).toHaveCount(0)
  await page.getByLabel('计划名称', { exact: true }).fill('每日英语')
  await page.getByLabel('每周目标天数（可留空）').fill('5')
  await page.getByLabel('每日目标分钟（可留空）').fill('30')
  await page.getByRole('combobox', { name: '目标生效范围', exact: true }).selectOption('next_and_future')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '每日英语', exact: true })).toBeVisible()
  expect(fixture.actions[0]).toMatchObject({ type: 'configure_reading_plan', expectedVersion: 1, patch: { name: '每日英语', daysPerWeek: 5, minMinutes: 30 }, goalScope: 'next_and_future' })
  expect(fixture.state.config.daysPerWeek).toBe(3)
  expect(fixture.state.config.minMinutes).toBe(20)
  await expect(page.getByRole('region', { name: '学习统计', exact: true })).toContainText('0 分钟')
  await expect(page.getByText('从 2026-11-23 起：每周 5 天，每天 30 分钟。', { exact: true })).toBeVisible()
})
