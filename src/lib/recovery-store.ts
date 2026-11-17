export interface PendingRequest {
  userId: string
  id: string
  kind: 'operation' | 'chat' | 'creation' | 'community' | 'feedback'
  path: string
  lookup: string
  body: Record<string, unknown>
  createdAt: number
  status: 'unknown' | 'confirmation' | 'transient'
  confirmationId?: string
  message?: string
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('planplan-recovery', 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('pending', { keyPath: 'userId' })
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(new Error('请允许网站存储，以便在网络中断时核对保存结果。'))
  })
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('pending', mode)
      const request = run(tx.objectStore('pending'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(new Error('无法保留待核对记录，请检查浏览器存储空间。'))
      tx.onerror = () => reject(new Error('无法保留待核对记录，请检查浏览器存储空间。'))
    })
  } finally { db.close() }
}

export async function readPending(userId: string): Promise<PendingRequest | null> {
  return (await transaction('readonly', store => store.get(userId))) as PendingRequest | undefined ?? null
}
export async function savePending(entry: PendingRequest): Promise<void> { await transaction('readwrite', store => store.put(entry)) }
export async function removePending(userId: string): Promise<void> { await transaction('readwrite', store => store.delete(userId)) }
