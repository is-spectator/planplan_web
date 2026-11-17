export interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  responseType?: 'json' | 'blob'
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timeout = AbortSignal.timeout(30_000)
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    })
  } catch {
    throw new ApiError('connection_lost', '连接中断，请检查网络后重试。')
  }
  if (response.ok && options.responseType === 'blob') return await response.blob() as T
  let data: unknown
  try { data = await response.json() } catch { throw new ApiError('invalid_response', '暂时无法确认服务器的回复。', response.status) }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error
    throw new ApiError(error?.code ?? (response.status === 404 ? 'not_found' : 'request_failed'), error?.message ?? '这次请求没有完成，请稍后重试。', response.status, error?.details)
  }
  return data as T
}

export async function withSessionLock<T>(task: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(new ApiError('browser_unsupported', '请使用新版浏览器完成保存。'))
  return await navigator.locks.request('planplan-browser-session', task)
}
