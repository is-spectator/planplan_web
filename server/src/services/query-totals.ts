import type { Queryable } from '../db/db.js';
import type { Category } from '../domain/ledger.js';
import type { BizDate } from '../domain/time.js';

function integer(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Query aggregate exceeds safe integer range');
  return n;
}

/** 数据库负责精确整数求和；记录天数按业务日去重，不代表达标天数。 */
export async function studyRangeTotals(q: Queryable, userId: string, planId: string, from: BizDate, to: BizDate) {
  const [r] = await q.query<{ minutes: string | number; days: string | number }>(
    `SELECT COALESCE(SUM(minutes), 0) AS minutes, COUNT(DISTINCT occurred_on) AS days
     FROM records WHERE user_id = $1 AND plan_id = $2 AND kind = 'study' AND NOT deleted
       AND occurred_on BETWEEN $3 AND $4`, [userId, planId, from, to]);
  return { totalMinutes: integer(r!.minutes), recordDays: integer(r!.days) };
}

/**
 * 退款归入退款发生日，分类和备注来自原支出；两边使用完全相同的过滤规则。
 * keywords 按备注做不区分大小写的子串匹配，任一词命中即算。
 */
export async function ledgerQueryTotals(q: Queryable, userId: string, planId: string, from: BizDate, to: BizDate, category: Category | null, keywords: string[] | null = null) {
  const [r] = await q.query<{ spend: string | number; refund: string | number; count: string | number }>(
    `SELECT COALESCE(SUM(r.amount_cents) FILTER (WHERE r.kind = 'expense'), 0) AS spend,
            COALESCE(SUM(r.amount_cents) FILTER (WHERE r.kind = 'refund'), 0) AS refund,
            COUNT(*) FILTER (WHERE r.kind = 'expense') AS count
     FROM records r LEFT JOIN records original ON r.refund_of = original.id AND original.user_id = r.user_id AND original.plan_id = r.plan_id
     WHERE r.user_id = $1 AND r.plan_id = $2 AND r.kind IN ('expense', 'refund') AND NOT r.deleted
       AND r.occurred_on BETWEEN $3 AND $4
       AND ($5::text IS NULL OR COALESCE(CASE WHEN r.kind = 'refund' THEN original.category ELSE r.category END, '其他') = $5)
       AND ($6::text[] IS NULL OR EXISTS (
         SELECT 1 FROM unnest($6::text[]) k
         WHERE strpos(lower(COALESCE(CASE WHEN r.kind = 'refund' THEN original.note ELSE r.note END, '')), lower(k)) > 0))`,
    [userId, planId, from, to, category, keywords?.length ? keywords : null]);
  const spendCents = integer(r!.spend), refundCents = integer(r!.refund);
  return { spendCents, refundCents, netCents: integer(spendCents - refundCents), count: integer(r!.count) };
}
