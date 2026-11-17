import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateDefinition } from '../src/lib/contracts'

const password = process.env.PLANPLAN_PLATFORM_PASSWORD
const statePath = process.env.PLANPLAN_CREATION_E2E_STORAGE_STATE
const output = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
const capabilities = 'generic-record-v1,generic-template-v2,private-template-v1,community-template-v1,reading-template-v1,ledger-template-v1,chat-recovery-v1'

test('创作修复真实链：一字必填、建议试填、私人保存采用与实际记录纠错一致', async ({ page }, info) => {
  test.skip(!password && !statePath, '需要专用平台合成账号或本轮正常登录会话')
  test.setTimeout(120000)
  const runtime: string[] = []
  page.on('pageerror', error => runtime.push(error.message))
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|Load failed|Request blocked by Playwright|server responded/.test(message.text())) runtime.push(message.text()) })
  let modelRequests = 0
  page.on('request', request => { if (request.method() === 'POST' && (new URL(request.url()).pathname === '/v1/chat' || new URL(request.url()).pathname === '/v1/creation/requests' && request.postDataJSON()?.action === 'message')) modelRequests++ })
  async function mutation(path: string, action: () => Promise<void>) {
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
    await action()
    const response = await waiting
    expect(response.ok(), await response.text()).toBe(true)
    const result = await response.json()
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some(lock => lock.name === 'planplan-browser-session') ?? false)).toBe(false)
    return result
  }
  async function read(path: string) {
    const session = await (await page.request.get('/v1/auth/web/session')).json()
    const response = await page.request.get(path, { headers: { 'X-PlanPlan-Expected-User': session.userId, 'X-PlanPlan-Capabilities': capabilities } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  async function field(sectionName: string, label: string, type: string, required = false) {
    const section = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: sectionName, exact: true }) })
    await section.getByRole('button', { name: '添加项目', exact: true }).click()
    const row = section.locator('.definition-field').last()
    await row.getByLabel('项目名称', { exact: true }).fill(label)
    await row.getByRole('combobox', { name: '填写方式', exact: true }).selectOption(type)
    if (required) await row.getByLabel('必须填写', { exact: true }).check()
    return row
  }
  const name = `创作修复${info.project.name}${Date.now().toString().slice(-4)}`.slice(0, 20)
  if (statePath) {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    await page.context().addCookies(state.cookies)
    await page.goto('/create')
  } else {
    await page.goto('/login?next=%2Fcreate')
    await page.getByLabel('邮箱', { exact: true }).fill('platform-author@planplan.test')
    await page.getByLabel('密码', { exact: true }).fill(password!)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: '创作', exact: true })).toBeVisible()
  const created = await mutation('/v1/creation/requests', () => page.getByRole('button', { name: '创建模板', exact: true }).click())
  const draftId: string = created.draft.id
  await page.getByRole('button', { name: '从空白开始设计', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill(name)
  await page.getByLabel('功能简介', { exact: true }).fill('按周核对阅读积累，先试填建议值再创建自己的计划。')
  await field('开始时的设置', '每周目标', 'duration')
  const grade = await field('每次记录的内容', '等级', 'text', true)
  await grade.getByLabel('最多字数', { exact: true }).fill('1')
  await field('每次记录的内容', '阅读时间', 'duration', true)
  await field('每次记录的内容', '读完', 'boolean')
  const metrics = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: '统计与目标', exact: true }) })
  await metrics.getByRole('button', { name: '添加统计', exact: true }).click()
  const goal = metrics.locator('.definition-field').last()
  await goal.getByLabel('统计名称', { exact: true }).fill('每周进度')
  await goal.getByRole('combobox', { name: '计算方式', exact: true }).selectOption('goal_progress')
  await goal.getByRole('combobox', { name: '统计周期', exact: true }).selectOption('week')
  await goal.getByRole('combobox', { name: '目标来自哪项设置', exact: true }).selectOption({ label: '每周目标' })
  await page.getByRole('checkbox', { name: '目标进度', exact: true }).check()
  for (const label of ['每周目标', '等级', '阅读时间', '读完']) await page.getByRole('checkbox', { name: `建议${label}`, exact: true }).check()
  await page.getByLabel('默认：每周目标（分钟）（可留空）', { exact: true }).fill('100')
  await page.getByLabel('默认：等级', { exact: true }).fill('A')
  await page.getByLabel('默认：阅读时间（分钟）', { exact: true }).fill('30')
  await page.getByLabel('默认：读完（可留空）', { exact: true }).selectOption('false')
  const updated = await mutation('/v1/creation/requests', () => page.getByRole('button', { name: '保存草稿修改', exact: true }).click())
  const definition: TemplateDefinition = updated.draft.definition
  const fieldId = (label: string) => definition.recordFields.find(field => field.label === label)!.id
  expect(definition.example.record[fieldId('等级')]).toBe('示')
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByText('调整试填设置', { exact: true }).click()
  await page.getByRole('button', { name: '载入首次设置建议', exact: true }).click()
  await page.getByLabel('试填时沿用常用记录建议', { exact: true }).check()
  await page.getByRole('button', { name: '加入试填', exact: true }).click()
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('已完成 30%')
  await page.getByRole('button', { name: '修改试填 1', exact: true }).click()
  await page.getByLabel('试填：阅读时间（分钟）', { exact: true }).fill('40')
  await page.getByLabel('试填：读完（可留空）', { exact: true }).selectOption('')
  await page.getByRole('button', { name: '保存试填修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('已完成 40%')
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, `${info.project.name}-creation-refinement-preview.png`), fullPage: true }) }
  const saved = await mutation('/v1/creation/requests', () => page.getByRole('button', { name: '保存私人模板', exact: true }).click())
  const adopted = await mutation('/v1/operations', () => page.getByRole('button', { name: '使用模板', exact: true }).click())
  const planId: string = adopted.templatePlan.planId
  expect(adopted.templatePlan.config.recordDefaults).toEqual({})
  expect((await read(`/v1/plans/${planId}/generic`)).records).toEqual([])
  await page.getByLabel('确认使用这些建议，仍可逐项修改').check()
  await page.getByText('新增记录的常用值', { exact: true }).click()
  await page.getByRole('button', { name: '载入模板建议，保存后启用', exact: true }).click()
  await mutation('/v1/operations', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
  await page.getByRole('button', { name: '添加记录', exact: true }).click()
  const added = await mutation('/v1/operations', () => page.getByRole('button', { name: '保存记录', exact: true }).click())
  const recordId: string = added.items[0].record.id
  expect(added.items[0].record.defaultedFields).toHaveLength(3)
  await page.goto(`/plans/${planId}?record=${recordId}`)
  await page.getByRole('button', { name: '修改记录', exact: true }).click()
  await page.getByLabel('阅读时间（分钟）', { exact: true }).fill('40')
  await page.getByLabel('读完（可留空）', { exact: true }).selectOption('')
  await mutation('/v1/operations', () => page.getByRole('button', { name: '保存修改', exact: true }).click())
  await page.reload()
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('已完成 40%')
  const view = await read(`/v1/plans/${planId}/generic`)
  expect(view.records).toHaveLength(1)
  expect(view.records[0].fields[fieldId('读完')]).toBeNull()
  expect(view.summary.metrics.find((metric: { label: string }) => metric.label === '每周进度')).toMatchObject({ value: 40, target: 100, progressPct: 40, period: 'week' })
  if (output) {
    await page.screenshot({ path: join(output, `${info.project.name}-creation-refinement-plan.png`), fullPage: true })
    await page.setViewportSize({ width: 375, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(output, `${info.project.name}-creation-refinement-mobile.png`), fullPage: true })
    await writeFile(join(output, `${info.project.name}-creation-refinement-ids.json`), JSON.stringify({ draftId, templateId: saved.draft.savedTemplate.id, planId, recordId, records: 1, value: 40, target: 100, modelRequests }, null, 2))
  }
  expect(modelRequests).toBe(0)
  expect(runtime).toEqual([])
  // A shared normal-login session is owned and cleaned up by the suite runner.
  if (!statePath) {
    await page.goto('/me')
    await page.getByRole('button', { name: '退出所有设备', exact: true }).click()
    const loggedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/logout' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '确认退出所有设备', exact: true }).click()
    expect((await loggedOut).ok()).toBe(true)
    await expect(page.getByRole('heading', { name: '欢迎来到 PlanPlan', exact: true })).toBeVisible()
  }
})
