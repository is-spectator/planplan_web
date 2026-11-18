import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { PlanView, TemplatePlanState } from '../src/lib/contracts'

const today = '2026-11-18'
const artifacts = '/opt/cursor/artifacts'

function plan(partial: Partial<PlanView> & Pick<PlanView, 'id' | 'kind' | 'name'>): PlanView {
  return { activity: null, status: 'active', startDate: today, hidden: [], order: [], lastActivityAt: new Date().toISOString(), ...partial }
}

const water: TemplatePlanState = {
  planId: 'water', templateId: 'official.water', templateVersion: 1, source: 'official', engine: 'generic',
  definition: {
    schemaVersion: 1, id: 'official.water', version: 1, name: '饮水', engine: 'generic', source: 'official', description: '记录饮水量', requiredCapabilities: ['generic-record-v1'],
    configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }],
    recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'amountMl', label: '饮水毫升', type: 'integer', required: true, unit: 'ml', min: 1, max: 100000 }],
    metrics: [{ id: 'daily', label: '今日饮水量', operation: 'sum', fieldId: 'amountMl', period: 'day' }],
    components: ['summary', 'records'],
    example: { config: { name: '饮水', startDate: today }, record: { date: today, amountMl: 500 } },
  },
  config: { version: 1, setupStatus: 'ready', name: '每天喝水', startDate: today, values: {}, currentBook: null, daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null } },
}

async function pendingStatus(page: Page, userId: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('planplan-recovery', 1)
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    try {
      return await new Promise<{ status?: string; id?: string } | null>((resolve, reject) => {
        const request = db.transaction('pending').objectStore('pending').get(id)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, userId)
}

async function install(page: Page, options: { plans: PlanView[]; mode?: 'transient' | 'processing' | 'drop' | 'ok'; water?: boolean; reading?: boolean }) {
  const userId = randomUUID()
  const posts: { clientMsgId: string; text: string; scopePlanId?: string | null }[] = []
  const operations: { clientOpId: string; actions: { type: string }[] }[] = []
  let mode = options.mode ?? 'transient'
  let lookup: 'not_found' | 'processing' | 'failed' = 'not_found'
  const readingState: TemplatePlanState = {
    planId: options.plans.find(item => item.kind === 'study')?.id ?? 'study', templateId: 'official.reading', templateVersion: 1, source: 'official', engine: 'study',
    definition: { schemaVersion: 1, id: 'official.reading', version: 1, name: '阅读', engine: 'study', source: 'official', description: '阅读', requiredCapabilities: ['reading-template-v1'], configurationFields: [], recordFields: [], metrics: [], components: ['records'], example: { config: {}, record: {} } },
    config: { version: 1, setupStatus: 'ready', name: '阅读', startDate: today, values: {}, currentBook: null, daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null } },
  }
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (path === '/v1/auth/web/session') return send({ userId, csrfToken: 'manual-handoff-csrf' })
    if (path === '/v1/me') return send({ id: userId, aiConsent: true, dataVersion: 1, today, timezone: 'Asia/Shanghai', signInMethod: 'email' })
    if (path === '/v1/plans') return send({ plans: options.plans.map(item => ({ plan: item })), dataVersion: 1 })
    if (path === '/v1/messages') return send({ messages: [] })
    if (path.endsWith('/template')) {
      const id = path.split('/')[3]
      if (options.water) return send({ ...water, planId: id })
      if (options.reading) return send(readingState)
      return send(null, 404)
    }
    if (path.includes('/ledger') || path.includes('/study')) {
      const id = path.split('/')[3]
      const current = options.plans.find(item => item.id === id)!
      if (path.endsWith('/ledger')) return send({ plan: current, month: '2026-11', stats: { month: '2026-11', spendCents: 0, refundCents: 0, netCents: 0, budgetCents: null, remainingCents: null, usagePct: null, overCents: 0, expenseCount: 0, refundCount: 0, byCategory: [], daily: [] }, records: [], months: ['2026-11'], dataVersion: 1 })
      return send({ plan: current, week: today, today, stats: { week: today, daysPerWeek: null, minMinutes: null, goalComplete: false, targetDays: null, metDays: null, exceededDays: 0, recordDays: 0, totalMinutes: 0, interrupted: false, days: [] }, previous: null, records: [], weeks: [today], totalRecords: 0, dataVersion: 1 })
    }
    if (path.endsWith('/generic')) return send({ plan: options.plans[0], templatePlan: { ...water, planId: options.plans[0]!.id }, today, summary: { planId: options.plans[0]!.id, from: today, to: today, recordCount: 0, metrics: [] }, records: [], totalRecords: 0, offset: 0, limit: 20, dataVersion: 1 })
    if (path === '/v1/chat' && request.method() === 'POST') {
      const body = request.postDataJSON()
      posts.push(body)
      if (mode === 'drop') return route.abort('failed')
      if (mode === 'processing') return send({ status: 'processing' }, 202)
      const user = { id: randomUUID(), role: 'user', text: body.text, cards: [], scopePlanId: body.scopePlanId ?? null, clientMsgId: body.clientMsgId, createdAt: new Date().toISOString() }
      const assistant = { ...user, id: randomUUID(), role: 'assistant', text: '', clientMsgId: null, cards: [{ type: 'error', code: 'model_unavailable', message: 'AI这次没有生成可用结果。这次没有更改计划或记录。', retryable: true }] }
      if (mode === 'ok') return send({ user, assistant: { ...assistant, text: '记好了。', cards: [] }, dataVersion: 2, transient: false })
      return send({ user, assistant, dataVersion: 1, transient: true })
    }
    if (path.startsWith('/v1/chat/')) return send(lookup === 'processing' ? { status: 'processing' } : lookup === 'failed' ? { status: 'not_found' } : { status: 'not_found' })
    if (path === '/v1/operations' && request.method() === 'POST') {
      const body = request.postDataJSON()
      operations.push(body)
      return send({ operationId: randomUUID(), clientOpId: body.clientOpId, kind: 'batch', items: [{ type: 'expense_added', record: { id: randomUUID(), planId: options.plans[0]?.id, kind: 'expense', amountCents: body.actions[0].amountCents, minutes: null, category: '餐饮', date: today, note: body.actions[0].note ?? '', refundOf: null, refundedCents: 0, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: new Date().toISOString() } }], dataVersion: 2, createdAt: new Date().toISOString(), undoable: false })
    }
    return send({ error: { code: 'not_found', message: 'fixture' } }, 404)
  })
  return { userId, posts, operations, setMode: (next: typeof mode) => { mode = next }, setLookup: (next: typeof lookup) => { lookup = next } }
}

test.beforeAll(async () => { await mkdir(artifacts, { recursive: true }) })

test('有计划范围的明确失败打开原计划表单，原文不预填，保存使用新的操作 ID', async ({ page }, info) => {
  const ledgerId = randomUUID()
  const ledger = plan({ id: ledgerId, kind: 'ledger', name: '日常记账' })
  const state = await install(page, { plans: [ledger] })
  await page.clock.install({ time: new Date(`${today}T08:00:00+08:00`) })
  await page.goto(`/chat?plan=${ledgerId}`)
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('午饭20元，删掉昨天的退款')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消重试，手动添加记录', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试原消息', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
  const before = state.posts.length
  await page.getByRole('button', { name: '取消重试，手动添加记录', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/plans/${ledgerId}$`))
  await expect(page.getByRole('heading', { name: '记录一笔支出', exact: true })).toBeVisible()
  await expect(page.getByLabel('支出金额（元）', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('备注（可留空）', { exact: true })).toHaveValue('')
  await page.getByText('原消息', { exact: true }).click()
  await expect(page.getByText('午饭20元，删掉昨天的退款', { exact: true })).toBeVisible()
  if (info.project.name === 'chromium') await page.screenshot({ path: `${artifacts}/manual-handoff-ledger-form.png` })
  expect(state.posts).toHaveLength(before)
  expect(state.operations).toHaveLength(0)
  await page.getByLabel('支出金额（元）', { exact: true }).fill('12.50')
  await page.getByLabel('备注（可留空）', { exact: true }).fill('手动午餐')
  await page.getByRole('button', { name: '保存记录', exact: true }).click()
  await expect.poll(() => state.operations.length).toBe(1)
  expect(state.operations[0]!.clientOpId).not.toBe(state.posts[0]!.clientMsgId)
  expect(state.operations[0]!.actions[0]).toMatchObject({ type: 'add_expense', amountCents: 1250, note: '手动午餐' })
  expect(state.posts).toHaveLength(1)
})

test('饮水计划的明确失败打开原记录表单，原文不会变成毫升', async ({ page }) => {
  const id = randomUUID()
  const state = await install(page, { plans: [plan({ id, kind: 'generic', name: '每天喝水', template: { id: 'official.water', version: 1, setupStatus: 'ready' } })], water: true })
  await page.goto(`/chat?plan=${id}`)
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('喝了500毫升')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '取消重试，手动添加记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '添加记录', exact: true })).toBeVisible()
  await expect(page.getByLabel('饮水毫升', { exact: true })).toHaveValue('')
  expect(state.operations).toHaveLength(0)
  expect(state.posts).toHaveLength(1)
})

test('无范围时必须选择计划；空列表、归档和找不到目标都不自动创建', async ({ page }) => {
  const first = plan({ id: randomUUID(), kind: 'ledger', name: '第一本账' })
  const second = plan({ id: randomUUID(), kind: 'study', name: '阅读计划', template: { id: 'official.reading', version: 1, setupStatus: 'ready' } })
  const state = await install(page, { plans: [first, second], reading: true })
  await page.goto('/chat')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('这个月花了多少')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消重试，选择计划记录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消重试，选择计划记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择要记录的计划', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /第一本账/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /阅读计划/ })).toBeVisible()
  expect(page.url()).not.toContain(first.id)
  await page.getByRole('button', { name: /阅读计划/ }).click()
  await expect(page).toHaveURL(new RegExp(`/plans/${second.id}$`))
  await expect(page.getByRole('heading', { name: '记录一段阅读', exact: true })).toBeVisible()
  await expect(page.getByLabel('阅读时长（分钟）', { exact: true })).toHaveValue('')
  expect(state.operations).toHaveLength(0)

  const empty = await install(page, { plans: [] })
  await page.goto('/chat')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('记一笔')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '取消重试，选择计划记录', exact: true }).click()
  await expect(page.getByRole('link', { name: '去市场挑选', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '新建计划', exact: true }).first()).toBeVisible()
  expect(empty.operations).toHaveLength(0)

  const archivedId = randomUUID()
  await install(page, { plans: [plan({ id: archivedId, kind: 'ledger', name: '旧账', status: 'archived' })] })
  await page.goto(`/chat?plan=${archivedId}`)
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('记到旧账')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '取消重试，手动添加记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '这个计划已归档', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '记录一笔支出', exact: true })).toHaveCount(0)

  const missingId = randomUUID()
  const disappearing = [plan({ id: missingId, kind: 'ledger', name: '即将消失' })]
  await install(page, { plans: disappearing })
  await page.goto(`/chat?plan=${missingId}`)
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('目标已经没了')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消重试，手动添加记录', exact: true })).toBeVisible()
  disappearing.splice(0, disappearing.length)
  await page.getByRole('button', { name: '取消重试，手动添加记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '没有找到这个计划', exact: true })).toBeVisible()
  await expect(page.getByText('不会改用其他计划，也不会新建。')).toBeVisible()
})

test('处理中、未知结果和存储失败不能转手动；明确失败后重试会先记下待核对', async ({ page }) => {
  const ledgerId = randomUUID()
  const state = await install(page, { plans: [plan({ id: ledgerId, kind: 'ledger', name: '日常记账' })], mode: 'drop' })
  await page.clock.install({ time: new Date(`${today}T08:00:00+08:00`) })
  await page.goto('/chat')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('午饭20元')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /取消重试/ })).toHaveCount(0)
  state.setLookup('processing')
  await page.clock.fastForward(4_000)
  await page.getByRole('button', { name: '重试原消息', exact: true }).click()
  await expect(page.getByText('仍在处理中，请稍后再核对。', { exact: true })).toBeVisible()
  expect(state.posts).toHaveLength(1)
  await expect(page.getByRole('button', { name: /取消重试/ })).toHaveCount(0)

  state.setMode('transient')
  state.setLookup('not_found')
  await page.evaluate(() => indexedDB.deleteDatabase('planplan-recovery'))
  await page.goto('/chat')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('再试一次失败')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消重试，选择计划记录', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: { status?: string; message?: string }, key?: IDBValidKey) {
      if (value?.status === 'unknown' && value.message === '还不能确定是否已保存，请先核对结果。') throw new DOMException('quota', 'QuotaExceededError')
      return original.call(this, value, key)
    }
  })
  await page.clock.fastForward(4_000)
  const count = state.posts.length
  await page.getByRole('button', { name: '重试原消息', exact: true }).click()
  await expect(page.getByText(/无法保留待核对记录|quota|Quota/)).toBeVisible()
  expect(state.posts).toHaveLength(count)
  expect(await pendingStatus(page, state.userId)).toMatchObject({ status: 'transient' })
})

test('创作明确失败打开最新草稿编辑器，手机可见，不覆盖未保存编辑', async ({ page }, info) => {
  const userId = randomUUID()
  const draftId = randomUUID()
  const posts: string[] = []
  const definition = { ...water.definition, id: `private.${draftId}`, source: 'private' as const, requiredCapabilities: ['generic-record-v1', 'private-template-v1'], name: '最新草稿名' }
  const version = 4
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (path === '/v1/auth/web/session') return send({ userId, csrfToken: 'creation-handoff' })
    if (path === '/v1/me') return send({ id: userId, aiConsent: true, dataVersion: 1, today, timezone: 'Asia/Shanghai', signInMethod: 'email' })
    if (path === `/v1/creation/drafts/${draftId}`) return send({ id: draftId, version, name: definition.name, definition, messages: [], changeSummary: [], canUndo: false, savedTemplate: null, sourcePlanId: null, sourcePlanVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    if (path === '/v1/creation/requests' && request.method() === 'POST') {
      const body = request.postDataJSON()
      posts.push(body.action)
      if (body.action === 'message') {
        return send({ clientOpId: body.clientOpId, kind: 'message', transient: true, message: 'AI这次没有生成可用结果。原草稿已保留。', draft: { id: draftId, version, name: definition.name, definition, messages: [], changeSummary: [], canUndo: false, savedTemplate: null, sourcePlanId: null, sourcePlanVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
      }
      return send({ error: { code: 'not_found', message: '未保存' } }, 404)
    }
    if (path.startsWith('/v1/creation/requests/')) return send({ status: 'not_found' })
    return send({ error: { code: 'not_found', message: 'fixture' } }, 404)
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/create/${draftId}`)
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill('未保存的标题')
  await page.evaluate(async ({ userId, draftId }) => {
    const entry = { userId, id: crypto.randomUUID(), kind: 'creation', path: '/v1/creation/requests', lookup: '/v1/creation/requests/x', body: { action: 'message', draftId, text: '把饮水量改成备注', expectedVersion: 1, clientOpId: 'x' }, createdAt: Date.now() - 10_000, status: 'transient', message: 'AI这次没有生成可用结果。原草稿已保留。' }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('planplan-recovery', 1); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(entry); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
    db.close()
    new BroadcastChannel('planplan-recovery').postMessage('changed')
  }, { userId, draftId })
  await expect(page.getByRole('button', { name: '取消重试，手动编辑', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消重试，手动编辑', exact: true }).click()
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('未保存的标题')
  expect(posts).toEqual([])
  await page.getByRole('button', { name: '取消编辑', exact: true }).click()
  await expect(page.getByRole('tab', { name: '预览', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('最新草稿名')
  await page.getByText('原消息', { exact: true }).click()
  await expect(page.locator('.original-message')).toContainText('把饮水量改成备注')
  expect(posts).toEqual([])
  if (info.project.name === 'chromium') await page.screenshot({ path: `${artifacts}/manual-handoff-creation-editor.png` })
})

test('创作转手动会重新读取草稿，不用打开前的旧缓存', async ({ page }) => {
  const userId = randomUUID()
  const draftId = randomUUID()
  let name = '打开前的草稿'
  let version = 4
  let reads = 0
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (path === '/v1/auth/web/session') return send({ userId, csrfToken: 'fresh-draft' })
    if (path === '/v1/me') return send({ id: userId, aiConsent: true, dataVersion: 1, today, timezone: 'Asia/Shanghai', signInMethod: 'email' })
    if (path === `/v1/creation/drafts/${draftId}`) {
      reads += 1
      const definition = { ...water.definition, id: `private.${draftId}`, source: 'private' as const, requiredCapabilities: ['generic-record-v1', 'private-template-v1'], name }
      return send({ id: draftId, version, name, definition, messages: [], changeSummary: [], canUndo: false, savedTemplate: null, sourcePlanId: null, sourcePlanVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    }
    return send({ error: { code: 'not_found', message: 'fixture' } }, 404)
  })
  await page.goto(`/create/${draftId}`)
  await expect(page.getByRole('heading', { name: '打开前的草稿', exact: true })).toBeVisible()
  const before = reads
  name = '别人刚改过'
  version = 9
  await page.evaluate(async ({ userId, draftId }) => {
    const entry = { userId, id: crypto.randomUUID(), kind: 'creation', path: '/v1/creation/requests', lookup: '/v1/creation/requests/x', body: { action: 'message', draftId, text: '旧请求里的说明', expectedVersion: 1, clientOpId: 'x' }, createdAt: Date.now() - 10_000, status: 'transient', message: '失败' }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('planplan-recovery', 1); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(entry); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
    db.close()
    new BroadcastChannel('planplan-recovery').postMessage('changed')
  }, { userId, draftId })
  await page.getByRole('button', { name: '取消重试，手动编辑', exact: true }).click()
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('别人刚改过')
  expect(reads).toBeGreaterThan(before)
})

test('真实本地 API：明确失败后手动保存只新增一条记录', async ({ page }) => {
  test.skip(!process.env.PLANPLAN_E2E_EMAIL || !process.env.PLANPLAN_E2E_PASSWORD, '需要隔离本地夹具账户')
  const marker = `手动交接${Date.now().toString().slice(-6)}`
  const chatPosts: string[] = []
  await page.route('**/v1/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    chatPosts.push(body.clientMsgId)
    const userMessage = { id: randomUUID(), role: 'user', text: body.text, cards: [], scopePlanId: body.scopePlanId ?? null, clientMsgId: body.clientMsgId, createdAt: new Date().toISOString() }
    const assistant = { ...userMessage, id: randomUUID(), role: 'assistant', text: '', clientMsgId: null, cards: [{ type: 'error', code: 'model_unavailable', message: 'AI这次没有生成可用结果。这次没有更改计划或记录。', retryable: true }] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: userMessage, assistant, dataVersion: 1, transient: true }) })
  })
  await page.goto('/login')
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.PLANPLAN_E2E_EMAIL!)
  await page.getByLabel('密码', { exact: true }).fill(process.env.PLANPLAN_E2E_PASSWORD!)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL('/plans')
  if (await page.locator('.plan-list-item.ledger').count() === 0) {
    await page.getByRole('button', { name: '新建计划', exact: true }).first().click()
    await page.getByRole('button', { name: '创建计划', exact: true }).click()
    await expect(page).toHaveURL(/\/plans\/.+/)
  } else await page.locator('.plan-list-item.ledger').first().click()
  await page.getByRole('link', { name: '去对话继续记录', exact: true }).click()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(`午饭20元 ${marker}`)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '取消重试，手动添加记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '记录一笔支出', exact: true })).toBeVisible()
  await expect(page.getByLabel('支出金额（元）', { exact: true })).toHaveValue('')
  expect(chatPosts).toHaveLength(1)
  await page.getByLabel('支出金额（元）', { exact: true }).fill('8.80')
  await page.getByLabel('备注（可留空）', { exact: true }).fill(marker)
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '保存记录', exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  const body = response.request().postDataJSON()
  expect(body.clientOpId).not.toBe(chatPosts[0])
  expect(body.actions[0]).toMatchObject({ type: 'add_expense', amountCents: 880, note: marker })
  await expect(page.getByText(marker, { exact: true })).toBeVisible()
  expect(chatPosts).toHaveLength(1)
  await page.getByRole('button', { name: new RegExp(marker) }).click()
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0)
})
