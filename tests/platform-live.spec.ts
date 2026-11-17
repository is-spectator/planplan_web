import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateDefinition } from '../src/lib/contracts'
const password = process.env.PLANPLAN_PLATFORM_PASSWORD
const output = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
const capabilities = 'generic-record-v1,generic-template-v2,private-template-v1,community-template-v1,reading-template-v1,ledger-template-v1,chat-recovery-v1'

test.describe('平台真实发布与采用链路', () => {
  test.skip(!password, '需要专用平台合成账号')
  test.describe.configure({ mode: 'serial', timeout: 120000 })
  let author: Page, consumer: Page, reviewer: Page
  const contexts: BrowserContext[] = []
  let draftId = '', templateId = '', listingId = '', planId = '', recordId = ''
  let definition: TemplateDefinition, title = '', name = ''
  const runtime: string[] = []
  async function headers(page: Page) { const session = await (await page.request.get('/v1/auth/web/session')).json(); return { Origin: new URL(page.url()).origin, 'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrfToken, 'X-PlanPlan-Capabilities': capabilities } }
  async function read(page: Page, path: string) { const r = await page.request.get(path, { headers: await headers(page) }); expect(r.ok(), await r.text()).toBe(true); return r.json() }
  async function mutation(page: Page, path: string, action: () => Promise<void>) { const wait = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'POST'); await action(); const response = await wait; expect(response.ok(), await response.text()).toBe(true); const result = await response.json(); await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some(lock => lock.name === 'planplan-browser-session') ?? false)).toBe(false); return result }
  async function capture(page: Page, label: string) { if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, `${test.info().project.name}-${label}.png`), fullPage: true }) } }
  async function field(page: Page, sectionName: string, label: string, type: string, required = false) { const section = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: sectionName, exact: true }) }); await section.getByRole('button', { name: '添加项目', exact: true }).click(); const row = section.locator('.definition-field').last(); await row.getByLabel('项目名称', { exact: true }).fill(label); await row.getByRole('combobox', { name: '填写方式', exact: true }).selectOption(type); if (required) await row.getByLabel('必须填写', { exact: true }).check(); if (type === 'single_select') await row.getByLabel('选项（每行一个）', { exact: true }).fill('纸质书\n电子书'); return row }
  async function approve() { await reviewer.goto('/review'); const row = reviewer.locator('.review-submission').filter({ has: reviewer.locator('summary').filter({ hasText: title }) }); await row.locator(':scope > summary').click(); await row.getByLabel('已核对公开名称、说明、字段、示例和建议值').check(); await mutation(reviewer, '/v1/community/requests', () => row.getByRole('button', { name: '确认审核结果', exact: true }).click()) }
  async function publish(version: number) { await author.goto(`/publish/${encodeURIComponent(templateId)}?version=${version}${listingId ? `&listing=${listingId}` : ''}`); await author.getByLabel('公开名称', { exact: true }).fill(title); await author.getByLabel('作者署名', { exact: true }).fill('内测作者'); await author.getByRole('combobox', { name: '分类', exact: true }).selectOption('reading'); await author.getByLabel('将模板建议值放入公开预览，逐项核对后才送审').check(); const preview = await mutation(author, '/v1/community/requests', () => author.getByRole('button', { name: '生成公开预览', exact: true }).click()); expect(preview.preview.payload.definition.example.record).not.toHaveProperty('privateNote'); await author.getByLabel('我已核对以上全部内容，同意将它作为公开模板送审').check(); const submitted = await mutation(author, '/v1/community/requests', () => author.getByRole('button', { name: '确认送审', exact: true }).click()); listingId = submitted.submission.listingId; await approve(); await author.goto(`/community/${listingId}`); await author.getByRole('button', { name: '发布审核通过的版本', exact: true }).click(); return mutation(author, '/v1/community/requests', () => author.getByRole('button', { name: '确认发布', exact: true }).click()) }
  test.beforeAll(async ({ browser }, info) => {
    name = `周阅读${info.project.name}`; title = `社区阅读${info.project.name}${Date.now().toString().slice(-5)}`
    for (const role of ['author', 'consumer', 'reviewer']) { let storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined; if (output) { try { storageState = JSON.parse(await readFile(join(output, `${info.project.name}-${role}-session.json`), 'utf8')) } catch { /* First normal login seeds a synthetic session. */ } } const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5173', storageState }); contexts.push(context); const page = await context.newPage(); page.on('pageerror', (error) => runtime.push(error.message)); page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|Load failed|Request blocked by Playwright|server responded/.test(message.text())) runtime.push(message.text()) }); if (storageState) await page.goto('/create'); else { await page.goto('/login?next=%2Fcreate'); await page.getByLabel('邮箱', { exact: true }).fill(`platform-${role}@planplan.test`); await page.getByLabel('密码', { exact: true }).fill(password!); await page.getByRole('button', { name: '登录', exact: true }).click(); } await expect(page.getByRole('heading', { name: '创作', exact: true })).toBeVisible(); if (role === 'author') author = page; else if (role === 'consumer') consumer = page; else reviewer = page; if (output) await writeFile(join(output, `${info.project.name}-${role}-session.json`), JSON.stringify(await context.storageState()), { mode: 0o600 }) }
  })
  test.afterEach(() => { expect(runtime).toEqual([]) })
  test.afterAll(async () => { for (const context of contexts) await context.close() })

  test('P04/05真实：手动设计周月统计、分类与建议值，保存私人版本', async () => {
    const created = await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '创建模板', exact: true }).click()); draftId = created.draft.id
    await author.getByRole('button', { name: '从空白开始设计', exact: true }).click(); await author.getByLabel('模板名称', { exact: true }).fill(name); await author.getByLabel('功能简介', { exact: true }).fill('记录阅读时长与类型，按周和月观察自己的积累。')
    await field(author, '开始时的设置', '每周目标', 'duration'); await field(author, '每次记录的内容', '阅读时长', 'duration', true); await field(author, '每次记录的内容', '类型', 'single_select'); await field(author, '每次记录的内容', '读完', 'boolean')
    const metrics = author.locator('.definition-section').filter({ has: author.getByRole('heading', { name: '统计与目标', exact: true }) })
    for (const [label, operation, period] of [['每周阅读', 'sum', 'week'], ['每月平均', 'mean', 'month'], ['每周目标进度', 'goal_progress', 'week']]) { await metrics.getByRole('button', { name: '添加统计', exact: true }).click(); const row = metrics.locator('.definition-field').last(); await row.getByLabel('统计名称', { exact: true }).fill(label!); await row.getByRole('combobox', { name: '计算方式', exact: true }).selectOption(operation!); await row.getByRole('combobox', { name: '统计周期', exact: true }).selectOption(period!); if (operation === 'goal_progress') await row.getByRole('combobox', { name: '目标来自哪项设置', exact: true }).selectOption({ label: '每周目标' }); if (operation === 'sum') await row.getByRole('combobox', { name: '分类维度', exact: true }).selectOption({ label: '类型' }) }
    for (const label of ['目标进度', '变化趋势', '分类统计']) await author.getByRole('checkbox', { name: label, exact: true }).check()
    for (const label of ['每周目标', '类型', '读完']) await author.getByRole('checkbox', { name: `建议${label}`, exact: true }).check()
    await author.getByLabel('默认：每周目标（分钟）（可留空）', { exact: true }).fill('100'); await author.getByLabel('默认：类型（可留空）', { exact: true }).selectOption('纸质书'); await author.getByLabel('默认：读完（可留空）', { exact: true }).selectOption('false')
    const updated = await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '保存草稿修改', exact: true }).click()); definition = updated.draft.definition
    expect(definition.requiredCapabilities).toContain('generic-template-v2'); expect(Object.values(definition.recordDefaults!)).toContain(false)
    const saved = await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '保存私人模板', exact: true }).click()); templateId = saved.draft.savedTemplate.id
    await capture(author, 'platform-private-v2')
  })
  test('P07/08/09真实：公开预览送审、独立审核、作者确认发布、公开市场筛选', async () => {
    const published = await publish(1); expect(published.listing.status).toBe('listed')
    await consumer.goto('/market'); await consumer.getByRole('combobox', { name: '来源', exact: true }).selectOption('community'); await consumer.getByRole('combobox', { name: '分类', exact: true }).selectOption('reading'); await consumer.getByRole('searchbox', { name: '搜索模板', exact: true }).fill(title); await consumer.getByRole('button', { name: '搜索', exact: true }).click(); await expect(consumer.locator('.template-card')).toHaveCount(1); await expect(consumer.locator('.template-card')).toContainText(title); await capture(consumer, 'platform-market'); await consumer.locator('.template-card').click(); await expect(consumer.getByRole('heading', { name: title, exact: true })).toBeVisible()
  })
  test('P04/05/10真实：采用不写默认，明确配置后新增沿用false，编辑不补写，周期结果可核对', async () => {
    const adopted = await mutation(consumer, '/v1/operations', () => consumer.getByRole('button', { name: '使用模板', exact: true }).click()); planId = adopted.templatePlan.planId; expect(adopted.templatePlan.config.recordDefaults).toEqual({}); expect(Object.values(adopted.templatePlan.config.values ?? {}).filter((value) => value !== null)).toHaveLength(0)
    await consumer.getByLabel('确认使用这些建议，仍可逐项修改').check(); await consumer.getByText('新增记录的常用值', { exact: true }).click(); await consumer.getByRole('button', { name: '载入模板建议，保存后启用', exact: true }).click(); await mutation(consumer, '/v1/operations', () => consumer.getByRole('button', { name: '保存设置', exact: true }).click())
    await consumer.getByRole('button', { name: '添加记录', exact: true }).click(); await consumer.getByLabel('阅读时长（分钟）', { exact: true }).fill('30'); const added = await mutation(consumer, '/v1/operations', () => consumer.getByRole('button', { name: '保存记录', exact: true }).click()); recordId = added.items[0].record.id; expect(added.items[0].record.defaultedFields).toHaveLength(2)
    const view = await read(consumer, `/v1/plans/${planId}/generic`); expect(view.summary.metrics.find((metric: { label: string }) => metric.label === '每周阅读').value).toBe(30); expect(view.summary.metrics.find((metric: { label: string }) => metric.label === '每月平均').sampleCount).toBe(1)
    await consumer.goto(`/plans/${planId}?record=${recordId}`); await expect(consumer.locator('.record-inspector')).toContainText('沿用设置'); await consumer.getByRole('button', { name: '修改记录', exact: true }).click(); await consumer.getByLabel('类型（可留空）', { exact: true }).selectOption(''); await mutation(consumer, '/v1/operations', () => consumer.getByRole('button', { name: '保存修改', exact: true }).click()); const changed = await read(consumer, `/v1/records/${recordId}`); const categoryId = definition.recordFields.find((field) => field.label === '类型')!.id; expect(changed.record.fields[categoryId]).toBeNull()
    await capture(consumer, 'platform-periods'); await consumer.setViewportSize({ width: 375, height: 812 }); expect(await consumer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await capture(consumer, 'platform-periods-mobile'); await consumer.setViewportSize({ width: 1280, height: 900 })
  })
  test('P10真实：新版本公开后旧计划不变，明确确认兼容更新并保留原记录', async () => {
    await author.goto(`/create/${draftId}`); await author.getByRole('button', { name: '手动编辑', exact: true }).click(); await field(author, '每次记录的内容', '阅读感想', 'text'); await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '保存草稿修改', exact: true }).click()); await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '保存私人模板', exact: true }).click()); await publish(2)
    await consumer.goto(`/plans/${planId}`); await expect(consumer.getByRole('heading', { name: '社区模板 · 当前版本 1', exact: true })).toBeVisible(); await consumer.getByRole('button', { name: '检查模板更新', exact: true }).click(); await expect(consumer.getByRole('heading', { name: '版本 1 → 2', exact: true })).toBeVisible(); await consumer.getByLabel('我已核对修改，采用这个兼容版本').check(); await mutation(consumer, '/v1/operations', () => consumer.getByRole('button', { name: '确认采用更新', exact: true }).click()); const view = await read(consumer, `/v1/plans/${planId}/generic`); expect(view.templatePlan.templateVersion).toBe(2); expect(view.records.find((record: { id: string }) => record.id === recordId)).toBeTruthy(); expect(view.records[0].definitionVersion).toBe(1)
  })
  test('P08/14真实：举报与审核下架保留采用计划，反馈可提交并收到审核回复', async () => {
    const work = await read(author, `/v1/community/works/${listingId}`); await consumer.goto(`/market/${encodeURIComponent(work.templateId)}`); await consumer.getByRole('button', { name: '举报这个模板', exact: true }).click(); await consumer.getByLabel('补充说明', { exact: true }).fill(`合成验收 ${title}`); await mutation(consumer, '/v1/community/requests', () => consumer.getByRole('button', { name: '提交举报', exact: true }).click())
    await reviewer.goto('/review'); const report = reviewer.locator('.plan-notice').filter({ has: reviewer.getByText(`合成验收 ${title}`, { exact: true }) }); await report.getByRole('combobox', { name: '处理方式', exact: true }).selectOption('actioned'); await report.getByLabel('处理说明', { exact: true }).fill('合成验收：暂停展示供确认'); await mutation(reviewer, '/v1/community/requests', () => report.getByRole('button', { name: '确认处理', exact: true }).click()); expect((await read(author, `/v1/community/works/${listingId}`)).status).toBe('suspended'); await consumer.goto(`/plans/${planId}`); await expect(consumer.getByRole('button', { name: '添加记录', exact: true })).toBeEnabled()
    await consumer.goto('/me'); await consumer.getByLabel('遇到了什么问题？', { exact: true }).fill(`合成反馈 ${title}`); await consumer.getByRole('button', { name: '预览反馈', exact: true }).click(); const created = await mutation(consumer, '/v1/feedback/requests', () => consumer.getByRole('button', { name: '确认提交反馈', exact: true }).click()); expect(created.ticket.diagnostics).toBeNull(); await reviewer.goto('/review'); const ticket = reviewer.locator('.feedback-ticket').filter({ hasText: `合成反馈 ${title}` }); await ticket.locator('summary').click(); await ticket.getByRole('combobox', { name: '处理状态', exact: true }).selectOption('resolved'); await ticket.getByLabel('给用户的回复', { exact: true }).fill('已确认反馈链路正常'); await mutation(reviewer, '/v1/feedback/requests', () => ticket.getByRole('button', { name: '保存处理结果', exact: true }).click()); await consumer.goto('/me'); const own = consumer.locator('.feedback-ticket').filter({ hasText: `合成反馈 ${title}` }); await own.locator('summary').click(); await expect(own).toContainText('已确认反馈链路正常')
    if (output) await writeFile(join(output, `${test.info().project.name}-platform-ids.json`), JSON.stringify({ draftId, templateId, listingId, planId, recordId, title, fieldTypes: definition.recordFields.map(({ id, type }) => ({ id, type })) }, null, 2)); await capture(consumer, 'platform-feedback')
  })
  test('P03真实：同账户可见页面同步、旧版本冲突保留输入与最新内容对照', async () => {
    await consumer.goto(`/plans/${planId}?record=${recordId}`)
    await consumer.getByRole('button', { name: '修改记录', exact: true }).click()
    await consumer.getByLabel('阅读时长（分钟）', { exact: true }).fill('40')
    const other = await consumer.context().newPage()
    await other.goto(`/plans/${planId}?record=${recordId}`)
    await other.getByRole('button', { name: '修改记录', exact: true }).click()
    await other.getByLabel('阅读时长（分钟）', { exact: true }).fill('45')
    await mutation(other, '/v1/operations', () => other.getByRole('button', { name: '保存修改', exact: true }).click())
    await consumer.bringToFront()
    await expect(consumer.getByRole('region', { name: '记录统计', exact: true })).toContainText('45 分钟', { timeout: 22000 })
    const response = consumer.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
    await consumer.getByRole('button', { name: '保存修改', exact: true }).click()
    expect((await response).status()).toBe(409)
    await expect(consumer.getByLabel('阅读时长（分钟）', { exact: true })).toHaveValue('40')
    await consumer.getByRole('link', { name: '查看提交详情与内容对照', exact: true }).click()
    const comparison = consumer.locator('.conflict-comparison')
    await expect(comparison).toContainText('40 分钟')
    await expect(comparison).toContainText('45 分钟')
    await capture(consumer, 'platform-conflict')
    await consumer.getByRole('button', { name: '已核对，关闭提示', exact: true }).click()
    await other.close()
  })
  test('P03/14真实：反馈已保存但响应丢失，刷新以原ID核对且无重复工单', async () => {
    await consumer.goto('/me')
    const description = `恢复验收 ${title}`
    await consumer.getByLabel('遇到了什么问题？', { exact: true }).fill(description)
    await consumer.getByRole('button', { name: '预览反馈', exact: true }).click()
    let originalId = ''
    await consumer.route('**/v1/feedback/requests', async route => { originalId = route.request().postDataJSON().clientOpId; const saved = await route.fetch(); expect(saved.ok()).toBe(true); await route.abort('failed') }, { times: 1 })
    await consumer.getByRole('button', { name: '确认提交反馈', exact: true }).click()
    await expect(consumer.getByRole('button', { name: '核对结果', exact: true }).first()).toBeVisible()
    await consumer.reload()
    await consumer.getByRole('button', { name: '核对结果', exact: true }).first().click()
    await expect(consumer.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
    const lookup = await read(consumer, `/v1/feedback/requests/${originalId}`)
    expect(lookup.status).toBe('succeeded')
    expect((await read(consumer, '/v1/feedback')).tickets.filter((ticket: { description: string }) => ticket.description === description)).toHaveLength(1)
    await capture(consumer, 'platform-recovered')
  })

  test('P02真实：指定模型记录后，可从记录详情定位本人的来源消息', async () => {
    let text = '今天阅读时长10分钟，类型和读完沿用计划设置，阅读感想留空。'
    let added: { record: { id: string; sourceMessageId: string; defaultedFields?: string[] } }
    if (process.env.PLANPLAN_SOURCE_READONLY_PATH) {
      const source = JSON.parse(await readFile(process.env.PLANPLAN_SOURCE_READONLY_PATH, 'utf8'))
      planId = source.planId
      added = await read(consumer, `/v1/records/${source.recordId}`)
      text = (await read(consumer, `/v1/messages/${source.sourceMessageId}`)).message.text
    } else {
      if (!planId && output) { const ids = JSON.parse(await readFile(join(output, `${test.info().project.name}-platform-ids.json`), 'utf8')); planId = ids.planId }
      expect(planId).not.toBe('')
      if (!(await read(consumer, '/v1/me')).aiConsent) { await consumer.goto('/me'); await consumer.getByRole('button', { name: '同意并开启 AI 对话', exact: true }).click(); await expect(consumer.getByRole('button', { name: '关闭 AI 对话', exact: true })).toBeVisible() }
      await consumer.goto(`/chat?plan=${planId}`)
      await consumer.getByRole('textbox', { name: '消息', exact: true }).fill(text)
      const result = await mutation(consumer, '/v1/chat', () => consumer.getByRole('button', { name: '发送消息', exact: true }).click())
      added = result.assistant.cards.flatMap((card: { items?: { type: string; record?: { id: string; sourceMessageId: string; defaultedFields?: string[] } }[] }) => card.items ?? []).find((item: { type: string }) => item.type === 'generic_added')
      expect(added, '真实模型需要保存一条通用记录').toBeTruthy()
    }
    expect(added.record.sourceMessageId).toBeTruthy()
    expect(added.record.defaultedFields?.length).toBe(2)
    await consumer.goto(`/plans/${planId}?record=${added.record.id}`)
    await consumer.getByRole('link', { name: '查看来源对话', exact: true }).click()
    await expect(consumer.getByRole('region', { name: '来源对话', exact: true })).toContainText(text)
    await capture(consumer, 'platform-source-message')
    if (output) await writeFile(join(output, `${test.info().project.name}-platform-source.json`), JSON.stringify({ planId, recordId: added.record.id, sourceMessageId: added.record.sourceMessageId, completedAt: new Date().toISOString() }, null, 2))
  })

  test('P07/08/11真实：查看历史、审核解除暂停与作者重新上架，删除私人作品保留已采用计划与公开版本', async () => {
    if (!planId && output) { const ids = JSON.parse(await readFile(join(output, `${test.info().project.name}-platform-ids.json`), 'utf8')); ({ planId, draftId, templateId, listingId, title } = ids) }
    await reviewer.goto('/review')
    await reviewer.getByRole('combobox', { name: '举报状态', exact: true }).selectOption('actioned')
    const report = reviewer.locator('.plan-notice').filter({ has: reviewer.getByText(`合成验收 ${title}`, { exact: true }) })
    await mutation(reviewer, '/v1/community/requests', () => report.getByRole('button', { name: '解除暂停，允许作者重新上架', exact: true }).click())
    await author.goto(`/community/${listingId}`)
    await author.getByRole('button', { name: '重新上架已发布版本', exact: true }).click()
    await mutation(author, '/v1/community/requests', () => author.getByRole('button', { name: '确认发布', exact: true }).click())
    await author.getByText('查看申请与处理历史', { exact: true }).click()
    await expect(author.locator('.community-history')).toContainText('解除暂停')
    await expect(author.locator('.community-history')).toContainText('审核暂停展示')
    await capture(author, 'platform-history')
    await author.goto(`/create/templates/${encodeURIComponent(templateId)}?version=2`)
    const adopted = await mutation(author, '/v1/operations', () => author.getByRole('button', { name: '使用模板', exact: true }).click())
    const privatePlanId = adopted.templatePlan.planId
    await mutation(author, '/v1/operations', () => author.getByRole('button', { name: '暂不设置，开始记录', exact: true }).click())
    await author.getByRole('button', { name: '添加记录', exact: true }).click()
    await author.getByLabel('阅读时长（分钟）', { exact: true }).fill('15')
    const added = await mutation(author, '/v1/operations', () => author.getByRole('button', { name: '保存记录', exact: true }).click())
    const privateRecordId = added.items[0].record.id
    await author.goto(`/create/${draftId}`)
    await author.getByRole('button', { name: /^删除私人作品/ }).click()
    await expect(author.getByRole('alert')).toContainText('已经采用的计划与记录会保留')
    await author.getByRole('button', { name: '保留作品', exact: true }).click()
    await expect(author.getByRole('button', { name: '确认删除私人作品', exact: true })).toHaveCount(0)
    await author.getByRole('button', { name: /^删除私人作品/ }).click()
    const deleted = await mutation(author, '/v1/creation/requests', () => author.getByRole('button', { name: '确认删除私人作品', exact: true }).click())
    expect(deleted.deleted.draftId).toBe(draftId)
    await expect(author).toHaveURL('/create')
    await expect(author.locator(`a[href="/create/${draftId}"]`)).toHaveCount(0)
    const unavailable = await author.request.get(`/v1/creation/templates/${encodeURIComponent(templateId)}`, { headers: await headers(author) })
    expect(unavailable.status()).toBe(404)
    await author.goto(`/plans/${privatePlanId}?record=${privateRecordId}`)
    await author.getByRole('button', { name: '修改记录', exact: true }).click()
    await author.getByLabel('阅读时长（分钟）', { exact: true }).fill('18')
    await mutation(author, '/v1/operations', () => author.getByRole('button', { name: '保存修改', exact: true }).click())
    expect((await read(author, `/v1/plans/${privatePlanId}/generic`)).records).toHaveLength(1)
    const work = await read(author, `/v1/community/works/${listingId}`)
    expect(work.status).toBe('listed')
    const published = await consumer.request.get(`/v1/market/templates/${encodeURIComponent(work.templateId)}`)
    expect(published.status()).toBe(200)
    expect((await read(consumer, `/v1/plans/${planId}/generic`)).records.length).toBeGreaterThan(0)
    if (output) { const path = join(output, `${test.info().project.name}-platform-ids.json`); const ids = JSON.parse(await readFile(path, 'utf8')); await writeFile(path, JSON.stringify({ ...ids, privatePlanId, privateRecordId, privateDeleted: true }, null, 2)) }
    await capture(author, 'platform-deleted-source-plan')
  })

})
