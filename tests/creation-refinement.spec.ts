import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { TemplateDefinition } from '../src/lib/contracts'
import type { CreationDraft } from '../src/features/creation/types'

const today = '2026-11-16'
function definition(): TemplateDefinition {
  return { schemaVersion: 1, id: `private.${randomUUID()}`, version: 1, source: 'private', engine: 'generic', requiredCapabilities: ['generic-record-v1', 'private-template-v1', 'generic-template-v2'], name: '阅读试填', description: '记录阅读时间，按周和月查看积累。', configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'target', label: '每周目标', type: 'duration', unit: 'minute', required: false, min: 1 }], recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'minutes', label: '阅读时间', type: 'duration', unit: 'minute', required: true, min: 1 }, { id: 'category', label: '类型', type: 'single_select', required: false, options: ['纸质书', '电子书'] }, { id: 'finished', label: '读完', type: 'boolean', required: false }], configurationDefaults: { target: 100 }, recordDefaults: { minutes: 30, category: '纸质书', finished: false }, metrics: [{ id: 'total', label: '累计阅读', operation: 'sum', fieldId: 'minutes', period: 'week', groupByFieldId: 'category' }, { id: 'goal', label: '每周进度', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'target', period: 'week' }, { id: 'mean', label: '每次平均', operation: 'mean', fieldId: 'minutes', period: 'month' }], components: ['summary', 'goal', 'categories', 'records'], example: { config: { name: '阅读试填', startDate: today, target: 20 }, record: { date: today, minutes: 10, category: '电子书', finished: true } } }
}

async function fixture(page: Page) {
  const userId = randomUUID(), now = new Date().toISOString()
  const draft: CreationDraft = { id: randomUUID(), version: 1, name: '阅读试填', definition: definition(), messages: [], changeSummary: [], canUndo: false, savedTemplate: null, sourcePlanId: null, sourcePlanVersion: null, createdAt: now, updatedAt: now }
  const updates: TemplateDefinition[] = [], writes: string[] = []
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') writes.push(path)
    if (path === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'controlled-creation-fixture' } })
    if (path === '/v1/me') return route.fulfill({ json: { id: userId, today, timezone: 'Asia/Shanghai', aiConsent: false, dataVersion: draft.version, signInMethod: 'email' } })
    if (path === `/v1/creation/drafts/${draft.id}`) return route.fulfill({ json: draft })
    if (path === '/v1/creation/requests') {
      const input = route.request().postDataJSON()
      expect(input.action).toBe('update')
      updates.push(input.definition)
      draft.definition = { ...draft.definition!, ...input.definition }; draft.version++
      return route.fulfill({ json: { clientOpId: input.clientOpId, kind: 'update', transient: false, draft } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture route missing' } } })
  })
  return { draft, updates, writes }
}

test('创作修复：一字必填项目与缩短名称生成合法示例，空文字变必填可保存', async ({ page }) => {
  const f = await fixture(page)
  f.draft.definition!.recordFields.push({ id: 'note', label: '说明', type: 'text', required: false, maxLength: 10 })
  f.draft.definition!.example.record.note = '  '
  await page.goto(`/create/${f.draft.id}`)
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  const fields = page.locator('.definition-field')
  const name = fields.filter({ has: page.locator('legend').filter({ hasText: /^计划名称$/ }) })
  await name.getByLabel('最多字数', { exact: true }).fill('1')
  const note = fields.filter({ has: page.locator('legend').filter({ hasText: /^说明$/ }) })
  await note.getByLabel('必须填写', { exact: true }).check()
  await note.getByLabel('最多字数', { exact: true }).fill('1')
  const records = page.locator('.definition-section').filter({ has: page.getByRole('heading', { name: '每次记录的内容', exact: true }) })
  await records.getByRole('button', { name: '添加项目', exact: true }).click()
  const added = records.locator('.definition-field').last()
  await added.getByLabel('项目名称', { exact: true }).fill('等级')
  await added.getByLabel('必须填写', { exact: true }).check()
  await added.getByLabel('最多字数', { exact: true }).fill('1')
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click()
  await expect.poll(() => f.updates.length).toBe(1)
  const value = f.updates[0]!
  for (const [group, example] of [[value.configurationFields, value.example.config], [value.recordFields, value.example.record]] as const) {
    for (const field of group.filter(item => item.type === 'text')) {
      const sample = example[field.id]
      if (field.required) expect(typeof sample === 'string' && sample.trim().length > 0).toBe(true)
      if (typeof sample === 'string') expect(sample.length).toBeLessThanOrEqual(field.maxLength ?? 200)
    }
  }
})

test('创作修复：试填建议明确载入，清空和修改不补写，切日重置新增建议', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/create/${f.draft.id}`)
  await expect(page.locator('.creation-description')).not.toContainText('每日汇总')
  await expect(page.locator('.creation-description')).toContainText('每周')
  await expect(page.locator('.creation-description')).toContainText('每月')
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByText('调整试填设置', { exact: true }).click()
  await expect(page.getByLabel('试填设置：每周目标（分钟）（可留空）', { exact: true })).toHaveValue('20')
  await page.getByRole('button', { name: '载入首次设置建议', exact: true }).click()
  await expect(page.getByLabel('试填设置：每周目标（分钟）（可留空）', { exact: true })).toHaveValue('100')
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('')
  await page.getByLabel('试填时沿用常用记录建议', { exact: true }).check()
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('30')
  await expect(page.getByLabel('试填：读完（可留空）', { exact: true })).toHaveValue('false')
  await page.getByLabel('试填：类型（可留空）', { exact: true }).selectOption('')
  await page.getByRole('button', { name: '加入试填', exact: true }).click()
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('已完成 30%')
  await expect(page.getByRole('region', { name: '先试着记一次', exact: true }).getByRole('region', { name: '累计阅读分类', exact: true })).toContainText('未填写')
  await page.getByRole('button', { name: '修改试填 1', exact: true }).click()
  await expect(page.getByLabel('试填：类型（可留空）', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('试填时沿用常用记录建议', { exact: true })).toBeDisabled()
  await page.getByLabel('试填：阅读时间（分钟）', { exact: true }).fill('40')
  await page.getByRole('button', { name: '保存试填修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '目标进度', exact: true })).toContainText('已完成 40%')
  await page.getByLabel('查看试填日期', { exact: true }).fill('2026-11-15')
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('30')
  await expect(page.getByLabel('试填：类型（可留空）', { exact: true })).toHaveValue('纸质书')
  await page.getByRole('button', { name: '清空试填', exact: true }).click()
  await expect(page.getByLabel('试填时沿用常用记录建议', { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('')
  expect(f.writes).toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('创作修复：试填启停建议保留手填内容，清空旧记录后修改不重新沿用', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/create/${f.draft.id}`)
  await page.getByText('试填体验', { exact: true }).click()
  await page.getByLabel('试填：阅读时间（分钟）', { exact: true }).fill('45')
  await page.getByLabel('试填：类型（可留空）', { exact: true }).selectOption('电子书')
  await page.getByLabel('试填时沿用常用记录建议', { exact: true }).check()
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('45')
  await expect(page.getByLabel('试填：类型（可留空）', { exact: true })).toHaveValue('电子书')
  await expect(page.getByLabel('试填：读完（可留空）', { exact: true })).toHaveValue('false')
  await page.getByLabel('试填时沿用常用记录建议', { exact: true }).uncheck()
  await expect(page.getByLabel('试填：阅读时间（分钟）', { exact: true })).toHaveValue('45')
  await expect(page.getByLabel('试填：读完（可留空）', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '加入试填', exact: true }).click()
  await page.getByLabel('试填时沿用常用记录建议', { exact: true }).check()
  await page.getByRole('button', { name: '修改试填 1', exact: true }).click()
  await expect(page.getByLabel('试填：读完（可留空）', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '保存试填修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '试填记录列表', exact: true })).not.toContainText('沿用设置')
  await page.getByRole('button', { name: '删除试填 1', exact: true }).click()
  await expect(page.getByRole('region', { name: '先试着记一次', exact: true }).getByRole('region', { name: '记录统计', exact: true })).toContainText('0 分钟')
  expect(f.writes).toEqual([])
})
