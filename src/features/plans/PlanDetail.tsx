import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, BookOpen, Plus, RefreshCw } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { OriginalMessage } from '../../components/OriginalMessage'
import { dismissManual, useManualIntent, useManualRecordOpen } from '../../lib/manual-handoff'
import { useSession } from '../../auth/SessionProvider'
import { useOperation } from '../../lib/useOperation'
import { PageState } from '../../components/PageState'
import type { LedgerView, OperationResult, PlanView, PlansResponse, RecordView, StudyView, TemplatePlanState } from '../../lib/contracts'
import { ApiError } from '../../lib/api'
import { ReadingSettings } from '../templates/ReadingSettings'
import { GenericPlanDetail } from '../templates/GenericPlanDetail'
import { LedgerSettings } from '../templates/LedgerSettings'
import { UndoPlanOperation } from './UndoPlanOperation'
import { LedgerSummary, StudySummary } from './PlanSummary'
import { RecordForm } from './RecordForm'
import { RecordInspector } from './RecordInspector'
import { errorMessage, money } from './format'
import { periodRange } from '../templates/dynamic-fields'
import { useHistoryRestart, useRecordPageBounds, useRecordPagination } from './useRecordPagination'

export function PlanDetail({ planId }: { planId: string }) {
  const { user, request } = useSession()
  const manual = useManualIntent()
  const [search] = useSearchParams()
  const plans = useQuery({
    queryKey: ['user', user!.id, 'plans', 'all'],
    queryFn: async ({ signal }) => {
      const [active, archived] = await Promise.all([
        request<PlansResponse>('/v1/plans?status=active', { signal }),
        request<PlansResponse>('/v1/plans?status=archived', { signal }),
      ])
      return [...active.plans, ...archived.plans]
    },
  })
  const plan = plans.data?.find((item) => item.plan.id === planId)?.plan
  return <div className="standard-page plans-page">
    <Link className="text-link back-link" to="/plans"><ArrowLeft size={17} aria-hidden="true" />返回计划</Link>
    {plans.isError && plan && <p className="plan-notice" role="alert">计划状态暂未更新，当前显示上次读取的内容。<button type="button" className="text-link" onClick={() => void plans.refetch()}>重试</button></p>}
    {plan ? plan.kind === 'generic' ? <GenericPlanDetail key={`${plan.id}:${search.get('date') || 'current'}`} plan={plan} /> : <DetailContent key={plan.id} plan={plan} /> : plans.isPending ? <p className="plan-loading" role="status">正在读取计划…</p> : plans.isError ? <PageState icon={<BookOpen size={28} />} title="暂时无法读取计划" tone="error" action={<button className="button primary" type="button" onClick={() => void plans.refetch()}>重新读取</button>}><p>{errorMessage(plans.error)}</p>{manual?.kind === 'chat' && manual.planId === planId && <><p>不会改用其他计划。</p><OriginalMessage text={manual.text} /></>}</PageState> : <PageState icon={<BookOpen size={28} />} title="没有找到这个计划"><p>请返回计划列表，重新选择。不会改用其他计划，也不会新建。</p>{manual?.kind === 'chat' && manual.planId === planId && <OriginalMessage text={manual.text} />}</PageState>}
  </div>
}

function DetailContent({ plan }: { plan: PlanView }) {
  const { user, request } = useSession()
  const [search, setSearch] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [settings, setSettings] = useState(search.get('setup') === '1')
  const [savedOperation, setSavedOperation] = useState<OperationResult | null>(null)
  const { submit, busy, pending, feedback } = useOperation()
  const ledger = plan.kind === 'ledger'
  const template = useQuery({
    queryKey: ['user', user!.id, 'plan-template', plan.id],
    queryFn: async ({ signal }) => {
      try { return await request<TemplatePlanState>(`/v1/plans/${encodeURIComponent(plan.id)}/template`, { signal }) }
      catch (reason) { if (reason instanceof ApiError && reason.status === 404) return null; throw reason }
    },
  })
  const reading = template.data?.templateId === 'official.reading' && template.data.source === 'official' ? template.data : null
  const ledgerTemplate = template.data?.engine === 'ledger' ? template.data : null
  const legacyStudy = template.data?.engine === 'study' && !reading ? template.data : null
  const period = search.get(ledger ? 'month' : 'week') ?? ''
  const { offset, setOffset } = useRecordPagination(search, setSearch, user!.dataVersion, ledger ? user!.today.slice(0, 7) : periodRange(user!.today, 'week').from, !period)
  const selectedRecord = search.get('record')
  const openManualForm = useCallback(() => setAdding(true), [])
  const manual = useManualRecordOpen(plan.id, plan.status, adding || settings || Boolean(selectedRecord) || (!ledger && (template.isPending || template.isError)), openManualForm)
  const detail = useQuery({
    queryKey: ['user', user!.id, 'plan', plan.id, plan.kind, period, offset, user!.today, user!.dataVersion],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (period) params.set(ledger ? 'month' : 'week', period)
      params.set('offset', String(offset))
      if (!ledger) params.set('limit', '20')
      params.set('expectedDataVersion', String(user!.dataVersion))
      return request<LedgerView | StudyView>(`/v1/plans/${encodeURIComponent(plan.id)}/${plan.kind}?${params}`, { signal })
    },
  })
  useHistoryRestart(detail.error, setOffset)
  const view = detail.data
  const ledgerView = view && 'month' in view ? view : null
  const studyView = view && 'week' in view ? view : null
  const records = ledgerView?.records ?? (studyView ? studyView.totalRecords === undefined ? studyView.records.slice(offset, offset + 20) : studyView.records : [])
  const total = ledgerView ? ledgerView.stats.expenseCount + ledgerView.stats.refundCount : studyView?.totalRecords ?? studyView?.records.length ?? 0
  useRecordPageBounds(view ? total : undefined, offset, setOffset)
  const currentPeriod = ledgerView?.month ?? studyView?.week ?? period
  const periods = ledgerView ? [...new Set([user!.today.slice(0, 7), ...ledgerView.months])].sort().reverse() : studyView?.weeks ?? []

  function closeRecord() {
    const next = new URLSearchParams(search)
    next.delete('record')
    setSearch(next, { replace: true })
  }
  function saved(result: OperationResult) { setSavedOperation(result); setAdding(false); if (manual?.opened) dismissManual(); const next = new URLSearchParams(search); next.delete('record'); next.delete('page'); setSearch(next, { replace: true }) }
  function closeSettings() {
    setSettings(false)
    const next = new URLSearchParams(search)
    next.delete('setup')
    setSearch(next, { replace: true })
  }
  function changePeriod(value: string) {
    const next = new URLSearchParams(search)
    next.set(ledger ? 'month' : 'week', value)
    next.delete('record')
    next.delete('page')
    setSearch(next)
    setAdding(false)
  }
  function chooseRecord(record: RecordView) {
    const next = new URLSearchParams(search)
    next.set('record', record.id)
    setSearch(next)
    setAdding(false)
    setSettings(false)
  }

  return <>
    <header className="page-heading plan-detail-heading"><div><h1>{plan.name}</h1><p>{plan.status === 'archived' ? '已归档 · 历史记录仍会保留' : ledger ? '每一笔日常，都值得清楚记录。' : reading ? '读过的每一刻，都慢慢留在生活里。' : '一段一段专注，慢慢积累。'}</p></div><button type="button" className="button plan-secondary" disabled={detail.isFetching || template.isFetching} onClick={() => { void detail.refetch(); void template.refetch() }}><RefreshCw size={16} aria-hidden="true" />刷新</button></header>
    {reading && <p className="reading-source">来自 PlanPlan 官方「{reading.definition.name}」· 第 {reading.templateVersion} 版 · 你的私人计划</p>}
    {template.isError && <div className="plan-notice" role="alert"><p>暂时无法读取计划设置。{errorMessage(template.error)}</p><button type="button" className="text-link" onClick={() => void template.refetch()}>重试</button></div>}
    {reading && (settings && plan.status === 'active' ? <ReadingSettings state={reading} today={user!.today} hasRecords={total > 0} onClose={closeSettings} /> : <section className="reading-settings-summary"><div className="plan-section-heading"><h2>{reading.config.setupStatus === 'pending' ? '计划已创建，可以继续设置' : '阅读设置'}</h2>{plan.status === 'active' && <button className="text-link" type="button" onClick={() => { setSettings(true); setAdding(false); closeRecord() }}>{reading.config.setupStatus === 'pending' ? '继续设置' : '调整设置'}</button>}</div><p>{reading.config.currentBook ? `当前书籍：${reading.config.currentBook}` : '还没有设置当前书籍'}</p><p>{reading.config.daysPerWeek === null || reading.config.minMinutes === null ? '目标可稍后完善，现在就可以记录阅读。' : `每周 ${reading.config.daysPerWeek} 天，每天 ${reading.config.minMinutes} 分钟`}</p>{reading.config.goalEffectiveFrom.daysPerWeek && <p>每周天数从 {reading.config.goalEffectiveFrom.daysPerWeek} 起生效</p>}{reading.config.goalEffectiveFrom.minMinutes && <p>每日时长从 {reading.config.goalEffectiveFrom.minMinutes} 起生效</p>}{reading.config.nextWeekGoals && (reading.config.nextWeekGoals.daysPerWeek !== reading.config.daysPerWeek || reading.config.nextWeekGoals.minMinutes !== reading.config.minMinutes) && <p>从 {reading.config.nextWeekGoals.startsOn} 起：{reading.config.nextWeekGoals.daysPerWeek === null ? '每周天数未设置' : `每周 ${reading.config.nextWeekGoals.daysPerWeek} 天`}，{reading.config.nextWeekGoals.minMinutes === null ? '每日时长未设置' : `每天 ${reading.config.nextWeekGoals.minMinutes} 分钟`}。</p>}</section>)}
    {legacyStudy && (settings && plan.status === 'active' ? <ReadingSettings state={legacyStudy} today={user!.today} hasRecords={total > 0} reading={false} onClose={closeSettings} /> : <section className="reading-settings-summary"><div className="plan-section-heading"><h2>学习计划设置</h2>{plan.status === 'active' && <button type="button" className="text-link" onClick={() => { setSettings(true); setAdding(false); closeRecord() }}>调整设置</button>}</div><p>{legacyStudy.config.daysPerWeek === null || legacyStudy.config.minMinutes === null ? '目标可以稍后完善，学习时长照常记录。' : `每周 ${legacyStudy.config.daysPerWeek} 天，每天 ${legacyStudy.config.minMinutes} 分钟`}</p>{legacyStudy.config.nextWeekGoals && (legacyStudy.config.nextWeekGoals.daysPerWeek !== legacyStudy.config.daysPerWeek || legacyStudy.config.nextWeekGoals.minMinutes !== legacyStudy.config.minMinutes) && <p>从 {legacyStudy.config.nextWeekGoals.startsOn} 起：每周 {legacyStudy.config.nextWeekGoals.daysPerWeek ?? '未设置'} 天，每天 {legacyStudy.config.nextWeekGoals.minMinutes ?? '未设置'} 分钟。</p>}</section>)}
    {ledgerTemplate && (settings && plan.status === 'active' ? <LedgerSettings state={ledgerTemplate} today={user!.today} onClose={closeSettings} /> : <section className="reading-settings-summary"><div className="plan-section-heading"><h2>{ledgerTemplate.config.setupStatus === 'pending' ? '计划已创建，可以设置预算' : '月预算设置'}</h2>{plan.status === 'active' && <button className="text-link" type="button" onClick={() => { setSettings(true); setAdding(false); closeRecord() }}>设置月预算</button>}</div>{plan.status === 'active' && <p><button type="button" className="text-link" onClick={() => { setSettings(true); setAdding(false); closeRecord() }}>修改计划名称</button></p>}<p>使用官方记账模板，原有账目与退款关系完整保留。</p><p>本月预算：{ledgerTemplate.config.budgetCents === null || ledgerTemplate.config.budgetCents === undefined ? '未设置' : money(ledgerTemplate.config.budgetCents)}</p>{ledgerTemplate.config.nextMonthBudget && ledgerTemplate.config.nextMonthBudget.value !== ledgerTemplate.config.budgetCents && <p>从 {ledgerTemplate.config.nextMonthBudget.startsOn} 起：{ledgerTemplate.config.nextMonthBudget.value === null ? '未设置预算' : money(ledgerTemplate.config.nextMonthBudget.value)}</p>}</section>)}
    {!adding && !selectedRecord && feedback}
    {savedOperation?.undoable && <UndoPlanOperation key={savedOperation.operationId} operation={savedOperation} onDone={() => setSavedOperation(null)} />}
    <div className="plan-toolbar">
      {view && <label className="period-select">{ledger ? '月份' : reading ? '阅读周' : '学习周'}<select aria-label={ledger ? '选择月份' : reading ? '选择阅读周' : '选择学习周'} value={currentPeriod} onChange={(event) => changePeriod(event.target.value)}>{periods.map((item) => <option key={item} value={item}>{ledger ? item : `${item} 起`}</option>)}</select></label>}
      <div className="plan-toolbar-actions">{plan.status === 'active' ? <>
        <button type="button" className="button primary" disabled={adding || Boolean(selectedRecord) || (!ledger && (template.isPending || template.isError))} onClick={() => { setAdding(true); closeSettings() }}><Plus size={17} aria-hidden="true" />{ledger ? '记一笔' : reading ? '记录阅读' : '记录学习'}</button>
        <button type="button" className="button plan-secondary" disabled={busy || pending} onClick={() => setArchiveConfirm(true)}>归档计划</button>
      </> : <button type="button" className="button primary" disabled={busy || pending} onClick={async () => { setArchiveConfirm(false); await submit([{ type: 'restore_plan', planId: plan.id }]) }}>{busy ? '正在恢复…' : '恢复计划'}</button>}</div>
    </div>
    {archiveConfirm && plan.status === 'active' && <section className="plan-notice"><h2>归档「{plan.name}」？</h2><p>归档后暂停新增记录，历史数据会保留，需要时可以恢复。学习计划的归档或恢复会影响本周达标评定。</p><div className="plan-form-actions"><button type="button" className="button primary" disabled={busy || pending} onClick={async () => { const result = await submit([{ type: 'archive_plan', planId: plan.id }]); if (result) setArchiveConfirm(false) }}>{busy ? '正在归档…' : '确认归档'}</button><button type="button" className="button plan-secondary" disabled={busy || pending} onClick={() => setArchiveConfirm(false)}>取消</button></div></section>}
    {manual && plan.status === 'archived' && <section className="plan-notice" role="status"><h2>这个计划已归档</h2><p>不能在这里新增记录，也不会改用其他计划。历史记录仍会保留。</p><Link className="text-link" to="/plans">返回计划</Link><OriginalMessage text={manual.text} /></section>}
    {manual && plan.status === 'active' && <OriginalMessage text={manual.text} />}
    {adding && <section className="plan-form-panel"><h2>{ledger ? '记录一笔支出' : reading ? '记录一段阅读' : '记录一段学习'}</h2><RecordForm plan={plan} today={user!.today} reading={reading?.config} onSaved={saved} onCancel={() => { setAdding(false); if (manual?.opened) dismissManual() }} /></section>}
    {selectedRecord && <RecordInspector key={selectedRecord} recordId={selectedRecord} plan={plan} today={user!.today} reading={reading?.config} onSaved={saved} onClose={closeRecord} />}
    {detail.isPending && <p className="plan-loading" role="status">正在读取统计和记录…</p>}
    {detail.isError && <div className="plan-notice plan-form-error" role="alert"><p>{errorMessage(detail.error)}</p><button className="text-link" type="button" onClick={() => void detail.refetch()}>重新读取</button></div>}
    {ledgerView && <LedgerSummary stats={ledgerView.stats} />}
    {studyView && <StudySummary stats={studyView.stats} today={studyView.today} reading={Boolean(reading)} />}
    {view && <section className="plan-records" aria-labelledby="records-heading"><div className="plan-section-heading"><h2 id="records-heading">{ledger ? '本月记录' : '本周记录'}</h2><span>{total} 条</span></div>
      {records.length === 0 ? <p className="plan-empty-records">这个周期还没有记录。</p> : <ul className="record-list">{records.map((record) => <li key={record.id}><button type="button" className="record-row" onClick={() => chooseRecord(record)}>
        <div className="record-row-main"><strong>{record.note || (record.kind === 'study' ? plan.activity || plan.name : record.kind === 'refund' ? '退款' : record.category || '支出')}</strong><span>{record.date}{record.category ? ` · ${record.category}` : ''}{record.kind === 'refund' ? ' · 退款' : ''}{(record.refundedCents ?? 0) > 0 ? ` · 已退 ${money(record.refundedCents ?? 0)}` : ''}</span></div>
        <strong className={record.kind === 'refund' ? 'refund-amount' : 'record-value'}>{record.kind === 'study' ? `${record.minutes} 分钟` : `${record.kind === 'refund' ? '+' : ''}${money(record.amountCents ?? 0)}`}</strong><ArrowRight size={16} aria-hidden="true" />
      </button></li>)}</ul>}
      {(total > 20 || offset > 0) && <nav className="record-pagination" aria-label="记录分页"><button className="button plan-secondary" type="button" disabled={offset === 0 || detail.isFetching} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} / {Math.max(1, Math.ceil(total / 20))} 页</span><button className="button plan-secondary" type="button" disabled={offset + 20 >= total || detail.isFetching} onClick={() => setOffset(offset + 20)}>下一页</button></nav>}
    </section>}
    <Link className="text-link plan-chat-link" to={`/chat?plan=${encodeURIComponent(plan.id)}`}>去对话继续记录<ArrowRight size={17} aria-hidden="true" /></Link>
  </>
}
