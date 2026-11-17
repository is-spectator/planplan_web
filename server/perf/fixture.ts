import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db.js';
import { addDays, monthOf, weekOf } from '../src/domain/time.js';

export const fixtureId = (label: string) => {
  const s = createHash('md5').update(`planplan-perf-v1:${label}`).digest('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
export const PERF_USER = fixtureId('user');
export const LEDGER = fixtureId('plan:1');
export const STUDY = fixtureId('plan:2');
export const EMPTY_PLAN = fixtureId('plan:100');

/** Deterministic values; only called in the benchmark's newly-created schema. */
export async function seedPerformanceFixture(db: Db, today: string) {
  await db.query('INSERT INTO users (id, dev_name, ai_consent) VALUES ($1, $2, true)', [PERF_USER, 'synthetic-performance-user']);
  const plans = Array.from({ length: 100 }, (_, index) => ({
    id: fixtureId(`plan:${index + 1}`), kind: index === 0 ? 'ledger' : 'study',
    name: index === 0 ? '性能测试账本' : `性能学习计划${index + 1}`, activity: index === 0 ? null : `性能学习${index + 1}`,
  }));
  await db.query(`INSERT INTO plans (id, user_id, kind, name, activity, start_date, created_at, last_activity_at)
    SELECT p.id::uuid, $2::uuid, p.kind, p.name, p.activity, $3, $4::timestamptz, $4::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS p(id text, kind text, name text, activity text)`, [JSON.stringify(plans), PERF_USER, addDays(today, -365), `${today}T00:00:00Z`]);
  await db.query(`INSERT INTO goal_segments (plan_id, param, value, from_period)
    SELECT id, 'budget_cents', 300000, $1 FROM plans WHERE kind = 'ledger'
    UNION ALL SELECT id, 'days_per_week', 3, $2 FROM plans WHERE kind = 'study'
    UNION ALL SELECT id, 'min_minutes', 20, $2 FROM plans WHERE kind = 'study'`, [monthOf(addDays(today, -365)), weekOf(addDays(today, -365))]);
  const rows = Array.from({ length: 10_000 }, (_, i) => {
    const n = i + 1, refund = n > 6500 && n <= 7000, study = n > 7000;
    const original = n - 6500;
    const expenseDate = (id: number) => addDays(today, -((id * 13) % 365));
    return {
      id: fixtureId(`record:${n}`), plan_id: study ? fixtureId(`plan:${2 + ((n - 7001) % 98)}`) : LEDGER,
      kind: study ? 'study' : refund ? 'refund' : 'expense', amount_cents: study ? null : refund ? 50 : 100 + (n % 4900),
      minutes: study ? 5 + (n % 56) : null, category: study || refund ? null : ['餐饮', '交通', '购物', '居住', '学习', '娱乐', '其他'][n % 7],
      occurred_on: study ? addDays(today, -Math.floor((n - 7001) / 98)) : refund ? [today, addDays(expenseDate(original), 7)].sort()[0] : expenseDate(n),
      refund_of: refund ? fixtureId(`record:${original}`) : null,
    };
  });
  // Insert expenses before refunds so foreign keys do not depend on row order.
  for (let i = 0; i < rows.length; i += 500) await db.query(`INSERT INTO records
    (id, user_id, plan_id, kind, amount_cents, minutes, category, occurred_on, refund_of, source, input_at, created_at)
    SELECT r.id::uuid, $2::uuid, r.plan_id::uuid, r.kind, r.amount_cents, r.minutes, r.category, r.occurred_on,
      r.refund_of::uuid, 'form', $3::timestamptz, $3::timestamptz + (row_number() OVER()) * interval '1 microsecond'
    FROM jsonb_to_recordset($1::jsonb) AS r(id text, plan_id text, kind text, amount_cents int, minutes int, category text, occurred_on text, refund_of text)`,
    [JSON.stringify(rows.slice(i, i + 500)), PERF_USER, `${today}T00:00:00Z`]);
  await db.exec('ANALYZE plans; ANALYZE records; ANALYZE goal_segments; ANALYZE plan_lifecycle;');
  return { version: 'synthetic-v1', plans: 100, records: 10_000, expenses: 6500, refunds: 500, studyRecords: 3000, today };
}
