import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus, RefreshCw } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'
import type { GenericView, OperationResult, PlanView, TemplatePlanState } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { UndoPlanOperation } from '../plans/UndoPlanOperation'
import { errorMessage } from '../plans/format'
import { OriginalMessage } from '../../components/OriginalMessage'
import { dismissManual, useManualRecordOpen } from '../../lib/manual-handoff'
import { CommunityUpgrade } from '../community/CommunityUpgrade'
import { GenericMetrics } from './GenericMetrics'
import { GenericRecordForm } from './GenericRecordForm'
import { GenericRecordInspector } from './GenericRecordInspector'
import { GenericSettings } from './GenericSettings'
import { formatFieldValue, supportsGeneric, periodRange } from './dynamic-fields'
import { useHistoryRestart, useRecordPageBounds, useRecordPagination } from '../plans/useRecordPagination'

export function GenericPlanDetail({ plan }: { plan: PlanView }) {
  const { user, request } = useSession()
  const [search, setSearch] = useSearchParams()
  const date = search.get('date') || user!.today
  const range = search.get('range') || 'metrics'
  const bounds = periodRange(date, range === 'week' || range === 'month' ? range : 'day')
  const selectedRecord = search.get('record')
  const { offset, setOffset } = useRecordPagination(search, setSearch, user!.dataVersion, user!.today, !search.get('date'))
  const [adding, setAdding] = useState(false)
  const [settings, setSettings] = useState(search.get('setup') === '1')
  const [archiving, setArchiving] = useState(false)
  const [lastOperation, setLastOperation] = useState<OperationResult | null>(null)
  const { submit, busy, pending, feedback } = useOperation()
  const query = useQuery({ queryKey: ['user', user!.id, 'generic', plan.id, date, range, offset, user!.today, user!.dataVersion], queryFn: ({ signal }) => request<GenericView>(`/v1/plans/${encodeURIComponent(plan.id)}/generic?${new URLSearchParams({ ...(range === 'metrics' ? { date } : bounds), offset: String(offset), limit: '20', expectedDataVersion: String(user!.dataVersion) })}`, { signal }) })
  useHistoryRestart(query.error, setOffset)
  const current = useQuery({ queryKey: ['user', user!.id, 'plan-template', plan.id], queryFn: ({ signal }) => request<TemplatePlanState>(`/v1/plans/${encodeURIComponent(plan.id)}/template`, { signal }) })
  // Preserve this plan's form definition while a new period is loading; statistics stay query-specific.
  const state = query.data?.templatePlan ?? current.data
  const definition = state?.definition
  const supported = definition && supportsGeneric(definition)
  const settingsState = current.data
  function closePanel() { const next = new URLSearchParams(search); next.delete('record'); next.delete('setup'); setSearch(next, { replace: true }); setAdding(false); setSettings(false) }
  const formHeading = useRef<HTMLHeadingElement>(null)
  const openManualForm = useCallback(() => setAdding(true), [])
  const manual = useManualRecordOpen(plan.id, plan.status, adding || settings || Boolean(selectedRecord) || archiving || current.isPending || current.isError || !supported, openManualForm)
  useEffect(() => { if (adding && manual?.opened) formHeading.current?.focus() }, [adding, manual?.opened])
  function saved(result: OperationResult) { setLastOperation(result); const next = new URLSearchParams(search); next.delete('record'); next.delete('setup'); next.delete('page'); setSearch(next, { replace: true }); setAdding(false); setSettings(false); if (manual) dismissManual() }
  function changeDate(value: string) { const next = new URLSearchParams(); if (range !== 'metrics') next.set('range', range); if (value) next.set('date', value); setSearch(next); setAdding(false); setSettings(false); setLastOperation(null) }
  const records = query.data?.records ?? []
  const total = query.data?.totalRecords ?? 0
  useRecordPageBounds(query.data?.totalRecords, offset, setOffset, user!.dataVersion)
  return <>
    <header className="page-heading plan-detail-heading"><div><h1>{plan.name}</h1><p>{plan.status === 'archived' ? '已归档 · 历史记录仍会保留' : '每一份日常积累，都清楚地留在这里。'}</p></div><button type="button" className="button plan-secondary" disabled={query.isFetching || current.isFetching} onClick={() => { void query.refetch(); void current.refetch() }}><RefreshCw size={16} aria-hidden="true" />刷新</button></header>
    {state && <p className="reading-source">来自{state.source === 'private' ? '我的模板' : state.source === 'community' ? '社区模板' : ' PlanPlan 官方'}「{state.definition.name}」· 你的私人计划</p>}
    {query.isPending && <p className="plan-loading" role="status">正在读取计划和记录…</p>}{query.isError && <div className="plan-notice plan-form-error" role="alert"><p>{errorMessage(query.error)}</p><button className="text-link" type="button" onClick={() => void query.refetch()}>重新读取</button></div>}
    {current.isPending && settings && <p className="plan-loading" role="status">正在读取今天的设置…</p>}
    {current.isError && <div className="plan-notice" role="alert"><p>暂时无法读取今天的设置，历史统计仍按所选日期展示。</p><button type="button" className="text-link" onClick={() => void current.refetch()}>重新读取设置</button></div>}
    {state && !supported && <p className="plan-notice" role="alert">这个计划包含当前页面尚不能使用的内容。请更新页面后再查看和记录。</p>}
    {state && definition && supported && <>
      {settingsState && (settings && plan.status === 'active' ? <GenericSettings state={settingsState} today={user!.today} onClose={closePanel} /> : <section className="reading-settings-summary"><div className="plan-section-heading"><h2>{settingsState.config.setupStatus === 'pending' ? '计划已创建，可以继续设置' : date === user!.today ? '计划设置' : '计划设置（今天）'}</h2>{plan.status === 'active' && <button className="text-link" type="button" onClick={() => { closePanel(); setSettings(true) }}>{settingsState.config.setupStatus === 'pending' ? '继续设置' : '调整设置'}</button>}</div><dl className="generic-inline-fields">{definition.configurationFields.filter((field) => !['name', 'startDate'].includes(field.id)).map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{formatFieldValue(field, settingsState.config.values?.[field.id])}</dd></div>)}</dl>{Object.entries(settingsState.config.nextPeriodValues ?? {}).filter(([id, next]) => JSON.stringify(next.value) !== JSON.stringify(settingsState.config.values?.[id] ?? null)).map(([id, next]) => <p key={id}>{definition.configurationFields.find((field) => field.id === id)?.label ?? '目标'}从 {next.startsOn} 起：{formatFieldValue(definition.configurationFields.find((field) => field.id === id) ?? {}, next.value)}</p>)}</section>)}
      {state.source === 'community' && plan.status === 'active' && <CommunityUpgrade state={settingsState ?? state} />}
      {feedback}{lastOperation?.undoable && <UndoPlanOperation key={lastOperation.operationId} operation={lastOperation} onDone={() => setLastOperation(null)} />}
      <div className="plan-toolbar"><label className="period-select">查看日期<input aria-label="查看日期" type="date" max={user!.today} value={date} onChange={(event) => changeDate(event.target.value)} /></label><label className="period-select">统计范围<select value={range} onChange={(event) => { const next = new URLSearchParams(search); next.set('range', event.target.value); next.delete('record'); next.delete('page'); setSearch(next) }}><option value="metrics">各统计自身周期</option><option value="day">所选日</option><option value="week">所选周至当天</option><option value="month">所选月至当天</option></select></label><div className="plan-toolbar-actions">{plan.status === 'active' ? <><button type="button" className="button primary" disabled={adding || Boolean(selectedRecord) || busy || pending} onClick={() => { closePanel(); setAdding(true) }}><Plus size={17} aria-hidden="true" />添加记录</button><button className="button plan-secondary" type="button" disabled={busy || pending} onClick={() => setArchiving(true)}>归档计划</button></> : <button type="button" className="button primary" disabled={busy || pending} onClick={() => void submit([{ type: 'restore_plan', planId: plan.id }])}>恢复计划</button>}</div></div>
      {archiving && plan.status === 'active' && <section className="plan-notice"><h2>归档「{plan.name}」？</h2><p>归档后暂停新增记录，历史数据会保留，需要时可以恢复。</p><div className="plan-form-actions"><button type="button" className="button primary" disabled={busy || pending} onClick={async () => { const result = await submit([{ type: 'archive_plan', planId: plan.id }]); if (result) { setArchiving(false); closePanel() } }}>确认归档</button><button type="button" className="button plan-secondary" disabled={busy || pending} onClick={() => setArchiving(false)}>取消</button></div></section>}
      {manual && plan.status === 'archived' && <section className="plan-notice" role="status"><h2>这个计划已归档</h2><p>不能在这里新增记录，也不会改用其他计划。历史记录仍会保留。</p><Link className="text-link" to="/plans">返回计划</Link><OriginalMessage text={manual.text} /></section>}
      {manual && plan.status === 'active' && <OriginalMessage text={manual.text} />}
      {adding && <section className="plan-form-panel"><h2 tabIndex={-1} ref={formHeading}>添加记录</h2><GenericRecordForm key={plan.id} state={state} today={user!.today} date={date} onSaved={saved} onCancel={() => { closePanel(); if (manual) dismissManual() }} /></section>}
      {selectedRecord && <GenericRecordInspector key={selectedRecord} state={state} recordId={selectedRecord} today={user!.today} onSaved={saved} onClose={closePanel} />}
      {query.data && definition.components.map((component) => component === 'summary' || component === 'goal' || component === 'trend' || component === 'categories' ? <GenericMetrics key={component} definition={definition} summary={query.data.summary} component={component} rangeSelected={range !== 'metrics'} /> : component === 'records' ? <section key={component} className="plan-records" aria-label="记录列表"><div className="plan-section-heading"><h2>{range === 'metrics' || range === 'day' ? '当日记录' : '范围内记录'}</h2><span>{total} 条</span></div>{records.length === 0 ? <p className="plan-empty-records">{range === 'metrics' || range === 'day' ? '这一天还没有记录。' : '这个范围还没有记录。'}</p> : <ul className="record-list">{records.map((record) => <li key={record.id}><button type="button" className="record-row generic-record-row" onClick={() => { const next = new URLSearchParams(search); next.set('record', record.id); next.delete('setup'); setSearch(next); setAdding(false); setSettings(false) }}><dl className="generic-inline-fields">{definition.recordFields.map((field) => record.fields?.[field.id] !== null && record.fields?.[field.id] !== undefined && <div key={field.id}><dt>{field.label}</dt><dd>{formatFieldValue(field, record.fields[field.id])}</dd></div>)}</dl><ArrowRight size={16} aria-hidden="true" /></button></li>)}</ul>}{(total > 20 || offset > 0) && <nav className="record-pagination" aria-label="记录分页"><button type="button" className="button plan-secondary" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} / {Math.max(1, Math.ceil(total / 20))} 页</span><button type="button" className="button plan-secondary" disabled={offset + 20 >= total || query.isFetching} onClick={() => setOffset(offset + 20)}>下一页</button></nav>}</section> : null)}
    </>}
    {state && supported && plan.status === 'active' && <p className="generic-private-edit"><Link className="text-link" to={`/create?fromPlan=${encodeURIComponent(plan.id)}`}>调整这个计划的模板<ArrowRight size={16} /></Link></p>}
    <div className="plan-form-actions"><Link className="text-link" to={`/chat?plan=${encodeURIComponent(plan.id)}`}>去对话继续记录<ArrowRight size={16} aria-hidden="true" /></Link><Link className="text-link" to="/me">导出我的数据<ArrowRight size={16} aria-hidden="true" /></Link></div>
  </>
}
