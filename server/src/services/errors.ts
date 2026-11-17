export type ErrorCode =
  | 'duplicate_confirmation_required'
  | 'confirmation_expired'
  | 'operation_changed'
  | 'invalid_input'
  | 'not_found'
  | 'future_date'
  | 'plan_archived'
  | 'no_ledger'
  | 'no_study_plan'
  | 'ledger_exists'
  | 'duplicate_name'
  | 'kind_mismatch'
  | 'refund_exceeds_expense'
  | 'refund_before_expense'
  | 'expense_below_refunds'
  | 'has_refunds'
  | 'refund_confirmation_required'
  | 'day_minutes_exceeded'
  | 'version_conflict'
  | 'undo_conflict'
  | 'already_undone'
  | 'unauthorized'
  | 'forbidden'
  | 'ai_consent_required'
  | 'rate_limited'
  | 'circle_conflict'
  | 'internal';

/** 业务层拒绝。message 是可以直接给用户看的中文说明。 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new DomainError(code, message, details);
};
