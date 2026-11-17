import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider'
import { RecoveryFeedback, useRecovery } from '../lib/RecoveryProvider'
import type { CreationDraft } from '../features/creation/types'
import type { GenericValue, RecordView, RefundSnapshot, TemplatePlanState } from '../lib/contracts'
import { formatFieldValue } from '../features/templates/dynamic-fields'
import { money } from '../features/plans/format'

const names: Record<string, string> = { name: '计划名称', startDate: '开始日期', currentBook: '正在阅读', daysPerWeek: '每周天数', minMinutes: '每日分钟', budgetCents: '月预算', amountCents: '金额', minutes: '时长', date: '日期', note: '备注', category: '分类', title: '公开名称', description: '说明', authorName: '作者署名', text: '原消息', reason: '原因', response: '回复' }
function Values({ values, state }: { values: Record<string, unknown>; state?: TemplatePlanState }) {
  const nested = values.values && typeof values.values === 'object' ? values.values as Record<string, unknown> : values.fields && typeof values.fields === 'object' ? values.fields as Record<string, unknown> : {}
  return <dl className="generic-inline-fields">{Object.entries({ ...values, ...nested }).filter(([key]) => names[key] || state?.definition.recordFields.some((field) => field.id === key) || state?.definition.configurationFields.some((field) => field.id === key)).map(([key, value]) => { const field = [...state?.definition.recordFields ?? [], ...state?.definition.configurationFields ?? []].find((field) => field.id === key); if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) && !Array.isArray(value)) return null; return <div key={key}><dt>{field?.label ?? names[key]}</dt><dd>{formatFieldValue(field ?? { unit: key.endsWith('Cents') ? 'CNY_cent' : key === 'minutes' || key === 'minMinutes' ? 'minute' : undefined }, value as GenericValue)}</dd></div> })}</dl>
}
export function RecoveryCenter() {
  const { user, request } = useSession(), { entry, conflict, clearConflict } = useRecovery()
  const action = ((conflict?.entry ?? entry)?.body.actions as Record<string, unknown>[] | undefined)?.[0]
  const body = action ?? (conflict?.entry ?? entry)?.body ?? {}
  const draftId = typeof body.draftId === 'string' ? body.draftId : undefined
  const latestDraft = useQuery({ queryKey: ['user', user?.id, 'recovery-draft', draftId], enabled: !!user && !!conflict && !!draftId, queryFn: ({ signal }) => request<CreationDraft>(`/v1/creation/drafts/${encodeURIComponent(draftId!)}`, { signal }) })
  const latestRecord = conflict?.details.record as RecordView | undefined
  const latestRefunds = conflict?.details.refundSnapshot as RefundSnapshot | undefined
  const latestPlan = conflict?.details.templatePlan as TemplatePlanState | undefined
  const planId = latestPlan?.planId ?? latestRecord?.planId ?? (typeof body.planId === 'string' ? body.planId : undefined)
  const template = useQuery({ queryKey: ['user', user?.id, 'recovery-template', planId], enabled: !!user && !!planId, queryFn: ({ signal }) => request<TemplatePlanState>(`/v1/plans/${encodeURIComponent(planId!)}/template`, { signal }) })
  const state = latestPlan ?? template.data
  return <section className="settings-section recovery-center"><h2>提交与恢复</h2>{!entry && !conflict ? <p>没有等待核对的提交。</p> : <><p>这里只展示当前账户待核对的内容。断网后可先核对结果，再继续同一次提交。</p>{entry && <><p>{new Date(entry.createdAt).toLocaleString('zh-CN')} · {{ operation: '计划操作', chat: '对话消息', creation: '模板创作', community: '社区作品操作', feedback: '问题反馈' }[entry.kind]}</p><details><summary>查看原提交内容</summary><Values values={(body.patch as Record<string, unknown>) ?? (body.definition as Record<string, unknown>) ?? body} state={state} /></details><RecoveryFeedback global /></>}{conflict && <div className="plan-notice" role="alert"><h3>内容已更新，请核对后重新编辑</h3><p>{conflict.message}</p><div className="conflict-comparison"><div><h4>你提交的修改</h4>{body.type === 'delete_record' ? <p>{body.includeRefunds ? '删除这条记录及当时确认的关联退款。' : '删除这条记录。'}本次没有执行删除。</p> : <Values values={(body.patch as Record<string, unknown>) ?? (body.definition as Record<string, unknown>) ?? body} state={state} />}</div><div><h4>当前已保存的内容</h4>{latestPlan ? <Values values={{ ...latestPlan.config, ...latestPlan.config.values }} state={state} /> : latestRecord ? <><Values values={latestRecord as unknown as Record<string, unknown>} state={state} />{latestRefunds && <p>当前关联退款 {latestRefunds.count} 条，合计 {money(latestRefunds.totalCents)}。请重新打开记录核对。</p>}</> : latestDraft.data?.definition ? <><Values values={latestDraft.data.definition as unknown as Record<string, unknown>} /><p>记录内容：{latestDraft.data.definition.recordFields.map((field) => field.label).join('、')}</p></> : <p>打开原页面刷新，即可查看最新版本。</p>}</div></div><div className="plan-form-actions">{draftId && <Link className="button plan-secondary" to={`/create/${encodeURIComponent(draftId)}`}>打开最新草稿重新编辑</Link>}{typeof body.listingId === 'string' && <Link className="button plan-secondary" to={`/community/${encodeURIComponent(body.listingId)}`}>打开最新作品状态</Link>}{planId && <Link className="button plan-secondary" to={`/plans/${encodeURIComponent(planId)}${latestRecord ? `?record=${encodeURIComponent(latestRecord.id)}` : ''}`}>打开最新内容重新编辑</Link>}<button type="button" className="text-link" onClick={clearConflict}>已核对，关闭提示</button></div></div>}</>}</section>
}
