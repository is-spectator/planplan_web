import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Action, GenericSummary, GenericView, OperationResult, PlanView, PlansResponse, RecordView, TemplateDefinition, TemplatePlanState } from '../src/lib/contracts'

const email = process.env.PLANPLAN_GENERIC_E2E_EMAIL
const password = process.env.PLANPLAN_GENERIC_E2E_PASSWORD
type Storage = Awaited<ReturnType<BrowserContext['storageState']>>
let storage: Storage | null = null
const capabilities = 'reading-template-v1,ledger-template-v1,generic-record-v1'

async function screenshot(page: Page, name: string) {
  const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: join(directory, name), fullPage: true })
}
const health = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }, info) => {
  const problems: string[] = []
  health.set(page, problems)
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => {
    if (!['warning', 'error'].includes(message.type())) return
    const text = message.text(), url = message.location().url
    if (url.includes('/v1/auth/web/session') && /\b401\b/.test(text)) return // Public pages probe the anonymous session.
    if ((info.title.includes('丢响应') || info.title.includes('切换账户')) && url.includes('/v1/operations') && (/\b409\b/.test(text) || /ERR_(?:CONNECTION_)?FAILED|Load failed|cancelled|canceled/i.test(text))) return // This scenario deliberately loses a response and submits an old version.
    problems.push(`${message.type()}: ${text}`)
  })
})
test.afterEach(async ({ page }) => { expect(health.get(page)).toEqual([]) })

async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true) }
function unzipText(zip: Buffer, wanted: string) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThanOrEqual(0)
  let cursor = zip.readUInt32LE(end + 16)
  for (let n = 0; n < zip.readUInt16LE(end + 10); n++) {
    const length = zip.readUInt16LE(cursor + 28)
    if (zip.subarray(cursor + 46, cursor + 46 + length).toString() === wanted) {
      const local = zip.readUInt32LE(cursor + 42)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const value = zip.subarray(start, start + zip.readUInt32LE(cursor + 20))
      return (zip.readUInt16LE(cursor + 10) === 8 ? inflateRawSync(value) : value).toString()
    }
    cursor += 46 + length + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32)
  }
  throw new Error(`ZIP 缺少 ${wanted}`)
}

test('另一份定义改变控件、约束、指标和顺序，同一页面真实提交该字段结构', async ({ page }) => {
  const userId = randomUUID(), planId = randomUUID(), today = '2026-11-16'
  const definition: TemplateDefinition = { schemaVersion: 1, id: 'official.qa-count', version: 1, name: '次数记录', description: '合成定义用于验证同一通用界面。', engine: 'generic', source: 'official', requiredCapabilities: ['generic-record-v1'], configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }], recordFields: [{ id: 'date', label: '发生日期', type: 'date', required: true }, { id: 'quantity', label: '次数', type: 'integer', required: true, min: 1, max: 5 }, { id: 'context', label: '场景', type: 'text', required: true, maxLength: 12 }], metrics: [{ id: 'quantitySum', label: '累计次数', operation: 'sum', fieldId: 'quantity', period: 'day' }], components: ['records', 'summary'], example: { config: { name: '次数记录', startDate: today }, record: { date: today, quantity: 2, context: '下午' } } }
  const plan: PlanView = { id: planId, kind: 'generic', name: 'QA次数', activity: null, status: 'active', startDate: today, hidden: [], order: [], lastActivityAt: new Date().toISOString(), template: { id: definition.id, version: 1, setupStatus: 'ready' } }
  const template: TemplatePlanState = { planId, templateId: definition.id, templateVersion: 1, source: 'official', engine: 'generic', definition, config: { version: 1, setupStatus: 'ready', name: plan.name, startDate: today, currentBook: null, daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null }, values: {}, canChangeStartDate: false } }
  const records: RecordView[] = []
  const actions: Action[] = []
  const summary = (): GenericSummary => ({ planId, from: today, to: today, recordCount: records.length, metrics: definition.metrics.map((metric) => ({ ...metric, value: metric.operation === 'count' ? records.length : records.reduce((sum, record) => sum + Number(record.fields?.quantity ?? 0), 0), target: null, remaining: null, progressPct: null })) })
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url())
    let body: unknown
    if (url.pathname === '/v1/auth/web/session') body = { userId, csrfToken: 'fixture-csrf' }
    else if (url.pathname === '/v1/me') body = { id: userId, today, timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: records.length, signInMethod: 'email' }
    else if (url.pathname === '/v1/templates') body = { templates: [definition] }
    else if (url.pathname === '/v1/market/templates') body = { templates: [{ id: definition.id, templateId: definition.id, source: 'official', title: definition.name, description: definition.description, category: 'health', author: { kind: 'official', name: 'PlanPlan 官方' }, templateVersion: definition.version, adoptionCount: null, definition }], total: 1, limit: 20, offset: 0 }
    else if (url.pathname === `/v1/market/templates/${definition.id}`) body = { id: definition.id, templateId: definition.id, source: 'official', title: definition.name, description: definition.description, category: 'health', author: { kind: 'official', name: 'PlanPlan 官方' }, templateVersion: definition.version, adoptionCount: null, definition }
    else if (url.pathname === `/v1/templates/${definition.id}`) body = definition
    else if (url.pathname === '/v1/plans') body = { plans: url.searchParams.get('status') === 'archived' ? [] : [{ plan, generic: summary() }], dataVersion: records.length }
    else if (url.pathname.endsWith('/template')) body = template
    else if (url.pathname.endsWith('/generic')) body = { plan, templatePlan: template, today, summary: summary(), records, totalRecords: records.length, offset: 0, limit: 20, dataVersion: records.length }
    else if (url.pathname === '/v1/operations') {
      const input = route.request().postDataJSON()
      actions.push(...input.actions)
      const action = input.actions[0] as Extract<Action, { type: 'add_generic_record' }>
      const record: RecordView = { id: randomUUID(), planId, kind: 'generic', amountCents: null, minutes: null, category: null, date: today, note: '', refundOf: null, refundedCents: null, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: new Date().toISOString(), fields: action.values, definitionVersion: 1 }
      records.push(record)
      body = { operationId: randomUUID(), clientOpId: input.clientOpId, kind: 'batch', items: [{ type: 'generic_added', record, generic: summary() }], dataVersion: records.length, createdAt: new Date().toISOString(), undoable: false }
    } else return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'fixture route missing' } } })
    await route.fulfill({ json: body })
  })
  await page.goto(`/market/${definition.id}`)
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toContainText('累计次数')
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).not.toContainText('饮水')
  await expect(page.getByRole('heading', { name: '功能简介', exact: true })).toBeVisible()
  await expect(page.getByLabel('试填：次数', { exact: true })).toBeHidden()
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByLabel('试填：次数', { exact: true }).fill('2')
  await page.getByLabel('试填：场景', { exact: true }).fill('下午')
  await page.getByRole('button', { name: '加入试填' }).click()
  await expect(page.getByRole('region', { name: '记录统计' })).toContainText('累计次数')
  expect(actions).toHaveLength(0)
  await page.goto(`/plans/${planId}`)
  await page.getByRole('button', { name: '添加记录', exact: true }).click()
  await expect(page.getByLabel('次数', { exact: true })).toBeVisible()
  await expect(page.getByLabel('饮水毫升', { exact: true })).toHaveCount(0)
  await page.getByLabel('次数', { exact: true }).fill('6')
  await page.getByLabel('场景', { exact: true }).fill('下午')
  await page.getByRole('button', { name: '保存记录' }).click()
  await expect(page.getByRole('alert')).toContainText('范围 1 至 5')
  expect(actions).toHaveLength(0)
  await page.getByLabel('次数', { exact: true }).fill('4')
  await page.getByRole('button', { name: '保存记录' }).click()
  await expect(page.locator('.generic-record-row')).toHaveCount(1)
  expect(actions[0]).toMatchObject({ type: 'add_generic_record', planId, values: { date: today, quantity: 4, context: '下午' } })
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('section[aria-label="记录列表"], section[aria-label="记录统计"]'), (node) => node.getAttribute('aria-label')))).toEqual(['记录列表', '记录统计'])
  definition.recordFields.push({ id: 'mood', label: '补充感受', type: 'text', required: false, maxLength: 30 })
  definition.metrics.push({ id: 'events', label: '记录次数', operation: 'count', period: 'day' })
  definition.components = ['summary', 'records']
  await page.goto(`/market/${definition.id}`)
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toContainText('记录次数')
  expect(actions).toHaveLength(1)
  await page.goto(`/plans/${planId}`)
  await expect(page.getByRole('region', { name: '记录统计' })).toContainText('记录次数')
  await page.getByRole('button', { name: '添加记录', exact: true }).click()
  await expect(page.getByLabel('补充感受（可留空）')).toBeVisible()
  await page.getByLabel('次数', { exact: true }).fill('2')
  await page.getByLabel('场景', { exact: true }).fill('晚上')
  await page.getByLabel('补充感受（可留空）').fill('不错')
  await page.getByRole('button', { name: '保存记录' }).click()
  await expect(page.locator('.generic-record-row')).toHaveCount(2)
  expect(actions[1]).toMatchObject({ values: { quantity: 2, context: '晚上', mood: '不错' } })
  await expect(page.getByRole('region', { name: '记录统计' })).toContainText('6')
  definition.recordFields.push({ id: 'unsupported', label: '未支持项目', type: 'decimal', required: false })
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('尚不能使用')
  await expect(page.getByRole('button', { name: '添加记录', exact: true })).toHaveCount(0)
  definition.recordFields.pop()
  for (const unsupported of ['source', 'count-field', 'missing-date'] as const) {
    definition.metrics[0]!.sourceRule = unsupported === 'source' ? 'ledger_net' : 'generic_records'
    definition.metrics[1]!.fieldId = unsupported === 'count-field' ? 'quantity' : undefined
    definition.recordFields[0]!.required = unsupported !== 'missing-date'
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('尚不能使用')
    await expect(page.getByRole('button', { name: '添加记录', exact: true })).toHaveCount(0)
  }
  expect(actions).toHaveLength(2)
})

test('官方三模板可打开，独立饮水/记账试填不调用任何业务写入', async ({ page }, info) => {
  const writes: string[] = []
  page.on('request', (request) => { if (request.url().includes('/v1/') && request.method() !== 'GET') writes.push(request.url()) })
  await page.goto('/market')
  for (const name of ['阅读', '记账', '饮水']) await expect(page.locator('.template-card').getByRole('heading', { name, exact: true })).toBeVisible()
  await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: '饮水', exact: true }) }).click()
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '功能简介', exact: true })).toBeVisible()
  await expect(page.getByLabel('试填：饮水毫升', { exact: true })).toBeHidden()
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByLabel('试填：饮水毫升单位').selectOption('L')
  await page.getByLabel('试填：饮水毫升', { exact: true }).fill('0.5')
  await page.getByRole('button', { name: '加入试填' }).click()
  await expect(page.getByRole('region', { name: '记录统计' })).toContainText('500 ml')
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('25%')
  await screenshot(page, `${info.project.name}-generic-market-desktop.png`)
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); expect(await page.getByLabel('试填：饮水毫升单位').evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); await screenshot(page, `${info.project.name}-generic-market-${width}.png`) }
  await page.getByRole('link', { name: '登录后使用' }).click()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/market/official.water')
  await page.goto('/market/official.ledger')
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '功能简介', exact: true })).toBeVisible()
  await expect(page.getByLabel('试填：金额（元）', { exact: true })).toBeHidden()
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByLabel('试填：金额（元）', { exact: true }).fill('20')
  await page.getByRole('button', { name: '加入试填' }).click()
  await expect(page.locator('.template-preview')).toContainText('¥20.00')
  await page.getByLabel('试填记录类型').selectOption('refund')
  await page.getByLabel('试填原支出').selectOption({ index: 1 })
  await page.getByLabel('试填：金额（元）', { exact: true }).fill('5')
  await page.getByRole('button', { name: '加入试填' }).click()
  await expect(page.locator('.template-preview')).toContainText('¥15.00')
  expect(writes).toEqual([])
})

test.describe('generic和记账模板真实闭环', () => {
  test.skip(!email || !password, '需要 PLANPLAN_GENERIC_E2E_EMAIL/PASSWORD 指定独立合成账户')
  test.describe.configure({ mode: 'serial', timeout: 90_000 })
  let created: string[] = []
  let today = ''
  let errors: string[] = []
  async function headers(page: Page) {
    const response = await page.request.get('/v1/auth/web/session')
    expect(response.ok()).toBe(true)
    const session = await response.json()
    return { Origin: new URL(page.url()).origin, 'X-PlanPlan-Expected-User': session.userId as string, 'X-CSRF-Token': session.csrfToken as string, 'X-PlanPlan-Capabilities': capabilities }
  }
  async function read<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(path, { headers: await headers(page) })
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json() as T
  }
  async function post(page: Page, actions: Action[]) {
    const response = await page.request.post('/v1/operations', { headers: await headers(page), data: { clientOpId: randomUUID(), inputAt: new Date().toISOString(), actions } })
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json() as OperationResult
  }
  async function operation(page: Page, click: () => Promise<void>, status = 200) {
    const waiting = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
    await click()
    const response = await waiting
    expect(response.status(), await response.text()).toBe(status)
    return { result: await response.json() as OperationResult, body: response.request().postDataJSON() }
  }
  async function adopt(page: Page) {
    await page.goto('/market/official.water')
    const { result } = await operation(page, () => page.getByRole('button', { name: '使用模板', exact: true }).click())
    const id = result.templatePlan!.planId
    created.push(id)
    await expect(page).toHaveURL(new RegExp(`/plans/${id}\\?setup=1$`))
    await expect(page.getByRole('heading', { name: '完善计划设置' })).toBeVisible()
    return id
  }
  async function view(page: Page, id: string, date = today) { return read<GenericView>(page, `/v1/plans/${id}/generic?date=${date}`) }
  async function add(page: Page, amount: string, note: string, unit = 'ml') {
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await page.getByLabel('饮水毫升单位').selectOption(unit)
    await page.getByLabel('饮水毫升', { exact: true }).fill(amount)
    await page.getByLabel('备注（可留空）').fill(note)
    const result = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    await expect(page.locator('.record-form')).toHaveCount(0)
    return result
  }
  async function skip(page: Page) { await operation(page, () => page.getByRole('button', { name: '暂不设置，开始记录' }).click()) }
  test.beforeEach(async ({ page }) => {
    created = []; errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const path = process.env.PLANPLAN_GENERIC_E2E_STORAGE_STATE
    if (!storage && path) { try { storage = JSON.parse(await readFile(path, 'utf8')) as Storage } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    if (storage) { await page.context().addCookies(storage.cookies); await page.goto('/plans') }
    else {
      await page.goto('/login?next=%2Fmarket%2Fofficial.water')
      await page.getByLabel('邮箱', { exact: true }).fill(email!)
      await page.getByLabel('密码', { exact: true }).fill(password!)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(page).toHaveURL('/market/official.water')
      storage = await page.context().storageState()
      if (path) await writeFile(path, JSON.stringify(storage), { mode: 0o600 })
    }
    const me = await read<{ today: string; aiConsent: boolean }>(page, '/v1/me')
    today = me.today
    expect(me.aiConsent).toBe(false)
    if (new URL(page.url()).pathname === '/plans') {
      await expect(page.getByRole('button', { name: '新建计划', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '刷新计划', exact: true })).toBeEnabled()
    }
  })
  test.afterEach(async ({ page }) => {
    if (storage) await page.context().addCookies(storage.cookies)
    for (const id of created) {
      const plans = await read<PlansResponse>(page, '/v1/plans?status=active')
      if (plans.plans.some((card) => card.plan.id === id)) await post(page, [{ type: 'rename_plan', planId: id, name: `QA模板${id.slice(0, 8)}` }, { type: 'archive_plan', planId: id }])
    }
    expect(errors).toEqual([])
  })

  test('关闭AI：目标零事实、500+300=800/40%、改删与升换算、刷新和实际ZIP一致', async ({ page }, info) => {
    const aiRequests: string[] = []
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/chat' && request.method() === 'POST') aiRequests.push(request.url()) })
    const id = await adopt(page)
    await page.getByLabel('计划名称', { exact: true }).fill(`QA饮水${Date.now().toString().slice(-8)}`)
    await page.getByLabel('每日目标毫升（可留空）', { exact: true }).fill('2000')
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    expect((await view(page, id)).summary.recordCount).toBe(0)
    await add(page, '500', 'QA第一条')
    await add(page, '300', 'QA第二条')
    await expect(page.getByRole('region', { name: '记录统计' })).toContainText('800 ml')
    await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('40%')
    await screenshot(page, `${info.project.name}-generic-800-desktop.png`)
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); await screenshot(page, `${info.project.name}-generic-800-${width}.png`) }
    await page.locator('.generic-record-row').filter({ hasText: 'QA第二条' }).click()
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('200')
    await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    await expect(page.locator('.record-inspector')).toHaveCount(0)
    expect((await view(page, id)).summary.metrics.find((metric) => metric.id === 'dailyMl')?.value).toBe(700)
    await page.locator('.generic-record-row').filter({ hasText: 'QA第二条' }).click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    expect((await view(page, id)).summary.metrics.find((metric) => metric.id === 'dailyMl')?.value).toBe(500)
    const converted = await add(page, '0.5', 'QA明确升数', 'L')
    expect(converted.body.actions[0].values.amountMl).toBe(500)
    await page.reload()
    const saved = await view(page, id)
    expect(saved.summary).toMatchObject({ recordCount: 2 })
    expect(saved.summary.metrics.find((metric) => metric.id === 'dailyMl')?.value).toBe(1000)
    expect(saved.records.find((record) => record.fields?.note === 'QA明确升数')?.fields?.amountMl).toBe(500)
    await page.getByRole('link', { name: '导出我的数据', exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出数据', exact: true }).click()
    const download = await downloading
    const path = await download.path()
    expect(path).not.toBeNull()
    const zip = await readFile(path!)
    const exported = JSON.parse(unzipText(zip, 'generic-records.json')) as { records: RecordView[] }
    expect(exported.records.filter((record) => record.planId === id).map((record) => record.fields?.amountMl).sort()).toEqual([500, 500])
    const templates = JSON.parse(unzipText(zip, 'templates.json')) as { templates: TemplatePlanState[] }
    expect(templates.templates.find((item) => item.planId === id)?.config.values?.dailyGoalMl).toBe(2000)
    expect(aiRequests).toEqual([])
  })

  test('丢响应恢复同条、版本冲突保留草稿，适用撤销只逆转本次更改', async ({ page }) => {
    const id = await adopt(page); await skip(page)
    let lostId = ''
    await page.route('**/v1/operations', async (route) => {
      const input = route.request().postDataJSON()
      if (input.actions?.[0]?.values?.note !== 'QA丢响应') return route.continue()
      lostId = input.clientOpId
      const response = await route.fetch(); expect(response.ok()).toBe(true)
      await route.abort('connectionfailed')
    })
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('250')
    await page.getByLabel('备注（可留空）').fill('QA丢响应')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.unroute('**/v1/operations'); await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page.locator('.generic-record-row')).toHaveCount(1)
    const recovered = await read<{ result: OperationResult }>(page, `/v1/operations/${lostId}`)
    expect(recovered.result.items[0]?.type).toBe('generic_added')
    const record = (await view(page, id)).records[0]!
    await page.locator('.generic-record-row').click(); await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('300')
    await post(page, [{ type: 'edit_generic_record', recordId: record.id, expectedVersion: record.version, values: { ...record.fields, amountMl: 400 } }])
    await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click(), 409)
    await expect(page.getByLabel('饮水毫升', { exact: true })).toHaveValue('300')
    expect((await view(page, id)).records[0]?.fields?.amountMl).toBe(400)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '刷新记录', exact: true }).click()
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('350')
    await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    await page.getByRole('button', { name: '撤销这次更改' }).click()
    const undo = page.waitForResponse((response) => response.url().includes('/undo') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '确认撤销更改' }).click(); expect((await undo).ok()).toBe(true)
    expect((await view(page, id)).records[0]?.fields?.amountMl).toBe(400)
  })

  test('历史目标与今天设置分离，日期切换清草稿，分页无丢项', async ({ page }) => {
    const id = await adopt(page)
    const prior = new Date(`${today}T00:00:00Z`); prior.setUTCDate(prior.getUTCDate() - 1); const yesterday = prior.toISOString().slice(0, 10)
    await page.getByLabel('开始日期', { exact: true }).fill(yesterday)
    await page.getByLabel('每日目标毫升（可留空）', { exact: true }).fill('2000')
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    for (let offset = 0; offset < 22; offset += 8) await post(page, Array.from({ length: Math.min(8, 22 - offset) }, (_, n): Action => ({ type: 'add_generic_record', planId: id, values: { date: today, amountMl: offset + n + 1, note: `QA分页${offset + n + 1}` } })))
    await page.reload(); await expect(page.locator('.generic-record-row')).toHaveCount(20)
    await page.getByRole('button', { name: '下一页' }).click(); await expect(page.locator('.generic-record-row')).toHaveCount(2)
    await page.getByLabel('查看日期', { exact: true }).fill(yesterday)
    await expect(page.locator('.generic-record-row')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('未设置目标')
    await page.getByRole('button', { name: '调整设置', exact: true }).click()
    await expect(page.getByLabel('每日目标毫升（可留空）', { exact: true })).toHaveValue('2000')
    await page.getByLabel('每日目标毫升（可留空）', { exact: true }).fill('3000')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByLabel('查看日期', { exact: true }).fill(today)
    await page.getByRole('button', { name: '调整设置', exact: true }).click()
    await expect(page.getByLabel('每日目标毫升（可留空）', { exact: true })).toHaveValue('2000')
    await page.getByLabel('目标生效范围').selectOption('next_and_future')
    await page.getByLabel('每日目标毫升（可留空）', { exact: true }).fill('3000')
    await operation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    await expect(page.locator('.reading-settings-summary')).toContainText('3,000 ml')
    const state = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    expect(state.config.values?.dailyGoalMl).toBe(2000)
    expect(state.config.nextPeriodValues?.dailyGoalMl?.value).toBe(3000)
  })

  test('配置丢响应恢复只更新一次且零事实，切换计划不复用未保存草稿', async ({ page }) => {
    const id = await adopt(page)
    const initial = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    let operationId = '', committedVersion = 0
    await page.route('**/v1/operations', async (route) => {
      const input = route.request().postDataJSON()
      if (input.actions?.[0]?.type !== 'configure_generic_plan') return route.continue()
      operationId = input.clientOpId
      const response = await route.fetch(); expect(response.ok()).toBe(true)
      committedVersion = (await response.json() as OperationResult).templatePlan!.config.version
      await route.abort('connectionfailed')
    })
    await page.getByLabel('每日目标毫升（可留空）', { exact: true }).fill('2000')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.unroute('**/v1/operations'); await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
    const recovered = await read<{ result: OperationResult }>(page, `/v1/operations/${operationId}`)
    expect(recovered.result.templatePlan?.config.values?.dailyGoalMl).toBe(2000)
    const saved = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    expect(committedVersion).toBeGreaterThan(initial.config.version)
    expect(saved.config.version).toBe(committedVersion)
    expect(recovered.result.templatePlan?.config.version).toBe(committedVersion)
    expect((await view(page, id)).summary.recordCount).toBe(0)
    const otherId = await adopt(page); await skip(page)
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('999')
    await page.getByLabel('备注（可留空）').fill('QA未保存草稿')
    await page.goto(`/plans/${id}`)
    await expect(page.locator('.record-form')).toHaveCount(0)
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await expect(page.getByLabel('饮水毫升', { exact: true })).toHaveValue('')
    expect((await view(page, otherId)).summary.recordCount).toBe(0)
  })

  test('切换账户后通用记录的待核对查询和旧写入拒绝，私人计划与草稿不串用', async ({ page }) => {
    const otherEmail = process.env.PLANPLAN_GENERIC_SECOND_EMAIL
    const otherPassword = process.env.PLANPLAN_GENERIC_SECOND_PASSWORD
    test.skip(!otherEmail || !otherPassword, '需要第二个只读合成账户验证隔离')
    const id = await adopt(page); await skip(page)
    const originalHeaders = await headers(page)
    let body: unknown = null
    await page.route('**/v1/operations', async (route) => {
      const input = route.request().postDataJSON()
      if (input.actions?.[0]?.values?.note !== 'QA隔离待核对') return route.continue()
      body = input
      expect(route.request().headers()['x-planplan-expected-user']).toBe(originalHeaders['X-PlanPlan-Expected-User'])
      await route.abort('connectionfailed')
    })
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await page.getByLabel('饮水毫升', { exact: true }).fill('123')
    await page.getByLabel('备注（可留空）').fill('QA隔离待核对')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    const login = await page.request.post('/v1/auth/web/email/login', { headers: { Origin: new URL(page.url()).origin }, data: { email: otherEmail, password: otherPassword } })
    expect(login.ok()).toBe(true)
    const before = await read<PlansResponse>(page, '/v1/plans')
    const rejected = await page.request.post('/v1/operations', { headers: originalHeaders, data: body })
    expect(rejected.status()).toBe(409); expect((await rejected.json()).error.code).toBe('account_mismatch')
    const lookup = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/v1/operations/') && response.request().method() === 'GET')
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    const response = await lookup
    expect(response.status()).toBe(409)
    expect(response.request().headers()['x-planplan-expected-user']).toBe(originalHeaders['X-PlanPlan-Expected-User'])
    await expect(page.locator('.record-form')).toHaveCount(0)
    await expect(page.getByText('QA隔离待核对', { exact: true })).toHaveCount(0)
    const crossRead = await page.request.get(`/v1/plans/${id}/generic`, { headers: await headers(page) })
    expect(crossRead.status()).toBe(404)
    expect(await read<PlansResponse>(page, '/v1/plans')).toEqual(before)
    await page.context().addCookies(storage!.cookies)
    expect((await view(page, id)).summary.recordCount).toBe(0)
  })

  test('记账模板从首次选用到复用/显式恢复：预算不被默认值覆盖，原支出退款保持', async ({ page }, info) => {
    await page.goto('/market/official.ledger')
    const candidates = page.getByRole('button', { name: /^(使用模板|使用现有计划|恢复并使用计划)$/ })
    const { result } = await operation(page, () => candidates.click())
    const id = result.templatePlan!.planId; created.push(id)
    await expect(page).toHaveURL(new RegExp(`/plans/${id}`))
    if (result.templatePlan!.config.setupStatus === 'ready') await page.getByRole('button', { name: '设置月预算', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设置月预算', exact: true })).toBeVisible()
    await page.getByLabel('月预算（元，可留空）', { exact: true }).fill('600')
    await operation(page, () => page.getByRole('button', { name: '保存预算', exact: true }).click())
    const initial = await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)
    expect(initial.config.budgetCents).toBe(60000)
    const expense = await post(page, [{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today, note: 'QA模板账本原支出' }])
    const first = expense.items.find((item) => item.type === 'expense_added')!
    if (first.type !== 'expense_added') throw new Error('没有支出回执')
    const refund = await post(page, [{ type: 'add_refund', expenseId: first.record.id, amountCents: 500, date: today, note: 'QA模板账本退款' }])
    const refunded = refund.items.find((item) => item.type === 'refund_added')!
    if (refunded.type !== 'refund_added') throw new Error('没有退款回执')
    await page.goto('/market/official.ledger')
    await expect(page.getByRole('region', { name: '已有计划' })).toContainText('¥600.00')
    await screenshot(page, `${info.project.name}-ledger-reuse-desktop.png`)
    const reused = await operation(page, () => page.getByRole('button', { name: '使用现有计划', exact: true }).click())
    expect(reused.result.templatePlan?.planId).toBe(id)
    expect(reused.result.templatePlan?.config.budgetCents).toBe(60000)
    await page.getByRole('button', { name: '归档计划', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认归档', exact: true }).click())
    await expect(page.getByRole('button', { name: '恢复计划', exact: true })).toBeEnabled()
    await page.goto('/market/official.ledger')
    await expect(page.getByRole('button', { name: '恢复并使用计划', exact: true })).toBeVisible()
    expect((await read<PlansResponse>(page, '/v1/plans?status=archived')).plans.some((card) => card.plan.id === id)).toBe(true)
    await page.setViewportSize({ width: 320, height: 844 }); await noOverflow(page); await screenshot(page, `${info.project.name}-ledger-restore-320.png`)
    const restored = await operation(page, () => page.getByRole('button', { name: '恢复并使用计划', exact: true }).click())
    expect(restored.result.templatePlan?.planId).toBe(id)
    const plans = await read<PlansResponse>(page, '/v1/plans?status=active')
    expect(plans.plans.filter((card) => card.plan.kind === 'ledger')).toHaveLength(1)
    expect((await read<TemplatePlanState>(page, `/v1/plans/${id}/template`)).config.budgetCents).toBe(60000)
    const ledger = await read<{ records: RecordView[] }>(page, `/v1/plans/${id}/ledger`)
    expect(ledger.records.find((record) => record.id === refunded.record.id)?.refundOf).toBe(first.record.id)
    const currentExpense = ledger.records.find((record) => record.id === first.record.id)!
    await page.goto(`/plans/${id}?record=${first.record.id}`)
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
    const deleted = await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    expect(deleted.body.actions[0]).toMatchObject({ type: 'delete_record', recordId: first.record.id, expectedVersion: currentExpense.version, includeRefunds: true, expectedRefundSnapshot: expect.stringMatching(/^refunds-v1:[a-f0-9]{64}$/) })
  })
})
