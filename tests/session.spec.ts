import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

// Protocol fixtures exercise browser races without a model or a real account.
async function accountFixture(page: Page) {
  const userId = randomUUID()
  const me = { id: userId, aiConsent: true, dataVersion: 1, today: '2026-11-16', timezone: 'Asia/Shanghai', signInMethod: 'email' }
  const state = { authenticated: true, delayNextMe: false, cleanupStatus: 'completed', logoutRequests: 0, deleteRequests: 0, releaseMe: null as (() => Promise<void>) | null }
  await page.route('**/legal/metadata', route => route.fulfill({ json: { consentVersion: 'fixture', aiRecipient: '测试服务', aiService: '协议测试', aiProcessingDisclosure: '', modelUsageDisclosure: '' } }))
  await page.route('**/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/auth/web/session') return state.authenticated
      ? route.fulfill({ json: { userId, csrfToken: 'session-fixture-csrf' } })
      : route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: '请先登录。' } } })
    if (path === '/v1/me' && request.method() === 'GET') {
      if (state.delayNextMe) {
        state.delayNextMe = false
        state.releaseMe = () => route.fulfill({ json: me })
        return
      }
      return route.fulfill({ json: me })
    }
    if (path === '/v1/feedback') return route.fulfill({ json: { tickets: [], total: 0 } })
    if (path === '/v1/logout') {
      state.logoutRequests++
      state.authenticated = false
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/v1/me' && request.method() === 'DELETE') {
      state.deleteRequests++
      state.authenticated = false
      return route.fulfill({ json: { cleanupStatus: state.cleanupStatus } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '此测试没有设置该接口。' } } })
  })
  await page.goto('/me')
  await expect(page).toHaveTitle('我的 · PlanPlan')
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
  return { userId, state }
}

async function holdSessionLock(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    void navigator.locks.request('planplan-browser-session', () => new Promise<void>(release => {
      (window as Window & { releaseSessionTestLock?: () => void }).releaseSessionTestLock = release
      resolve()
    }))
  }))
}

async function storePending(page: Page, userId: string, id: string) {
  await page.evaluate(async ({ userId, id }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('planplan-recovery', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'userId' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pending', 'readwrite')
        tx.objectStore('pending').put({ userId, id, kind: 'operation', path: '/v1/operations', lookup: `/v1/operations/${id}`, body: { clientOpId: id }, createdAt: Date.now(), status: 'unknown' })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally { db.close() }
  }, { userId, id })
}

async function readPendingId(page: Page, userId: string) {
  return page.evaluate(async userId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('planplan-recovery', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const request = db.transaction('pending').objectStore('pending').get(userId)
        request.onsuccess = () => resolve(request.result?.id ?? null)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, userId)
}

test('退出后返回的旧账户响应不能恢复登录状态', async ({ page }) => {
  const { state } = await accountFixture(page)
  state.delayNextMe = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => !!state.releaseMe).toBe(true)
  await page.getByRole('button', { name: '退出所有设备', exact: true }).click()
  await page.getByRole('button', { name: '确认退出所有设备', exact: true }).click()
  await expect(page.getByRole('link', { name: '登录或注册', exact: true })).toBeVisible()
  expect(state.logoutRequests).toBe(1)
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/me')
  await state.releaseMe!()
  await (await staleResponse).finished()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByRole('link', { name: '登录或注册', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toHaveCount(0)
})

for (const action of ['logout', 'delete'] as const) {
  test(`等待会话锁时出现待核对记录，${action === 'logout' ? '退出' : '删除账户'}不会发出请求`, async ({ page }) => {
    const { userId, state } = await accountFixture(page)
    await holdSessionLock(page)
    await page.getByRole('button', { name: action === 'logout' ? '退出所有设备' : '删除账户', exact: true }).click()
    if (action === 'delete') {
      await page.getByLabel('输入 DELETE 确认', { exact: true }).fill('DELETE')
      await page.getByLabel('账户密码', { exact: true }).fill('fixture-password')
    }
    await page.getByRole('button', { name: action === 'logout' ? '确认退出所有设备' : '确认删除账户', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'planplan-browser-session').length ?? 0)).toBe(1)
    const requestId = randomUUID()
    await storePending(page, userId, requestId)
    await page.evaluate(() => (window as Window & { releaseSessionTestLock?: () => void }).releaseSessionTestLock?.())
    await expect(page.getByRole('status').filter({ hasText: action === 'logout' ? '还有一条记录需要核对，请处理后再退出。' : '还有一条记录需要核对，请处理后再删除账户。' })).toBeVisible()
    expect(state.logoutRequests).toBe(0)
    expect(state.deleteRequests).toBe(0)
    expect(await readPendingId(page, userId)).toBe(requestId)
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
  })
}

for (const status of ['completed', 'pending'] as const) {
  test(`删除账户 ${status} 的结果在退出登录后仍然可见`, async ({ page }) => {
    const { state } = await accountFixture(page)
    state.cleanupStatus = status
    await page.getByRole('button', { name: '删除账户', exact: true }).click()
    await page.getByLabel('输入 DELETE 确认', { exact: true }).fill('DELETE')
    await page.getByLabel('账户密码', { exact: true }).fill('fixture-password')
    await page.getByRole('button', { name: '确认删除账户', exact: true }).click()
    await expect(page.getByRole('link', { name: '登录或注册', exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: status === 'completed' ? '账户已删除。' : '账户已停用，剩余数据正在清理。' })).toBeVisible()
    expect(state.deleteRequests).toBe(1)
  })
}
