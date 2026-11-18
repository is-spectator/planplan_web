import { expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Action, OperationResult, PlanView, RecordView, TemplateDefinition, TemplatePlanState } from '../src/lib/contracts'

// Sunday/month-end in Shanghai. Auckland is already on Monday; Los Angeles is
// still on Sunday. Neither browser's local date is the product's date source.
const before = '2027-01-31', after = '2027-02-01'
const instant = '2027-01-31T15:59:00.000Z'
type Kind = 'ledger' | 'study' | 'generic'
type Body = { clientOpId: string; inputAt: string; actions: Action[] }
const dayAdd = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
function monday(date: string) { const n = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; return dayAdd(date, 1 - n) }

async function fixture(page: Page, kind: Kind) {
  await page.clock.install({ time: new Date(instant) })
  const userId = randomUUID(), planId = randomUUID()
  const plan: PlanView = { id: planId, kind, name: `${kind}跨日计划`, activity: kind === 'study' ? '学习' : null, status: 'active', startDate: '2027-01-01', hidden: [], order: [], lastActivityAt: instant }
  const definition: TemplateDefinition = { schemaVersion: 1, id: kind === 'generic' ? 'official.water' : kind === 'ledger' ? 'official.ledger' : 'legacy.study', version: 1, name: plan.name, description: '跨日合成模板', engine: kind, source: 'official', requiredCapabilities: [kind === 'generic' ? 'generic-record-v1' : kind === 'ledger' ? 'ledger-template-v1' : 'reading-template-v1'], configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }], recordFields: kind === 'generic' ? [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'amountMl', label: '饮水量', type: 'integer', unit: 'ml', required: true, min: 1, max: 10000 }] : [], metrics: kind === 'generic' ? [{ id: 'total', label: '饮水量合计', operation: 'sum', fieldId: 'amountMl', period: 'day' }] : [], components: ['summary', 'records'], example: { config: { name: plan.name, startDate: before }, record: { date: before, amountMl: 100 } } }
  const template: TemplatePlanState = { planId, templateId: definition.id, templateVersion: 1, source: kind === 'study' ? 'legacy' : definition.source, engine: kind, definition, config: { version: 1, setupStatus: 'ready', name: plan.name, startDate: plan.startDate, currentBook: null, daysPerWeek: kind === 'study' ? 3 : null, minMinutes: kind === 'study' ? 20 : null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null }, values: {}, recordDefaults: {}, budgetCents: kind === 'ledger' ? 10000 : null, canChangeStartDate: false } }
  if (kind === 'ledger') definition.configurationFields.push({ id: 'budgetCents', label: '月预算', type: 'money', required: false, unit: 'CNY_cent', min: 1, max: 99999999 })
  if (kind === 'generic') {
    definition.requiredCapabilities.push('generic-template-v2')
    for (const period of ['week', 'month'] as const) {
      const label = period === 'week' ? '每周饮水目标' : '每月饮水目标', fieldId = `${period}Target`
      definition.configurationFields.push({ id: fieldId, label, type: 'integer', unit: 'ml', required: false, min: 1 })
      definition.metrics.push({ id: `${period}Progress`, label, operation: 'goal_progress', fieldId: 'amountMl', goalFieldId: fieldId, period })
      template.config.values![fieldId] = period === 'week' ? 2000 : 10000
    }
  }
  const record: RecordView = { id: randomUUID(), planId, kind: kind === 'ledger' ? 'expense' : kind, date: before, amountCents: kind === 'ledger' ? 1000 : null, minutes: kind === 'study' ? 25 : null, category: kind === 'ledger' ? '餐饮' : null, note: '上期已有记录', refundOf: null, refundedCents: kind === 'ledger' ? 0 : null, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: instant, ...(kind === 'generic' ? { fields: { date: before, amountMl: 100 }, definitionVersion: 1, definitionTemplateId: definition.id } : {}) }
  const state = { today: before, dataVersion: 1, planReads: 0, meReads: 0, dropNext: false, writes: 0 }
  const bodies: Body[] = [], lookups: string[] = [], periods: string[] = [], errors: string[] = []
  const saved = new Map<string, OperationResult>()
  let releasePlans: (() => void) | undefined, planGate: Promise<void> | undefined
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    if (path === '/v1/auth/web/session') return json({ userId, csrfToken: 'business-date-synthetic' })
    if (path === '/v1/me') { state.meReads++; return json({ id: userId, today: state.today, timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: state.dataVersion, signInMethod: 'email' }) }
    if (path === '/v1/plans') { state.planReads++; if (planGate) await planGate; return json({ plans: url.searchParams.get('status') === 'archived' ? [] : [{ plan }], today: state.today, timezone: 'Asia/Shanghai', dataVersion: state.dataVersion }) }
    if (path === `/v1/plans/${planId}/template`) return json(template)
    if (path === `/v1/plans/${planId}/ledger`) {
      const month = url.searchParams.get('month') ?? state.today.slice(0, 7), found = before.startsWith(month), offset = Number(url.searchParams.get('offset') ?? 0)
      periods.push(month)
      return json({ plan, month, records: found && offset === 0 ? [record] : [], months: [...new Set(['2027-01', month])].sort().reverse(), dataVersion: state.dataVersion, stats: { month, spendCents: found ? 1000 : 0, refundCents: 0, netCents: found ? 1000 : 0, budgetCents: 10000, remainingCents: found ? 9000 : 10000, usagePct: found ? 10 : 0, overCents: null, expenseCount: found ? 1 : 0, refundCount: 0, byCategory: [], daily: [] } })
    }
    if (path === `/v1/plans/${planId}/study`) {
      const week = monday(url.searchParams.get('week') ?? state.today), found = before >= week && before <= dayAdd(week, 6)
      periods.push(week)
      return json({ plan, week, today: state.today, previous: null, records: found ? [record] : [], weeks: [...new Set([monday(before), monday(state.today), week])].sort().reverse(), dataVersion: state.dataVersion, stats: { week, daysPerWeek: 3, minMinutes: 20, goalComplete: true, targetDays: 3, metDays: found ? 1 : 0, exceededDays: 0, recordDays: found ? 1 : 0, totalMinutes: found ? 25 : 0, interrupted: false, days: Array.from({ length: 7 }, (_, i) => { const date = dayAdd(week, i); return { date, minutes: date === before ? 25 : 0, sessions: date === before ? 1 : 0, status: date > state.today ? 'future' : date === before ? 'met' : 'none' } }) } })
    }
    if (path === `/v1/plans/${planId}/generic`) {
      const date = url.searchParams.get('date'), from = url.searchParams.get('from'), to = url.searchParams.get('to')
      if (date && (from || to) || Boolean(from) !== Boolean(to)) return json({ error: { code: 'invalid_input', message: '请指定一天，或完整的起止日期。' } }, 422)
      const first = from ?? date ?? state.today, last = to ?? date ?? first
      if (first > last || last > state.today) return json({ error: { code: 'invalid_input', message: '请选择不晚于今天的有效日期范围。' } }, 422)
      const found = before >= first && before <= last, offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20)
      periods.push(first)
      const metrics = definition.metrics.map(metric => {
        const metricFrom = from ? first : metric.period === 'week' ? monday(first) : metric.period === 'month' ? `${first.slice(0, 7)}-01` : first
        const value = before >= metricFrom && before <= last ? 100 : 0
        const target = metric.goalFieldId ? Number(template.config.values![metric.goalFieldId]) : null
        return { id: metric.id, label: metric.label, operation: metric.operation, fieldId: metric.fieldId, unit: 'ml', period: metric.period, from: metricFrom, to: last, value, target, remaining: target === null ? null : target - value, progressPct: target === null ? null : value / target * 100 }
      })
      return json({ plan, templatePlan: template, today: state.today, summary: { planId, from: first, to: last, recordCount: found ? 1 : 0, metrics }, records: found && offset === 0 ? [record] : [], totalRecords: found ? 1 : 0, offset, limit, dataVersion: state.dataVersion })
    }
    if (path.startsWith('/v1/operations/')) {
      const id = path.split('/').at(-1)!; lookups.push(id)
      return saved.has(id) ? json({ status: 'succeeded', result: saved.get(id) }) : json({ status: 'not_found' }, 404)
    }
    if (path === '/v1/operations') {
      const body = route.request().postDataJSON() as Body; bodies.push(body)
      if (state.dropNext) { state.dropNext = false; return route.abort('connectionfailed') }
      if (saved.has(body.clientOpId)) return json({ ...saved.get(body.clientOpId), replayed: true })
      for (const action of body.actions) {
        if (!('reviewedOn' in action) || !action.reviewedOn) continue
        const reviewed = action.reviewedOn
        const changed = action.type === 'configure_ledger_plan' ? action.patch.budgetCents !== undefined && reviewed.slice(0, 7) !== state.today.slice(0, 7)
          : action.type === 'configure_reading_plan' ? (action.patch.daysPerWeek !== undefined || action.patch.minMinutes !== undefined) && monday(reviewed) !== monday(state.today)
          : action.type === 'configure_generic_plan' && definition.metrics.some(metric => metric.goalFieldId && Object.hasOwn(action.patch.values ?? {}, metric.goalFieldId) && (metric.period === 'month' ? reviewed.slice(0, 7) !== state.today.slice(0, 7) : metric.period === 'week' ? monday(reviewed) !== monday(state.today) : reviewed !== state.today))
        if (changed) return json({ error: { code: 'version_conflict', message: '日期已进入新的周期，输入已保留。请核对新的目标生效范围后再保存。', details: { kind: 'goal_period_changed', today: state.today } } }, 409)
      }
      state.writes++; state.dataVersion++
      const result: OperationResult = { operationId: randomUUID(), clientOpId: body.clientOpId, kind: 'batch', items: [], dataVersion: state.dataVersion, createdAt: body.inputAt, undoable: false }
      saved.set(body.clientOpId, result); return json(result)
    }
    return json({ error: { code: 'not_found', message: 'Unknown synthetic route' } }, 404)
  })
  async function crossMidnight(assertPreserved?: () => Promise<void>, nextDate = after, elapsedMs = 65000) {
    const previousReads = state.planReads
    planGate = new Promise<void>(resolve => { releasePlans = resolve })
    state.today = nextDate
    try {
      await page.clock.fastForward(elapsedMs)
      await expect.poll(() => state.planReads).toBeGreaterThan(previousReads)
      if (assertPreserved) await assertPreserved()
    } finally { releasePlans?.(); planGate = undefined }
    await expect.poll(() => periods.length).toBeGreaterThan(0)
  }
  return { plan, state, bodies, lookups, periods, errors, crossMidnight }
}

function formValue(page: Page, kind: Kind): Locator { return page.getByLabel(kind === 'generic' ? '饮水量' : kind === 'ledger' ? '支出金额（元）' : '学习时长（分钟）', { exact: true }) }
async function openRecord(page: Page, kind: Kind) { await page.getByRole('button', { name: kind === 'generic' ? '添加记录' : kind === 'ledger' ? '记一笔' : '记录学习', exact: true }).click() }
function periodFor(kind: Kind, date: string) { return kind === 'ledger' ? date.slice(0, 7) : kind === 'study' ? monday(date) : date }

for (const zone of ['America/Los_Angeles', 'Pacific/Auckland']) test.describe(zone, () => {
  test.use({ timezoneId: zone })
  for (const kind of ['ledger', 'study', 'generic'] as const) {
    test(`${kind}跨上海日周月：无业务版本变化也刷新，保留未提交记录与原日期`, async ({ page }) => {
      const f = await fixture(page, kind)
      await page.goto(`/plans/${f.plan.id}`)
      await openRecord(page, kind)
      expect(await page.evaluate(() => new Date().getDate())).toBe(zone === 'Pacific/Auckland' ? 1 : 31)
      await expect(page.getByLabel('日期', { exact: true })).toHaveValue(before)
      await formValue(page, kind).fill('25')
      await f.crossMidnight(async () => { await expect(formValue(page, kind)).toHaveValue('25'); await expect(page.getByLabel('日期', { exact: true })).toHaveValue(before) })
      await expect.poll(() => f.periods.at(-1)).toBe(periodFor(kind, after))
      await expect(formValue(page, kind)).toHaveValue('25')
      expect(f.state.dataVersion).toBe(1); expect(f.state.writes).toBe(0)
      await page.getByRole('button', { name: '保存记录', exact: true }).click()
      await expect.poll(() => f.bodies.length).toBe(1)
      const action = f.bodies[0]!.actions[0]!
      expect(kind === 'generic' && action.type === 'add_generic_record' ? action.values.date : 'date' in action ? action.date : null).toBe(before)
      expect(Date.parse(f.bodies[0]!.inputAt)).toBeGreaterThanOrEqual(Date.parse('2027-01-31T16:00:00Z'))
      await expect(formValue(page, kind)).toHaveCount(0)
      await openRecord(page, kind)
      await expect(page.getByLabel('日期', { exact: true })).toHaveValue(after)
      expect(f.errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    })

    test(`${kind}跨上海午夜：未提交设置保留，明确历史周期不跳走`, async ({ page }) => {
      const f = await fixture(page, kind), key = kind === 'ledger' ? 'month' : kind === 'study' ? 'week' : 'date', historical = periodFor(kind, before)
      await page.goto(`/plans/${f.plan.id}?${key}=${historical}`)
      await page.getByRole('button', { name: kind === 'ledger' ? '修改计划名称' : '调整设置', exact: true }).click()
      await page.getByLabel('计划名称', { exact: true }).fill('保留跨日草稿')
      await f.crossMidnight(async () => { await expect(page.getByLabel('计划名称', { exact: true })).toHaveValue('保留跨日草稿') })
      await expect(page.getByLabel('计划名称', { exact: true })).toHaveValue('保留跨日草稿')
      await expect.poll(() => f.periods.at(-1)).toBe(historical)
      expect(new URL(page.url()).searchParams.get(key)).toBe(historical)
      expect(f.state.dataVersion).toBe(1); expect(f.state.writes).toBe(0); expect(f.errors).toEqual([])
      await expect(page.getByRole('checkbox', { name: /已核对新的生效周期/ })).toHaveCount(0)
      await page.getByRole('button', { name: kind === 'ledger' ? '保存预算' : '保存设置', exact: true }).click()
      await expect.poll(() => f.bodies.length).toBe(1)
      expect(f.bodies[0]!.actions[0]).toMatchObject({ expectedVersion: 1, patch: { name: '保留跨日草稿' } })
      expect('patch' in f.bodies[0]!.actions[0]! ? f.bodies[0]!.actions[0]!.patch : null).toEqual({ name: '保留跨日草稿' })
    })

    test(`${kind}目标跨周期需重新核对：保留输入和scope，核对前零提交`, async ({ page }, info) => {
      const f = await fixture(page, kind)
      await page.goto(`/plans/${f.plan.id}`)
      await page.getByRole('button', { name: kind === 'ledger' ? '修改计划名称' : '调整设置', exact: true }).click()
      const value = page.getByLabel(kind === 'ledger' ? '月预算（元，可留空）' : kind === 'study' ? '每日目标分钟（可留空）' : '每周饮水目标（可留空）', { exact: true })
      await value.fill(kind === 'generic' ? '5000' : '30')
      if (kind === 'generic') await page.getByLabel('每月饮水目标（可留空）', { exact: true }).fill('20000')
      const scope = page.getByRole('combobox', { name: kind === 'ledger' ? '预算生效范围' : '目标生效范围', exact: true })
      await scope.selectOption('next_and_future')
      await f.crossMidnight(async () => { await expect(value).toHaveValue(kind === 'generic' ? '5000' : '30') })
      const save = page.getByRole('button', { name: kind === 'ledger' ? '保存预算' : '保存设置', exact: true })
      const review = page.getByRole('checkbox', { name: /已核对新的生效周期/ })
      await expect(review).toBeVisible(); await expect(review).not.toBeChecked()
      if (kind === 'generic' && zone === 'America/Los_Angeles') {
        await expect(page.getByRole('alert')).toContainText('2027-02-08 起')
        await expect(page.getByRole('alert')).toContainText('2027-03-01 起')
        const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
        if (directory) {
          await mkdir(directory, { recursive: true })
          await page.screenshot({ path: join(directory, `${info.project.name}-period-review-desktop.png`), fullPage: true })
        }
        await page.setViewportSize({ width: 375, height: 812 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        if (directory) await page.screenshot({ path: join(directory, `${info.project.name}-period-review-mobile.png`), fullPage: true })
      }
      if (await save.isEnabled()) await save.click()
      expect(f.bodies).toHaveLength(0)
      await review.check()
      if (kind === 'generic') {
        // Returning a month later must invalidate the first acknowledgement.
        // Use wall-clock resume, avoiding a fake-timer jump above signed 32-bit.
        await page.clock.setSystemTime(new Date('2027-02-28T16:00:05Z'))
        await f.crossMidnight(undefined, '2027-03-01', 16000)
        await expect(review).not.toBeChecked()
        if (await save.isEnabled()) await save.click()
        expect(f.bodies).toHaveLength(0)
        await review.check()
      }
      await save.click()
      await expect.poll(() => f.bodies.length).toBe(1)
      expect(f.bodies[0]!.actions[0]).toMatchObject({ expectedVersion: 1, goalScope: 'next_and_future' })
      expect(f.state.writes).toBe(1); expect(f.errors).toEqual([])
    })
  }

  test('通用模板仅修改月目标：首次修改及只跨周都不误要求确认', async ({ page }) => {
    const f = await fixture(page, 'generic')
    f.state.today = '2027-02-06'
    await page.clock.setSystemTime(new Date('2027-02-06T15:59:00Z'))
    await page.goto(`/plans/${f.plan.id}`)
    await page.getByRole('button', { name: '调整设置', exact: true }).click()
    await page.getByLabel('每月饮水目标（可留空）', { exact: true }).fill('20000')
    await expect(page.getByRole('checkbox', { name: /已核对新的生效周期/ })).toHaveCount(0)
    await f.crossMidnight(undefined, '2027-02-08', 2 * 86400000 + 65000)
    await expect(page.getByLabel('每月饮水目标（可留空）', { exact: true })).toHaveValue('20000')
    await expect(page.getByRole('checkbox', { name: /已核对新的生效周期/ })).toHaveCount(0)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect.poll(() => f.bodies.length).toBe(1)
    expect(f.bodies[0]!.actions[0]).toMatchObject({ expectedVersion: 1, goalScope: 'current_and_future', patch: { values: { monthTarget: 20000 } } })
    const action = f.bodies[0]!.actions[0]!
    expect(action.type === 'configure_generic_plan' ? action.patch.values : null).toEqual({ monthTarget: 20000 })
    expect(f.state.writes).toBe(1); expect(f.errors).toEqual([])
  })

  test('跨午夜结果未知：核对并继续原请求保留clientOpId/inputAt/日期，不重解释今天', async ({ page }) => {
    const f = await fixture(page, 'generic')
    await page.goto(`/plans/${f.plan.id}`); await openRecord(page, 'generic'); await formValue(page, 'generic').fill('250')
    f.state.dropNext = true
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByText('还不能确定是否已保存，请先核对结果。')).toBeVisible()
    const original = structuredClone(f.bodies[0]!)
    expect(Date.parse(original.inputAt)).toBeGreaterThanOrEqual(Date.parse(instant))
    expect(Date.parse(original.inputAt)).toBeLessThan(Date.parse('2027-01-31T16:00:00Z'))
    await f.crossMidnight()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page.getByText('尚未查到结果。你可以稍后核对，或继续提交这同一条记录。')).toBeVisible()
    await page.clock.fastForward(3100)
    await page.getByRole('button', { name: '继续提交原记录', exact: true }).click()
    await expect.poll(() => f.bodies.length).toBe(2)
    expect(f.bodies[1]).toEqual(original)
    expect(f.lookups.every(id => id === original.clientOpId)).toBe(true)
    expect(f.state.writes).toBe(1); expect(f.errors).toEqual([])
  })
})

for (const kind of ['ledger', 'study', 'generic'] as const) test(`${kind}轮询前跨午夜提交：服务器拒绝旧核对日期，保留草稿后确认重提`, async ({ page }, info) => {
  const f = await fixture(page, kind)
  await page.goto(`/plans/${f.plan.id}`)
  await expect(page).toHaveTitle(/PlanPlan/)
  await page.getByRole('button', { name: kind === 'ledger' ? '修改计划名称' : '调整设置', exact: true }).click()
  const value = page.getByLabel(kind === 'ledger' ? '月预算（元，可留空）' : kind === 'study' ? '每日目标分钟（可留空）' : '每周饮水目标（可留空）', { exact: true })
  await value.fill(kind === 'generic' ? '5000' : '30')
  f.state.today = after
  const save = page.getByRole('button', { name: kind === 'ledger' ? '保存预算' : '保存设置', exact: true })
  await save.click()
  await expect.poll(() => f.bodies.length).toBe(1)
  expect(f.bodies[0]!.actions[0]).toHaveProperty('reviewedOn', before)
  expect(f.state.writes).toBe(0)
  await page.clock.setSystemTime(new Date('2027-01-31T16:00:01Z'))
  await expect(value).toHaveValue(kind === 'generic' ? '5000' : '30')
  const review = page.getByRole('checkbox', { name: /已核对新的生效周期/ })
  await expect(review).toBeVisible(); await expect(save).toBeDisabled()
  if (kind === 'generic' && process.env.PLANPLAN_E2E_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 375, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, `${info.project.name}-midnight-before-poll.png`), fullPage: true })
  }
  await review.check(); await save.click()
  await expect.poll(() => f.state.writes).toBe(1)
  expect(f.bodies[1]!.actions[0]).toHaveProperty('reviewedOn', after)
  expect(f.bodies[1]!.actions[0]).toMatchObject({ patch: f.bodies[0]!.actions[0] && 'patch' in f.bodies[0].actions[0] ? f.bodies[0].actions[0].patch : {} })
  expect(f.errors).toEqual([])
})
