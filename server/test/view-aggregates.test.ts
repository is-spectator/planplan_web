import { expect, it } from 'vitest';
import { openTestDb } from './database.js';
import { seedPerformanceFixture, PERF_USER, LEDGER, STUDY } from '../perf/fixture.js';
import { ledgerMonthStats, type ExpenseFact, type RefundFact } from '../src/domain/ledger.js';
import { studyWeekStats } from '../src/domain/study.js';
import { valueAt } from '../src/domain/rules.js';
import { weekOf } from '../src/domain/time.js';
import { getPlan, planRecords, segments } from '../src/services/repo.js';
import { ledgerStatsFor, ledgerView, planCards, studyView } from '../src/services/views.js';
import { Chat } from '../src/services/chat.js';
import { FakeLlm } from '../src/ai/llm.js';

it('100 plans/10k records retain the independent domain totals, refunds and session counts with bounded SQL calls', async () => {
  const db = await openTestDb(); const today = '2026-10-27';
  await seedPerformanceFixture(db, today);
  const ledger = await getPlan(db, PERF_USER, LEDGER);
  const rows = await planRecords(db, LEDGER);
  const expenses: ExpenseFact[] = rows.filter((r) => r.kind === 'expense').map((r) => ({ id: r.id, amountCents: r.amount_cents!, date: r.occurred_on, category: r.category ?? '其他' }));
  const refunds: RefundFact[] = rows.filter((r) => r.kind === 'refund').map((r) => ({ id: r.id, amountCents: r.amount_cents!, date: r.occurred_on, refundOf: r.refund_of! }));
  const rules = await segments(db, LEDGER);
  for (const month of ['2026-10', '2026-09', '2025-10', '2020-01']) {
    const expected = ledgerMonthStats(month, expenses, refunds, valueAt(rules, 'budget_cents', month));
    expect(await ledgerStatsFor(db, ledger, month)).toEqual(expected);
    const view = await ledgerView(db, PERF_USER, LEDGER, month, 20, 20);
    expect(view.stats).toEqual(expected);
    for (const record of view.records) {
      expect(record.date.startsWith(month)).toBe(true);
      if (record.kind === 'expense') expect(record.refundedCents).toBe(refunds.filter((r) => r.refundOf === record.id).reduce((a, r) => a + r.amountCents, 0));
    }
  }
  expect((await ledgerView(db, PERF_USER, LEDGER, '2026-10', 20, 1.5)).records).toEqual((await ledgerView(db, PERF_USER, LEDGER, '2026-10', 20, 1)).records);
  expect((await ledgerView(db, PERF_USER, LEDGER, '2026-10', 20, Infinity)).records).toEqual([]);
  // More than one session on one date must retain its count after SUM grouping.
  await db.query(`INSERT INTO records (user_id, plan_id, kind, minutes, occurred_on, source, input_at)
    VALUES ($1, $2, 'study', 7, $3, 'form', now()), ($1, $2, 'study', 13, $3, 'form', now())`, [PERF_USER, STUDY, today]);
  const study = await getPlan(db, PERF_USER, STUDY), studyRows = await planRecords(db, STUDY), studyRules = await segments(db, STUDY);
  const week = weekOf(today);
  const expected = studyWeekStats({ week, planStart: study.start_date, today,
    records: studyRows.map((r) => ({ date: r.occurred_on, minutes: r.minutes! })),
    daysPerWeek: valueAt(studyRules, 'days_per_week', week), minMinutes: valueAt(studyRules, 'min_minutes', week), interrupted: false });
  expect((await studyView(db, PERF_USER, STUDY, week, today)).stats).toEqual(expected);
  let calls = 0;
  const cards = await planCards({ query: async <T>(sql: string, p?: unknown[]) => { calls++; return db.query<T>(sql, p); } }, PERF_USER, today, 'active');
  expect(cards.plans).toHaveLength(100); expect(calls).toBeLessThanOrEqual(6);
  const card = cards.plans.find((p) => p.plan.id === STUDY)!.study!;
  expect(card.totalMinutes).toBe(expected.totalMinutes); expect(card.metDays).toBe(expected.metDays);
  expect(card.todayMinutes).toBe(expected.days.find((d) => d.date === today)!.minutes);
  let goalQueries = 0;
  const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '测试完成' }));
  const chat = new Chat({ ...db, exec: db.exec.bind(db), tx: db.tx.bind(db), close: db.close.bind(db),
    query: async <T>(sql: string, p?: unknown[]) => { if (sql.includes('FROM goal_segments')) goalQueries++; return db.query<T>(sql, p); } }, llm);
  await chat.send(PERF_USER, { clientMsgId: 'performance-context-check', inputAt: new Date('2026-10-27T04:00:00Z'), text: '你好' });
  expect(goalQueries).toBe(1);
  expect(llm.calls[0]!.system).toContain('性能学习计划100');
  expect(llm.calls[0]!.system).toContain('每周 3 天，每天 20 分钟');
}, 20_000);

it('SQL aggregation excludes soft deletes and retains archived-week and incomplete-goal semantics', async () => {
  const db = await openTestDb();
  const [user] = await db.query<{ id: string }>("INSERT INTO users (dev_name) VALUES ('aggregate-edge') RETURNING id");
  const [plan] = await db.query<{ id: string }>("INSERT INTO plans (user_id, kind, name, start_date) VALUES ($1, 'study', 'edge', '2026-10-25') RETURNING id", [user!.id]);
  await db.query("INSERT INTO goal_segments (plan_id, param, value, from_period) VALUES ($1, 'days_per_week', 7, '2026-10-19'), ($1, 'min_minutes', 20, '2026-10-19')", [plan!.id]);
  await db.query("INSERT INTO plan_lifecycle (plan_id, event, on_date) VALUES ($1, 'archived', '2026-10-26'), ($1, 'restored', '2026-10-27')", [plan!.id]);
  await db.query("INSERT INTO records (user_id, plan_id, kind, minutes, occurred_on, source, input_at, deleted) VALUES ($1, $2, 'study', 50, '2026-10-27', 'form', now(), false), ($1, $2, 'study', 70, '2026-10-27', 'form', now(), true)", [user!.id, plan!.id]);
  const view = await studyView(db, user!.id, plan!.id, '2026-10-26', '2026-10-27');
  expect(view.stats).toMatchObject({ interrupted: true, metDays: null, totalMinutes: 50 });
  expect(view.previous?.targetDays).toBe(1);
  await db.query("UPDATE goal_segments SET revoked = true WHERE plan_id = $1 AND param = 'min_minutes'", [plan!.id]);
  const cards = await planCards(db, user!.id, '2026-10-27', 'active');
  expect(cards.plans[0]!.study).toMatchObject({ goalComplete: false, targetDays: null, metDays: null, totalMinutes: 50 });
});

it('SQL pagination uses a unique tie-breaker for records created in the same batch', async () => {
  const db = await openTestDb();
  const [user] = await db.query<{id:string}>("INSERT INTO users(dev_name) VALUES('paging-ties') RETURNING id");
  const [plan] = await db.query<{id:string}>("INSERT INTO plans(user_id,kind,name,start_date) VALUES($1,'ledger','fixture','2026-10-27') RETURNING id", [user!.id]);
  const rows = await db.query<{id:string}>(`INSERT INTO records(user_id,plan_id,kind,amount_cents,category,occurred_on,source,input_at,created_at)
    SELECT $1,$2,'expense',100,'其他','2026-10-27','form',now(),now() FROM generate_series(1,4) RETURNING id`, [user!.id,plan!.id]);
  const got:string[] = [];
  for(let offset=0;offset<4;offset++) got.push(...(await ledgerView(db,user!.id,plan!.id,'2026-10',1,offset)).records.map(r=>r.id));
  expect(got).toEqual(rows.map(r=>r.id).sort().reverse());
  expect(new Set(got).size).toBe(4);
});
