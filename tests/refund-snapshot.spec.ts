import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { PlanView, RecordView, RefundSnapshot } from '../src/lib/contracts'

const token = (value: string) => `refunds-v1:${value.repeat(64)}`
async function fixture(page: Page, snapshot: RefundSnapshot | null = { token: token('a'), count: 1, totalCents: 1000 }) {
  const userId = randomUUID(), planId = randomUUID(), recordId = randomUUID(), now = new Date().toISOString()
  const plan: PlanView = { id: planId, kind: 'ledger', name: '退款确认验收', activity: null, status: 'active', startDate: '2026-11-01', hidden: [], order: [], lastActivityAt: now }
  const record: RecordView = { id: recordId, planId, kind: 'expense', amountCents: 5000, minutes: null, category: '购物', date: '2026-11-16', note: '关联退款核对', refundOf: null, refundedCents: snapshot?.totalCents ?? 0, source: 'form', sourceMessageId: null, version: 1, deleted: false, createdAt: now }
  const state = { snapshot, version: 1, detailReads: 0, rejected: false, abortFirst: false, rejectCode: 'version_conflict' }
  const bodies: { clientOpId: string; actions: Record<string, unknown>[] }[] = []
  const lookupIds: string[] = []
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'refund-snapshot-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: userId, today: '2026-11-16', timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: state.version, signInMethod: 'email' } })
    if (path === '/v1/plans') return route.fulfill({ json: { plans: new URL(route.request().url()).searchParams.get('status') === plan.status ? [{ plan }] : [], dataVersion: state.version } })
    if (path.endsWith('/template')) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '这是旧计划。' } } })
    if (path.endsWith('/ledger')) return route.fulfill({ json: { plan, month: '2026-11', months: ['2026-11'], dataVersion: state.version, records: record.deleted ? [] : [record], stats: { month: '2026-11', spendCents: record.deleted ? 0 : 5000, refundCents: record.refundedCents, netCents: record.deleted ? 0 : 5000 - record.refundedCents!, budgetCents: null, remainingCents: null, usagePct: null, overCents: null, expenseCount: record.deleted ? 0 : 1, refundCount: state.snapshot?.count ?? 0, byCategory: [], daily: [] } } })
    if (path === `/v1/records/${recordId}`) { state.detailReads++; return route.fulfill({ json: { record, refundSnapshot: state.snapshot, source: null } }) }
    if (path.startsWith('/v1/operations/')) { lookupIds.push(path.split('/').at(-1)!); return route.fulfill({ json: { status: 'not_found' } }) }
    if (path === '/v1/operations') {
      const body = route.request().postDataJSON(); bodies.push(body)
      const action = body.actions[0]
      if (action.type === 'delete_record') {
        if (state.abortFirst && bodies.filter(item => item.actions[0].type === 'delete_record').length === 1) return route.abort('connectionfailed')
        if (state.rejected || action.expectedRefundSnapshot !== state.snapshot?.token) return route.fulfill({ status: 409, json: { error: { code: state.rejectCode, message: '关联退款已变化，本次没有删除。请重新核对退款后确认。', details: { record, refundSnapshot: state.snapshot } } } })
        record.deleted = true
      } else { expect(action.type).toBe('archive_plan'); plan.status = 'archived' }
      state.version++
      return route.fulfill({ json: { clientOpId: body.clientOpId, operationId: randomUUID(), kind: 'batch', items: [], undoable: false, createdAt: now, dataVersion: state.version } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  await page.goto(`/plans/${planId}?record=${recordId}`)
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  return { state, record, bodies, lookupIds, planId }
}

for (const change of [
  { title: '新增退款', count: 2, totalCents: 1500 },
  { title: '删掉退款且原支出版本不变', count: 0, totalCents: 0 },
  { title: '同额退款内容修改', count: 1, totalCents: 1000 },
]) test(`删除确认固定关联退款快照：${change.title}后必须重新确认`, async ({ page }, info) => {
  const f = await fixture(page)
  const panel = page.locator('.record-delete-confirm')
  await expect(panel).toContainText('关联退款 1 条，合计 ¥10.00')
  await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
  const reads = f.state.detailReads
  f.state.snapshot = { token: token('b'), count: change.count, totalCents: change.totalCents }
  f.record.refundedCents = change.totalCents; f.state.version++
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => f.state.detailReads).toBeGreaterThan(reads)
  await expect(panel).toContainText('关联退款 1 条，合计 ¥10.00')
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(panel).toContainText('这次删除没有执行')
  expect(f.bodies[0].actions[0]).toMatchObject({ expectedVersion: 1, expectedRefundSnapshot: token('a'), includeRefunds: true })
  expect(f.record.deleted).toBe(false)
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  // Another operation clears the global conflict. The mounted deletion confirmation must remain invalid.
  await page.getByRole('button', { name: '归档计划', exact: true }).click()
  await page.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复计划', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  expect(f.bodies.filter(body => body.actions[0].type === 'delete_record')).toHaveLength(1)
  if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR && change.count === 2) {
    await mkdir(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, { recursive: true })
    await panel.screenshot({ path: `${process.env.PLANPLAN_E2E_SCREENSHOT_DIR}/${info.project.name}-refund-conflict-frozen.png` })
  }
  await page.getByRole('button', { name: '取消并重新核对', exact: true }).click()
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await expect(panel).toContainText(`关联退款 ${change.count} 条`)
  if (change.count) {
    await expect(page.getByRole('checkbox', { name: /同时删除关联退款/ })).not.toBeChecked()
    await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
  } else await expect(page.getByRole('checkbox', { name: /同时删除关联退款/ })).toHaveCount(0)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => f.record.deleted).toBe(true)
  expect(f.bodies.at(-1)!.actions[0]).toMatchObject({ expectedVersion: 1, expectedRefundSnapshot: token('b'), includeRefunds: change.count > 0 })
})

test('删除确认缺少关联退款快照时停止提交，刷新后可重新核对零退款', async ({ page }) => {
  const f = await fixture(page, null)
  await expect(page.getByRole('alert')).toContainText('暂时无法核对关联退款')
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  expect(f.bodies).toHaveLength(0)
  f.state.snapshot = { token: token('b'), count: 0, totalCents: 0 }
  await page.getByRole('button', { name: '取消并重新核对', exact: true }).click()
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => f.record.deleted).toBe(true)
  expect(f.bodies[0].actions[0]).toMatchObject({ includeRefunds: false, expectedRefundSnapshot: token('b') })
})

test('旧退款确认错误进入恢复对照，显示当前退款数量与金额且不泄露 token', async ({ page }) => {
  const f = await fixture(page)
  f.state.rejected = true; f.state.rejectCode = 'refund_confirmation_required'
  await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.locator('.record-delete-confirm')).toContainText('这次删除没有执行')
  await page.getByRole('link', { name: '我的', exact: true }).click()
  await expect(page.locator('.recovery-center')).toContainText('本次没有执行删除')
  await expect(page.locator('.recovery-center')).toContainText('当前关联退款 1 条，合计 ¥10.00')
  await expect(page.locator('body')).not.toContainText(/refunds-v1:|expectedRefundSnapshot|refundSnapshot/)
  await page.getByRole('button', { name: '已核对，关闭提示', exact: true }).click()
  await expect(page.locator('.recovery-center')).toContainText('没有等待核对的提交')
  expect(f.record.deleted).toBe(false)
})

test('删除回复未知后核对与原请求重试仍携带原快照，不扩大关联删除范围', async ({ page }) => {
  const f = await fixture(page)
  f.state.abortFirst = true
  await page.getByRole('checkbox', { name: /同时删除关联退款/ }).check()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByText('还不能确定是否已保存，请先核对结果。')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  f.state.snapshot = { token: token('b'), count: 2, totalCents: 1500 }; f.record.refundedCents = 1500
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await expect(page.getByText('尚未查到结果。你可以稍后核对，或继续提交这同一条记录。')).toBeVisible()
  // Recovery deliberately waits three seconds before allowing the original operation to be retried.
  await page.waitForTimeout(3100)
  await page.getByRole('button', { name: '继续提交原记录', exact: true }).click()
  await expect(page.locator('.record-delete-confirm')).toContainText('这次删除没有执行')
  expect(f.bodies).toHaveLength(2)
  expect(f.bodies[1]).toEqual(f.bodies[0])
  expect(f.lookupIds).toEqual([f.bodies[0].clientOpId, f.bodies[0].clientOpId])
  expect(f.bodies[1].actions[0].expectedRefundSnapshot).toBe(token('a'))
  expect(f.record.deleted).toBe(false)
})
