import { test, expect, type Page } from '@playwright/test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Action, PlanView, RecordResponse, RecordView } from '../src/lib/contracts'

const statePath = process.env.PLANPLAN_E2E_STORAGE_STATE
const output = process.env.PLANPLAN_E2E_SCREENSHOT_DIR

for (const change of ['新增退款', '移除退款', '同额编辑退款'] as const) test(`真实两页面删除确认：${change}后旧快照被拒绝且重核后才删除`, async ({ page, browser }, info) => {
  test.skip(!statePath, '需要本轮正常 UI 登录取得的合成账户会话')
  test.setTimeout(90000)
  const state = JSON.parse(await readFile(statePath!, 'utf8'))
  await page.context().addCookies(state.cookies)
  const other = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } })
  const second = await other.newPage()
  page.setDefaultTimeout(15000); second.setDefaultTimeout(15000)
  const errors: string[] = [], modelRequests: string[] = []
  for (const p of [page, second]) {
    p.on('pageerror', error => errors.push(error.message))
    p.on('request', request => { const path = new URL(request.url()).pathname; if (request.method() === 'POST' && (path === '/v1/chat' || path === '/v1/creation/requests' && request.postDataJSON()?.action === 'message')) modelRequests.push(path) })
  }
  const sessionResponse = await page.request.get('/v1/auth/web/session')
  expect(sessionResponse.ok()).toBe(true)
  const session = await sessionResponse.json()
  const headers = { 'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrfToken, Origin: 'http://127.0.0.1:5173' }
  async function read<T>(path: string): Promise<T> {
    const response = await page.request.get(path, { headers })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  async function operate(actions: Action[]) {
    const response = await page.request.post('/v1/operations', { headers, data: { clientOpId: randomUUID(), inputAt: new Date().toISOString(), actions } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  async function uiOperation(p: Page, action: () => Promise<void>, status = 200) {
    const waiting = p.waitForResponse(response => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST', { timeout: 15000 })
    await action()
    const response = await waiting
    expect(response.status(), await response.text()).toBe(status)
    const result = await response.json(), body = response.request().postDataJSON()
    await expect.poll(() => p.evaluate(async () => (await navigator.locks.query()).held?.some(lock => lock.name === 'planplan-browser-session') ?? false)).toBe(false)
    return { result, body }
  }
  const marker = `退款快照-${info.project.name}-${change}-${Date.now()}`
  const me = await read<{ today: string }>('/v1/me')
  const active = await read<{ plans: { plan: PlanView }[] }>('/v1/plans?status=active')
  if (!active.plans.some(item => item.plan.kind === 'ledger')) {
    const archived = await read<{ plans: { plan: PlanView }[] }>('/v1/plans?status=archived')
    const prior = archived.plans.find(item => item.plan.kind === 'ledger')
    await operate([prior ? { type: 'restore_plan', planId: prior.plan.id } : { type: 'create_ledger' }])
  }
  const added = await operate([{ type: 'add_expense', amountCents: 10000, category: '购物', date: me.today, note: marker }])
  const expense = added.items.find((item: { type: string }) => item.type === 'expense_added').record as RecordView
  const initialRefund = await operate([{ type: 'add_refund', expenseId: expense.id, amountCents: 1000, date: me.today, note: `${marker}-原退款` }])
  const refund = initialRefund.items.find((item: { type: string }) => item.type === 'refund_added').record as RecordView
  const before = await read<RecordResponse>(`/v1/records/${expense.id}`)
  await page.goto(`/plans/${expense.planId}?record=${expense.id}`)
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
  const panel = page.locator('.record-delete-confirm')
  await expect(panel).toContainText('关联退款 1 条，合计 ¥10.00')
  let extraRefundId: string | undefined
  try {
    await second.goto(`/plans/${expense.planId}?record=${change === '新增退款' ? expense.id : refund.id}`)
    if (change === '新增退款') {
      await second.getByRole('button', { name: '记录退款', exact: true }).click()
      await second.getByLabel('退款金额（元）', { exact: true }).fill('5')
      await second.getByLabel('备注（可留空）', { exact: true }).fill(`${marker}-新增退款`)
      const result = await uiOperation(second, () => second.getByRole('button', { name: '保存记录', exact: true }).click())
      extraRefundId = result.result.items.find((item: { type: string }) => item.type === 'refund_added').record.id
    } else if (change === '移除退款') {
      await second.getByRole('button', { name: '删除记录', exact: true }).click()
      const result = await uiOperation(second, () => second.getByRole('button', { name: '确认删除', exact: true }).click())
      expect(result.body.actions[0]).not.toHaveProperty('expectedRefundSnapshot')
    } else {
      await second.getByRole('button', { name: '修改记录', exact: true }).click()
      await second.getByRole('textbox', { name: /^备注（可留空）/ }).fill(`${marker}-修改说明金额不变`)
      await uiOperation(second, () => second.getByRole('button', { name: '保存修改', exact: true }).click())
    }
    const latest = await read<RecordResponse>(`/v1/records/${expense.id}`)
    expect(latest.refundSnapshot!.token).not.toBe(before.refundSnapshot!.token)
    expect(latest.record.version).toBe(before.record.version)
    const versionBeforeFailure = await read<{ dataVersion: number }>('/v1/me')
    const rejected = await uiOperation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click(), 409)
    expect(rejected.result.error.code).toBe('version_conflict')
    expect(rejected.body.actions[0].expectedRefundSnapshot).toBe(before.refundSnapshot!.token)
    const afterFailure = await read<RecordResponse>(`/v1/records/${expense.id}`)
    expect(afterFailure).toEqual(latest)
    expect((await read<{ dataVersion: number }>('/v1/me')).dataVersion).toBe(versionBeforeFailure.dataVersion)
    await expect(panel).toContainText('这次删除没有执行')
    await expect(page.locator('body')).not.toContainText(/refunds-v1:|expectedRefundSnapshot|refundSnapshot/)
    await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
    if (output && change === '新增退款') {
      await mkdir(output, { recursive: true })
      await panel.screenshot({ path: `${output}/${info.project.name}-refund-live-conflict-desktop.png` })
      await page.setViewportSize({ width: 375, height: 812 })
      await panel.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${info.project.name}-refund-live-conflict-mobile.png`, fullPage: true })
    }
    await page.getByRole('button', { name: '取消并重新核对', exact: true }).click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(panel).toContainText(`关联退款 ${latest.refundSnapshot!.count} 条`)
    if (latest.refundSnapshot!.count > 0) {
      await expect(page.getByRole('checkbox', { name: /同时删除关联退款/ })).not.toBeChecked()
      await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
    }
    const accepted = await uiOperation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    expect(accepted.body.clientOpId).not.toBe(rejected.body.clientOpId)
    expect(accepted.body.actions[0]).toMatchObject({ expectedVersion: latest.record.version, expectedRefundSnapshot: latest.refundSnapshot!.token, includeRefunds: latest.refundSnapshot!.count > 0 })
    for (const id of [expense.id, refund.id, extraRefundId].filter(Boolean)) expect((await read<RecordResponse>(`/v1/records/${id}`)).record.deleted).toBe(true)
    if (output) await writeFile(`${output}/${info.project.name}-refund-live-${change}-ids.json`, JSON.stringify({ planId: expense.planId, expenseId: expense.id, refundId: refund.id, extraRefundId, expenseVersionUnchanged: true, rejectedStatus: 409, failedDeletionDataVersionUnchanged: true, latestRefundCount: latest.refundSnapshot!.count, explicitlyReconfirmed: true, recordsDeleted: true, modelRequests, runtimeErrors: errors }, null, 2))
    expect(modelRequests).toEqual([])
    expect(errors).toEqual([])
  } catch (error) {
    if (output) { await page.screenshot({ path: `${output}/${info.project.name}-${change}-failure-primary.png`, fullPage: true }).catch(() => {}); await second.screenshot({ path: `${output}/${info.project.name}-${change}-failure-secondary.png`, fullPage: true }).catch(() => {}) }
    throw error
  } finally { await other.close().catch(() => {}) }
})
