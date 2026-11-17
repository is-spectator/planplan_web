import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError, withSessionLock, type RequestOptions } from '../lib/api'
import { readPending } from '../lib/recovery-store'

export interface Me { id: string; aiConsent: boolean; dataVersion: number; today: string; timezone: string; signInMethod: string; roles?: string[] }
interface CookieSession { userId: string; csrfToken: string }
interface SessionContextValue {
  user: Me | null
  loading: boolean
  error: string | null
  offline: boolean
  stale: boolean
  lastSyncedAt: number | null
  accountNotice: string | null
  refresh: () => Promise<void>
  request: <T>(path: string, options?: RequestOptions) => Promise<T>
  authenticate: (mode: 'login' | 'register', body: Record<string, string>) => Promise<void>
  logout: () => Promise<void>
  deleteAccount: (confirm: string, password: string) => Promise<{ cleanupStatus: string }>
}
const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const cache = useQueryClient()
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accountNotice, setAccountNotice] = useState<string | null>(null)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const version = useRef<Me | null>(null)
  const failures = useRef(0)
  const nextPollAt = useRef(0)
  const polling = useRef(false)
  const snapshot = useRef<CookieSession | null>(null)
  const epoch = useRef(0)
  const refreshCounter = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)

  const clear = useCallback((invalidateRefresh = true) => {
    if (invalidateRefresh) ++refreshCounter.current
    epoch.current++
    snapshot.current = null
    version.current = null
    setLastSyncedAt(null)
    setUser(null)
    void cache.cancelQueries({ queryKey: ['user'] })
    cache.removeQueries({ queryKey: ['user'] })
  }, [cache])

  const refresh = useCallback(async () => {
    const sequence = ++refreshCounter.current
    try {
      const session = await api<CookieSession>('/v1/auth/web/session')
      const me = await api<Me>('/v1/me', { headers: { 'X-PlanPlan-Expected-User': session.userId } })
      if (sequence !== refreshCounter.current) return
      if (me.id !== session.userId) throw new ApiError('account_mismatch', '账户已切换，请重新登录。', 409)
      if (snapshot.current?.userId !== session.userId) clear(false)
      const previous = version.current
      snapshot.current = session
      version.current = me
      if (previous?.id === me.id && (previous.dataVersion !== me.dataVersion || previous.today !== me.today)) {
        void cache.invalidateQueries({ queryKey: ['user', me.id] })
      } else {
        // Messages may change without a business-data version increment.
        void cache.invalidateQueries({ queryKey: ['user', me.id, 'messages'] })
      }
      failures.current = 0
      nextPollAt.current = Date.now() + 15_000
      setOffline(false)
      setLastSyncedAt(Date.now())
      setUser(me)
      setError(null)
    } catch (reason) {
      if (sequence !== refreshCounter.current) return
      if (reason instanceof ApiError && (reason.status === 401 || reason.code === 'account_mismatch')) {
        clear(false)
        setError(null)
      } else {
        failures.current++
        nextPollAt.current = Date.now() + Math.min(120_000, 15_000 * 2 ** Math.min(failures.current, 3))
        setOffline(!navigator.onLine)
        setError(reason instanceof Error ? reason.message : '暂时无法连接，请稍后重试。')
      }
    } finally { if (sequence === refreshCounter.current) setLoading(false) }
  }, [clear, cache])

  useEffect(() => {
    // The initial asynchronous request reconciles an external HttpOnly session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const requests = refreshCounter
    const listener = () => {
      setOffline(!navigator.onLine)
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const disconnected = () => setOffline(true)
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || polling.current || Date.now() < nextPollAt.current) return
      polling.current = true
      void refresh().finally(() => { polling.current = false })
    }, 1000)
    const notify = () => { clear(); void refresh() }
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('planplan-session')
      channel.current.addEventListener('message', notify)
    }
    window.addEventListener('focus', listener)
    window.addEventListener('online', listener)
    window.addEventListener('offline', disconnected)
    document.addEventListener('visibilitychange', listener)
    return () => {
      ++requests.current
      channel.current?.close()
      channel.current = null
      window.removeEventListener('focus', listener)
      window.removeEventListener('online', listener)
      window.removeEventListener('offline', disconnected)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', listener)
    }
  }, [clear, refresh])

  const request = useCallback(async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
    const current = snapshot.current
    const atStart = epoch.current
    if (!current) throw new ApiError('unauthorized', '请先登录。', 401)
    try {
      const result = await api<T>(path, { ...options, headers: { ...options.headers, 'X-PlanPlan-Capabilities': 'reading-template-v1,ledger-template-v1,generic-record-v1,private-template-v1,generic-template-v2,community-template-v1,chat-recovery-v1', 'X-PlanPlan-Expected-User': current.userId, 'X-CSRF-Token': current.csrfToken } })
      if (atStart !== epoch.current || current.userId !== snapshot.current?.userId) throw new ApiError('account_mismatch', '账户已切换，请重新核对。', 409)
      return result
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.code === 'account_mismatch')) { clear(); void refresh() }
      throw reason
    }
  }, [clear, refresh])

  const authenticate = useCallback(async (mode: 'login' | 'register', body: Record<string, string>) => {
    await withSessionLock(async () => {
      await api(`/v1/auth/web/email/${mode}`, { method: 'POST', body })
      setAccountNotice(null)
      clear()
      await refresh()
      channel.current?.postMessage('changed')
    })
  }, [clear, refresh])

  const logout = useCallback(async () => {
    const accountId = snapshot.current?.userId
    await withSessionLock(async () => {
      if (!accountId || snapshot.current?.userId !== accountId) throw new ApiError('account_mismatch', '账户已切换，请重新核对。', 409)
      if (await readPending(accountId)) throw new ApiError('pending_request', '还有一条记录需要核对，请处理后再退出。')
      await request('/v1/logout', { method: 'POST' })
      clear()
      channel.current?.postMessage('changed')
    })
  }, [clear, request])

  const deleteAccount = useCallback(async (confirm: string, password: string) => {
    const accountId = snapshot.current?.userId
    return withSessionLock(async () => {
      if (!accountId || snapshot.current?.userId !== accountId) throw new ApiError('account_mismatch', '账户已切换，请重新核对。', 409)
      if (await readPending(accountId)) throw new ApiError('pending_request', '还有一条记录需要核对，请处理后再删除账户。')
      const result = await request<{ cleanupStatus: string }>('/v1/me', { method: 'DELETE', body: { confirm, password } })
      clear()
      setAccountNotice(result.cleanupStatus === 'completed' ? '账户已删除。' : '账户已停用，剩余数据正在清理。')
      channel.current?.postMessage('changed')
      return result
    })
  }, [clear, request])
  return <SessionContext.Provider value={{ user, loading, error, offline, stale: !!user && (!!error || offline), lastSyncedAt, accountNotice, request, refresh, authenticate, logout, deleteAccount }}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('SessionProvider is required')
  return context
}
