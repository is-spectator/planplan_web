import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { PlanView, RecordView, TemplateDefinition, TemplatePlanState } from '../src/lib/contracts'

type Kind = 'ledger' | 'study' | 'generic'
const today = '2026-11-17'
async function fixture(page: Page, kind: Kind) {
  const userId = randomUUID(), now = new Date().toISOString()
  const plan: PlanView = { id: randomUUID(), kind, name: `${kind}历史分页`, activity: kind === 'study' ? '学习' : null, status: 'active', startDate: '2026-10-01', hidden: [], order: [], lastActivityAt: now }
  const definition: TemplateDefinition = { schemaVersion: 1, id: 'official.water', version: 1, engine: 'generic', source: 'official', requiredCapabilities: ['generic-record-v1'], name: '饮水', description: '记录饮水与日期。', configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }], recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'amountMl', label: '饮水量', type: 'integer', unit: 'ml', required: true, min: 1 }, { id: 'note', label: '备注', type: 'text', required: false }], metrics: [{ id: 'total', label: '饮水量合计', operation: 'sum', fieldId: 'amountMl', period: 'day' }], components: ['summary', 'records'], example: { config: { name: '饮水', startDate: today }, record: { date: today, amountMl: 100 } } }
  const template: TemplatePlanState = { planId: plan.id, templateId: definition.id, templateVersion: 1, source: 'official', engine: 'generic', definition, config: { version: 1, setupStatus: 'ready', name: plan.name, startDate: plan.startDate, currentBook: null, daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null }, values: {}, recordDefaults: {}, canChangeStartDate: false } }
  if (kind === 'generic') {
    definition.configurationFields.push({ id: 'dailyGoal', label: '每日目标', type: 'integer', unit: 'ml', required: false, min: 1 })
    definition.metrics.push({ id: 'progress', label: '目标进度', operation: 'goal_progress', fieldId: 'amountMl', goalFieldId: 'dailyGoal', period: 'day' })
    definition.components.push('goal')
  }
  const previousDate = kind === 'ledger' ? '2026-10-01' : kind === 'study' ? '2026-11-09' : '2026-11-16'
  const record = (date: string, index: number): RecordView => ({ id: randomUUID(), planId: plan.id, kind: kind === 'ledger' ? 'expense' : kind, date, amountCents: kind === 'ledger' ? 1000 : null, minutes: kind === 'study' ? 10 : null, category: kind === 'ledger' ? '其他' : null, note: `${date}记录${index + 1}`, refundOf: null, refundedCents: kind === 'ledger' ? 0 : null, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: now, ...(kind === 'generic' ? { fields: { date, amountMl: 100, note: `${date}记录${index + 1}` }, definitionTemplateId: definition.id, definitionVersion: 1 } : {}) })
  const current = Array.from({ length: 3 }, (_, n) => record(today, n)), previous = Array.from({ length: 45 }, (_, n) => record(previousDate, n))
  const state = { version: 1, previous, offlinePeriod: false, writes: 0 }
  const requests: Record<string, string>[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (route.request().method() !== 'GET') { state.writes++; return route.fulfill({ status: 405, json: { error: { code: 'not_allowed', message: '只读测试不允许写入。' } } }) }
    const send = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (path === '/v1/auth/web/session') return send({ userId, csrfToken: 'history-navigation-fixture' })
    if (path === '/v1/me') return send({ id: userId, today, timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: state.version, signInMethod: 'email' })
    if (path === '/v1/plans') return send({ plans: url.searchParams.get('status') === 'archived' ? [] : [{ plan }], dataVersion: state.version })
    if (path.endsWith('/template')) return kind === 'generic' ? send(template) : send({ error: { code: 'not_found', message: '旧计划。' } }, 404)
    if (path.startsWith('/v1/records/')) return send({ record: [...current, ...state.previous].find(item => path.endsWith(item.id)), refundSnapshot: kind === 'ledger' ? { token: `refunds-v1:${'a'.repeat(64)}`, count: 0, totalCents: 0 } : null, source: null })
    if (path.endsWith(`/${kind}`)) {
      const params = Object.fromEntries(url.searchParams); requests.push(params)
      if (state.offlinePeriod) return send({ error: { code: 'temporarily_unavailable', message: '这次读取暂时失败，请重试。' } }, 503)
      if (params.expectedDataVersion !== undefined && Number(params.expectedDataVersion) !== state.version) return send({ error: { code: 'version_conflict', message: '记录已变化，请从第一页重新查看。', details: { kind: 'history_changed', dataVersion: state.version } } }, 409)
      const offset = Number(params.offset ?? '0')
      if (kind === 'ledger') {
        const month = params.month ?? today.slice(0, 7), all = month === '2026-11' ? current : state.previous
        return send({ plan, month, months: ['2026-11', '2026-10'], dataVersion: state.version, records: all.slice(offset, offset + 20), stats: { month, spendCents: all.length * 1000, refundCents: 0, netCents: all.length * 1000, budgetCents: null, remainingCents: null, usagePct: null, overCents: null, expenseCount: all.length, refundCount: 0, byCategory: [], daily: [] } })
      }
      if (kind === 'study') {
        const week = params.week ?? '2026-11-16', all = week === '2026-11-16' ? current : state.previous
        return send({ plan, week, today, weeks: ['2026-11-16', '2026-11-09'], dataVersion: state.version, previous: null, totalRecords: all.length, records: params.limit ? all.slice(offset, offset + Number(params.limit)) : all, stats: { week, daysPerWeek: null, minMinutes: null, goalComplete: false, targetDays: null, metDays: null, exceededDays: null, recordDays: 1, totalMinutes: all.length * 10, interrupted: false, days: [] } })
      }
      if (params.date && (params.from || params.to) || Boolean(params.from) !== Boolean(params.to)) return send({ error: { code: 'invalid_input', message: '请指定一天，或完整的起止日期。' } }, 422)
      const from = params.from ?? params.date ?? today, to = params.to ?? params.date ?? today
      const all = [...current, ...state.previous].filter(item => item.date >= from && item.date <= to)
      return send({ plan, templatePlan: template, today, dataVersion: state.version, records: all.slice(offset, offset + 20), totalRecords: all.length, offset, limit: 20, summary: { planId: plan.id, from, to, recordCount: all.length, metrics: definition.metrics.map(metric => ({ ...metric, unit: 'ml', from, to, value: all.length * 100, target: null, remaining: null, progressPct: null })) } })
    }
    return send({ error: { code: 'not_found', message: '没有此路径。' } }, 404)
  })
  return { plan, state, requests, current, previousDate, errors }
}

test('通用计划的日周月范围使用互斥查询参数，失败后可切回且记录统计相符', async ({ page }, info) => {
  const f = await fixture(page, 'generic')
  await page.goto(`/plans/${f.plan.id}`)
  await expect(page.locator('.record-row')).toHaveCount(3)
  await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText('按日')
  expect(f.requests.at(-1)).toMatchObject({ date: today })
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('未设置目标，记录照常累积。')
  for (const range of ['day', 'week', 'month']) {
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/generic') && new URL(reply.url()).searchParams.get('from') === (range === 'day' ? today : range === 'week' ? '2026-11-16' : '2026-11-01'))
    await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption(range)
    expect((await response).status()).toBe(200)
    await expect(page.locator('.record-row')).toHaveCount(range === 'day' ? 3 : 20)
    const params = f.requests.at(-1)!
    expect(params).not.toHaveProperty('date')
    expect(params).toMatchObject({ from: range === 'day' ? today : range === 'week' ? '2026-11-16' : '2026-11-01', to: today, offset: '0', limit: '20' })
    await expect(page.getByRole('region', { name: '记录列表' })).toContainText(`${range === 'day' ? 3 : 48} 条`)
    await expect(page.locator('.generic-metric-grid strong').first()).toHaveText(range === 'day' ? '300 ml' : '4,800 ml')
    await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText('所选范围')
    await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('所选范围暂无可对比的目标，记录照常统计。')
    await expect(page.getByRole('region', { name: '目标进度', exact: true })).not.toContainText('未设置目标')
    await expect(page.getByRole('button', { name: '添加记录', exact: true })).toBeVisible()
  }
  const metricsResponse = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/generic') && new URL(reply.url()).searchParams.has('date'))
  await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('metrics')
  expect((await metricsResponse).status()).toBe(200)
  expect(f.requests.at(-1)).not.toHaveProperty('from')
  await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText('按日')
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('未设置目标，记录照常累积。')
  f.state.offlinePeriod = true
  await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('day')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('这次读取暂时失败')
  await expect(page.getByRole('combobox', { name: '统计范围', exact: true })).toBeVisible()
  f.state.offlinePeriod = false
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.record-row')).toHaveCount(3)
  await page.getByLabel('查看日期', { exact: true }).fill('2026-10-01')
  await expect(page.locator('.plan-empty-records')).toHaveText('这一天还没有记录。')
  for (const emptyRange of ['week', 'month']) {
    await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption(emptyRange)
    await expect(page.locator('.plan-empty-records')).toHaveText('这个范围还没有记录。')
    await expect(page.locator('.generic-metric-grid .plan-form-hint').first()).toContainText('所选范围')
    await expect(page.getByRole('region', { name: '记录列表' })).toContainText('0 条')
  }
  await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('metrics')
  await expect(page.locator('.plan-empty-records')).toHaveText('这一天还没有记录。')
  await page.getByLabel('查看日期', { exact: true }).fill(today)
  await expect(page.locator('.record-row')).toHaveCount(3)
  if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR) {
    await mkdir(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: `${process.env.PLANPLAN_E2E_SCREENSHOT_DIR}/${info.project.name}-range-recovered.png`, fullPage: true })
  }
  expect(f.state.writes).toBe(0); expect(f.errors).toEqual([])
})

for (const kind of ['ledger', 'study', 'generic'] as const) test(`${kind}多页记录：返回周期不残留页码，刷新深链保留页，版本变化与越界可恢复`, async ({ page }, info) => {
  const f = await fixture(page, kind)
  await page.goto(`/plans/${f.plan.id}`)
  await expect(page.locator('.record-row')).toHaveCount(3)
  const selector = page.getByRole('combobox', { name: kind === 'ledger' ? '选择月份' : kind === 'study' ? '选择学习周' : '统计范围', exact: true })
  await selector.selectOption(kind === 'ledger' ? '2026-10' : kind === 'study' ? '2026-11-09' : 'week')
  await expect(page.locator('.record-row')).toHaveCount(20)
  const seen = await page.locator('.record-row').allTextContents()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 2 / 3 页')
  const middle = await page.locator('.record-row').allTextContents(); seen.push(...middle)
  await page.reload()
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 2 / 3 页')
  await expect.poll(() => page.locator('.record-row').allTextContents()).toEqual(middle)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.record-row')).toHaveCount(kind === 'generic' ? 8 : 5)
  seen.push(...await page.locator('.record-row').allTextContents())
  expect(new Set(seen).size).toBe(kind === 'generic' ? 48 : 45)
  await page.goBack()
  await expect(page.locator('.record-row')).toHaveCount(3)
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.locator('.plan-empty-records')).toHaveCount(0)
  await page.goForward()
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 3 / 3 页')
  await page.locator('.record-row').first().click()
  await expect(page.locator('.record-inspector')).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 3 / 3 页')
  f.state.previous = f.state.previous.slice(0, 25); f.state.version++
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.locator('.record-row')).toHaveCount(20)
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 1 /')
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '记录分页' })).toContainText('第 2 / 2 页')
  f.state.previous = f.state.previous.slice(0, 2); f.state.version++
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.locator('.record-row')).toHaveCount(kind === 'generic' ? 5 : 2)
  // A stale bookmarked last page must also recover when the current version was loaded at navigation time.
  const stale = new URL(page.url()); stale.searchParams.set('page', '500')
  await page.goto(stale.toString())
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.locator('.record-row')).toHaveCount(kind === 'generic' ? 5 : 2)
  for (const invalid of ['-1', '1.5', 'NaN', '999999999999999999999']) {
    const target = new URL(page.url()); target.searchParams.set('page', invalid)
    await page.goto(target.toString()); await expect(page).not.toHaveURL(/page=/)
    await expect(page.locator('.record-row')).toHaveCount(kind === 'generic' ? 5 : 2)
  }
  if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 375, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `${process.env.PLANPLAN_E2E_SCREENSHOT_DIR}/${info.project.name}-${kind}-history-restored-mobile.png`, fullPage: true })
  }
  expect(f.state.writes).toBe(0); expect(f.errors).toEqual([])
})

for (const kind of ['ledger', 'study', 'generic'] as const) test(`${kind}翻页时数据变化：旧版本被拒绝，重新回首页读取完整范围`, async ({ page }) => {
  const f = await fixture(page, kind)
  const period = kind === 'ledger' ? 'month=2026-10' : kind === 'study' ? 'week=2026-11-09' : 'date=2026-11-16'
  await page.goto(`/plans/${f.plan.id}?${period}`)
  await expect(page.locator('.record-row')).toHaveCount(20)
  expect(f.requests.at(-1)).toHaveProperty('expectedDataVersion', '1')
  f.state.previous.splice(0, 1); f.state.version++
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect.poll(() => f.requests.some(p => p.offset === '20' && p.expectedDataVersion === '1')).toBe(true)
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull()
  await expect.poll(() => f.requests.at(-1)?.expectedDataVersion).toBe('2')
  await expect(page.locator('.record-row')).toHaveCount(20)
  expect((await page.locator('.record-row').allTextContents()).some(text => text.includes('记录2'))).toBe(true)
  expect(f.state.writes).toBe(0); expect(f.errors).toEqual([])
})
