import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { join } from 'node:path'

// Run against an isolated real backend and an explicitly supplied synthetic account.
// Use --workers=1 when both browser projects share this account.
const email = process.env.PLANPLAN_E2E_EMAIL
const password = process.env.PLANPLAN_E2E_PASSWORD
const secondEmail = process.env.PLANPLAN_E2E_SECOND_EMAIL
const secondPassword = process.env.PLANPLAN_E2E_SECOND_PASSWORD
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>
let authenticatedState: StorageState | null = null

test.describe('真实手动记录链路', () => {
  test.skip(!email || !password, '需要 PLANPLAN_E2E_EMAIL / PLANPLAN_E2E_PASSWORD 指定隔离测试账户')
  test.describe.configure({ mode: 'serial', timeout: 60_000 })

  async function login(page: Page) {
    if (!authenticatedState && process.env.PLANPLAN_E2E_STORAGE_STATE) {
      authenticatedState = JSON.parse(await readFile(process.env.PLANPLAN_E2E_STORAGE_STATE, 'utf8')) as StorageState
    }
    if (authenticatedState) {
      await page.context().addCookies(authenticatedState.cookies)
      await page.goto('/plans')
    } else {
      await page.goto('/login')
      await page.getByLabel('邮箱', { exact: true }).fill(email!)
      await page.getByLabel('密码', { exact: true }).fill(password!)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    await expect(page).toHaveURL('/plans')
    await expect(page.getByRole('button', { name: '新建计划', exact: true })).toBeVisible()
    await expect(page.getByText('正在读取计划…', { exact: true })).toHaveCount(0)
    await expect(page.locator('.plan-form-error')).toHaveCount(0)
    authenticatedState ??= await page.context().storageState()
  }

  async function operation(page: Page, click: () => Promise<void>) {
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
    await click()
    const response = await responsePromise
    expect(response.ok()).toBe(true)
    return { result: await response.json(), body: response.request().postDataJSON() }
  }

  async function session(page: Page) {
    const response = await page.request.get('/v1/auth/web/session')
    expect(response.ok()).toBe(true)
    return await response.json() as { userId: string; csrfToken: string }
  }

  async function ledgerData(page: Page, planId: string, userId: string) {
    const response = await page.request.get(`/v1/plans/${planId}/ledger`, { headers: { 'X-PlanPlan-Expected-User': userId } })
    expect(response.ok()).toBe(true)
    return await response.json() as { records: { id: string; version: number; note: string; amountCents: number; deleted: boolean }[]; stats: { netCents: number; expenseCount: number; refundCount: number } }
  }

  async function openLedger(page: Page) {
    await login(page)
    await page.locator('.plan-list-item.ledger').first().click()
    await expect(page.getByRole('region', { name: '计划统计' })).toBeVisible()
    return new URL(page.url()).pathname.split('/').at(-1)!
  }

  async function startExpense(page: Page, marker: string, amount: string) {
    await page.getByRole('button', { name: '记一笔', exact: true }).click()
    await page.getByLabel('支出金额（元）', { exact: true }).fill(amount)
    await page.getByLabel('备注（可留空）', { exact: true }).fill(marker)
  }

  async function deleteOwnRecord(page: Page, marker: string) {
    const row = page.locator('.record-row').filter({ hasText: marker })
    await row.click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    await expect(row).toHaveCount(0)
  }

  function zipEntry(zip: Buffer, name: string) {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(end).toBeGreaterThanOrEqual(0)
    let cursor = zip.readUInt32LE(end + 16)
    const count = zip.readUInt16LE(end + 10)
    for (let index = 0; index < count; index++) {
      expect(zip.readUInt32LE(cursor)).toBe(0x02014b50)
      const nameLength = zip.readUInt16LE(cursor + 28)
      const extraLength = zip.readUInt16LE(cursor + 30)
      const commentLength = zip.readUInt16LE(cursor + 32)
      if (zip.subarray(cursor + 46, cursor + 46 + nameLength).toString() === name) {
        const size = zip.readUInt32LE(cursor + 20)
        const local = zip.readUInt32LE(cursor + 42)
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
        const bytes = zip.subarray(start, start + size)
        const method = zip.readUInt16LE(cursor + 10)
        expect([0, 8]).toContain(method)
        return (method === 8 ? inflateRawSync(bytes) : bytes).toString('utf8')
      }
      cursor += 46 + nameLength + extraLength + commentLength
    }
    throw new Error(`导出文件缺少 ${name}`)
  }

  test('登录后支出20元→修改25元→刷新保留→删除，写入使用版本与固定标识', async ({ page, browserName }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await login(page)
    const ledger = page.locator('.plan-list-item.ledger').first()
    if (!(await ledger.count())) {
      await page.getByRole('button', { name: '新建计划', exact: true }).click()
      await page.getByLabel('月预算（元，可留空）').fill('3000')
      await operation(page, () => page.getByRole('button', { name: '创建计划', exact: true }).click())
    } else await ledger.click()
    await expect(page.getByRole('region', { name: '计划统计' })).toBeVisible()
    const marker = `网页回归-${browserName}-${Date.now()}`
    await page.getByRole('button', { name: '记一笔', exact: true }).click()
    await page.getByLabel('支出金额（元）', { exact: true }).fill('20')
    await page.getByLabel('备注（可留空）', { exact: true }).fill(marker)
    const added = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    expect(added.body.actions[0].amountCents).toBe(2000)
    expect(added.body.clientOpId).toEqual(expect.any(String))
    expect(added.body.inputAt).toEqual(expect.any(String))
    const addedRecord = added.result.items.find((item: { type: string }) => item.type === 'expense_added').record
    const row = page.locator('.record-row').filter({ hasText: marker })
    await expect(row).toContainText('¥20.00')
    await row.click()
    await expect(page).toHaveURL(new RegExp(`record=${addedRecord.id}`))
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('支出金额（元）', { exact: true }).fill('25')
    const edited = await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    expect(edited.body.actions[0].expectedVersion).toBe(addedRecord.version)
    expect(edited.body.actions[0].patch.amountCents).toBe(2500)
    await expect(row).toContainText('¥25.00')
    await page.reload()
    await expect(row).toContainText('¥25.00')
    if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, `ledger-${browserName}.png`), fullPage: true })
    await row.click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    const deleted = await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    const editedRecord = edited.result.items.find((item: { type: string }) => item.type === 'record_edited').record
    expect(deleted.body.actions[0].expectedVersion).toBe(editedRecord.version)
    await expect(row).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: '计划统计' })).toBeVisible()
    await expect(row).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('创建学习计划→记录20分钟→刷新统计→删除记录并归档本测试计划', async ({ page, browserName }) => {
    await login(page)
    const marker = `阅读-${browserName.slice(0, 1)}-${Date.now().toString().slice(-9)}`
    await page.getByRole('button', { name: '新建计划', exact: true }).click()
    await page.getByRole('button', { name: '学习计划', exact: true }).click()
    await page.getByLabel('计划名称', { exact: true }).fill(marker)
    await page.getByLabel('每周天数（可留空）').fill('5')
    await page.getByLabel('每日分钟（可留空）').fill('20')
    const created = await operation(page, () => page.getByRole('button', { name: '创建计划', exact: true }).click())
    const plan = created.result.items.find((item: { type: string }) => item.type === 'plan_created').plan
    await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible()
    await page.getByRole('button', { name: '记录学习', exact: true }).click()
    await page.getByLabel('学习时长（分钟）', { exact: true }).fill('20')
    await page.getByLabel('备注（可留空）', { exact: true }).fill(marker)
    const added = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    expect(added.body.actions[0].planId).toBe(plan.id)
    expect(added.body.actions[0].minutes).toBe(20)
    await expect(page.locator('.study-summary .summary-primary')).toContainText('20 分钟')
    await page.reload()
    await expect(page.locator('.study-summary .summary-primary')).toContainText('20 分钟')
    const initialViewport = page.viewportSize()!
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const label of await page.locator('.study-day small').all()) {
        expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
    }
    if (process.env.PLANPLAN_E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLANPLAN_E2E_SCREENSHOT_DIR, `study-mobile-${browserName}.png`), fullPage: true })
    await page.setViewportSize(initialViewport)
    const row = page.locator('.record-row').filter({ hasText: marker })
    await expect(row).toContainText('20 分钟')
    await row.click()
    await page.getByRole('button', { name: '删除记录', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    await expect(row).toHaveCount(0)
    await expect(page.locator('.study-summary .summary-primary')).toContainText('0 分钟')
    await page.getByRole('button', { name: '归档计划', exact: true }).click()
    await operation(page, () => page.getByRole('button', { name: '确认归档', exact: true }).click())
    await expect(page.getByRole('button', { name: '恢复计划', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '返回计划', exact: true }).click()
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await expect(page.locator('.plan-list-item').filter({ hasText: marker })).toBeVisible()
  })

  test('真实写入后丢失响应，刷新再按原ID核对，只保存一条', async ({ page, browserName }) => {
    const planId = await openLedger(page)
    const account = await session(page)
    const marker = `丢响应-${browserName}-${Date.now()}`
    let clientOpId = ''
    let writes = 0
    await page.route('**/v1/operations', async (route) => {
      const body = route.request().postDataJSON()
      if (body.actions?.[0]?.note === marker) {
        writes++
        clientOpId = body.clientOpId
        const actual = await route.fetch()
        expect(actual.ok()).toBe(true)
        // Commit on the real backend, then lose only the browser response.
        await route.abort('connectionfailed')
      } else await route.continue()
    })
    await startExpense(page, marker, '12.34')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '保存记录', exact: true })).toBeDisabled()
    expect(clientOpId).not.toBe('')
    await page.reload()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    const lookup = page.waitForRequest((request) => new URL(request.url()).pathname === `/v1/operations/${clientOpId}`)
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    expect((await lookup).headers()['x-planplan-expected-user']).toBe(account.userId)
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
    const row = page.locator('.record-row').filter({ hasText: marker })
    await expect(row).toHaveCount(1)
    expect((await ledgerData(page, planId, account.userId)).records.filter((record) => record.note === marker)).toHaveLength(1)
    expect(writes).toBe(1)
    await deleteOwnRecord(page, marker)
  })

  test('旧版本编辑被拒绝，保留草稿，核对新版本后才能保存', async ({ page, browserName }) => {
    const planId = await openLedger(page)
    const account = await session(page)
    const marker = `版本冲突-${browserName}-${Date.now()}`
    await startExpense(page, marker, '13.21')
    const added = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    const original = added.result.items.find((item: { type: string }) => item.type === 'expense_added').record
    await page.locator('.record-row').filter({ hasText: marker }).click()
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('支出金额（元）', { exact: true }).fill('16.21')
    const concurrent = await page.request.post('/v1/operations', {
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': account.csrfToken, 'X-PlanPlan-Expected-User': account.userId },
      data: { clientOpId: crypto.randomUUID(), inputAt: new Date().toISOString(), actions: [{ type: 'edit_record', recordId: original.id, expectedVersion: original.version, patch: { amountCents: 1521 } }] },
    })
    expect(concurrent.ok()).toBe(true)
    const rejectedPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    const rejected = await rejectedPromise
    expect(rejected.status()).toBe(409)
    expect(rejected.request().postDataJSON().actions[0].expectedVersion).toBe(original.version)
    await expect(page.getByText('记录已被修改。请查看最新内容，再决定如何调整。')).toBeVisible()
    await expect(page.getByLabel('支出金额（元）', { exact: true })).toHaveValue('16.21')
    const current = (await ledgerData(page, planId, account.userId)).records.find((record) => record.id === original.id)!
    expect(current.amountCents).toBe(1521)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '刷新记录', exact: true }).click()
    await expect(page.locator('.record-facts')).toContainText('¥15.21')
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await expect(page.getByLabel('支出金额（元）', { exact: true })).toHaveValue('15.21')
    await page.getByLabel('支出金额（元）', { exact: true }).fill('16.21')
    const saved = await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    expect(saved.body.actions[0].expectedVersion).toBe(current.version)
    await expect(page.locator('.record-row').filter({ hasText: marker })).toContainText('¥16.21')
    await deleteOwnRecord(page, marker)
  })

  test('退款关联原支出，可修改金额并逐条删除，只清理本测试数据', async ({ page, browserName }) => {
    await openLedger(page)
    const suffix = `${browserName}-${Date.now()}`
    const expenseMarker = `退款原支出-${suffix}`
    const refundMarker = `退款记录-${suffix}`
    await startExpense(page, expenseMarker, '50.32')
    const added = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    const expense = added.result.items.find((item: { type: string }) => item.type === 'expense_added').record
    await page.locator('.record-row').filter({ hasText: expenseMarker }).click()
    await page.getByRole('button', { name: '记录退款', exact: true }).click()
    await page.getByLabel('退款金额（元）', { exact: true }).fill('10')
    await page.getByLabel('备注（可留空）', { exact: true }).fill(refundMarker)
    const refunded = await operation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    const refund = refunded.result.items.find((item: { type: string }) => item.type === 'refund_added').record
    expect(refund.refundOf).toBe(expense.id)
    expect(refunded.body.actions[0].expenseId).toBe(expense.id)
    await expect(page.locator('.record-row').filter({ hasText: expenseMarker })).toContainText('已退 ¥10.00')
    const refundRow = page.locator('.record-row').filter({ hasText: refundMarker })
    await expect(refundRow).toContainText('+¥10.00')
    await refundRow.click()
    await page.getByRole('link', { name: '查看关联的原支出', exact: true }).click()
    await expect(page.locator('.record-facts')).toContainText(expenseMarker)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await refundRow.click()
    await page.getByRole('button', { name: '修改记录', exact: true }).click()
    await page.getByLabel('退款金额（元）', { exact: true }).fill('12.34')
    const edited = await operation(page, () => page.getByRole('button', { name: '保存修改', exact: true }).click())
    expect(edited.body.actions[0].expectedVersion).toBe(refund.version)
    expect(edited.body.actions[0].patch.amountCents).toBe(1234)
    await expect(refundRow).toContainText('+¥12.34')
    await expect(page.locator('.record-row').filter({ hasText: expenseMarker })).toContainText('已退 ¥12.34')
    await deleteOwnRecord(page, refundMarker)
    await expect(page.locator('.record-row').filter({ hasText: expenseMarker })).not.toContainText('已退')
    await deleteOwnRecord(page, expenseMarker)
  })

  test('同源Cookie切换账户后，旧队列查询和写入均拒绝，B不增加A记录', async ({ page, browserName }) => {
    test.skip(!secondEmail || !secondPassword, '需要第二个隔离账户检查跨账户隔离')
    const planId = await openLedger(page)
    const accountA = await session(page)
    const marker = `账户隔离-${browserName}-${Date.now()}`
    let originalBody: Record<string, unknown> | null = null
    let originalHeaders: Record<string, string> = {}
    await page.route('**/v1/operations', async (route) => {
      const body = route.request().postDataJSON()
      if (body.actions?.[0]?.note === marker) {
        originalBody = body
        originalHeaders = route.request().headers()
        await route.abort('connectionfailed')
      } else await route.continue()
    })
    await startExpense(page, marker, '9.87')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
    expect(originalHeaders['x-planplan-expected-user']).toBe(accountA.userId)
    expect(originalBody).not.toBeNull()
    const loginB = await page.request.post('/v1/auth/web/email/login', { headers: { Origin: new URL(page.url()).origin }, data: { email: secondEmail, password: secondPassword } })
    expect(loginB.ok()).toBe(true)
    const accountB = await session(page)
    expect(accountB.userId).not.toBe(accountA.userId)
    const plansB = await page.request.get('/v1/plans', { headers: { 'X-PlanPlan-Expected-User': accountB.userId } })
    const bPlanId = (await plansB.json()).plans.find((card: { plan: { kind: string } }) => card.plan.kind === 'ledger').plan.id as string
    const beforeB = await ledgerData(page, bPlanId, accountB.userId)
    const rejectedWrite = await page.request.post('/v1/operations', { headers: { Origin: new URL(page.url()).origin, 'X-PlanPlan-Expected-User': accountA.userId, 'X-CSRF-Token': originalHeaders['x-csrf-token']! }, data: originalBody })
    expect(rejectedWrite.status()).toBe(409)
    expect((await rejectedWrite.json()).error.code).toBe('account_mismatch')
    const rejectedLookup = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/v1/operations/') && response.request().method() === 'GET')
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    const lookup = await rejectedLookup
    expect(lookup.request().headers()['x-planplan-expected-user']).toBe(accountA.userId)
    expect(lookup.status()).toBe(409)
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0)
    const afterB = await ledgerData(page, bPlanId, accountB.userId)
    expect(afterB.stats).toEqual(beforeB.stats)
    expect(afterB.records.some((record) => record.note === marker)).toBe(false)
    const crossRead = await page.request.get(`/v1/plans/${planId}/ledger`, { headers: { 'X-PlanPlan-Expected-User': accountB.userId } })
    expect(crossRead.status()).toBe(404)
  })

  test('我的页面真实导出ZIP，可读取计划和两类记录文件', async ({ page }) => {
    const planId = await openLedger(page)
    const account = await session(page)
    await page.goto('/me')
    const downloadPromise = page.waitForEvent('download')
    const exportRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/v1/export')
    await page.getByRole('button', { name: '导出数据', exact: true }).click()
    const download = await downloadPromise
    expect((await exportRequest).headers()['x-planplan-expected-user']).toBe(account.userId)
    expect(download.suggestedFilename()).toMatch(/^planplan-\d{4}-\d{2}-\d{2}\.zip$/)
    const path = await download.path()
    expect(path).not.toBeNull()
    const zip = await readFile(path!)
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const plans = JSON.parse(zipEntry(zip, 'plans.json'))
    expect(plans.timezone).toBe('Asia/Shanghai')
    expect(plans.plans.some((plan: { id: string }) => plan.id === planId)).toBe(true)
    expect(zipEntry(zip, 'expenses_refunds.csv')).toContain('amount_cny')
    expect(zipEntry(zip, 'study.csv')).toContain('minutes')
    await download.delete()
  })
})
