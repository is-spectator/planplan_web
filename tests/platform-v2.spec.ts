import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { GenericView, TemplateDefinition, TemplatePlanState } from '../src/lib/contracts'
import type { CommunityListing, CommunityPreview, CommunityReport, CommunitySubmission, MarketTemplate } from '../src/features/community/types'

const today = '2026-11-16'
async function fixture(page: Page, reviewer = false) {
  const userId = randomUUID(), planId = randomUUID(), listingId = randomUUID(), requests: Record<string, unknown>[] = []
  const definition: TemplateDefinition = { schemaVersion: 1, id: 'private.test', version: 1, name: '阅读日常', description: '记录阅读时长与类型，按周观察变化。', source: 'private', engine: 'generic', requiredCapabilities: ['generic-record-v1', 'private-template-v1', 'generic-template-v2'], configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'target', label: '每周目标', type: 'duration', unit: 'minute', required: false, min: 1 }], recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'minutes', label: '阅读时长', type: 'duration', unit: 'minute', required: true, min: 1 }, { id: 'category', label: '类型', type: 'single_select', options: ['纸质书', '电子书'], required: false }, { id: 'finished', label: '读完', type: 'boolean', required: false }], configurationDefaults: { target: 100 }, recordDefaults: { category: '纸质书', finished: false }, metrics: [{ id: 'total', label: '阅读时长', operation: 'sum', fieldId: 'minutes', period: 'week', groupByFieldId: 'category' }, { id: 'goal', label: '每周进度', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'target', period: 'week' }, { id: 'mean', label: '每次平均', operation: 'mean', fieldId: 'minutes', period: 'month' }], components: ['summary', 'goal', 'trend', 'categories', 'records'], example: { config: { name: '阅读日常', startDate: today, target: 100 }, record: { date: today, minutes: 30, category: '纸质书', finished: false } } }
  const state: TemplatePlanState = { planId, templateId: definition.id, templateVersion: 1, source: 'private', engine: 'generic', definition, config: { version: 1, setupStatus: 'pending', name: '阅读日常', startDate: today, currentBook: null, daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null }, values: { target: null }, recordDefaults: {}, proposedDefaults: { target: 100 }, canChangeStartDate: true } }
  const plan = { id: planId, kind: 'generic' as const, name: state.config.name, activity: null, status: 'active' as const, startDate: today, hidden: [], order: [], lastActivityAt: new Date().toISOString(), template: { id: definition.id, version: 1, setupStatus: 'pending' as const } }
  const generic: GenericView = { plan, templatePlan: state, today, summary: { planId, from: today, to: today, recordCount: 0, metrics: [{ id: 'total', label: '阅读时长', operation: 'sum', fieldId: 'minutes', unit: 'minute', value: 60, target: null, remaining: null, progressPct: null, period: 'week', from: today, to: today, groups: [{ key: '纸质书', label: '纸质书', value: 60, sampleCount: 2, recordCount: 2 }], series: [{ date: today, value: 60, sampleCount: 2, recordCount: 2 }] }, { id: 'mean', label: '每次平均', operation: 'mean', unit: 'minute', value: null, target: null, remaining: null, progressPct: null, sampleCount: 0, period: 'month', from: '2026-11-01', to: today, series: [] }] }, records: [], totalRecords: 0, offset: 0, limit: 20, dataVersion: 1 }
  const publicDefinition = { ...structuredClone(definition), id: `community.${listingId}`, source: 'community' as const, requiredCapabilities: ['generic-record-v1', 'generic-template-v2', 'community-template-v1'] }
  const listing: CommunityListing = { id: listingId, templateId: publicDefinition.id, version: 1, status: 'unlisted', title: definition.name, description: definition.description, category: 'reading', author: { kind: 'community', name: '小林' }, templateVersion: null, adoptionCount: 0, moderationReason: null, publishedSubmissionId: null, latestSubmission: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const savedResults = new Map<string, Record<string, unknown>>()
  let dropAction: string | null = null
  let preview: CommunityPreview | null = null
  let report: CommunityReport | null = null
  const tickets: Record<string, unknown>[] = []
  const card = (): MarketTemplate => ({ id: listingId, templateId: publicDefinition.id, title: listing.title, description: listing.description, category: 'reading', source: 'community', author: listing.author, templateVersion: 2, adoptionCount: 3, definition: { ...publicDefinition, version: 2 } })
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'v2-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: userId, today, timezone: 'Asia/Shanghai', aiConsent: true, dataVersion: state.config.version, roles: reviewer ? ['reviewer'] : [], signInMethod: 'email' } })
    if (path === '/v1/plans') return route.fulfill({ json: { plans: [{ plan }], dataVersion: state.config.version } })
    if (path.endsWith('/template')) return route.fulfill({ json: state })
    if (path.endsWith('/generic')) return route.fulfill({ json: generic })
    if (path.endsWith('/publication-eligibility')) return route.fulfill({ json: { canPublish: true, reason: null } })
    if (path === '/v1/creation/templates/private.test') return route.fulfill({ json: definition })
    if (path === '/v1/creation/templates') return route.fulfill({ json: { templates: [], total: 0 } })
    if (path === '/v1/creation/drafts') return route.fulfill({ json: { drafts: [], total: 0 } })
    if (path === '/v1/market/templates') { requests.push({ market: url.search }); return route.fulfill({ json: { templates: [card()], total: 1, offset: 0, limit: 20 } }) }
    if (path.startsWith('/v1/market/templates/')) return route.fulfill({ json: card() })
    if (path === '/v1/community/works') return route.fulfill({ json: { listings: [listing], total: 1 } })
    if (path.startsWith('/v1/community/works/') || path.startsWith('/v1/community/review/works/')) return route.fulfill({ json: listing })
    if (path === '/v1/community/review') return route.fulfill({ json: { submissions: listing.latestSubmission ? [listing.latestSubmission] : [], total: listing.latestSubmission ? 1 : 0 } })
    if (path === '/v1/community/reports') return route.fulfill({ json: { reports: report ? [report] : [], total: report ? 1 : 0 } })
    if (path === '/v1/feedback' || path === '/v1/feedback/review') return route.fulfill({ json: { tickets, total: tickets.length } })
    if (path === '/v1/messages') { requests.push({ messages: true }); return route.fulfill({ json: { messages: [] } }) }
    if (path.startsWith('/v1/messages/')) return route.fulfill({ json: { message: { id: path.split('/').at(-1), role: 'user', text: '阅读三十分钟', cards: [], scopePlanId: planId, clientMsgId: randomUUID(), createdAt: new Date().toISOString() } } })
    if (path.endsWith('/community-upgrade')) return route.fulfill({ json: { current: publicDefinition, next: { ...publicDefinition, version: 2, name: '阅读与收获' }, changes: ['新增可选的阅读感想', '调整页面样式'], expectedVersion: state.config.version, currentTemplateVersion: 1, compatible: true } })
    if (path.startsWith('/v1/community/requests/')) { const result = savedResults.get(path.split('/').at(-1)!); return route.fulfill({ json: result ? { status: 'succeeded', result } : { status: 'not_found' } }) }
    if (path === '/v1/community/requests') {
      const input = route.request().postDataJSON(); requests.push(input)
      if (savedResults.has(input.clientOpId)) return route.fulfill({ json: savedResults.get(input.clientOpId) })
      const result: Record<string, unknown> = { clientOpId: input.clientOpId, kind: input.action, transient: false }
      if (input.action === 'preview') { preview = { id: randomUUID(), publicHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 600000).toISOString(), listingId, listingVersion: listing.version, payload: { title: input.title, description: input.description, category: input.category, authorName: input.authorName, definition: { ...publicDefinition, configurationDefaults: undefined, recordDefaults: undefined } } }; result.preview = preview }
      if (input.action === 'submit') { listing.latestSubmission = { id: randomUUID(), listingId, version: 1, status: 'pending', payload: preview!.payload, rejectionReason: null, publishedVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; result.submission = listing.latestSubmission }
      if (input.action === 'review') { listing.latestSubmission!.status = input.decision === 'approve' ? 'approved' : 'rejected'; listing.latestSubmission!.rejectionReason = input.reason; result.submission = listing.latestSubmission }
      if (input.action === 'publish') { listing.status = 'listed'; listing.templateVersion = 1; listing.latestSubmission!.status = 'published'; result.listing = listing }
      if (input.action === 'unlist') { listing.status = 'unlisted'; result.listing = listing }
      if (input.action === 'withdraw') { listing.latestSubmission!.status = 'withdrawn'; result.submission = listing.latestSubmission }
      if (input.action === 'report') { report = { id: randomUUID(), listingId, version: 1, templateVersion: 1, reason: input.reason, details: input.details, status: 'open', resolutionReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; result.report = report }
      if (input.action === 'resolve_report') { report!.status = input.resolution; report!.resolutionReason = input.reason; if (input.resolution === 'actioned') listing.status = 'suspended'; result.report = report }
      savedResults.set(input.clientOpId, result)
      if (dropAction === input.action) { dropAction = null; return route.abort('failed') }
      return route.fulfill({ json: result })
    }
    if (path === '/v1/feedback/requests') { const input = route.request().postDataJSON(); requests.push(input); const ticket = { id: randomUUID(), version: 1, status: 'open', description: input.description, diagnostics: input.diagnostics ?? null, response: null, history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; tickets.push(ticket); return route.fulfill({ json: { clientOpId: input.clientOpId, kind: input.action, transient: false, ticket } }) }
    if (path === '/v1/operations') { const input = route.request().postDataJSON(); requests.push(input); const action = input.actions[0]; if (action.type === 'configure_generic_plan') { if (action.applyTemplateDefaults) state.config.values = { ...definition.configurationDefaults, ...action.patch.values }; else state.config.values = { ...state.config.values, ...action.patch.values }; state.config.recordDefaults = action.recordDefaults; state.config.setupStatus = 'ready'; state.config.version++ } if (action.type === 'upgrade_community_template') { state.templateVersion = 2; state.definition.version = 2; state.config.version++ } return route.fulfill({ json: { clientOpId: input.clientOpId, operationId: randomUUID(), kind: 'batch', items: [], undoable: false, createdAt: new Date().toISOString(), dataVersion: state.config.version, templatePlan: state } }) }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  return { requests, planId, state, definition, listing, generic, dropNext: (action: string) => { dropAction = action }, setSubmission: (submission: CommunitySubmission) => { listing.latestSubmission = submission }, setCommunity: () => { state.source = 'community'; state.templateId = publicDefinition.id; state.definition = publicDefinition } }
}

test('P04/05协议：建议显式启用、false沿用、周期分类趋势和新增缺值协议', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/plans/${f.planId}?setup=1`)
  await expect(page.getByLabel('每周目标（分钟）（可留空）', { exact: true })).toHaveValue('')
  await page.getByLabel('确认使用这些建议，仍可逐项修改').check()
  await expect(page.getByLabel('每周目标（分钟）（可留空）', { exact: true })).toHaveValue('100')
  await page.getByText('新增记录的常用值', { exact: true }).click()
  await page.getByRole('button', { name: '载入模板建议，保存后启用' }).click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect.poll(() => f.state.config.values?.target).toBe(100)
  expect(f.state.config.recordDefaults).toEqual({ category: '纸质书', finished: false })
  await expect(page.getByRole('region', { name: '阅读时长分类', exact: true })).toContainText('60 分钟')
  await expect(page.getByRole('region', { name: '记录统计', exact: true })).toContainText('按月')
  await page.getByRole('button', { name: '添加记录', exact: true }).click()
  await page.getByLabel('阅读时长（分钟）', { exact: true }).fill('25')
  await expect(page.getByLabel('读完（可留空）', { exact: true })).toHaveValue('false')
  await page.getByRole('button', { name: '保存记录', exact: true }).click()
  await expect.poll(() => f.requests.filter((request) => (request.actions as { type: string }[] | undefined)?.[0]?.type === 'add_generic_record').length).toBe(1)
  const added = f.requests.find((request) => (request.actions as { type: string }[] | undefined)?.[0]?.type === 'add_generic_record')
  expect(added).toMatchObject({ actions: [{ values: { date: today, minutes: 25 } }] })
  expect((added!.actions as { values: object }[])[0]!.values).not.toHaveProperty('finished')
  await page.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('month')
  await expect(page.getByRole('heading', { name: '范围内记录', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 720 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('P07协议：公开内容先预览再确认，编辑预览后不能送旧内容，作者发布与下架', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/publish/private.test?version=1')
  await page.getByLabel('作者署名', { exact: true }).fill('公开的小林')
  await page.getByRole('button', { name: '生成公开预览', exact: true }).click()
  await expect(page.getByRole('region', { name: '公开内容预览', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认送审', exact: true })).toBeDisabled()
  expect(f.requests.find((request) => request.action === 'preview')).not.toHaveProperty('publicDefaults')
  await page.getByLabel('公开名称', { exact: true }).fill('读书时光')
  await expect(page.getByRole('button', { name: '确认送审', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '生成公开预览', exact: true }).click()
  await page.getByLabel('我已核对以上全部内容，同意将它作为公开模板送审').check()
  await page.getByRole('button', { name: '确认送审', exact: true }).click()
  await expect(page.getByText('最近送审：等待审核', { exact: true })).toBeVisible()
  f.listing.latestSubmission!.status = 'approved'
  await page.reload()
  await page.getByRole('button', { name: '发布审核通过的版本', exact: true }).click()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await expect(page.getByText(/市场展示中 · 已公开版本 1/)).toBeVisible()
  await page.getByRole('button', { name: '下架作品', exact: true }).click()
  await page.getByRole('button', { name: '确认下架', exact: true }).click()
  await expect(page.getByText(/未上架 · 已公开版本 1/)).toBeVisible()
})

test('P09协议：市场筛选搜索与社区详情、署名采用量、举报不暴露内部数据', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/market')
  await page.getByRole('combobox', { name: '来源', exact: true }).selectOption('community')
  await page.getByRole('combobox', { name: '分类', exact: true }).selectOption('reading')
  await page.getByRole('searchbox', { name: '搜索模板', exact: true }).fill('阅读')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.template-card')).toContainText('小林 · 3 次采用')
  await expect.poll(() => f.requests.some((request) => typeof request.market === 'string' && request.market.includes('source=community') && request.market.includes('category=reading') && request.market.includes('q='))).toBe(true)
  await page.locator('.template-card').click()
  await page.getByRole('button', { name: '举报这个模板', exact: true }).click()
  await page.getByLabel('补充说明', { exact: true }).fill('公开说明与试填结果不一致')
  await page.getByRole('button', { name: '提交举报', exact: true }).click()
  await expect(page.getByText('举报已提交，审核人员会核对这个公开版本。', { exact: true })).toBeVisible()
  expect(f.requests.find((request) => request.action === 'report')).toMatchObject({ listingId: f.listing.id, templateVersion: 2 })
  await expect(page.locator('body')).not.toContainText('CNY_cent')
})

test('P10协议：社区更新比较后显式采用，保留当前版本直到确认', async ({ page }) => {
  const f = await fixture(page); f.setCommunity(); f.state.config.setupStatus = 'ready'
  await page.goto(`/plans/${f.planId}`)
  await page.getByRole('button', { name: '检查模板更新', exact: true }).click()
  await expect(page.getByRole('heading', { name: '版本 1 → 2', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认采用更新', exact: true })).toBeDisabled()
  expect(f.state.templateVersion).toBe(1)
  await page.getByLabel('我已核对修改，采用这个兼容版本').check()
  await page.getByRole('button', { name: '确认采用更新', exact: true }).click()
  await expect(page.getByRole('heading', { name: '社区模板 · 当前版本 2', exact: true })).toBeVisible()
  expect(f.requests.find((request) => (request.actions as { type: string }[] | undefined)?.[0]?.type === 'upgrade_community_template')).toMatchObject({ actions: [{ targetVersion: 2, expectedVersion: 1 }] })
})

test('P03/14协议：来源消息定位、反馈预览提交跟踪、普通账户无审核权限', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/chat?message=${randomUUID()}`)
  await expect(page.getByRole('region', { name: '来源对话', exact: true })).toContainText('阅读三十分钟')
  await page.goto('/me')
  await page.getByLabel('遇到了什么问题？', { exact: true }).fill('手机上希望更清楚地看到每周目标')
  await page.getByLabel('附上当前页面与应用版本（不含消息、计划或记录）').check()
  await page.getByRole('button', { name: '预览反馈', exact: true }).click()
  expect(f.requests.filter((request) => request.action === 'create')).toHaveLength(0)
  await page.getByRole('button', { name: '确认提交反馈', exact: true }).click()
  await expect(page.locator('.feedback-ticket')).toContainText('待处理')
  expect(f.requests.find((request) => request.action === 'create')).toMatchObject({ diagnostics: { route: '/me', version: 'local' } })
  await page.goto('/review')
  await expect(page.getByText('此页面仅供审核人员使用。', { exact: true })).toBeVisible()
})

test('P08协议：审核者核对公开预览，退回原因必填，通过不自动发布', async ({ page }) => {
  const f = await fixture(page, true)
  f.setSubmission({ id: randomUUID(), listingId: f.listing.id, version: 1, status: 'pending', payload: { title: '阅读日常', description: '记录阅读', category: 'reading', authorName: '小林', definition: f.definition }, rejectionReason: null, publishedVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  await page.goto('/review')
  await page.locator('.review-submission > summary').click()
  await page.getByRole('combobox', { name: '审核结果', exact: true }).selectOption('reject')
  await expect(page.getByLabel('审核说明', { exact: true })).toHaveAttribute('required', '')
  await page.getByRole('combobox', { name: '审核结果', exact: true }).selectOption('approve')
  await page.getByLabel('已核对公开名称、说明、字段、示例和建议值').check()
  await page.getByRole('button', { name: '确认审核结果', exact: true }).click()
  await expect.poll(() => f.listing.latestSubmission?.status).toBe('approved')
  expect(f.listing.status).toBe('unlisted')
})


test('P03/07协议：社区提交丢响应后刷新核对原请求，不重复送审', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/publish/private.test?version=1')
  await page.getByLabel('作者署名', { exact: true }).fill('合成作者')
  await page.getByRole('button', { name: '生成公开预览', exact: true }).click()
  await page.getByLabel('我已核对以上全部内容，同意将它作为公开模板送审').check()
  f.dropNext('submit')
  await page.getByRole('button', { name: '确认送审', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
  expect(f.requests.filter((request) => request.action === 'submit')).toHaveLength(1)
  await page.goto(`/community/${f.listing.id}`)
  await expect(page.getByText('最近送审：等待审核', { exact: true })).toBeVisible()
})


test('P03协议：可见期间版本变化刷新统计，消息独立轮询，断网标记旧数据', async ({ page }) => {
  const f = await fixture(page)
  await page.clock.install()
  await page.goto(`/plans/${f.planId}`)
  await expect(page.getByRole('region', { name: '记录统计', exact: true })).toContainText('60 分钟')
  f.generic.summary.metrics[0]!.value = 90
  f.state.config.version++
  await page.clock.fastForward(16000)
  await expect(page.getByRole('region', { name: '记录统计', exact: true })).toContainText('90 分钟')
  await page.goto('/chat')
  await expect.poll(() => f.requests.filter((request) => request.messages).length).toBeGreaterThan(0)
  const before = f.requests.filter((request) => request.messages).length
  await page.clock.fastForward(16000)
  await expect.poll(() => f.requests.filter((request) => request.messages).length).toBeGreaterThan(before)
  await page.context().setOffline(true)
  await expect(page.locator('.sync-status')).toContainText('网络已断开')
  await page.context().setOffline(false)
  await page.clock.fastForward(1000)
  await expect(page.locator('.sync-status')).toHaveCount(0)
})
