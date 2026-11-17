import { FIRST_WEEK_EXPECTATIONS, judgeFirstWeek } from './first-week-expectations.js';
import type { Llm } from '../src/ai/llm.js';
import { Chat, type Card } from '../src/services/chat.js';
import type { EvalCase } from './cases.js';
import { INPUT_AT, makeFixture, type Fixture } from './fixtures.js';
import { judgeQuery } from './query-expectations.js';

// ───────── 数据快照与差异 ─────────

interface Snap {
  records: Map<string, { kind: string; amount_cents: number | null; minutes: number | null; category: string | null; occurred_on: string; plan_id: string; version: number; deleted: boolean; refund_of: string | null }>;
  plans: Map<string, { kind: string; name: string; activity: string | null; status: string; view_config: unknown }>;
  segments: Set<number>;
}

async function snap(fx: Fixture): Promise<Snap> {
  const records = await fx.db.query<{ id: string } & Snap['records'] extends Map<string, infer V> ? V & { id: string } : never>(`SELECT id, kind, amount_cents, minutes, category, occurred_on, plan_id, version, deleted, refund_of FROM records WHERE user_id = $1`, [fx.userId]);
  const plans = await fx.db.query<{ id: string; kind: string; name: string; activity: string | null; status: string; view_config: unknown }>(`SELECT id, kind, name, activity, status, view_config FROM plans WHERE user_id = $1`, [fx.userId]);
  const segs = await fx.db.query<{ seq: number }>(`SELECT g.seq FROM goal_segments g JOIN plans p ON p.id = g.plan_id WHERE p.user_id = $1 AND NOT g.revoked`, [fx.userId]);
  return {
    records: new Map(records.map((r) => [r.id, r])),
    plans: new Map(plans.map((p) => [p.id, p])),
    segments: new Set(segs.map((s) => Number(s.seq))),
  };
}

interface Diff {
  created: { id: string; kind: string; yuan: number | null; minutes: number | null; category: string | null; date: string; planId: string; refundOf: string | null }[];
  edited: { id: string; yuan: number | null; minutes: number | null; category: string | null; date: string }[];
  deleted: string[];
  newPlans: { id: string; kind: string; name: string; activity: string | null }[];
  planChanges: { id: string; renamed?: string; status?: string; view?: boolean; viewConfig?: { order?: string[]; hidden?: string[] } }[];
  newSegments: { planId: string; param: string; value: number; from: string; to: string | null }[];
}

async function diff(fx: Fixture, a: Snap, b: Snap): Promise<Diff> {
  const d: Diff = { created: [], edited: [], deleted: [], newPlans: [], planChanges: [], newSegments: [] };
  for (const [id, r] of b.records) {
    const old = a.records.get(id);
    const yuan = r.amount_cents === null ? null : r.amount_cents / 100;
    if (!old) {
      if (!r.deleted) d.created.push({ id, kind: r.kind, yuan, minutes: r.minutes, category: r.category, date: r.occurred_on, planId: r.plan_id, refundOf: r.refund_of });
    } else if (r.deleted && !old.deleted) d.deleted.push(id);
    else if (!r.deleted && r.version !== old.version) d.edited.push({ id, yuan, minutes: r.minutes, category: r.category, date: r.occurred_on });
  }
  for (const [id, p] of b.plans) {
    const old = a.plans.get(id);
    if (!old) d.newPlans.push({ id, kind: p.kind, name: p.name, activity: p.activity });
    else {
      const ch: Diff['planChanges'][number] = { id };
      if (old.name !== p.name) ch.renamed = p.name;
      if (old.status !== p.status) ch.status = p.status;
      if (JSON.stringify(old.view_config) !== JSON.stringify(p.view_config)) { ch.view = true; ch.viewConfig = p.view_config as { order?: string[]; hidden?: string[] }; }
      if (ch.renamed || ch.status || ch.view) d.planChanges.push(ch);
    }
  }
  for (const id of a.plans.keys()) if (!b.plans.has(id)) d.planChanges.push({ id, status: 'removed' });
  const fresh = [...b.segments].filter((s) => !a.segments.has(s));
  if (fresh.length) {
    const rows = await fx.db.query<{ plan_id: string; param: string; value: number; from_period: string; to_period: string | null }>(`SELECT plan_id, param, value, from_period, to_period FROM goal_segments WHERE seq = ANY($1::int[])`, [fresh]);
    d.newSegments = rows.map((r) => ({ planId: r.plan_id, param: r.param, value: r.value, from: r.from_period, to: r.to_period }));
  }
  return d;
}

const isEmptyDiff = (d: Diff) => !d.created.length && !d.edited.length && !d.deleted.length && !d.newPlans.length && !d.planChanges.length && !d.newSegments.length;

function scopeOf(seg: { param: string; from: string; to: string | null }): string {
  const current = seg.param === 'budget_cents' ? '2026-10' : '2026-10-26';
  if (seg.to === seg.from && seg.from === current) return 'current_only';
  if (seg.from === current && seg.to === null) return 'current_and_future';
  return 'next_and_future';
}

// ───────── 判定 ─────────

export interface Result {
  c: EvalCase;
  pass: boolean;
  reason: string;
  latencyMs: number;
  executedOneTurn: boolean;
  wrongFactWrites: number;
  reply: string;
  cards: string[];
}

const near = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 0.001;

function judge(c: EvalCase, fx: Fixture, d: Diff, cards: Card[], replyText: string): { pass: boolean; reason: string } {
  const e = c.expect;
  const planOf = (ref: string) => (ref === 'ledger' ? fx.plans.ledger : ref === 'read' ? fx.plans.read : fx.plans.eng);
  const clarifyOpen = cards.some((x) => x.type === 'clarify' && x.status === 'open');
  const queryKinds = cards.filter((x): x is Extract<Card, { type: 'query' }> => x.type === 'query').map((x) => x.kind);
  const describe = () => JSON.stringify({ created: d.created.map((r) => [r.kind, r.yuan ?? r.minutes, r.category, r.date]), edited: d.edited.length, deleted: d.deleted.length, plans: d.newPlans.length, changes: d.planChanges.length, segs: d.newSegments.map((s) => [s.param, s.value]), clarify: clarifyOpen, query: queryKinds });

  switch (e.kind) {
    case 'records': {
      if (d.created.length !== e.records.length || d.edited.length || d.deleted.length) return { pass: false, reason: `期望保存 ${e.records.length} 条，实际 ${describe()}` };
      const pool = [...d.created];
      for (const want of e.records) {
        const i = pool.findIndex((got) => {
          if (got.kind !== want.k) return false;
          if (want.yuan !== undefined && !near(got.yuan, want.yuan)) return false;
          if (want.minutes !== undefined && got.minutes !== want.minutes) return false;
          if (want.date !== undefined && got.date !== want.date) return false;
          if (want.plan && got.planId !== planOf(want.plan)) return false;
          if (want.category && got.category !== want.category) return false;
          return true;
        });
        if (i < 0) return { pass: false, reason: `没有找到 ${JSON.stringify(want)}；实际 ${describe()}` };
        pool.splice(i, 1);
      }
      return { pass: true, reason: '' };
    }
    case 'clarify':
      if (!isEmptyDiff(d)) return { pass: false, reason: `期望追问且不保存，实际 ${describe()}` };
      if (e.issue || e.options) {
        const candidates = cards.filter((x) => x.type === 'clarify' && x.status === 'open');
        if (candidates.length !== 1 || candidates[0]!.type !== 'clarify') return { pass: false, reason: '缺少唯一的确定性确认卡' };
        const confirmation = candidates[0]!;
        if (e.issue && !confirmation.items.some((item) => item.issue === e.issue)) return { pass: false, reason: '确认原因不符' };
        if (e.options && JSON.stringify(confirmation.options.map((option) => option.label)) !== JSON.stringify(e.options)) return { pass: false, reason: '确认选项不符' };
      }
      // 有待补充卡片，或回复本身是在追问缺少的信息，都算追问。
      return clarifyOpen || /[？?]/.test(replyText) ? { pass: true, reason: '' } : { pass: false, reason: `期望追问，实际没有追问 ${describe()}` };
    case 'no_write':
      return isEmptyDiff(d) ? { pass: true, reason: '' } : { pass: false, reason: `期望不写入，实际 ${describe()}` };
    case 'query':
      if (!isEmptyDiff(d)) return { pass: false, reason: `查询产生了写入 ${describe()}` };
      return judgeQuery(c.id, fx, cards);
    case 'plan': {
      const p = d.newPlans.find((x) => x.kind === e.plan.kind);
      if (!p || d.created.length) return { pass: false, reason: `期望新建 ${e.plan.kind}，实际 ${describe()}` };
      const segs = d.newSegments.filter((s) => s.planId === p.id);
      const val = (param: string) => segs.find((s) => s.param === param)?.value ?? null;
      if (e.plan.budgetYuan !== undefined && val('budget_cents') !== (e.plan.budgetYuan === null ? null : e.plan.budgetYuan * 100)) return { pass: false, reason: `预算不符：${val('budget_cents')}` };
      if (e.plan.days !== undefined && val('days_per_week') !== e.plan.days) return { pass: false, reason: `每周天数不符：${val('days_per_week')}` };
      if (e.plan.minutes !== undefined && val('min_minutes') !== e.plan.minutes) return { pass: false, reason: `每日分钟不符：${val('min_minutes')}` };
      if (e.plan.name && p.name !== e.plan.name) return { pass: false, reason: `名称不符：${p.name}` };
      if (e.plan.activity && !`${p.name}${p.activity ?? ''}`.includes(e.plan.activity)) return { pass: false, reason: `活动不符：${p.name}/${p.activity}` };
      return { pass: true, reason: '' };
    }
    case 'goal': {
      if (d.created.length || d.newPlans.length) return { pass: false, reason: `调整目标时产生了其他写入 ${describe()}` };
      for (const g of e.goals) {
        const s = d.newSegments.find((x) => x.planId === planOf(g.plan) && x.param === g.param && x.value === g.value);
        if (!s) return { pass: false, reason: `没有找到目标 ${JSON.stringify(g)}；实际 ${JSON.stringify(d.newSegments)}` };
        if (g.scope && scopeOf(s) !== g.scope) return { pass: false, reason: `生效范围不符：期望 ${g.scope}，实际 ${scopeOf(s)}` };
      }
      return { pass: true, reason: '' };
    }
    case 'edit': {
      if (d.created.length || d.deleted.length || d.edited.length !== e.edits.length) return { pass: false, reason: `期望修改 ${e.edits.length} 条，实际 ${describe()}` };
      for (const want of e.edits) {
        const got = d.edited.find((x) => x.id === fx.records[want.target]);
        if (!got) return { pass: false, reason: `没有修改 ${want.target}` };
        if (want.yuan !== undefined && !near(got.yuan, want.yuan)) return { pass: false, reason: `金额不符：${got.yuan}` };
        if (want.minutes !== undefined && got.minutes !== want.minutes) return { pass: false, reason: `时长不符：${got.minutes}` };
        if (want.category && got.category !== want.category) return { pass: false, reason: `分类不符：${got.category}` };
        if (want.date && got.date !== want.date) return { pass: false, reason: `日期不符：${got.date}` };
      }
      return { pass: true, reason: '' };
    }
    case 'delete':
    case 'undo': {
      const want = e.targets.map((t) => fx.records[t]).sort();
      const got = [...d.deleted].sort();
      if (d.created.length || d.edited.length || JSON.stringify(want) !== JSON.stringify(got)) return { pass: false, reason: `期望移除 ${e.targets.join(',')}，实际 ${describe()}` };
      return { pass: true, reason: '' };
    }
    case 'plan_update': {
      const ch = d.planChanges.find((x) => x.id === planOf(e.plan));
      if (!ch || d.planChanges.length !== 1 || d.created.length || d.edited.length || d.deleted.length || d.newPlans.length || d.newSegments.length) return { pass: false, reason: `期望只调整指定计划，实际 ${describe()}` };
      if (e.change === 'renamed' && ch.renamed !== e.name) return { pass: false, reason: `名称不符：${ch.renamed}` };
      if (e.change === 'archived' && ch.status !== 'archived') return { pass: false, reason: `没有归档` };
      if (e.change === 'view' && !ch.view) return { pass: false, reason: `页面没有变化` };
      if (e.change === 'view' && (ch.renamed || ch.status)) return { pass: false, reason: '调整页面时改变了名称或归档状态' };
      if (e.order && JSON.stringify(ch.viewConfig?.order) !== JSON.stringify(e.order)) return { pass: false, reason: '组件排列顺序不符' };
      if (e.hidden && JSON.stringify([...(ch.viewConfig?.hidden ?? [])].sort()) !== JSON.stringify([...e.hidden].sort())) return { pass: false, reason: '隐藏组件不符' };
      return { pass: true, reason: '' };
    }
  }
}

export async function runCase(c: EvalCase, i: number, llm: Llm, fixtureEnv?:NodeJS.ProcessEnv): Promise<Result> {
  const fx = await makeFixture(c.fixture ?? 'default',fixtureEnv);
  try {
    const chat = new Chat(fx.db, llm);
    const scopePlanId = c.scope ? fx.plans[c.scope] : null;
    const started = Date.now();
    let reply: Awaited<ReturnType<Chat['send']>> | undefined;
    let pass = true;
    let reason = '';
    let executedOneTurn = false;
    let wrongFactWrites = 0;
    const steps = [{ text: c.text, expect: c.expect, choiceLabel: undefined as string | undefined, chooseOnlyOption: undefined as true | undefined, inputAt: c.inputAt }, ...(c.followUps ?? [])];
    for (const [stepIndex, step] of steps.entries()) {
      const before = await snap(fx);
      const pending = reply?.assistant.cards.find((x) => x.type === 'clarify' && x.status === 'open');
      const options = pending?.type === 'clarify' ? pending.options.filter(option => option.style !== 'cancel') : [];
      if (step.chooseOnlyOption && (step.choiceLabel || stepIndex === 0 || steps[stepIndex - 1]!.expect.kind !== 'clarify' || options.length !== 1)) {
        pass = false; reason = `第 ${stepIndex + 1} 轮没有可唯一选择的已验收澄清选项`; break;
      }
      // This choice uses only the preceding server-issued card after its zero-write oracle passed.
      const choice = step.chooseOnlyOption ? options[0] : pending?.type === 'clarify' && step.choiceLabel ? pending.options.find((x) => x.label === step.choiceLabel) : undefined;
      if (step.choiceLabel && !choice) { pass = false; reason = `第 ${stepIndex + 1} 轮没有选项 ${step.choiceLabel}`; break; }
      // The first provider failure is evidence, not permission for an invisible retry.
      // A new evaluation invocation can explicitly retry the whole isolated case.
      reply = await chat.send(fx.userId, { clientMsgId: `eval-${c.id}-${i}-${stepIndex}`, text: step.text, inputAt: step.inputAt ? new Date(step.inputAt) : c.inputAt ? new Date(c.inputAt) : INPUT_AT, scopePlanId, ...(choice && pending?.type === 'clarify' ? { pendingId: pending.pendingId, choice: choice.id } : {}) });
      const d = await diff(fx, before, await snap(fx));
      const cards = reply!.assistant.cards;
      let checked = reply!.transient ? { pass: false, reason: '模型服务不可用' } : judge({ ...c, id: stepIndex ? `${c.id}.${stepIndex}` : c.id, expect: step.expect }, fx, d, cards, reply!.assistant.text);
      if (checked.pass && FIRST_WEEK_EXPECTATIONS[c.id]) checked = await judgeFirstWeek(c.id, stepIndex, fx, cards);
      if (!checked.pass) { pass = false; reason ||= `第 ${stepIndex + 1} 轮：${checked.reason}`; }
      const guarded = ['no_write', 'clarify', 'query'].includes(step.expect.kind);
      if (guarded) wrongFactWrites += d.created.length + d.edited.length + d.deleted.length + d.newPlans.length + d.planChanges.length + d.newSegments.length;
      if (stepIndex === 0) executedOneTurn = checked.pass && step.expect.kind === 'records' && d.created.length > 0 && !cards.some((x) => x.type === 'clarify');
      if (!checked.pass) break; // 失败后的脚本前提已经不成立，不能继续来掩盖失败。
    }
    return { c, pass, reason, latencyMs: Date.now() - started, executedOneTurn, wrongFactWrites,
      reply: reply?.assistant.text ?? '', cards: reply?.assistant.cards.map((x) => x.type === 'query' ? `query:${x.kind}` : x.type) ?? [] };

  } finally {
    await fx.db.close();
  }
}
