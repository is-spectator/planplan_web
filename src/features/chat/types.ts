import type { Category, GenericSummary, ItemResult, LedgerMonthStats, PlanCard, PlanView, StudyWeekStats } from '../../lib/contracts'

// Wire shapes from planplan/server/src/services/chat.ts and query.ts.
export interface ClarifyOption { id: string; label: string; style: 'primary' | 'secondary' | 'cancel' }
export interface ComparisonPeriod { from: string; to: string; label: string; value: number }
export type QueryCard =
  | ({ type: 'query'; kind: 'ledger_month'; plan: PlanView; month: string; from: string; to: string; focus: 'summary' | 'budget' | 'category'; category: Category | null } & Pick<LedgerMonthStats, 'spendCents' | 'refundCents' | 'netCents' | 'budgetCents' | 'remainingCents' | 'usagePct' | 'overCents' | 'byCategory'>)
  | ({ type: 'query'; kind: 'ledger_range'; plan: PlanView; from: string; to: string; category: Category | null; label: string; keywords?: string[]; count?: number } & Pick<LedgerMonthStats, 'spendCents' | 'refundCents' | 'netCents' | 'byCategory'>)
  | { type: 'query'; kind: 'study_week'; plan: PlanView; stats: StudyWeekStats; label: string; today: string }
  | { type: 'query'; kind: 'study_range'; plan: PlanView; from: string; to: string; label: string; totalMinutes: number; recordDays: number }
  | { type: 'query'; kind: 'comparison'; plan: PlanView; metric: 'spend' | 'refund' | 'net' | 'minutes'; unit: 'CNY_cents' | 'minutes'; category: Category | null; keywords?: string[]; current: ComparisonPeriod; previous: ComparisonPeriod; delta: number; changePct: number | null }
  | { type: 'query'; kind: 'generic_period'; plan: PlanView; summary: GenericSummary }
  | { type: 'query'; kind: 'overview'; plans: PlanCard[]; label: string }
  | { type: 'query'; kind: 'none'; message: string }

export type Card =
  | { type: 'receipt'; operationId: string; kind: 'batch' | 'undo'; undoable: boolean; items: ItemResult[]; current?: Record<string, 'same' | 'modified' | 'deleted'>; growth?: unknown }
  | { type: 'plan'; card: PlanCard; note: string }
  | QueryCard
  | { type: 'clarify'; pendingId: string; question: string; items: { summary: string; ready: boolean; issue: string | null }[]; options: ClarifyOption[]; hint: string; status: 'open' | 'resolved' | 'cancelled' }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'notice'; tone: 'info' | 'warn'; text: string }

export interface MessageView {
  id: string
  role: 'user' | 'assistant'
  text: string
  cards: Card[]
  scopePlanId: string | null
  clientMsgId: string | null
  createdAt: string
}
export interface ChatReply { user: MessageView; assistant: MessageView; dataVersion: number; transient: boolean }
export interface ChatInput { text: string; pendingId?: string | null; choice?: string | null; scopePlanId?: string | null }
export interface MessagesResponse { messages: MessageView[]; nextCursor?: string | null }
