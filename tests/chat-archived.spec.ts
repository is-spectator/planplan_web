import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { PlanView } from '../src/lib/contracts'
import type { ChatInput, MessageView } from '../src/features/chat/types'

// Protocol fixtures exercise archived-scope navigation without invoking a model.
test('归档计划可以对话查历史，且不会混入进行中列表', async ({ page }) => {
  const userId = randomUUID(), planId = randomUUID()
  const plan: PlanView = { id: planId, kind: 'study', name: '归档阅读验收', activity: '阅读', status: 'archived', startDate: '2026-11-01', hidden: [], order: [], lastActivityAt: new Date().toISOString() }
  const history: MessageView[] = []
  const posts: (ChatInput & { clientMsgId: string })[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/v1/**', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.pathname === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'archived-scope-fixture' } })
    if (url.pathname === '/v1/me') return route.fulfill({ json: { id: userId, aiConsent: true, dataVersion: 1, today: '2026-11-16', timezone: 'Asia/Shanghai', signInMethod: 'email' } })
    if (url.pathname === '/v1/plans') return route.fulfill({ json: { plans: url.searchParams.get('status') === 'archived' ? [{ plan }] : [], dataVersion: 1 } })
    if (url.pathname === '/v1/messages') {
      if (url.searchParams.has('scopePlanId')) expect(url.searchParams.get('scopePlanId')).toBe(planId)
      return route.fulfill({ json: { messages: history } })
    }
    if (url.pathname === '/v1/chat' && req.method() === 'POST') {
      const body = req.postDataJSON() as ChatInput & { clientMsgId: string }
      posts.push(body)
      expect(body.scopePlanId).toBe(planId)
      expect(req.headers()['x-planplan-expected-user']).toBe(userId)
      const user: MessageView = { id: randomUUID(), role: 'user', text: body.text, cards: [], scopePlanId: planId, clientMsgId: body.clientMsgId, createdAt: new Date().toISOString() }
      const assistant: MessageView = { id: randomUUID(), role: 'assistant', text: '归档计划的历史记录仍然保留。', cards: [{ type: 'query', kind: 'study_range', plan, from: '2026-11-01', to: '2026-11-16', label: '历史阅读', totalMinutes: 75, recordDays: 3 }], scopePlanId: planId, clientMsgId: null, createdAt: new Date().toISOString() }
      history.push(user, assistant)
      return route.fulfill({ json: { user, assistant, dataVersion: 1, transient: false } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '没有此内容。' } } })
  })
  await page.goto(`/chat?plan=${planId}`)
  await expect(page).toHaveTitle('对话 · PlanPlan')
  await expect(page.locator('.chat-scope')).toContainText(plan.name)
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveAttribute('placeholder', '告诉我实际完成的时长，或问问这个计划的进度')
  await expect(page.getByText('这个计划已归档，仍可查询历史。继续记录前，会先请你确认是否恢复计划。', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('这个计划一共读了多久？')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('归档计划的历史记录仍然保留。', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-card-number')).toContainText('75')
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('')
  expect(posts).toHaveLength(1)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '计划', exact: true }).click()
  await expect(page.getByRole('heading', { name: '给想做的事，一个位置', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(plan.name) })).toHaveCount(0)
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(page.getByRole('link', { name: new RegExp(plan.name) })).toBeVisible()
  expect(errors).toEqual([])
})

test('归档范围读取失败可以重试，未知计划不允许发送', async ({ page }) => {
  const userId = randomUUID(), planId = randomUUID()
  let unavailable = true
  let chatPosts = 0
  let finishConnecting!: () => void
  const connecting = new Promise<void>(resolve => { finishConnecting = resolve })
  await page.route('**/v1/**', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.pathname === '/v1/auth/web/session') { await connecting; return route.fulfill({ json: { userId, csrfToken: 'archived-retry-fixture' } }) }
    if (url.pathname === '/v1/me') return route.fulfill({ json: { id: userId, aiConsent: true, dataVersion: 1, today: '2026-11-16', timezone: 'Asia/Shanghai', signInMethod: 'email' } })
    if (url.pathname === '/v1/messages') return route.fulfill({ json: { messages: [] } })
    if (url.pathname === '/v1/plans') {
      if (url.searchParams.get('status') === 'archived' && unavailable) return route.fulfill({ status: 503, json: { error: { code: 'temporarily_unavailable', message: '暂时无法连接。' } } })
      return route.fulfill({ json: { plans: [], dataVersion: 1 } })
    }
    if (url.pathname === '/v1/chat' && req.method() === 'POST') chatPosts++
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '没有此内容。' } } })
  })
  await page.goto(`/chat?plan=${planId}`)
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled()
  finishConnecting()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('查看历史记录')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '重新读取计划', exact: true })).toBeVisible({ timeout: 15000 })
  unavailable = false
  await page.getByRole('button', { name: '重新读取计划', exact: true }).click()
  await expect(page.getByText('当前计划不可用，请返回计划列表选择。', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('查看历史记录')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  expect(chatPosts).toBe(0)
})
