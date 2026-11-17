import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const output = process.env.PLANPLAN_E2E_SCREENSHOT_DIR
const enabled = process.env.PLANPLAN_PLATFORM_PASSWORD
async function mutation(page: Page, action: () => Promise<void>) { const wait = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/operations' && response.request().method() === 'POST'); await action(); const r = await wait; expect(r.ok(), await r.text()).toBe(true); return r.json() }
async function read(page: Page, path: string) { const session = await (await page.request.get('/v1/auth/web/session')).json(); const r = await page.request.get(path, { headers: { 'X-PlanPlan-Expected-User': session.userId, 'X-PlanPlan-Capabilities': 'reading-template-v1,ledger-template-v1,generic-record-v1,generic-template-v2,private-template-v1,community-template-v1' } }); expect(r.ok(), await r.text()).toBe(true); return r.json() }
test.describe('基础管理真实补齐', () => {
  test.skip(!enabled || !output, '需要平台专用合成账户')
  test.setTimeout(120000)
  test.beforeEach(async ({ page }, info) => { const state = JSON.parse(await readFile(join(output!, `${info.project.name}-author-session.json`), 'utf8')); await page.context().addCookies(state.cookies); await page.goto('/plans'); await expect(page.getByRole('button', { name: '新建计划', exact: true })).toBeVisible() })
  test('P02真实：计划改名不覆盖预算，跨月退款的分类三金额与负值趋势正确', async ({ page }, info) => {
    const plans = await read(page, '/v1/plans'), ledger = plans.plans.find((item: { plan: { kind: string } }) => item.plan.kind === 'ledger').plan
    await page.goto(`/plans/${ledger.id}`)
    const before = await read(page, `/v1/plans/${ledger.id}/template`)
    await page.getByRole('button', { name: '修改计划名称', exact: true }).click(); await page.getByLabel('计划名称', { exact: true }).fill('日常计划验收'); const renamed = await mutation(page, () => page.getByRole('button', { name: '保存预算', exact: true }).click()); expect(renamed.templatePlan.config.budgetCents).toBe(before.config.budgetCents)
    const me = await read(page, '/v1/me'); const previous = new Date(`${me.today.slice(0, 7)}-01T12:00:00Z`); previous.setUTCDate(0)
    await page.getByRole('button', { name: '记一笔', exact: true }).click(); await page.getByLabel('支出金额（元）', { exact: true }).fill('20'); await page.getByLabel('日期', { exact: true }).fill(previous.toISOString().slice(0, 10)); await page.getByLabel('备注（可留空）', { exact: true }).fill('合成跨月退款验证'); const added = await mutation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click()); const record = added.items[0].record
    await page.goto(`/plans/${ledger.id}?record=${record.id}`); await page.getByRole('button', { name: '记录退款', exact: true }).click(); await page.getByLabel('退款金额（元）', { exact: true }).fill('5'); await page.getByLabel('日期', { exact: true }).fill(me.today); await mutation(page, () => page.getByRole('button', { name: '保存记录', exact: true }).click())
    const category = page.getByRole('region', { name: '分类支出与退款', exact: true }); await expect(category).toContainText('¥5.00'); await expect(category).toContainText('−¥5.00'); await expect(page.locator('.trend-point.negative')).toHaveCount(1); expect(await page.locator('.trend-zero').evaluate(line => getComputedStyle(line).stroke)).not.toBe('none')
    await page.screenshot({ path: join(output!, `${info.project.name}-platform-negative-live.png`), fullPage: true })
    await page.goto(`/plans/${ledger.id}?record=${record.id}`); await page.getByRole('button', { name: '删除记录', exact: true }).click(); await page.getByLabel(/同时删除关联退款/).check(); await mutation(page, () => page.getByRole('button', { name: '确认删除', exact: true }).click())
    await writeFile(join(output!, `${info.project.name}-platform-management.json`), JSON.stringify({ ledgerPlanId: ledger.id, deletedTestExpenseId: record.id }, null, 2))
  })
  test('P02真实：旧学习计划可手动改名并设置下周目标，不产生学习事实', async ({ page }, info) => {
    await page.getByRole('button', { name: '新建计划', exact: true }).click(); await page.getByRole('button', { name: '学习计划', exact: true }).click(); await page.getByLabel('计划名称', { exact: true }).fill(`学习目标${info.project.name}`); await page.getByLabel('每周天数（可留空）', { exact: true }).fill('3'); await page.getByLabel('每日分钟（可留空）', { exact: true }).fill('20'); const created = await mutation(page, () => page.getByRole('button', { name: '创建计划', exact: true }).click()); const planId = created.items[0].plan.id
    await page.getByRole('button', { name: '调整设置', exact: true }).click(); await expect(page.getByLabel('当前书籍（可留空）')).toHaveCount(0); await page.getByLabel('计划名称', { exact: true }).fill(`英语计划${info.project.name}`); await page.getByLabel('每周目标天数（可留空）').fill('5'); await page.getByLabel('每日目标分钟（可留空）').fill('30'); await page.getByRole('combobox', { name: '目标生效范围', exact: true }).selectOption('next_and_future'); const configured = await mutation(page, () => page.getByRole('button', { name: '保存设置', exact: true }).click()); expect(configured.templatePlan.config.daysPerWeek).toBe(3); expect(configured.templatePlan.config.nextWeekGoals.daysPerWeek).toBe(5); expect((await read(page, `/v1/plans/${planId}/study`)).records).toHaveLength(0)
    await page.setViewportSize({ width: 375, height: 812 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: join(output!, `${info.project.name}-platform-legacy-study-live.png`), fullPage: true })
    await page.getByRole('button', { name: '归档计划', exact: true }).click(); await mutation(page, () => page.getByRole('button', { name: '确认归档', exact: true }).click())
  })
})
