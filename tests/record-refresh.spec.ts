import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { PlanView, RecordView } from '../src/lib/contracts'

for (const latestVersion of [1, 3]) test(`记录详情刷新不能用旧退款快照操作：退款清空后版本${latestVersion === 1 ? '不变' : '另有修改'}`, async ({ page }) => {
  const userId = randomUUID(), planId = randomUUID(), recordId = randomUUID(), now = new Date().toISOString()
  const plan: PlanView = { id: planId, kind: 'ledger', name: '记录刷新验收', activity: null, status: 'active', startDate: '2026-11-01', hidden: [], order: [], lastActivityAt: now }
  const record: RecordView = { id: recordId, planId, kind: 'expense', amountCents: 5000, minutes: null, category: '购物', date: '2026-11-16', note: '退款已删除的原支出', refundOf: null, refundedCents: 1000, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: now }
  let hold = false, heldRequests = 0
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const actions: Record<string, unknown>[] = []
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'record-refresh-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: userId, today: '2026-11-16', timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: 1, signInMethod: 'email' } })
    if (path === '/v1/plans') return route.fulfill({ json: { plans: new URL(route.request().url()).searchParams.get('status') === 'archived' ? [] : [{ plan }], dataVersion: 1 } })
    if (path.endsWith('/template')) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '这是旧计划。' } } })
    if (path.endsWith('/ledger')) return route.fulfill({ json: { plan, month: '2026-11', months: ['2026-11'], dataVersion: 1, records: record.deleted ? [] : [record], stats: { month: '2026-11', spendCents: record.deleted ? 0 : 5000, refundCents: record.refundedCents, netCents: record.deleted ? 0 : 5000 - record.refundedCents!, budgetCents: null, remainingCents: null, usagePct: null, overCents: null, expenseCount: record.deleted ? 0 : 1, refundCount: record.refundedCents ? 1 : 0, byCategory: [], daily: [] } } })
    if (path === `/v1/records/${recordId}`) { if (hold) { heldRequests++; await waiting } return route.fulfill({ json: { record, refundSnapshot: { token: `refunds-v1:${(record.refundedCents ? 'a' : 'b').repeat(64)}`, count: record.refundedCents ? 1 : 0, totalCents: record.refundedCents ?? 0 }, source: null } }) }
    if (path === '/v1/operations') {
      const body = route.request().postDataJSON()
      actions.push(...body.actions)
      record.deleted = true
      return route.fulfill({ json: { clientOpId: body.clientOpId, operationId: randomUUID(), kind: 'batch', items: [], undoable: false, createdAt: now, dataVersion: 2 } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  await page.goto(`/plans/${planId}?record=${recordId}`)
  await expect(page.locator('.record-facts')).toContainText('已退款')
  await expect(page.getByRole('button', { name: '删除记录', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  hold = true
  record.refundedCents = 0; record.version = latestVersion
  await page.locator('.record-row').click()
  await expect.poll(() => heldRequests).toBeGreaterThan(0)
  for (const name of ['修改记录', '记录退款', '删除记录']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  expect(actions).toEqual([])
  release()
  await expect(page.locator('.record-facts')).not.toContainText('已退款')
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /同时删除关联退款/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => actions.length).toBe(1)
  expect(actions[0]).toMatchObject({ type: 'delete_record', recordId, expectedVersion: latestVersion, includeRefunds: false, expectedRefundSnapshot: `refunds-v1:${'b'.repeat(64)}` })
  await expect(page.locator('.record-row')).toHaveCount(0)
})
