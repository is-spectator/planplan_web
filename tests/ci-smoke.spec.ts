import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Self-contained local API smoke. Credentials are the public fixture accounts.
// A missing API or account must fail this file. Do not bypass a case.
const email = 'tester@planplan.test'
const password = 'PlanPlan-local-test-2026'
const capabilities = 'reading-template-v1,ledger-template-v1,generic-record-v1,private-template-v1,generic-template-v2,community-template-v1,chat-recovery-v1'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL('/plans')
  await expect(page.getByRole('button', { name: '新建计划', exact: true }).first()).toBeVisible()
}

async function headers(page: Page) {
  const sessionResponse = await page.request.get('/v1/auth/web/session')
  expect(sessionResponse.ok(), await sessionResponse.text()).toBe(true)
  const session = await sessionResponse.json() as { userId: string }
  return { 'X-PlanPlan-Expected-User': session.userId, 'X-PlanPlan-Capabilities': capabilities }
}

function daysBefore(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

async function shot(page: Page, name: string) {
  const directory = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, name), fullPage: true })
}

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('手动创建学习计划并保存一条记录，刷新后仍在', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await login(page)
  const marker = `CI${info.project.name.slice(0, 3)}${Date.now().toString().slice(-8)}`
  await page.getByRole('button', { name: '新建计划', exact: true }).first().click()
  await page.getByRole('button', { name: '学习计划', exact: true }).click()
  await page.getByLabel('计划名称', { exact: true }).fill(marker)
  await page.getByRole('button', { name: '创建计划', exact: true }).click()
  await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible()
  const planId = new URL(page.url()).pathname.split('/').at(-1)
  expect(planId).toBeTruthy()
  await page.getByRole('button', { name: '记录学习', exact: true }).click()
  await page.getByLabel('学习时长（分钟）', { exact: true }).fill('20')
  await page.getByLabel('备注（可留空）', { exact: true }).fill(marker)
  await page.getByRole('button', { name: '保存记录', exact: true }).click()
  const row = page.locator('.record-row').filter({ hasText: marker })
  await expect(row).toContainText('20 分钟')
  await page.reload()
  await expect(row).toContainText('20 分钟')
  const study = await page.request.get(`/v1/plans/${planId}/study`, { headers: await headers(page) })
  expect(study.ok(), await study.text()).toBe(true)
  const body = await study.json() as { records: { note: string | null }[]; totalRecords: number }
  expect(body.records.filter(record => record.note === marker)).toHaveLength(1)
  expect(body.totalRecords).toBeGreaterThanOrEqual(1)
  await shot(page, `ci-smoke-record-${info.project.name}.png`)
  expect(errors).toEqual([])
})

test('手动编辑并保存私人模板，采用后没有记录', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await login(page)
  const name = `模${info.project.name.slice(0, 3)}${Date.now().toString().slice(-8)}`
  await page.goto('/create')
  await page.getByRole('button', { name: '创建模板', exact: true }).click()
  await expect(page).toHaveURL(/\/create\/[0-9a-f-]+$/)
  await page.getByRole('button', { name: '从空白开始设计', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill(name)
  await page.getByLabel('功能简介', { exact: true }).fill('只用于自动检查的私人模板')
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存私人模板', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存私人模板', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用模板', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '使用模板', exact: true }).click()
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  await expect(page.getByText('这一天还没有记录。', { exact: true })).toBeVisible()
  const planId = new URL(page.url()).pathname.split('/').at(-1)
  const requestHeaders = await headers(page)
  const me = await page.request.get('/v1/me', { headers: requestHeaders })
  expect(me.ok(), await me.text()).toBe(true)
  const today = (await me.json() as { today: string }).today
  const generic = await page.request.get(`/v1/plans/${planId}/generic?from=${daysBefore(today, 364)}&to=${today}`, { headers: requestHeaders })
  expect(generic.ok(), await generic.text()).toBe(true)
  const body = await generic.json() as { records: unknown[]; totalRecords: number }
  expect(body.records).toEqual([])
  expect(body.totalRecords).toBe(0)
  await shot(page, `ci-smoke-template-${info.project.name}.png`)
  expect(errors).toEqual([])
})
