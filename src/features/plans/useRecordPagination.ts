import { ApiError } from '../../lib/api'
import { useSession } from '../../auth/SessionProvider'
import { useCallback, useEffect, useRef } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'

const pageSize = 20

export function useRecordPagination(search: URLSearchParams, setSearch: SetURLSearchParams, dataVersion: number, currentPeriod: string, followsCurrentPeriod: boolean) {
  const raw = search.get('page')
  const candidate = Number(raw ?? '1')
  const valid = /^\d+$/.test(raw ?? '1') && Number.isSafeInteger(candidate) && candidate > 0 && Number.isSafeInteger((candidate - 1) * pageSize)
  const page = valid ? candidate : 1
  const offset = (page - 1) * pageSize
  const previous = useRef({ dataVersion, currentPeriod })
  const setOffset = useCallback((value: number) => {
    setSearch(current => {
      const next = new URLSearchParams(current)
      const nextPage = Math.floor(Math.max(0, value) / pageSize) + 1
      if (nextPage === 1) next.delete('page')
      else next.set('page', String(nextPage))
      return next
    }, { replace: true })
  }, [setSearch])

  useEffect(() => {
    const changed = previous.current.dataVersion !== dataVersion || followsCurrentPeriod && previous.current.currentPeriod !== currentPeriod
    previous.current = { dataVersion, currentPeriod }
    if (changed && offset > 0) setOffset(0)
    else if (raw !== null && raw !== (page === 1 ? null : String(page))) setOffset(offset)
  }, [currentPeriod, dataVersion, followsCurrentPeriod, offset, page, raw, setOffset])
  return { offset, setOffset }
}

export function useRecordPageBounds(total: number | undefined, offset: number, setOffset: (offset: number) => void, dataVersion: number) {
  const settledVersion = useRef(dataVersion)
  useEffect(() => {
    // A new dataset makes the old page meaningless. Pagination already returns
    // to the first page; clamping this stale offset to the last page would
    // overwrite that reset, including on the development double effect run.
    if (settledVersion.current !== dataVersion) {
      if (offset === 0) settledVersion.current = dataVersion
      return
    }
    if (total !== undefined && offset > 0 && offset >= total) setOffset(Math.max(0, Math.ceil(total / pageSize) - 1) * pageSize)
  }, [dataVersion, offset, setOffset, total])
}

export function useHistoryRestart(error: unknown, setOffset: (offset: number) => void) {
  const { refresh } = useSession()
  useEffect(() => {
    if (error instanceof ApiError && error.details?.kind === 'history_changed') {
      setOffset(0)
      void refresh()
    }
  }, [error, refresh, setOffset])
}
