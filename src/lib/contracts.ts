// Browser DTOs based on planplan server @ 1fc1bc5136af4f4e69cc81ef74863fbe34b208d2.
// Keep this module independent of server runtime and configuration.
export const categories = ['餐饮', '交通', '购物', '居住', '学习', '娱乐', '其他'] as const
export type Category = typeof categories[number]
export type PlanKind = 'ledger' | 'study' | 'generic'
export type PlanStatus = 'active' | 'archived'
export type GoalParam = 'budget_cents' | 'days_per_week' | 'min_minutes'
export type ChangeScope = 'current_only' | 'current_and_future' | 'next_and_future'

export interface PlanView {
  id: string
  kind: PlanKind
  name: string
  activity: string | null
  status: PlanStatus
  startDate: string
  hidden: string[]
  order: string[]
  lastActivityAt: string
  template?: { id: string; version: number; setupStatus: 'pending' | 'ready' }
}

export interface RecordView {
  id: string
  planId: string
  kind: 'expense' | 'refund' | 'study' | 'generic'
  amountCents: number | null
  minutes: number | null
  category: Category | null
  date: string
  note: string
  refundOf: string | null
  refundedCents: number | null
  source: 'chat' | 'form'
  sourceMessageId: string | null
  version: number
  deleted: boolean
  createdAt: string
  fields?: Record<string, GenericValue>
  definitionVersion?: number
  definitionTemplateId?: string
  defaultedFields?: string[]
}

export interface LedgerMonthStats {
  month: string
  spendCents: number
  refundCents: number
  netCents: number
  budgetCents: number | null
  remainingCents: number | null
  usagePct: number | null
  overCents: number | null
  expenseCount: number
  refundCount: number
  byCategory: { category: Category; spendCents: number; refundCents: number; netCents: number }[]
  daily: { date: string; netCents: number }[]
}
export type DayStatus = 'future' | 'before_start' | 'none' | 'recorded' | 'below' | 'met'
export interface StudyWeekStats {
  week: string
  daysPerWeek: number | null
  minMinutes: number | null
  goalComplete: boolean
  targetDays: number | null
  metDays: number | null
  exceededDays: number | null
  recordDays: number
  totalMinutes: number
  interrupted: boolean
  days: { date: string; minutes: number; sessions: number; status: DayStatus }[]
}
export interface PlanCard {
  plan: PlanView
  ledger?: Pick<LedgerMonthStats, 'month' | 'spendCents' | 'refundCents' | 'netCents' | 'budgetCents' | 'remainingCents' | 'usagePct' | 'overCents'>
  study?: Omit<StudyWeekStats, 'days' | 'exceededDays'> & { todayMinutes: number; todayStatus: string }
  generic?: GenericSummary
}
export interface PlansResponse { plans: PlanCard[]; dataVersion: number }
export interface LedgerView { plan: PlanView; month: string; stats: LedgerMonthStats; records: RecordView[]; months: string[]; dataVersion: number }
export interface StudyView { plan: PlanView; week: string; today: string; stats: StudyWeekStats; previous: StudyWeekStats | null; records: RecordView[]; weeks: string[]; totalRecords?: number; dataVersion: number }
export interface RefundSnapshot { token: string; count: number; totalCents: number }
export interface RecordResponse { record: RecordView; refundSnapshot: RefundSnapshot | null; source: { text: string; createdAt: string } | null }

type CorrectionReason = 'understanding_error' | 'normal_adjustment' | 'unspecified'
export type Action =
  | { type: 'upgrade_community_template'; planId: string; targetVersion: number; expectedVersion: number }
  | { type: 'apply_private_template'; planId: string; templateId: string; templateVersion: number; expectedVersion: number }
  | { type: 'adopt_template'; templateId: string; templateVersion: number; existingPlanId?: string; existingLedgerAction?: 'reuse' | 'restore' }
  | { type: 'configure_reading_plan'; reviewedOn?: string; planId: string; expectedVersion: number; patch: { name?: string; startDate?: string; currentBook?: string | null; daysPerWeek?: number | null; minMinutes?: number | null }; completeSetup?: boolean; goalScope?: ChangeScope }
  | { type: 'configure_ledger_plan'; reviewedOn?: string; planId: string; expectedVersion: number; patch: { name?: string; budgetCents?: number | null }; completeSetup?: boolean; goalScope?: ChangeScope }
  | { type: 'configure_generic_plan'; reviewedOn?: string; planId: string; expectedVersion: number; patch: { name?: string; startDate?: string; values?: Record<string, GenericValue> }; completeSetup?: boolean; goalScope?: ChangeScope; units?: Record<string, string>; applyTemplateDefaults?: boolean; recordDefaults?: GenericValues }
  | { type: 'add_generic_record'; planId: string; values: Record<string, GenericValue>; units?: Record<string, string> }
  | { type: 'edit_generic_record'; recordId: string; expectedVersion: number; values: Record<string, GenericValue>; units?: Record<string, string> }
  | { type: 'create_ledger'; budgetCents?: number | null }
  | { type: 'create_study'; name?: string | null; activity?: string | null; daysPerWeek?: number | null; minMinutes?: number | null }
  | { type: 'add_expense'; amountCents: number; category: Category; date: string; note?: string }
  | { type: 'add_refund'; expenseId: string; amountCents: number; date: string; note?: string }
  | { type: 'add_study'; planId: string; minutes: number; date: string; note?: string }
  | { type: 'edit_record'; recordId: string; expectedVersion: number; correctionReason?: CorrectionReason; patch: { amountCents?: number; minutes?: number; category?: Category; date?: string; note?: string } }
  | { type: 'delete_record'; recordId: string; expectedVersion: number; correctionReason?: CorrectionReason; includeRefunds?: boolean; expectedRefundSnapshot?: string }
  | { type: 'set_goal'; planId: string; param: GoalParam; value: number; scope: ChangeScope }
  | { type: 'rename_plan'; planId: string; name: string }
  | { type: 'archive_plan' | 'restore_plan'; planId: string }
  | { type: 'set_view'; planId: string; hidden?: string[]; order?: string[] }

export interface LedgerBrief extends Pick<LedgerMonthStats, 'month' | 'spendCents' | 'refundCents' | 'netCents' | 'budgetCents' | 'remainingCents' | 'usagePct' | 'overCents'> { planId: string }
export interface StudyBrief extends Pick<StudyWeekStats, 'week' | 'goalComplete' | 'daysPerWeek' | 'minMinutes' | 'metDays' | 'targetDays' | 'recordDays' | 'totalMinutes'> { planId: string; planName: string; date: string; dayMinutes: number; dayStatus: string }
export type ItemResult =
  | { type: 'plan_created'; plan: PlanView; budgetCents: number | null; daysPerWeek: number | null; minMinutes: number | null; firstWeekTarget: number | null; goalPending: boolean; goalStartsOn?: string }
  | { type: 'expense_added'; record: RecordView; ledger?: LedgerBrief }
  | { type: 'refund_added'; record: RecordView; expense: RecordView; ledger?: LedgerBrief }
  | { type: 'study_added'; record: RecordView; study?: StudyBrief }
  | { type: 'generic_added'; record: RecordView; generic?: GenericSummary }
  | { type: 'record_edited'; before: RecordView; record: RecordView; ledger?: LedgerBrief; study?: StudyBrief; generic?: GenericSummary }
  | { type: 'record_deleted'; records: RecordView[]; ledger?: LedgerBrief; study?: StudyBrief; generic?: GenericSummary }
  | { type: 'goal_set'; plan: PlanView; param: GoalParam; value: number; scope: ChangeScope; effectiveFrom: string; previous: number | null; replacedFuture: { fromPeriod: string; value: number }[]; study?: StudyBrief; ledger?: LedgerBrief }
  | { type: 'plan_updated'; plan: PlanView; change: 'renamed' | 'archived' | 'restored' | 'view' }
  | { type: 'undone'; of: string; records: RecordView[]; ledger?: LedgerBrief; study?: StudyBrief; generic?: GenericSummary; plans: PlanView[] }
export interface OperationResult {
  operationId: string
  clientOpId: string
  kind: 'batch' | 'undo'
  items: ItemResult[]
  dataVersion: number
  createdAt: string
  undoable: boolean
  replayed?: boolean
  clarificationRounds?: 1
  growth?: unknown
  templatePlan?: TemplatePlanState
}

export interface ReadingConfiguration {
  version: number
  setupStatus: 'pending' | 'ready'
  name: string
  startDate: string
  currentBook: string | null
  daysPerWeek: number | null
  minMinutes: number | null
  goalEffectiveFrom: { daysPerWeek: string | null; minMinutes: string | null }
  nextWeekGoals?: { startsOn: string; daysPerWeek: number | null; minMinutes: number | null }
  canChangeStartDate?: boolean
  budgetCents?: number | null
  budgetEffectiveFrom?: string | null
  nextMonthBudget?: { startsOn: string; value: number | null }
  values?: Record<string, GenericValue>
  recordDefaults?: GenericValues
  proposedDefaults?: GenericValues
  goals?: GenericGoalState[]
  nextPeriodValues?: Record<string, { startsOn: string; value: GenericValue }>
}

export interface TemplatePlanState {
  planId: string
  templateId: string
  templateVersion: number
  source: 'official' | 'legacy' | 'private' | 'community'
  engine: PlanKind
  definition: TemplateDefinition
  config: ReadingConfiguration
}

export interface TemplateField {
  id: string
  label: string
  type: 'text' | 'integer' | 'decimal' | 'money' | 'date' | 'duration' | 'single_select' | 'multi_select' | 'boolean'
  required: boolean
  unit?: 'CNY_cent' | 'minute' | 'ml' | 'day_per_week'
  min?: number
  max?: number
  maxLength?: number
  options?: string[]
}
export interface TemplateMetric {
  id: string
  label: string
  operation: 'sum' | 'count' | 'distinct_days' | 'mean' | 'goal_progress'
  fieldId?: string
  period: 'day' | 'week' | 'month'
  goalFieldId?: string
  goalAggregation?: 'sum' | 'count' | 'distinct_days'
  groupByFieldId?: string
  sourceRule?: 'ledger_expenses' | 'ledger_net' | 'study_week' | 'generic_records'
}
export interface TemplateDefinition {
  schemaVersion: 1
  id: string
  version: number
  name: string
  description: string
  engine: 'ledger' | 'study' | 'generic'
  source: 'official' | 'private' | 'community'
  requiredCapabilities: string[]
  configurationFields: TemplateField[]
  configurationDefaults?: GenericValues
  recordDefaults?: GenericValues
  recordFields: TemplateField[]
  metrics: TemplateMetric[]
  components: string[]
  example: { config: Record<string, unknown>; record: Record<string, unknown> }
}

export type GenericValue = string | number | boolean | string[] | null
export type GenericValues = Record<string, GenericValue>
export type GenericPeriod = 'day' | 'week' | 'month'
export interface GenericGoalState { fieldId: string; period: GenericPeriod; from: string; to: string; value: GenericValue; effectiveFrom: string | null; next: { startsOn: string; value: GenericValue }; partialPeriod: boolean }
export interface GenericMetricGroup { key: string | boolean | null; label: string; value: number | null; sampleCount: number; recordCount: number }
export interface GenericMetricPoint { date: string; value: number | null; sampleCount: number; recordCount: number }
export interface GenericMetricValue {
  id: string
  label: string
  operation: TemplateMetric['operation']
  fieldId?: string
  unit?: string
  value: number | null
  target: number | null
  remaining: number | null
  progressPct: number | null
  sampleCount?: number
  period?: GenericPeriod
  from?: string
  to?: string
  partialPeriod?: boolean
  groups?: GenericMetricGroup[]
  series?: GenericMetricPoint[]
}
export interface GenericSummary { planId: string; from: string; to: string; recordCount: number; metrics: GenericMetricValue[] }
export interface GenericView { plan: PlanView; templatePlan: TemplatePlanState; today: string; summary: GenericSummary; records: RecordView[]; totalRecords: number; offset: number; limit: number; dataVersion: number }
