import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import type { TemplateDefinition } from '../src/lib/contracts'
import type { CreationDraft, CreationResult } from '../src/features/creation/types'

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

const today = '2026-11-16'
function definition(): TemplateDefinition {
  return { schemaVersion: 1, id: `private.${randomUUID()}`, version: 1, engine: 'generic', source: 'private', requiredCapabilities: ['generic-record-v1', 'private-template-v1'], name: '私人阅读', description: '记录书名、阅读时间和感受，查看每日积累。', configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'dailyGoal', label: '每日目标', type: 'duration', unit: 'minute', required: false, min: 1, max: 1440 }], recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'book', label: '书名', type: 'text', required: true, maxLength: 80 }, { id: 'minutes', label: '阅读时间', type: 'duration', unit: 'minute', required: true, min: 1, max: 1440 }, { id: 'page', label: '读到页数', type: 'integer', required: false, min: 0, max: 100000 }, { id: 'cost', label: '购书花费', type: 'money', unit: 'CNY_cent', required: false, min: 1, max: 99999999 }, { id: 'mood', label: '阅读感受', type: 'single_select', required: true, options: ['轻松', '专注'] }, { id: 'tags', label: '阅读标签', type: 'multi_select', required: true, options: ['小说', '历史', '科普'] }, { id: 'finished', label: '已经读完', type: 'boolean', required: true }], metrics: [{ id: 'total', label: '每日阅读时长', operation: 'sum', fieldId: 'minutes', period: 'day' }, { id: 'count', label: '记录次数', operation: 'count', period: 'day' }, { id: 'progress', label: '目标进度', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'dailyGoal', period: 'day' }], components: ['summary', 'goal', 'records'], example: { config: { name: '私人阅读', startDate: today, dailyGoal: 60 }, record: { date: today, book: '示例书籍', minutes: 20, page: 35, cost: 2000, mood: '专注', tags: ['小说'], finished: false } } }
}

async function fixture(page: Page, populated = true) {
  const userId = randomUUID()
  let user = userId
  let aiConsent = true
  let versionConflict = false
  let loseNextMessage = false
  let lookupProcessing = false
  const value = definition()
  const now = new Date().toISOString()
  const draft: CreationDraft = { id: randomUUID(), version: 1, name: populated ? value.name : '新的创作', definition: populated ? value : null, messages: [], changeSummary: [], canUndo: false, savedTemplate: null, sourcePlanId: null, sourcePlanVersion: null, createdAt: now, updatedAt: now }
  const requests: Record<string, unknown>[] = []
  const results = new Map<string, CreationResult>()
  const definitions: TemplateDefinition[] = []
  const versions: (TemplateDefinition | null)[] = []
  let lookupCount = 0
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId: user, csrfToken: 'creation-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: user, today, timezone: 'Asia/Shanghai', aiConsent, dataVersion: draft.version, signInMethod: 'email' } })
    if (path === '/v1/creation/drafts') return route.fulfill({ json: { drafts: user === userId ? [draft] : [], total: user === userId ? 1 : 0 } })
    if (path === `/v1/creation/drafts/${draft.id}`) return user === userId ? route.fulfill({ json: draft }) : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '没有找到这个草稿。' } } })
    if (path === '/v1/creation/templates') return route.fulfill({ json: { templates: definitions.map((item) => ({ id: item.id, version: item.version, name: item.name, description: item.description, draftId: draft.id, updatedAt: now })), total: definitions.length } })
    if (path.startsWith('/v1/creation/templates/')) return route.fulfill({ json: definitions.at(-1) })
    if (path.startsWith('/v1/creation/requests/')) { lookupCount++; const result = results.get(path.split('/').at(-1)!); return route.fulfill({ json: lookupProcessing ? { status: 'processing' } : result ? { status: 'succeeded', result } : { status: 'not_found' } }) }
    if (path === '/v1/creation/requests') {
      const input = route.request().postDataJSON()
      requests.push(input)
      expect(route.request().headers()['x-planplan-capabilities']).toContain('private-template-v1')
      if (versionConflict) return route.fulfill({ status: 409, json: { error: { code: 'version_conflict', message: '草稿已在另一处更新。' } } })
      if (input.action === 'update') {
        expect(Object.keys(input.definition).sort()).toEqual(['name', 'description', 'configurationFields', 'recordFields', 'metrics', 'components', 'example'].sort())
        versions.push(structuredClone(draft.definition))
        draft.definition = { ...value, ...input.definition }
        draft.name = draft.definition!.name
        draft.savedTemplate = null
        draft.changeSummary = ['已更新填写项目与统计。']
        draft.canUndo = true
      } else if (input.action === 'message') {
        versions.push(structuredClone(draft.definition))
        draft.definition = { ...value, name: input.text.includes('跑步') ? '私人跑步' : value.name }
        draft.name = draft.definition.name
        draft.messages.push({ id: randomUUID(), role: 'user', text: input.text, createdAt: now }, { id: randomUUID(), role: 'assistant', text: '草稿已经准备好，可以预览和试填，再保存私人模板。', createdAt: now })
        draft.changeSummary = ['已创建填写项目与每日汇总。']
        draft.canUndo = true
      } else if (input.action === 'undo') { draft.definition = versions.pop() ?? null; draft.name = draft.definition?.name ?? '新的创作'; draft.canUndo = versions.length > 0; draft.savedTemplate = null; draft.changeSummary = ['已撤回上一次修改。'] }
      else if (input.action === 'save') { const saved = structuredClone(draft.definition!); definitions.push(saved); draft.savedTemplate = { id: saved.id, version: saved.version, name: saved.name } }
      draft.version++
      const result: CreationResult = { clientOpId: input.clientOpId, kind: input.action, draft: structuredClone(draft), transient: false }
      results.set(input.clientOpId, result)
      if (loseNextMessage && input.action === 'message') { loseNextMessage = false; return route.abort('failed') }
      return route.fulfill({ json: result })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  return { draft, requests, definitions, setConflict: (value: boolean) => { versionConflict = value }, setConsent: (value: boolean) => { aiConsent = value }, loseMessage: () => { loseNextMessage = true }, setProcessing: (value: boolean) => { lookupProcessing = value }, lookupCount: () => lookupCount, switchAccount: () => { user = randomUUID() } }
}

async function capture(page: Page, name: string) {
  const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, name), fullPage: true })
}
const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => { const issues: string[] = []; errors.set(page, issues); page.on('pageerror', (error) => issues.push(error.message)); page.on('console', (message) => { if (['error', 'warning'].includes(message.type()) && !/Failed to load resource|net::ERR_FAILED|Load failed|Request blocked by Playwright|server responded with a status/.test(message.text())) issues.push(message.text()) }) })
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0); await expect(page).toHaveTitle(/PlanPlan/) })

// These are explicit protocol fixtures. Live database/model verification is separate.
test('创作协议：会话、手机切换、手动修改撤回、私人保存与版本入口', async ({ page }, info) => {
  const state = await fixture(page, false)
  await page.goto(`/create/${state.draft.id}`)
  await expect(page.getByRole('heading', { name: '新的创作' })).toBeVisible()
  await page.getByLabel('创作消息', { exact: true }).fill('我想记录阅读，保留书名和时长')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  await expect(page.getByRole('button', { name: '从空白开始设计' })).toBeVisible()
  await page.getByRole('tab', { name: '对话', exact: true }).click()
  await expect(page.getByLabel('创作消息', { exact: true })).toHaveValue('我想记录阅读，保留书名和时长')
  await page.getByRole('button', { name: '发送创作消息' }).click()
  await expect(page.getByRole('heading', { name: '私人阅读', exact: true })).toBeVisible()
  await expect(page.getByLabel('创作消息', { exact: true })).toHaveValue('')
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  await expect(page.getByRole('region', { name: '样式预览', exact: true })).toContainText('每日阅读时长')
  await page.getByRole('button', { name: '手动编辑' }).click()
  await page.getByLabel('模板名称', { exact: true }).fill('我的阅读模板')
  const field = page.locator('.definition-field').filter({ has: page.locator('legend', { hasText: /^书名$/ }) })
  await field.getByLabel('项目名称').fill('阅读书名')
  await page.getByRole('button', { name: '保存草稿修改' }).click()
  await expect(page.getByRole('heading', { name: '我的阅读模板', exact: true })).toBeVisible()
  expect((state.requests.at(-1)!.definition as TemplateDefinition).recordFields.find((item) => item.id === 'book')?.label).toBe('阅读书名')
  await page.getByRole('button', { name: '撤回修改' }).click()
  await expect(page.getByRole('heading', { name: '私人阅读', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存私人模板', exact: true }).click()
  await expect(page.getByRole('heading', { name: '私人模板已保存', exact: true })).toBeVisible()
  expect(state.definitions).toHaveLength(1)
  await capture(page, `${info.project.name}-creation-mobile.png`)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await capture(page, `${info.project.name}-creation-desktop.png`)
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true) }
  await page.getByRole('link', { name: '返回我的作品' }).click()
  await page.getByRole('region', { name: '我的模板', exact: true }).getByRole('link', { name: /私人阅读/ }).click()
  await expect(page.getByRole('heading', { name: '开始自己的计划', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '使用模板', exact: true })).toBeVisible()
  expect(state.requests.map((request) => request.action)).toEqual(['message', 'update', 'undo', 'save'])
})

test('创作协议：八类字段试填、编辑删除、切日重置均不写业务数据', async ({ page }, info) => {
  const state = await fixture(page)
  await page.goto(`/create/${state.draft.id}`)
  await page.getByText('试填体验', { exact: true }).click()
  const preview = page.locator('.template-preview')
  async function add(minutes: string) {
    await page.getByLabel('试填：书名', { exact: true }).fill('测试读物')
    await page.getByLabel('试填：阅读时间（分钟）', { exact: true }).fill(minutes)
    await page.getByLabel('试填：读到页数（可留空）', { exact: true }).fill('35')
    await page.getByLabel('试填：购书花费（元）（可留空）', { exact: true }).fill('12.34')
    await page.getByLabel('试填：阅读感受', { exact: true }).selectOption('专注')
    await page.getByRole('group', { name: '试填：阅读标签', exact: true }).getByLabel('小说', { exact: true }).check()
    await page.getByRole('group', { name: '试填：阅读标签', exact: true }).getByLabel('历史', { exact: true }).check()
    await page.getByLabel('试填：已经读完', { exact: true }).selectOption('false')
    await page.getByRole('button', { name: '加入试填', exact: true }).click()
  }
  await add('20'); await add('10')
  await expect(preview.getByRole('region', { name: '记录统计', exact: true })).toContainText('30 分钟')
  await expect(preview.getByRole('region', { name: '目标进度', exact: true })).toContainText('50%')
  await expect(page.getByRole('region', { name: '试填记录列表', exact: true })).toContainText('¥12.34')
  await expect(page.getByRole('region', { name: '试填记录列表', exact: true })).toContainText('小说、历史')
  await expect(page.getByRole('region', { name: '试填记录列表', exact: true })).toContainText('否')
  await page.getByRole('button', { name: '修改试填 1', exact: true }).click()
  await page.getByLabel('试填：阅读时间（分钟）', { exact: true }).fill('25')
  await page.getByRole('button', { name: '保存试填修改', exact: true }).click()
  await expect(preview.getByRole('region', { name: '记录统计', exact: true })).toContainText('35 分钟')
  await page.getByRole('button', { name: '删除试填 2', exact: true }).click()
  await expect(preview.getByRole('region', { name: '记录统计', exact: true })).toContainText('25 分钟')
  await page.getByLabel('查看试填日期', { exact: true }).fill('2026-11-15')
  await expect(preview.getByRole('region', { name: '记录统计', exact: true })).toContainText('0 分钟')
  await page.getByLabel('查看试填日期', { exact: true }).fill(today)
  await expect(preview.getByRole('region', { name: '记录统计', exact: true })).toContainText('25 分钟')
  await page.setViewportSize({ width: 320, height: 844 })
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  await capture(page, `${info.project.name}-creation-eight-fields-320.png`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '清空试填', exact: true }).click()
  await expect(preview.getByRole('region', { name: '试填记录列表', exact: true })).toContainText('0 条')
  expect(state.requests).toHaveLength(0)
})

test('创作协议：丢响应刷新和processing只核对原ID，换账户隔离草稿', async ({ page }) => {
  const state = await fixture(page, false)
  await page.goto(`/create/${state.draft.id}`)
  state.loseMessage()
  await page.getByLabel('创作消息', { exact: true }).fill('我要一个跑步模板')
  await page.getByRole('button', { name: '发送创作消息' }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
  const original = state.requests[0]!.clientOpId
  state.setProcessing(true)
  await page.reload()
  await expect(page.getByLabel('创作消息', { exact: true })).toHaveValue('我要一个跑步模板')
  await page.getByRole('button', { name: '重试原消息', exact: true }).click()
  await expect(page.getByText('仍在处理中，请稍后再核对。', { exact: true })).toBeVisible()
  expect(state.requests).toHaveLength(1)
  state.setProcessing(false)
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('创作消息', { exact: true })).toHaveValue('')
  await expect(page.getByRole('heading', { name: '私人跑步', exact: true })).toBeVisible()
  expect(state.requests[0]!.clientOpId).toBe(original)
  expect(state.lookupCount()).toBe(2)
  state.switchAccount()
  await page.reload()
  await expect(page.getByRole('heading', { name: '暂时无法打开草稿', exact: true })).toBeVisible()
  await expect(page.getByText('我要一个跑步模板', { exact: true })).toHaveCount(0)
})

test('创作协议：无AI可手动编辑，版本冲突保留未提交内容', async ({ page }) => {
  const state = await fixture(page)
  state.setConsent(false)
  await page.goto(`/create/${state.draft.id}`)
  await expect(page.getByRole('button', { name: '发送创作消息' })).toBeDisabled()
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill('保留这份修改')
  state.setConflict(true)
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click()
  await expect(page.getByText('草稿已被修改。请查看最新内容，再决定如何调整。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('保留这份修改')
  expect(state.requests[0]!.expectedVersion).toBe(1)
  expect(state.draft.definition?.name).toBe('私人阅读')
  await page.getByRole('button', { name: '取消编辑', exact: true }).click()
  await expect(page.getByRole('heading', { name: '私人阅读', exact: true })).toBeVisible()
})

test('创作协议：整数目标自动保持正值，手动改零时明确阻止保存', async ({ page }) => {
  const state = await fixture(page, false)
  await page.goto(`/create/${state.draft.id}`)
  await page.getByRole('button', { name: '从空白开始设计', exact: true }).click()
  await page.getByLabel('功能简介', { exact: true }).fill('按次记录运动。')
  for (const [sectionName, label] of [['开始时的设置', '每天目标'], ['每次记录的内容', '运动次数']]) {
    const section = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: sectionName, exact: true }) })
    await section.getByRole('button', { name: '添加项目', exact: true }).click()
    const field = section.locator('.definition-field').last()
    await field.getByLabel('项目名称', { exact: true }).fill(label!)
    await field.getByLabel('填写方式', { exact: true }).selectOption('integer')
  }
  const metrics = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: '统计与目标', exact: true }) })
  await metrics.getByLabel('计算方式', { exact: true }).selectOption('goal_progress')
  const target = page.locator('.definition-field').filter({ has: page.locator('legend', { hasText: /^每天目标$/ }) })
  await expect(target.getByLabel('最小值', { exact: true })).toHaveValue('1')
  await target.getByLabel('最小值', { exact: true }).fill('0')
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('最小值必须大于零')
  expect(state.requests).toHaveLength(0)
  await target.getByLabel('最小值', { exact: true }).fill('1')
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存私人模板', exact: true })).toBeEnabled()
  expect(state.draft.definition!.configurationFields.find(field => field.label === '每天目标')!.min).toBe(1)
})

const liveEmail = process.env.PLANPLAN_CREATION_E2E_EMAIL
const livePassword = process.env.PLANPLAN_CREATION_E2E_PASSWORD
const otherEmail = process.env.PLANPLAN_CREATION_SECOND_EMAIL
const otherPassword = process.env.PLANPLAN_CREATION_SECOND_PASSWORD

test.describe('私人创作真实手动链路', () => {
  test.skip(!liveEmail || !livePassword, '需要专用创作合成账户')
  test.describe.configure({ mode: 'serial', timeout: 120_000 })
  let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>> | null = null
  let draftId = '', planId = '', templateId = '', recordId = ''
  let originalDefinition: TemplateDefinition
  let fields: Record<string, string> = {}
  let originalRecord: Record<string, unknown>
  async function headers(page: Page) {
    const session = await (await page.request.get('/v1/auth/web/session')).json()
    return { Origin: new URL(page.url()).origin, 'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrfToken, 'X-PlanPlan-Capabilities': 'generic-record-v1,generic-template-v2,private-template-v1,community-template-v1,reading-template-v1,ledger-template-v1,chat-recovery-v1' }
  }
  async function read(page: Page, path: string) { const r = await page.request.get(path, { headers: await headers(page) }); expect(r.ok(), await r.text()).toBe(true); return r.json() }
  async function mutation(page: Page, path: string, action: () => Promise<void>) { const wait = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'POST'); await action(); const response = await wait; expect(response.ok(), await response.text()).toBe(true); const result = await response.json(); await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some(lock => lock.name === 'planplan-browser-session') ?? false)).toBe(false); return result }
  async function editField(page: Page, sectionName: string, name: string, type: string, required = false) {
    const section = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: sectionName, exact: true }) })
    await section.getByRole('button', { name: '添加项目', exact: true }).click()
    const row = section.locator('.definition-field').last()
    await row.getByLabel('项目名称', { exact: true }).fill(name)
    await row.getByRole('combobox', { name: '填写方式', exact: true }).selectOption(type)
    if (required) await row.getByLabel('必须填写', { exact: true }).check()
    if (type === 'single_select') await row.getByLabel('选项（每行一个）', { exact: true }).fill('轻松\n专注')
    if (type === 'multi_select') await row.getByLabel('选项（每行一个）', { exact: true }).fill('小说\n历史\n科普')
  }
  test.beforeEach(async ({ page }) => {
    const statePath = process.env.PLANPLAN_CREATION_E2E_STORAGE_STATE
    if (!cookies && statePath) { try { cookies = JSON.parse(await readFile(statePath, 'utf8')) } catch { /* First login writes an isolated session below. */ } }
    if (cookies) { await page.context().addCookies(cookies.cookies); await page.goto('/create') }
    else {
      await page.goto('/login?next=%2Fcreate')
      await page.getByLabel('邮箱', { exact: true }).fill(liveEmail!)
      await page.getByLabel('密码', { exact: true }).fill(livePassword!)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    await expect(page.getByRole('heading', { name: '创作', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建模板', exact: true })).toBeEnabled()
    cookies ??= await page.context().storageState()
    if (statePath) await writeFile(statePath, JSON.stringify(cookies), { mode: 0o600 })
  })

  test('八类字段从手动设计到保存采用、真实增改删统计及来源', async ({ page }, info) => {
    const initialPlanCount = (await read(page, '/v1/plans')).plans.length
    const created = await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '创建模板', exact: true }).click())
    draftId = created.draft.id
    await expect(page).toHaveURL(new RegExp(`/create/${draftId}$`))
    await page.getByRole('button', { name: '从空白开始设计', exact: true }).click()
    await page.getByLabel('模板名称', { exact: true }).fill(`阅读创作${info.project.name}`)
    await page.getByLabel('功能简介', { exact: true }).fill('记录书名、阅读时间与感受，按天查看积累。')
    await editField(page, '开始时的设置', '每日目标', 'duration')
    for (const [name, type, required] of [['书名', 'text', true], ['阅读时间', 'duration', true], ['读到页数', 'integer', false], ['购书花费', 'money', false], ['阅读感受', 'single_select', true], ['阅读标签', 'multi_select', true], ['已经读完', 'boolean', true]] as const) await editField(page, '每次记录的内容', name, type, required)
    const metrics = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: '统计与目标', exact: true }) })
    await metrics.getByRole('button', { name: '添加统计', exact: true }).click()
    let row = metrics.locator('.definition-field').last()
    await row.getByLabel('统计名称', { exact: true }).fill('每日阅读时长')
    await row.getByRole('combobox', { name: '计算方式', exact: true }).selectOption('sum')
    await row.getByRole('combobox', { name: '汇总哪个项目', exact: true }).selectOption({ label: '阅读时间' })
    await metrics.getByRole('button', { name: '添加统计', exact: true }).click()
    row = metrics.locator('.definition-field').last()
    await row.getByLabel('统计名称', { exact: true }).fill('目标进度')
    await row.getByRole('combobox', { name: '计算方式', exact: true }).selectOption('goal_progress')
    await row.getByRole('combobox', { name: '汇总哪个项目', exact: true }).selectOption({ label: '阅读时间' })
    await row.getByRole('combobox', { name: '目标来自哪项设置', exact: true }).selectOption({ label: '每日目标' })
    await page.getByRole('checkbox', { name: '目标进度', exact: true }).check()
    const updated = await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '保存草稿修改', exact: true }).click())
    originalDefinition = updated.draft.definition
    fields = Object.fromEntries(originalDefinition.recordFields.map((field) => [field.label, field.id]))
    expect(originalDefinition.recordFields).toHaveLength(8)
    expect((await read(page, '/v1/plans')).plans).toHaveLength(initialPlanCount)
    const saved = await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '保存私人模板', exact: true }).click())
    templateId = saved.draft.savedTemplate.id
    expect((await read(page, '/v1/plans')).plans).toHaveLength(initialPlanCount)
    const adopted = await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '使用模板', exact: true }).click())
    planId = adopted.templatePlan.planId
    await expect(page).toHaveURL(new RegExp(`/plans/${planId}\\?setup=1$`))
    await page.getByLabel('每日目标（分钟）（可留空）', { exact: true }).fill('60')
    await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    expect((await read(page, `/v1/plans/${planId}/generic`)).totalRecords).toBe(0)
    for (const minutes of ['20', '10']) {
      await page.getByRole('button', { name: '添加记录', exact: true }).click()
      await page.getByLabel('书名', { exact: true }).fill('创作验证读物')
      await page.getByLabel('阅读时间（分钟）', { exact: true }).fill(minutes)
      await page.getByLabel('读到页数（可留空）', { exact: true }).fill('35')
      await page.getByLabel('购书花费（元）（可留空）', { exact: true }).fill('12.34')
      await page.getByLabel('阅读感受', { exact: true }).selectOption('专注')
      await page.getByRole('group', { name: '阅读标签', exact: true }).getByLabel('小说', { exact: true }).check()
      await page.getByRole('group', { name: '阅读标签', exact: true }).getByLabel('历史', { exact: true }).check()
      await page.getByLabel('已经读完', { exact: true }).selectOption('false')
      const result = await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '保存记录', exact: true }).click())
      if (!recordId) recordId = result.items[0].record.id
    }
    let view = await read(page, `/v1/plans/${planId}/generic`)
    expect(view.summary.metrics.find((metric: { label: string }) => metric.label === '每日阅读时长').value).toBe(30)
    expect(view.summary.metrics.find((metric: { operation: string }) => metric.operation === 'goal_progress').progressPct).toBe(50)
    expect(view.records[0].fields[fields['购书花费']!]).toBe(1234)
    expect(view.records[0].fields[fields['已经读完']!]).toBe(false)
    expect(view.records[0].fields[fields['阅读标签']!]).toEqual(['小说', '历史'])
    await page.goto(`/plans/${planId}?record=${recordId}`)
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('阅读时间（分钟）', { exact: true }).fill('25')
    await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    view = await read(page, `/v1/plans/${planId}/generic`)
    expect(view.summary.metrics.find((metric: { label: string }) => metric.label === '每日阅读时长').value).toBe(35)
    const second = view.records.find((record: { id: string }) => record.id !== recordId)
    await page.goto(`/plans/${planId}?record=${second.id}`)
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    await page.reload()
    await expect(page.getByRole('region', { name: '记录统计', exact: true })).toContainText('25 分钟')
    await expect(page.locator('.reading-source')).toContainText('我的模板')
    originalRecord = (await read(page, `/v1/plans/${planId}/generic`)).records[0]
    if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR) await writeFile(join(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, `${info.project.name}-creation-ids.json`), JSON.stringify({ draftId, planId, templateId, recordId, fields: originalDefinition.recordFields.map(({ id, type }) => ({ id, type })) }, null, 2))
    await capture(page, `${info.project.name}-creation-live-records.png`)
  })

  test('原计划兼容派生：新增可选字段并明确应用，原记录及旧模板保留', async ({ page }, info) => {
    await page.goto(`/plans/${planId}`)
    await page.getByRole('link', { name: '调整这个计划的模板', exact: true }).click()
    const forked = await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '创建私人草稿', exact: true }).click())
    await expect(page).toHaveURL(new RegExp(`/create/${forked.draft.id}$`))
    await page.getByRole('button', { name: '手动编辑', exact: true }).click()
    await editField(page, '每次记录的内容', '天气', 'text')
    const book = page.locator('.definition-field').filter({ has: page.locator('legend', { hasText: /^书名$/ }) })
    await book.getByLabel('项目名称', { exact: true }).fill('作品名称')
    await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '保存草稿修改', exact: true }).click())
    const saved = await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '保存私人模板', exact: true }).click())
    const before = await read(page, `/v1/plans/${planId}/generic`)
    expect(before.templatePlan.templateId).toBe(templateId)
    await page.getByRole('button', { name: '应用到原计划', exact: true }).click()
    const applied = await mutation(page, '/v1/operations', () => page.getByRole('button', { name: '确认应用修改', exact: true }).click())
    expect(applied.templatePlan.templateId).toBe(saved.draft.savedTemplate.id)
    await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`))
    const after = await read(page, `/v1/plans/${planId}/generic`)
    expect(after.records[0]).toEqual(originalRecord)
    expect(after.templatePlan.definition.recordFields.find((field: { id: string }) => field.id === fields['书名']).label).toBe('作品名称')
    const weather = after.templatePlan.definition.recordFields.find((field: { label: string }) => field.label === '天气')
    expect(after.records[0].fields[weather.id]).toBeUndefined()
    const old = await read(page, `/v1/creation/templates/${encodeURIComponent(templateId)}?version=1`)
    expect(old.recordFields.find((field: { id: string }) => field.id === fields['书名']).label).toBe('书名')
    expect(old.recordFields.some((field: { label: string }) => field.label === '天气')).toBe(false)
    await page.getByRole('button', { name: '添加记录', exact: true }).click()
    await expect(page.getByLabel('天气（可留空）', { exact: true })).toBeVisible()
    await expect(page.getByLabel('作品名称', { exact: true })).toBeVisible()
    await capture(page, `${info.project.name}-creation-live-derived.png`)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.goto('/me')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出数据', exact: true }).click()
    const file = await download
    expect(await file.failure()).toBeNull()
    const path = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
    if (path) await file.saveAs(join(path, `${info.project.name}-creation-export.zip`))
    const zip = await readFile((await file.path())!)
    const exportedTemplates = JSON.parse(unzipText(zip, 'private-templates.json')).templates
    expect(JSON.stringify(exportedTemplates)).toContain(templateId)
    const exportedDrafts = JSON.parse(unzipText(zip, 'creation-drafts.json')).drafts
    expect(JSON.stringify(exportedDrafts)).toContain(draftId)
    const exportedRecords = JSON.parse(unzipText(zip, 'generic-records.json')).records
    expect(exportedRecords.find((record: { id: string }) => record.id === recordId)).toEqual(originalRecord)
  })

  test('创作真实丢响应：新建与保存都使用原ID恢复，不重复创建', async ({ page }) => {
    let originalId = ''
    await page.route('**/v1/creation/requests', async route => {
      const input = route.request().postDataJSON()
      if (input.action !== 'create') return route.continue()
      const response = await route.fetch(); expect(response.ok()).toBe(true); originalId = input.clientOpId; await route.abort('failed')
    }, { times: 1 })
    const before = await read(page, '/v1/creation/drafts?limit=20&offset=0')
    await page.getByRole('button', { name: '创建模板', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page).toHaveURL(/\/create\/[^/]+$/)
    const recovered = await read(page, `/v1/creation/requests/${originalId}`)
    expect(recovered.status).toBe('succeeded')
    expect(new URL(page.url()).pathname).toBe(`/create/${recovered.result.draft.id}`)
    expect((await read(page, '/v1/creation/drafts?limit=20&offset=0')).total).toBe(before.total + 1)
    await page.goto(`/create/${draftId}`)
    await page.getByRole('button', { name: '手动编辑', exact: true }).click()
    await page.getByLabel('功能简介', { exact: true }).fill('这是更新后的私人阅读模板。')
    await mutation(page, '/v1/creation/requests', () => page.getByRole('button', { name: '保存草稿修改', exact: true }).click())
    await page.route('**/v1/creation/requests', async route => {
      const input = route.request().postDataJSON()
      if (input.action !== 'save') return route.continue()
      const response = await route.fetch(); expect(response.ok()).toBe(true); originalId = input.clientOpId; await route.abort('failed')
    }, { times: 1 })
    await page.getByRole('button', { name: '保存私人模板', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    await expect(page.getByRole('heading', { name: '私人模板已保存', exact: true })).toBeVisible()
    const saved = await read(page, `/v1/creation/requests/${originalId}`)
    expect(saved.result.draft.savedTemplate.version).toBe(2)
    expect((await read(page, `/v1/creation/drafts/${draftId}`)).savedTemplate.version).toBe(2)
  })

  test('私人模板不进入公开市场，另一账户不能读取草稿或选用', async ({ page, browser }) => {
    test.skip(!otherEmail || !otherPassword, '需要第二个创作合成账户')
    const publicTemplates = await (await page.request.get('/v1/templates')).json()
    expect(publicTemplates.templates.every((item: { source: string }) => item.source === 'official')).toBe(true)
    const context = await browser.newContext()
    const other = await context.newPage()
    try {
      await other.goto('/login?next=%2Fcreate')
      await other.getByLabel('邮箱', { exact: true }).fill(otherEmail!)
      await other.getByLabel('密码', { exact: true }).fill(otherPassword!)
      await other.getByRole('button', { name: '登录', exact: true }).click()
      await expect(other.getByRole('heading', { name: '创作', exact: true })).toBeVisible()
      for (const path of [`/v1/creation/drafts/${draftId}`, `/v1/creation/templates/${encodeURIComponent(templateId)}?version=1`]) {
        const response = await other.request.get(path, { headers: await headers(other) }); expect(response.status()).toBe(404)
      }
      const response = await other.request.post('/v1/operations', { headers: await headers(other), data: { clientOpId: randomUUID(), inputAt: new Date().toISOString(), actions: [{ type: 'adopt_template', templateId, templateVersion: 1 }] } })
      expect(response.status()).toBe(404)
      expect((await read(other, '/v1/creation/templates')).templates.some((item: { id: string }) => item.id === templateId)).toBe(false)
      await other.goto(`/create/${draftId}`)
      await expect(other.getByRole('heading', { name: '暂时无法打开草稿', exact: true })).toBeVisible()
      await expect(other.getByRole('button', { name: '使用模板', exact: true })).toHaveCount(0)
    } finally { await context.close() }
  })
})
