import { unsupportedTemplatePlans } from './template-capabilities.js';
import { recordWithRefundSnapshot } from './refund-snapshot.js';
import { actionKey, hasDuplicate } from './duplicates.js';
import { linkRequest } from './entry.js';
import { attemptRequestDigest } from '../ai/usage-store.js';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import type { Llm } from '../ai/llm.js';
import { LlmError } from '../ai/llm.js';
import { aiFailureMessage } from '../ai/user-feedback.js';
import { buildSystemPrompt } from '../ai/prompt.js';
import type { Turn, TurnQuery, TurnWrite } from '../ai/turn.js';
import { formatYuan, parseYuanToCents, isValidCents } from '../domain/money.js';
import { resolveDateExpr, shanghaiDate, shanghaiTime, weekdayCN, weekOf, nextWeek, addDays, formatMonthDay, type BizDate } from '../domain/time.js';
import { firstWeekAvailableDays, isValidDaysPerWeek } from '../domain/study.js';
import { valueAt } from '../domain/rules.js';
import { DomainError } from './errors.js';
import type { GrowthDelta } from './growth.js';
import { execute, findOperation, undo, NEW_STUDY_PLAN, type Action, type ItemResult, type OperationResult } from './engine.js';
import { activeRefunds, getPlan, getRecord, listPlans, segments, segmentsForPlans, type PlanRow, type RecordRow } from './repo.js';
import { componentOrder, planCard, recordView, type PlanCard, type RecordView } from './views.js';
import { runQuery, type QueryCard } from './query.js';
import { itemsText, queryText, recordText } from './describe.js';
import { usage, usageQuery } from './usage.js';
import { clarificationCategory, logEvent } from './events.js';
import { matchStudyByActivity } from './match.js';
import { getPlanTemplate } from './templates.js';
import { validateGenericRecordValues, validateGenericConfigValues, prepareGenericRecordValues } from './generic.js';
import { genericTurnValues, genericRecordDefaultsFromTurn, isGenericWrite, isConfigurationWrite, mergeGenericAnswer } from './chat-generic.js';

// ───────────────────────── 卡片与消息 ─────────────────────────

export interface ClarifyOption {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'cancel';
}

export type Card =
  | { type: 'receipt'; operationId: string; kind: 'batch' | 'undo'; undoable: boolean; items: ItemResult[]; current?: Record<string, 'same' | 'modified' | 'deleted'>; growth?: GrowthDelta }
  | { type: 'plan'; card: PlanCard; note: string }
  | QueryCard
  | { type: 'clarify'; pendingId: string; question: string; items: { summary: string; ready: boolean; issue: string | null }[]; options: ClarifyOption[]; hint: string; status: 'open' | 'resolved' | 'cancelled' }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'notice'; tone: 'info' | 'warn'; text: string };

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: Card[];
  scopePlanId: string | null;
  clientMsgId: string | null;
  createdAt: string;
}

export interface ChatInput {
  clientMsgId: string;
  text: string;
  inputAt: Date;
  scopePlanId?: string | null;
  pendingId?: string | null;
  choice?: string | null;
  templateCapability?: boolean;
  genericCapability?: boolean;
  ledgerTemplateCapability?: boolean;
  recoveryCapability?: boolean;
  privateTemplateCapability?: boolean;
  genericTemplateV2Capability?: boolean;
  communityTemplateCapability?: boolean;
}

export interface ChatReply {
  user: MessageView;
  assistant: MessageView;
  dataVersion: number;
  /** true 表示这次回复没有被保存（例如模型暂时不可用），客户端可以用同一个 clientMsgId 重试。 */
  transient: boolean;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: Card[];
  scope_plan_id: string | null;
  client_msg_id: string | null;
  reply_to: string | null;
  created_at: Date;
}

const msgView = (m: MessageRow): MessageView => ({
  id: m.id,
  role: m.role,
  text: m.text,
  cards: m.cards,
  scopePlanId: m.scope_plan_id,
  clientMsgId: m.client_msg_id,
  createdAt: new Date(m.created_at).toISOString(),
});

// ───────────────────────── 待补充 ─────────────────────────

type Patch =
  | { k: 'set'; idx: number; field: keyof TurnWrite; value: unknown }
  | { k: 'remove'; idx: number }
  | { k: 'first_week'; writeKey: string; mode: 'adjust' | 'next' }
  | { k: 'duplicate'; actionKey: string }
  | { k: 'create_ledger_first' }
  | { k: 'create_study_first'; activity: string }
  | { k: 'restore_first'; planId: string }
  | { k: 'undo_operation'; operationId: string }
  | { k: 'confirm_refund_delete'; recordId: string; token: string }
  | { k: 'delete_target'; idx: number; recordId: string; version: number }
  | { k: 'cancel' };

interface DraftOption extends ClarifyOption {
  patches: Patch[];
}

interface Draft {
  rounds?: number;
  writes: TurnWrite[];
  query: TurnQuery | null;
  scopePlanId: string | null;
  pre: { createLedger: boolean; createStudy: string | null; restore: string[]; firstWeek?: { writeKey: string; mode: 'adjust' | 'next' }[]; duplicates?: string[]; undoOperationId?: string; refundDeleteSnapshots?: Record<string, string>; deleteTargets?: Record<string, number> };
  originalText?: string;
  fixedWrites?: number[];
  options: DraftOption[];
  messageId: string;
}

interface PendingRow {
  id: string;
  draft: Draft;
  status: 'open' | 'resolved' | 'cancelled';
  input_at: Date;
  message_id: string | null;
}

// ───────────────────────── 解析每一条写入 ─────────────────────────

type ReadingTemplate = Awaited<ReturnType<typeof getPlanTemplate>>;

interface Env {
  reading: Map<string, ReadingTemplate>;
  templates: Map<string, ReadingTemplate>;
  templateCapability: boolean;
  genericCapability: boolean;
  ledgerTemplateCapability: boolean;
  privateTemplateCapability: boolean;
  genericTemplateV2Capability: boolean;
  communityTemplateCapability: boolean;
  unsupportedPlanIds: Set<string>;
  answering: boolean;
  plans: PlanRow[];
  scope: PlanRow | null;
  today: BizDate;
  inputAt: Date;
  pre: Draft['pre'];
  lastRecords: RecordRow[];
  undoReceipts: { result: OperationResult; undone: boolean }[];
  /** 同一批里有新建学习计划时，未指定计划的学习记录归入它。 */
  batchStudy: string | null;
  /** 用户原话，用于按提到的计划名称定位计划。 */
  text: string;
  /** Unmodified server-stored pending writes, before a choice or model reply narrows them. */
  originalWrites?: TurnWrite[];
  /** Choice labels are not used for record resolution, but their request text is still checked. */
  deletionText?: string;
}

type Resolved =
  | { k: 'actions'; actions: Action[]; summary: string }
  | { k: 'missing'; summary: string; issue: string; question: string; options: DraftOption[] }
  | { k: 'notice'; text: string; cards?: Card[] }
  | { k: 'undo'; operationId: string }
  | { k: 'blocked'; text: string };

const opt = (label: string, patches: Patch[], style: ClarifyOption['style'] = 'secondary'): DraftOption => ({ id: randomUUID().slice(0, 8), label, style, patches });

/** 只识别意图，不授权。批准来自持久化的服务端 choice，模型没有对应输入字段。 */
function firstWeekDecision(w: TurnWrite, env: Env, planStart: BizDate): { mode: 'adjust' | 'next' | null; available: number; question?: Extract<Resolved, { k: 'missing' }> } {
  const available = firstWeekAvailableDays(planStart);
  const explicit = w.goal_period === 'this_week' || w.scope === 'current_only' || /(?:本周|这周|这个星期)[^，。！？;；]{0,30}[一二三四五六七两1-7]\s*天/.test(env.text);
  if (!explicit || w.days_per_week === null || !isValidDaysPerWeek(w.days_per_week) || w.days_per_week <= available || weekOf(planStart) !== weekOf(env.today)) return { mode: null, available };
  // JSONB 读取后属性顺序会改变；规范顺序保证同一草稿跨持久化仍匹配。
  const writeKey = JSON.stringify(Object.fromEntries(Object.entries(w).sort(([a], [b]) => a.localeCompare(b))));
  const approved = env.pre.firstWeek?.find((c) => c.writeKey === writeKey);
  if (approved) return { mode: approved.mode, available };
  const end = addDays(weekOf(planStart), 6);
  return { mode: null, available, question: {
    k: 'missing', summary: `本周目标 ${w.days_per_week} 天`, issue: '本周目标超过首周可用天数',
    question: `从计划开始日期 ${planStart} 到 ${end}，首周可用 ${available} 天，无法在本周完成 ${w.days_per_week} 天。按 ${available} 天调整本周目标，还是从 ${nextWeek(weekOf(env.today))} 开始？`,
    options: [opt(`本周按 ${available} 天`, [{ k: 'first_week', writeKey, mode: 'adjust' }], 'primary'), opt('从下周开始', [{ k: 'first_week', writeKey, mode: 'next' }])],
  } };
}

/** Advisory check uses original input time so delayed offline uploads retain their ordering semantics. */
async function duplicateChoice(q: Queryable, userId: string, r: Resolved, env: Env): Promise<Resolved> {
  if (r.k !== 'actions' || r.actions.length !== 1) return r;
  const a = r.actions[0]!;
  if (env.pre.duplicates?.includes(actionKey(a)) || !(await hasDuplicate(q, userId, a, env.inputAt))) return r;
  return { k: 'missing', summary: r.summary, issue: '疑似重复记录',
    question: `在这次输入前后 2 分钟内已经记过相同内容（${r.summary}）。这是又发生了一次吗？`,
    options: [opt('又发生了一次，仍要保存', [{ k: 'duplicate', actionKey: actionKey(a) }], 'primary')],
  };
}

function minutesOf(w: TurnWrite): { minutes: number | null; bad: boolean } {
  if (w.duration_value === null) return { minutes: null, bad: false };
  const m = w.duration_unit === 'hour' ? w.duration_value * 60 : w.duration_value;
  if (!Number.isInteger(m)) return { minutes: null, bad: true };
  return { minutes: m, bad: false };
}

function dateOf(w: TurnWrite, inputAt: Date): BizDate | 'future' | null {
  if (w.date_kind === 'future') return 'future';
  const d = resolveDateExpr(
    w.date_kind === 'days_ago' ? { kind: 'days_ago', days: w.days_ago ?? -1 } : w.date_kind === 'absolute' ? { kind: 'absolute', date: w.date ?? '' } : { kind: w.date_kind as 'today' | 'yesterday' | 'day_before_yesterday' | 'unknown' },
    inputAt,
  );
  if (d && d > shanghaiDate(inputAt)) return 'future';
  return d;
}

const DELETE_REVIEW_TEXT = '删除需要逐条核对。请到计划详情打开具体记录，或一次明确说明一条要删除的记录。这次没有删除或保存任何内容。';

/** Recent model context is a bounded sample, never authorization to clear a range. */
function broadRecordDeletion(text: string): boolean {
  const deletion = /删|清空|清除|清掉|清理|移除|抹掉|抹除|\b(?:delete|remove|clear|erase|wipe)\b/iu;
  // A range and its verb may be separated by punctuation or a newline. Remove
  // only explicit preservation of the other records before checking the whole
  // request; "delete this one, keep all others" is still a single deletion.
  let request = text.normalize('NFKC').split(/[，,。.!！？?；;：:\n]/u).filter(clause => {
    const keepOthers = /其他|其余|剩余|剩下|别的/u.test(clause)
      && /保留|不删|不要删|别删|不动|别动|保持/u.test(clause)
      && !/(?:不|不要|别)\s*保留/u.test(clause);
    const affirmative = clause.replace(/(?:不要|别|不必|不用|无需|不)\s*(?:删(?:除|掉|去)?|清空|移除)/gu, '');
    return !keepOthers || deletion.test(affirmative);
  }).join(' ');
  if (!deletion.test(request)) return false;
  // Only the refund portion of one explicit parent may use a range word. Do
  // not exempt the entire request: another "all records" clause stays blocked.
  const parents = request.match(/(?:这|那|该|一)[条笔](?:支出|消费|记录)/gu) ?? [];
  if (parents.length === 1) {
    request = request
      .replace(/(?:它|其)(?:的)?\s*(?:全部|所有|全都)(?:的)?\s*(?:(?:关联|对应)(?:的)?)?\s*退款/gu, '退款')
      .replace(/(?:全部|所有|全都)(?:的)?\s*(?:关联|对应)(?:的)?\s*退款/gu, '退款')
      .replace(/(?:关联|对应)(?:的)?\s*(?:全部|所有|全都)(?:的)?\s*退款/gu, '退款')
      .replace(/((?:它|其)(?:的)?(?:(?:关联|对应)(?:的)?)?退款|(?:关联|对应)(?:的)?退款)\s*(?:全部|全都|都)(?=\s*(?:删|移除|清除))/gu, '$1');
  }
  return /所有|全部|全都|全量|全删|删光|统统|批量|整批|每一?[条笔]|[这那]些|[这那]几[条笔]|[两二三四五六七八九十2-9][条笔]|(?:记录|数据|支出|退款).{0,8}都|都\s*(?:删|清空|移除)|\b(?:all|everything|every)\b/iu.test(request)
    || /清空.{0,20}(?:计划|账本|记录|数据|历史|明细|支出|退款)|(?:计划|账本|记录|数据|历史|明细).{0,12}清空/u.test(request);
}

function unsafeChatDeletion(writes: TurnWrite[], env: Env): boolean {
  const deletes = writes.filter(write => write.op === 'delete_record'
    || write.op === 'undo_last' && /删/u.test(env.text) && !/撤销|撤回|取消/u.test(env.text));
  return broadRecordDeletion(env.deletionText ?? env.text)
    || deletes.length > 0 && (writes.length !== 1 || env.pre.createLedger || !!env.pre.createStudy);
}

/** 同一批里重复的建账本合并为一个；还没有账本时，“建账本 + 设预算”合并为“建账本并带预算”。 */
function normalizeWrites(writes: TurnWrite[], env: Env): TurnWrite[] {
  // 用户说的是“删”而不是“撤销”：按删除处理，上一次保存了多条时由删除逻辑列出候选（PRD 9.4）。
  if (/删/.test(env.text) && !/撤销|撤回|取消/.test(env.text)) writes = writes.map((x) => (x.op === 'undo_last' ? { ...x, op: 'delete_record' as const, record_id: null } : x));
  // 小数小时换算不成整分钟时（如 1.33 小时），不让模型自行取整，交给追问（PRD 7.1）。
  const decimalHours = [...env.text.matchAll(/(\d+\.\d+)\s*个?小时/g)].map((m) => Number(m[1]));
  const fractional = decimalHours.find((h) => !Number.isInteger(Math.round(h * 60 * 1000) / 1000));
  if (fractional !== undefined) writes = writes.map((x) => (x.op === 'add_study' || x.op === 'day_total_claim' ? { ...x, duration_value: fractional, duration_unit: 'hour' as const } : x));
  // Official reading settings stay versioned; legacy study keeps its existing goal path.
  writes = writes.map(write => {
    const selected = pickStudy(write, env).plan;
    const state = selected ? env.reading.get(selected.id) : undefined;
    if (!state) return write;
    const configure = write.op === 'configure_reading_plan' || (env.templateCapability && (write.op === 'set_study_goal' || (write.op === 'rename_plan' && write.plan_id === selected!.id)));
    return configure ? { ...write, op: 'configure_reading_plan' as const, plan_id: selected!.id, expected_config_version: write.expected_config_version ?? state.config.version } : write;
  });
  writes = writes.map(write => {
    const ledger = ledgerOf(env);
    if (env.ledgerTemplateCapability && ledger && env.templates.get(ledger.id)?.engine === 'ledger' && (write.op === 'set_budget' || write.op === 'configure_ledger_plan' || (write.op === 'rename_plan' && write.plan_id === ledger.id))) return { ...write, op: 'configure_ledger_plan' as const, plan_id: ledger.id, expected_config_version: write.expected_config_version ?? env.templates.get(ledger.id)!.config.version };
    if (write.op === 'configure_generic_plan') {
      const plan = pickGeneric(write, env);
      const state = plan ? env.templates.get(plan.id) : undefined;
      if (state) return { ...write, plan_id: plan!.id, expected_config_version: write.expected_config_version ?? state.config.version };
    }
    return write;
  });
  const configurations = new Map<string, TurnWrite>();
  writes = writes.filter(write => {
    if (write.op !== 'configure_reading_plan' || !write.plan_id) return true;
    const previous = configurations.get(write.plan_id);
    if (!previous) { configurations.set(write.plan_id, write); return true; }
    previous.plan_name = write.plan_name ?? previous.plan_name;
    previous.days_per_week = write.days_per_week ?? previous.days_per_week;
    previous.min_minutes = write.min_minutes ?? previous.min_minutes;
    previous.reading_book = write.reading_book ?? previous.reading_book;
    previous.clear_current_book ||= write.clear_current_book;
    previous.complete_setup ||= write.complete_setup;
    return false;
  });
  const hasLedger = env.plans.some((p) => p.kind === 'ledger');
  const creates = writes.filter((x) => x.op === 'create_ledger');
  const budgets = writes.filter((x) => x.op === 'set_budget');
  if (hasLedger || (!creates.length && budgets.length <= 1)) return writes;
  const amount = creates.find((x) => x.amount_text)?.amount_text ?? budgets.find((x) => x.amount_text)?.amount_text ?? null;
  let placed = false;
  const out: TurnWrite[] = [];
  for (const x of writes) {
    if (x.op === 'create_ledger' || x.op === 'set_budget') {
      if (!placed) out.push({ ...x, op: 'create_ledger', amount_text: amount });
      placed = true;
    } else out.push(x);
  }
  return out;
}

/** “-20”“－20”“负20元”这类负数金额。 */
const HAS_NEGATIVE_AMOUNT = /(^|[^\d\w])[-－−]\s*\d|负\s*\d|负[一二三四五六七八九十百千]/;

/** 粗略统计一句话里带数字的片段数，用来在调用模型前拦下超过 10 条的批量记录。 */
function countAmountSegments(text: string): number {
  return text.split(/[，,、；;。\n]+/).filter((seg) => /\d|[一二三四五六七八九十两半]+(块|元|分钟|小时)/.test(seg)).length;
}

function questionFor(missing: Turn['missing']): string | null {
  if (missing.includes('amount')) return '花了多少钱？';
  if (missing.includes('minutes')) return '这次多长时间？告诉我分钟数就行。';
  if (missing.includes('date')) return '是哪天的？';
  if (missing.includes('plan')) return '记到哪个计划？';
  if (missing.includes('target')) return '要改哪一条？改成什么？';
  if (missing.includes('currency')) return '目前只支持人民币，折合人民币多少？';
  return null;
}

const ledgerOf = (env: Env) => env.plans.find((p) => p.kind === 'ledger') ?? null;
const activeStudies = (env: Env) => env.plans.filter((p) => p.kind === 'study' && p.status === 'active');

/** 选学习计划：明确指定 > 页面范围 > 唯一候选。返回 null 表示需要追问。 */
function pickStudy(w: TurnWrite, env: Env): { plan: PlanRow | null; archived?: PlanRow; created?: boolean } {
  let explicit = w.plan_id ? env.plans.find((p) => p.id === w.plan_id && p.kind === 'study') : undefined;
  if (w.plan_id && !explicit) return { plan: null };
  if (env.pre.createStudy || (env.batchStudy && !w.plan_id)) return { plan: null, created: true };
  // 优先级：用户明确指定 > 页面范围 > 唯一候选（PRD 9.1）。模型推断的计划只有在原话点名或说“记到…”时才压过页面范围。
  const scopeStudy = env.scope?.kind === 'study' ? env.scope : null;
  const named = (p: PlanRow) => env.text.includes(p.name) || /记到|记在|算到|算在/.test(env.text);
  if (scopeStudy && explicit && explicit.id !== scopeStudy.id && !named(explicit)) explicit = undefined;
  const byName = !explicit && !scopeStudy && w.activity ? matchStudyByActivity(env.plans, w.activity) : undefined;
  const chosen = explicit ?? scopeStudy ?? byName;
  if (chosen) {
    if (chosen.status === 'archived' && !env.pre.restore.includes(chosen.id)) return { plan: null, archived: chosen };
    return { plan: chosen };
  }
  const act = activeStudies(env);
  if (act.length === 1) return { plan: act[0]! };
  return { plan: null };
}

const compactText = (value: string) => value.replace(/\s/g, '');
function explicitReadingValue(value: string | null | undefined, text: string): string | null {
  return value && compactText(text).includes(compactText(value)) ? value : null;
}
function readingNote(write: TurnWrite, env: Env, planId: string): string {
  const state = env.reading.get(planId);
  if (!state) return write.note ?? '';
  const quotedBooks = [...env.text.matchAll(/《([^》]{1,80})》/gu)].map(match => match[1]!);
  const explicitBook = explicitReadingValue(write.reading_book, env.text) ?? (quotedBooks.length === 1 ? quotedBooks[0]! : null);
  const book = explicitBook ?? state.config.currentBook;
  const location = explicitReadingValue(write.reading_position, env.text) ?? env.text.match(/(?:读到|看到)\s*(第?\s*[\d一二三四五六七八九十百千]+\s*[页章])/u)?.[1] ?? null;
  const reflection = explicitReadingValue(write.reading_reflection, env.text);
  const note = explicitReadingValue(write.note, env.text);
  return [book ? `书名：《${book}》` : '', location ? `阅读位置：${location}` : '', reflection ? `收获：${reflection}` : '', note && note !== book && note !== location && note !== reflection ? `备注：${note}` : ''].filter(Boolean).join('\n');
}

function studyChoice(idx: number, w: TurnWrite, env: Env, summary: string, issue: string): Resolved {
  const act = activeStudies(env);
  if (!act.length) {
    const activity = w.activity ?? '阅读';
    return { k: 'missing', summary, issue: '还没有学习计划', question: `还没有${activity}计划，要先建一个吗？`, options: [opt(`创建「${activity}」并记录`, [{ k: 'create_study_first', activity }], 'primary')] };
  }
  return { k: 'missing', summary, issue, question: '记到哪个计划？', options: act.map((p) => opt(p.name, [{ k: 'set', idx, field: 'plan_id', value: p.id }])) };
}

function undoRecords(items: ItemResult[]): RecordView[] {
  return items.flatMap(item => 'record' in item ? [item.record] : item.type === 'record_deleted' ? item.records : []);
}
function undoLabel(result: OperationResult, env: Env): string {
  const records = undoRecords(result.items);
  const content = records.length ? records.slice(0, 3).map(record => recordText(record, env.plans.find(plan => plan.id === record.planId)?.name, env.templates.get(record.planId)?.definition)).join('；') : itemsText(result.items);
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(result.createdAt));
  return `${time} · ${content.slice(0, 150)}${records.length > 3 ? `等 ${records.length} 条` : ''}`;
}

function pickGeneric(w: TurnWrite, env: Env): PlanRow | null {
  const generic = env.plans.filter(plan => plan.kind === 'generic');
  const active = generic.filter(plan => plan.status === 'active' || env.pre.restore.includes(plan.id));
  // An explicit or scoped archived plan remains the target. The engine then
  // requires a restore confirmation; it must never turn into a different plan.
  const explicit = w.plan_id ? generic.find(plan => plan.id === w.plan_id) : null;
  if (w.plan_id && !explicit) return null;
  const scope = env.scope?.kind === 'generic' && generic.some(plan => plan.id === env.scope!.id) ? env.scope : null;
  if (scope && explicit && scope.id !== explicit.id && !env.text.includes(explicit.name) && !/记到|记在|算到|算在/u.test(env.text)) return scope;
  const named = generic.filter(plan => env.text.includes(plan.name));
  return explicit ?? scope ?? (named.length === 1 ? named[0]! : active.length === 1 ? active[0]! : null);
}
function genericChoice(idx: number, env: Env): Resolved {
  const pool = env.plans.filter(plan => plan.kind === 'generic' && plan.status === 'active');
  return { k: 'missing', summary: '选择记录计划', issue: '需要选计划', question: pool.length ? '记到哪个计划？' : '请先在模板市场选用合适的模板，再记录这项内容。', options: pool.map(plan => opt(plan.name, [{ k: 'set', idx, field: 'plan_id', value: plan.id }])) };
}

async function resolveWrite(q: Queryable, userId: string, idx: number, w: TurnWrite, env: Env): Promise<Resolved> {
  const ledger = ledgerOf(env);
  const date = dateOf(w, env.inputAt);

  switch (w.op) {
    case 'configure_generic_plan':
    case 'add_generic_record':
    case 'edit_generic_record': {
      if (!env.genericCapability) return { k: 'blocked', text: '这个计划需要在新版网页中操作。' };
      let target: RecordRow | null = null;
      if (w.op === 'edit_generic_record') {
        if (w.record_id) target = await getRecord(q, userId, w.record_id).catch(() => null);
        if (!target) {
          const candidates = env.lastRecords.filter(record => record.kind === 'generic' && !record.deleted && (!w.plan_id || record.plan_id === w.plan_id));
          if (candidates.length === 1) target = candidates[0]!;
          else if (candidates.length > 1) return { k: 'missing', summary: '修改记录', issue: '需要选记录', question: '要改哪一条记录？', options: candidates.map(record => opt(recordText(recordView(record), env.plans.find(plan => plan.id === record.plan_id)?.name, env.templates.get(record.plan_id)?.definition), [{ k: 'set', idx, field: 'record_id', value: record.id }])) };
        }
        if (!target || target.deleted || target.kind !== 'generic') return { k: 'missing', summary: '修改记录', issue: '需要选记录', question: '没有找到要修改的记录，请在计划详情中选择具体记录。', options: [] };
      }
      const plan = target ? env.plans.find(plan => plan.id === target!.plan_id) : pickGeneric(w, env);
      if (!plan) return genericChoice(idx, env);
      const state = env.templates.get(plan.id);
      if (!state || state.engine !== 'generic') return { k: 'blocked', text: '这个计划的模板暂不支持这项操作。' };
      const summary = `${w.op === 'configure_generic_plan' ? '更新设置' : w.op === 'edit_generic_record' ? '修改记录' : '记录'} · ${plan.name}`;
      try {
        const values = genericTurnValues(state.definition, w.generic_fields ?? [], w.op === 'configure_generic_plan' ? 'configuration' : 'record', { text: env.text, answering: env.answering });
        if (w.op === 'configure_generic_plan') {
          const patch: Extract<Action, { type: 'configure_generic_plan' }>['patch'] = {};
          if (w.plan_name !== null) patch.name = w.plan_name;
          if (typeof values.name === 'string') patch.name = values.name;
          if (typeof values.startDate === 'string') patch.startDate = values.startDate;
          delete values.name; delete values.startDate;
          if (Object.keys(values).length) patch.values = validateGenericConfigValues(state.definition, values);
          if ((w.record_defaults != null || w.apply_template_defaults) && !env.genericTemplateV2Capability) return { k: 'blocked', text: '请更新网页后调整默认填写。' };
          const recordDefaults = genericRecordDefaultsFromTurn(state.definition, state.config.recordDefaults ?? {}, w.record_defaults, env.text);
          if (!Object.keys(patch).length && recordDefaults === undefined && !w.apply_template_defaults && !w.complete_setup) return { k: 'missing', summary, issue: '缺少要修改的设置', question: '想设置什么目标？暂时不设目标也可以开始记录。', options: [opt('暂时不设目标，开始记录', [{ k: 'set', idx, field: 'complete_setup', value: true }], 'primary')] };
          return { k: 'actions', summary, actions: [{ type: 'configure_generic_plan', planId: plan.id, expectedVersion: w.expected_config_version ?? state.config.version, patch, ...(recordDefaults !== undefined ? { recordDefaults } : {}), ...(w.apply_template_defaults === true ? { applyTemplateDefaults: true } : {}), completeSetup: w.complete_setup === true, goalScope: w.scope === 'unspecified' ? 'current_and_future' : w.scope }] };
        }
        if (w.op === 'add_generic_record') {
          if (!w.is_fact || /^(?:我)?(?:想|打算|准备)?(?:每天|每日|目标)/u.test(env.text.trim())) return { k: 'missing', summary, issue: '目标不是实际记录', question: '这还是目标或安排，实际完成了多少？目标可以单独在计划设置中修改。', options: [] };
          if (!date || date === 'future') return { k: 'missing', summary, issue: '日期不确定', question: date === 'future' ? '还没有发生的内容不能计入记录。实际发生在哪一天？' : '这次记录是哪天的？', options: [opt('今天', [{ k: 'set', idx, field: 'date_kind', value: 'today' }]), opt('昨天', [{ k: 'set', idx, field: 'date_kind', value: 'yesterday' }])] };
          if (Object.hasOwn(values, 'date') && values.date !== date) throw new DomainError('invalid_input', '这次记录的日期不一致，请明确是哪一天。');
          if (!Object.hasOwn(values, 'date')) values.date = date;
          if (w.note !== null && !Object.hasOwn(values, 'note') && state.definition.recordFields.some(field => field.id === 'note')) values.note = w.note;
          prepareGenericRecordValues(state.definition, values, undefined, env.today, state.config.recordDefaults ?? {});
          return { k: 'actions', summary, actions: [{ type: 'add_generic_record', planId: plan.id, values }] };
        }
        const explicitDateChange = /(?:改|调|更正|其实|应(?:该)?是).{0,12}(?:今天|昨天|前天|\d{1,4}[年月日号]|\d{4}-\d{2}-\d{2})/u.test(env.text);
        if (Object.hasOwn(values, 'date') && (w.date_kind !== 'today' || explicitDateChange) && values.date !== date) throw new DomainError('invalid_input', '这次修改的日期不一致，请明确是哪一天。');
        if (!Object.keys(values).length && w.note === null && w.date_kind === 'today' && !explicitDateChange) return { k: 'missing', summary, issue: '缺少修改内容', question: '这条记录要改成什么？', options: [] };
        const replacement = { ...target!.fields, ...values };
        if (!Object.hasOwn(values, 'date') && (w.date_kind !== 'today' || explicitDateChange)) {
          if (!date || date === 'future') throw new DomainError('invalid_input', '请提供已经发生的有效日期。');
          replacement.date = date;
        }
        if (w.note !== null && state.definition.recordFields.some(field => field.id === 'note')) replacement.note = w.note;
        return { k: 'actions', summary, actions: [{ type: 'edit_generic_record', recordId: target!.id, expectedVersion: target!.version, values: validateGenericRecordValues(state.definition, replacement, undefined, env.today) }] };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { k: 'missing', summary, issue: error.message, question: error.message, options: [] };
      }
    }
    case 'configure_ledger_plan': {
      if (!env.ledgerTemplateCapability) return { k: 'blocked', text: '请在新版网页中修改记账模板设置。' };
      const state = ledger ? env.templates.get(ledger.id) : undefined;
      if (!ledger || !state || state.engine !== 'ledger') return { k: 'blocked', text: '请先在模板市场选用记账模板。' };
      if (w.amount_text !== null && w.currency === 'other') return { k: 'missing', summary: '设置月预算', issue: '不是人民币', question: '目前只支持人民币预算，这个预算折合人民币多少？', options: [] };
      const patch: Extract<Action, { type: 'configure_ledger_plan' }>['patch'] = {};
      if (w.plan_name !== null) patch.name = w.plan_name;
      if (w.clear_budget && /清空|取消|不设|移除/u.test(env.text)) patch.budgetCents = null;
      else if (w.amount_text !== null) {
        const cents = parseYuanToCents(w.amount_text);
        if (cents === null || !isValidCents(cents)) return { k: 'missing', summary: '设置预算', issue: '预算金额无效', question: '每月预算多少元？', options: [] };
        patch.budgetCents = cents;
      }
      if (!Object.keys(patch).length && !w.complete_setup) return { k: 'missing', summary: '完善计划', issue: '缺少设置', question: '每月预算多少？暂时不设预算也可以。', options: [opt('暂时不设预算，开始记录', [{ k: 'set', idx, field: 'complete_setup', value: true }])] };
      return { k: 'actions', summary: '更新计划设置', actions: [{ type: 'configure_ledger_plan', planId: ledger.id, expectedVersion: w.expected_config_version ?? state.config.version, patch, completeSetup: w.complete_setup === true, goalScope: w.scope === 'unspecified' ? 'current_and_future' : w.scope }] };
    }

    case 'add_expense': {
      const cents = w.amount_text ? parseYuanToCents(w.amount_text) : null;
      const label = w.note ?? '支出';
      const summary = `${label} ${cents ? formatYuan(cents) : '？元'} · ${w.category ?? '其他'} · 日常记账`;
      if (!w.is_fact || date === 'future') return { k: 'notice', text: `「${label}」还没发生，不会记成已发生的支出。` };
      if (w.currency === 'other') return { k: 'missing', summary, issue: '不是人民币', question: '目前只支持人民币记账，这笔折合人民币多少？', options: [] };
      if (!cents || !isValidCents(cents)) return { k: 'missing', summary, issue: '缺少金额', question: `${label}花了多少钱？`, options: [] };
      if (!date) return { k: 'missing', summary, issue: '日期不确定', question: `${label}是哪天的？`, options: [opt('今天', [{ k: 'set', idx, field: 'date_kind', value: 'today' }]), opt('昨天', [{ k: 'set', idx, field: 'date_kind', value: 'yesterday' }])] };
      if (!ledger && !env.pre.createLedger) return { k: 'missing', summary, issue: '还没有可用的计划', question: '要创建一个计划来记录这笔支出吗？', options: [opt('创建计划并记录', [{ k: 'create_ledger_first' }], 'primary')] };
      if (ledger?.status === 'archived' && !env.pre.restore.includes(ledger.id)) return { k: 'missing', summary, issue: '计划已归档', question: '「日常记账」已归档，要恢复后记下这笔吗？', options: [opt('恢复并记录', [{ k: 'restore_first', planId: ledger.id }], 'primary')] };
      return { k: 'actions', summary, actions: [{ type: 'add_expense', amountCents: cents, category: w.category ?? '其他', date, note: w.note ?? '' }] };
    }

    case 'add_study':
    case 'day_total_claim': {
      const { minutes, bad } = minutesOf(w);
      const pick = pickStudy(w, env);
      const planName = pick.plan?.name ?? env.pre.createStudy ?? env.batchStudy ?? w.activity ?? '学习';
      const summary = `${planName} ${minutes ?? '？'} 分钟${date && date !== 'future' ? ` · ${formatMonthDay(date)}` : ''}`;
      if (pick.plan && env.reading.has(pick.plan.id) && /^(?:我)?(?:想|打算|准备)?(?:每周|每天|目标)|^(?:当前|现在)(?:在)?读/u.test(env.text.trim()) && !/(?:今天|昨天|刚才|刚刚)[^。！？]*(?:读了|阅读了|学习了)/u.test(env.text)) return { k: 'notice', text: '这是计划设置或阅读安排，还没有计入真实阅读。可以告诉我实际读了多少分钟。' };
      if (!w.is_fact || date === 'future') return { k: 'notice', text: '这是之后的安排，不会记成已完成。提醒功能暂时还不支持。' };
      if (bad) return { k: 'missing', summary, issue: '时长不是整分钟', question: '这次是多少分钟？请给一个整数分钟。', options: [] };
      if (!date) return { k: 'missing', summary, issue: '日期不确定', question: '是哪天的？', options: [opt('今天', [{ k: 'set', idx, field: 'date_kind', value: 'today' }]), opt('昨天', [{ k: 'set', idx, field: 'date_kind', value: 'yesterday' }])] };
      if (pick.archived) return { k: 'missing', summary, issue: '计划已归档', question: `「${pick.archived.name}」已归档，要恢复后记录吗？`, options: [opt('恢复并记录', [{ k: 'restore_first', planId: pick.archived.id }], 'primary')] };
      if (!pick.plan && !pick.created) {
        const r = studyChoice(idx, w, env, summary, '需要选计划');
        if (r.k === 'missing' && minutes === null) r.question = `${r.question.replace(/？$/, '')}？这次多长时间也一起告诉我。`;
        return r;
      }
      if (w.op === 'day_total_claim') {
        if (minutes === null || !pick.plan) return { k: 'missing', summary, issue: '缺少时长', question: '今天一共多少分钟？', options: [] };
        const rows = await q.query<{ total: number }>(`SELECT COALESCE(SUM(minutes),0)::int AS total FROM records WHERE plan_id = $1 AND occurred_on = $2 AND NOT deleted`, [pick.plan.id, date]);
        const recorded = Number(rows[0]?.total ?? 0);
        if (minutes <= recorded) return { k: 'notice', text: `「${pick.plan.name}」${formatMonthDay(date)}已经记了 ${recorded} 分钟，不需要补记。如果之前记错了，可以直接修改那条记录。` };
        const extra = minutes - recorded;
        return {
          k: 'missing',
          summary: `${pick.plan.name} · ${formatMonthDay(date)}已记录 ${recorded} 分钟`,
          issue: `你说一共 ${minutes} 分钟`,
          question: `「${pick.plan.name}」${formatMonthDay(date)}已经记了 ${recorded} 分钟。要补记 ${extra} 分钟，还是修改已有记录？`,
          options: [opt(`补记 ${extra} 分钟`, [{ k: 'set', idx, field: 'op', value: 'add_study' }, { k: 'set', idx, field: 'duration_value', value: extra }, { k: 'set', idx, field: 'duration_unit', value: 'minute' }, { k: 'set', idx, field: 'plan_id', value: pick.plan.id }], 'primary')],
        };
      }
      if (minutes === null) return { k: 'missing', summary, issue: '缺少时长', question: `这次${planName}多长时间？`, options: [15, 30, 60].map((m) => opt(`${m} 分钟`, [{ k: 'set', idx, field: 'duration_value', value: m }, { k: 'set', idx, field: 'duration_unit', value: 'minute' }])) };
      const note = pick.plan ? readingNote(w, env, pick.plan.id) : w.note ?? '';
      if (note.length > 200) return { k: 'missing', summary, issue: '阅读备注过长', question: '书名、阅读位置和备注合计超过了 200 字，请缩短本次补充内容。还没有保存。', options: [] };
      return { k: 'actions', summary, actions: [{ type: 'add_study', planId: pick.plan?.id ?? NEW_STUDY_PLAN, minutes, date, note }] };
    }

    case 'add_refund': {
      const cents = w.amount_text ? parseYuanToCents(w.amount_text) : null;
      if (!w.is_fact || date === 'future') return { k: 'notice', text: '退款还没有到账，不会记成已收到的退款。到账后再告诉我金额和日期即可。' };
      if (w.currency === 'other') return { k: 'missing', summary: '记录退款', issue: '不是人民币', question: '目前只支持人民币退款，这笔退款折合人民币多少？', options: [] };
      let expense: RecordRow | null = null;
      let invalidReference = false;
      if (w.record_id) {
        const r = await getRecord(q, userId, w.record_id).catch(() => null);
        if (r && r.kind === 'expense' && !r.deleted) expense = r;
        else invalidReference = true;
      }
      if (!expense && ledger) {
        // The model may include the refund status in its note. Strip only this
        // trailing phrase; never use the refund amount to guess the purchase.
        const kw = (w.note ?? '').trim().replace(/(?:[，,\s]*(?:退货)?退款(?:了)?\s*(?:[0-9]+(?:\.[0-9]+)?\s*(?:元|块(?:钱)?)?)?\s*(?:(?:已经|已)?(?:到账|到帐)(?:了)?)?)[。.!！\s]*$/u, '').trim();
        const candidates = (keyword: string) => q.query<RecordRow>(
          `SELECT * FROM records WHERE user_id = $1 AND plan_id = $2 AND kind = 'expense' AND NOT deleted AND occurred_on <= $3 ${keyword ? `AND strpos(lower(note), lower($4)) > 0` : ''} ORDER BY occurred_on DESC, created_at DESC, id LIMIT 4`,
          keyword ? [userId, ledger.id, env.today, keyword] : [userId, ledger.id, env.today],
        );
        let cands = await candidates(kw);
        const unmatched = !!kw && cands.length === 0;
        if (unmatched) cands = await candidates('');
        // An unmatched description is not evidence that the purchase is absent.
        // Let the user select it; even one fallback candidate is not auto-linked.
        if (cands.length === 1 && !unmatched && !invalidReference) expense = cands[0]!;
        else if (cands.length > 0)
          return { k: 'missing', summary: `退款 ${cents ? formatYuan(cents) : ''}`.trim(), issue: '需要选原支出', question: unmatched || invalidReference ? '还不能确定对应的原支出。这笔退款对应下面哪一笔？如果不在其中，可以补充原消费的备注，或到原记录详情里退款。' : '这笔退款对应哪一笔支出？', options: cands.map((c) => opt(`${c.note || c.category} ${formatYuan(c.amount_cents!)} · ${formatMonthDay(c.occurred_on)}`, [{ k: 'set', idx, field: 'record_id', value: c.id }])) };
      }
      if (!expense) return { k: 'notice', text: '没有找到对应的原支出。退款需要关联一笔已记录的支出，可以先补录原消费，再在它的详情里发起退款。' };
      const done = (await activeRefunds(q, expense.id)).reduce((s, r) => s + r.amount_cents!, 0);
      const left = expense.amount_cents! - done;
      const summary = `退款 ${cents ? formatYuan(cents) : '？元'} · ${expense.note || expense.category} ${formatYuan(expense.amount_cents!)}`;
      if (!cents) return { k: 'missing', summary, issue: '缺少金额', question: `退了多少？最多还能退 ${formatYuan(left)}。`, options: left > 0 ? [opt(`全额退 ${formatYuan(left)}`, [{ k: 'set', idx, field: 'amount_text', value: (left / 100).toFixed(2) }, { k: 'set', idx, field: 'record_id', value: expense.id }])] : [] };
      if (!date || date === 'future') return { k: 'missing', summary, issue: '日期不确定', question: '退款是哪天到的？', options: [opt('今天', [{ k: 'set', idx, field: 'date_kind', value: 'today' }, { k: 'set', idx, field: 'record_id', value: expense.id }])] };
      return { k: 'actions', summary, actions: [{ type: 'add_refund', expenseId: expense.id, amountCents: cents, date }] };
    }

    case 'edit_record':
    case 'delete_record': {
      const cents = w.amount_text ? parseYuanToCents(w.amount_text) : null;
      const { minutes } = minutesOf(w);
      let target: RecordRow | null = null;
      if (w.record_id) {
        const r = await getRecord(q, userId, w.record_id).catch(() => null);
        if (r && !r.deleted) target = r;
      }
      if (w.op === 'delete_record') {
        const affirmative = env.text.replace(/(?:不要|别|不必|不用|无需|不)\s*(?:删(?:除|掉|去)?|清空|移除)/gu, '');
        const hasNegatedDeletion = affirmative !== env.text;
        if (!/删|清空|移除|\b(?:delete|remove|erase)\b/iu.test(affirmative)) return { k: 'notice', text: '这次没有删除任何记录。需要删除时，请明确选择要删除的记录。' };
        // A model-supplied ID is a suggestion, never evidence of the user's selection.
        if (w.record_id && !target || target && (env.scope && target.plan_id !== env.scope.id || env.unsupportedPlanIds.has(target.plan_id)))
          return { k: 'notice', text: '没有找到这次要删除的记录。没有删除任何内容，请从计划详情选择具体记录。' };
        const confirmedVersion = target ? env.pre.deleteTargets?.[target.id] : undefined;
        const staleChoice = confirmedVersion !== undefined && confirmedVersion !== target?.version;
        let candidates = env.lastRecords.filter(r => !r.deleted);
        const studyHint = /阅读|读书|读了|学习|英语|单词/.test(env.text);
        const moneyHint = /饭|元|块|笔|支出|花|买|打车|退款/.test(env.text);
        if (studyHint !== moneyHint) candidates = candidates.filter(r => studyHint ? r.kind === 'study' : r.kind !== 'study');
        const relative = /刚才|刚刚|上一条|上一笔/.test(env.text);
        let explicit = false;
        // Mixed preservation/deletion requests must be resolved by a server choice,
        // even when the model points to the only named record of its kind.
        if (target && !relative && !hasNegatedDeletion) {
          const namedIds = [...new Set(env.text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu) ?? [])];
          explicit = namedIds.length === 1 && namedIds[0] === target.id;
          if (!explicit && target.note.trim().length >= 2 && env.text.includes(target.note.trim())) {
            const matches = await q.query<{id: string}>(`SELECT id FROM records WHERE user_id=$1 AND NOT deleted AND length(btrim(note)) >= 2 AND strpos($2, btrim(note)) > 0 ${env.scope ? 'AND plan_id=$3' : ''} LIMIT 2`, env.scope ? [userId, env.text, env.scope.id] : [userId, env.text]);
            explicit = matches.length === 1 && matches[0]!.id === target.id;
          }
        }
        const chosen = target && confirmedVersion === target.version;
        const uniqueRecent = relative && !hasNegatedDeletion && candidates.length === 1 && (!target || target.id === candidates[0]!.id);
        // A refund snapshot already presents the exact parent and requires a server choice.
        const refundPreview = target?.kind === 'expense' && !env.pre.refundDeleteSnapshots?.[target.id] && (await recordWithRefundSnapshot(q, userId, target.id)).refundSnapshot!.count > 0;
        if (!staleChoice && (chosen || explicit || uniqueRecent || refundPreview)) target ??= candidates[0]!;
        else {
          // Show only accessible, scoped records. A stale selection must be reviewed again.
          if (target && !candidates.some(r => r.id === target!.id)) candidates.push(target);
          if (!candidates.length) return { k: 'notice', text: '还不能确定要删除哪条记录。没有删除任何内容，请从计划详情选择。' };
          return { k: 'missing', summary: '删除记录', issue: '需要选记录', question: staleChoice ? '这条记录已经变化，请重新核对要删除的记录。' : '还不能确定要删除哪一条，请选择具体记录。', options: candidates.map(c => opt(recordText(recordView(c)), [{ k: 'set', idx, field: 'record_id', value: c.id }, { k: 'delete_target', idx, recordId: c.id, version: c.version }])) };
        }
      }
      // 说的是“刚才/刚刚/上一条”时，只在最近一次保存的记录里找（PRD 9.4）。
      if (w.op !== 'delete_record' && target && /刚才|刚刚|上一条|上一笔/.test(env.text) && env.lastRecords.length && !env.lastRecords.some((r) => r.id === target!.id)) target = null;
      if (!target) {
        let cands = env.lastRecords.filter((r) => !r.deleted);
        // 用原话里的线索缩小范围：提到阅读/学习就是学习记录，提到饭/金额/笔就是支出。
        const studyHint = /阅读|读书|读了|学习|英语|单词/.test(env.text);
        const moneyHint = /饭|元|块|笔|支出|花|买|打车|退款/.test(env.text);
        if (studyHint !== moneyHint) {
          const narrowed = cands.filter((r) => (studyHint ? r.kind === 'study' : r.kind !== 'study'));
          if (narrowed.length) cands = narrowed;
        }
        if (w.op === 'edit_record') {
          if (cents !== null || w.category) cands = cands.filter((r) => r.kind !== 'study');
          if (minutes !== null) cands = cands.filter((r) => r.kind === 'study');
        }
        if (cands.length === 1) target = cands[0]!;
        else if (cands.length > 1)
          return { k: 'missing', summary: w.op === 'edit_record' ? '修改记录' : '删除记录', issue: '需要选记录', question: `要${w.op === 'edit_record' ? '改' : '删'}哪一条？`, options: cands.map((c) => opt(recordText(recordView(c)), [{ k: 'set', idx, field: 'record_id', value: c.id }])) };
      }
      if (!target) return { k: 'notice', text: '没有找到最近可以修改的记录。可以在计划详情里点开具体记录来改。' };
      if (target.kind === 'generic' && (!env.genericCapability || w.op === 'edit_record')) return { k: 'blocked', text: !env.genericCapability ? '这条记录需要在新版网页中操作。' : '请按当前模板字段说明要修改的内容。' };
      const view = recordView(target);
      if (w.op === 'delete_record') {
        if (target.kind === 'expense') {
          const current = await recordWithRefundSnapshot(q, userId, target.id);
          const snapshot = current.refundSnapshot!;
          const confirmed = env.pre.refundDeleteSnapshots?.[target.id];
          if (confirmed !== snapshot.token && (snapshot.count || confirmed || w.note === '__with_refunds__')) {
            const changed = !!confirmed || w.note === '__with_refunds__';
            const question = snapshot.count
              ? `${changed ? '确认信息已过期，请重新核对。' : ''}这笔支出有 ${snapshot.count} 笔退款，共 ${formatYuan(snapshot.totalCents)}。删除会把它们一起移出统计，确定吗？`
              : '关联退款已变化，目前没有有效退款。请重新确认是否删除这条支出。';
            return { k: 'missing', summary: recordText(recordView(current.record, snapshot.totalCents)), issue: `有 ${snapshot.count} 笔退款`, question, options: [opt(snapshot.count ? '连同退款一起删除' : '确认删除这条支出', [
              { k: 'set', idx, field: 'record_id', value: target.id },
              { k: 'confirm_refund_delete', recordId: target.id, token: snapshot.token },
              { k: 'delete_target', idx, recordId: target.id, version: current.record.version },
            ], 'primary')] };
          }
          return { k: 'actions', summary: `删除 ${recordText(view)}`, actions: [{ type: 'delete_record', recordId: target.id, expectedVersion: current.record.version, expectedRefundSnapshot: snapshot.token, includeRefunds: confirmed === snapshot.token }] };
        }
        return { k: 'actions', summary: `删除 ${recordText(view)}`, actions: [{ type: 'delete_record', recordId: target.id, expectedVersion: target.version }] };
      }
      const patch: Extract<Action, { type: 'edit_record' }>['patch'] = {};
      if (cents !== null) patch.amountCents = cents;
      if (minutes !== null && target.kind === 'study') patch.minutes = minutes;
      if (w.category && target.kind === 'expense') patch.category = w.category;
      if (date && date !== 'future' && (w.date_kind !== 'today' || Object.keys(patch).length === 0) && date !== target.occurred_on) patch.date = date;
      // 和现在一样的字段不算修改；全都一样说明没有真正的改动（或找错了记录），追问而不是“修改成原样”。
      if (patch.amountCents === target.amount_cents) delete patch.amountCents;
      if (patch.minutes === target.minutes) delete patch.minutes;
      if (patch.category === target.category) delete patch.category;
      if (!Object.keys(patch).length) return { k: 'missing', summary: recordText(view), issue: '没有要改的内容', question: `「${recordText(view)}」要改成什么？比如金额、分类或日期。`, options: [] };
      return { k: 'actions', summary: `修改 ${recordText(view)}`, actions: [{ type: 'edit_record', recordId: target.id, expectedVersion: target.version, patch }] };
    }

    case 'undo_last': {
      const unsupportedReceipt = (result: OperationResult) => referencesHiddenPlan(result, env.unsupportedPlanIds) || !env.genericCapability && containsGenericCard(result);
      // Only a server-issued choice may pin an operation ID; the model cannot set it.
      if (env.pre.undoOperationId) {
        const [selected] = await q.query<{ result: OperationResult; undone: boolean }>('SELECT result, undone FROM operations WHERE user_id = $1 AND id = $2', [userId, env.pre.undoOperationId]);
        if (!selected || selected.undone || !selected.result.undoable) return { k: 'notice', text: '所选操作已撤销或不能撤销，没有改动其他记录。' };
        if (unsupportedReceipt(selected.result)) return { k: 'blocked', text: '所选对话包含当前网页不支持的计划，请在新版网页中撤销。没有改动其他记录。' };
        return { k: 'undo', operationId: selected.result.operationId };
      }
      if (/撤销.{0,8}(?:手动|表单)|(?:手动|表单).{0,12}(?:那|这|刚|上|最新).{0,6}(?:条|笔|次)/u.test(env.text)) return { k: 'notice', text: '请到计划详情选择要处理的手动记录。这次没有撤销任何对话或手动记录。' };
      const latest = env.undoReceipts[0];
      if (!latest) return { k: 'notice', text: '当前对话里没有找到可撤销的保存回执。可以到计划详情核对具体记录。' };
      const undoText = env.text.replace(/[,，；;]\s*(?:保留|不撤销|不要撤销|别动|不改).*$/u, '');
      const recent = /刚才|刚刚|上(?:一|1)(?:次|条|组|批)|最后(?:一|1)(?:次|条|组|批)/u.test(env.text);
      if (recent && unsupportedReceipt(latest.result)) return { k: 'blocked', text: '这次对话包含当前网页不支持的计划，请在新版网页中撤销。没有改动其他记录。' };
      const grouped = /(?:那|这|一|整).{0,3}(?:组|批)|一起|那几|这几|[两二三四五六七八九十2-9][条笔]/u.test(undoText);
      const namedPlans = env.plans.filter(plan => undoText.includes(plan.name)).map(plan => plan.id);
      const knownNotes = [...new Set(env.undoReceipts.flatMap(receipt => undoRecords(receipt.result.items).map(record => record.note)).filter(note => note.length >= 2 && undoText.includes(note)))];
      const kinds = [/(?:支出|消费|晚饭|午饭|餐饮|记账)/u.test(env.text) ? 'expense' : null, /阅读|学习|读书|分钟/u.test(env.text) ? 'study' : null, /饮水|喝水|毫升|\bml\b/iu.test(env.text) ? 'generic' : null, /退款/u.test(env.text) ? 'refund' : null].filter(Boolean);
      let remainingReference = undoText;
      for (const text of [...knownNotes, ...env.plans.filter(plan => namedPlans.includes(plan.id)).map(plan => plan.name)]) remainingReference = remainingReference.split(text).join('');
      remainingReference = remainingReference.replace(/支出|消费|晚饭|午饭|餐饮|记账|阅读|学习|读书|分钟|饮水|喝水|毫升|\bml\b|退款/giu, '').replace(/请|帮我|给我|把(?=刚才|刚刚)|记的都|记的全部|撤销|撤回|刚才|刚刚|上一[次条组批]|最后一[次条组批]|[那这]一?[组批次条笔]|一[组批]|一起|全部|[那这]几条|记录|操作|保存|的|和|与|及|掉|一下/gu, '').replace(/[\s，,。.!！?？、；;：:「」《》“”"'（）()]/gu, '');
      const clearReference = remainingReference.length === 0;
      const matches = (result: OperationResult) => {
        const records = undoRecords(result.items);
        const planIds = new Set([...records.map(record => record.planId), ...result.items.flatMap(item => 'plan' in item ? [item.plan.id] : [])]);
        return (!grouped || result.items.length > 1) && namedPlans.every(id => planIds.has(id)) && knownNotes.every(note => records.some(record => record.note === note)) && kinds.every(kind => records.some(record => record.kind === kind));
      };
      // A later form write never changes what "the last reply" refers to. Conversely,
      // never skip an already-undone or nonmatching latest receipt and undo an older one.
      if (recent && clearReference && matches(latest.result)) {
        if (latest.undone || !latest.result.undoable) return { k: 'notice', text: '刚才那次操作已撤销或不能撤销，没有改动更早或后来单独保存的记录。' };
        return { k: 'undo', operationId: latest.result.operationId };
      }
      const candidates = env.undoReceipts.filter(receipt => !receipt.undone && receipt.result.undoable && matches(receipt.result));
      if (!candidates.length) return { k: 'notice', text: '没有找到与这次描述一致、可以撤销的对话回执。请在原保存回执中选择撤销，这次没有改动记录。' };
      if (candidates.some(receipt => unsupportedReceipt(receipt.result))) return { k: 'blocked', text: '候选对话包含当前网页不支持的计划，请在新版网页中选择要撤销的回执。没有改动其他记录。' };
      return { k: 'missing', summary: '撤销一次对话操作', issue: '需要选保存回执', question: '要撤销哪次对话保存？请核对整批内容；后来单独保存的记录会保留。', options: candidates.slice(0, 5).map(receipt => opt(undoLabel(receipt.result, env), [{ k: 'undo_operation', operationId: receipt.result.operationId }])) };
    }

    case 'create_ledger': {
      if (ledger) {
        const card = await planCard(q, ledger, env.today);
        return { k: 'notice', text: ledger.status === 'archived' ? '你已经有一个归档的「日常记账」，在计划库的“已归档”里可以恢复。' : '你已经有「日常记账」了，直接说“午饭 20 元”就能记。', cards: [{ type: 'plan', card, note: '已有计划' }] };
      }
      const cents = w.amount_text ? parseYuanToCents(w.amount_text) : null;
      return { k: 'actions', summary: '创建日常记账', actions: [{ type: 'create_ledger', budgetCents: cents && isValidCents(cents) ? cents : null }] };
    }

    case 'create_study': {
      const activity = w.activity ?? w.plan_name ?? '阅读';
      const name = w.plan_name ?? activity;
      const dup = env.plans.find((p) => p.kind === 'study' && p.status === 'active' && p.name === name);
      if (dup && !w.plan_name) {
        const card = await planCard(q, dup, env.today);
        return { k: 'notice', text: `已经有进行中的「${dup.name}」了。要调整目标可以直接说，比如“从下周起改成每周 3 天”；要另建一个，请给它起个不同的名字。`, cards: [{ type: 'plan', card, note: '已有计划' }] };
      }
      const first = firstWeekDecision(w, env, env.today);
      if (first.question) return first.question;
      return { k: 'actions', summary: `创建「${name}」`, actions: [{ type: 'create_study', name, activity, daysPerWeek: w.days_per_week, minMinutes: w.min_minutes, startNextWeek: first.mode === 'next' }] };
    }

    case 'set_budget': {
      const cents = w.amount_text ? parseYuanToCents(w.amount_text) : null;
      if (!cents || !isValidCents(cents)) return { k: 'missing', summary: '设置月预算', issue: '缺少金额', question: '每月预算多少？', options: [] };
      const scope = w.scope === 'unspecified' ? 'current_and_future' : w.scope;
      if (!ledger) return { k: 'actions', summary: `创建日常记账，月预算 ${formatYuan(cents)}`, actions: [{ type: 'create_ledger', budgetCents: cents }] };
      return { k: 'actions', summary: `月预算 ${formatYuan(cents)}`, actions: [{ type: 'set_goal', planId: ledger.id, param: 'budget_cents', value: cents, scope }] };
    }

    case 'configure_reading_plan': {
      if (!env.templateCapability) return { k: 'notice', text: '请在支持模板设置的网页中修改计划。这次没有保存。' };
      const selected = pickStudy(w, env);
      if (!selected.plan) return studyChoice(idx, w, env, '完善计划', '需要选计划');
      const state = env.reading.get(selected.plan.id);
      if (!state) return { k: 'notice', text: '这个计划没有采用官方阅读模板，可以在计划详情中调整已有目标。' };
      const patch: Extract<Action, { type: 'configure_reading_plan' }>['patch'] = {};
      if (w.plan_name !== null) patch.name = w.plan_name;
      if (w.days_per_week !== null) patch.daysPerWeek = w.days_per_week;
      if (w.min_minutes !== null) patch.minMinutes = w.min_minutes;
      if (w.reading_book) {
        const book = explicitReadingValue(w.reading_book, env.text);
        if (!book) return { k: 'missing', summary: '设置当前书籍', issue: '书名需要确认', question: '当前在读哪一本书？', options: [] };
        patch.currentBook = book;
      }
      if (w.clear_current_book && /清空|不设|取消|移除/u.test(env.text)) patch.currentBook = null;
      if (!Object.keys(patch).length && !w.complete_setup) return { k: 'missing', summary: '完善计划', issue: '缺少要修改的设置', question: '可以告诉我计划名称、当前书籍或阅读目标；暂时不设目标也可以。', options: [opt('暂时不设目标，开始记录', [{ k: 'set', idx, field: 'complete_setup', value: true }], 'primary')] };
      const first = firstWeekDecision(w, env, selected.plan.start_date);
      if (first.question) return first.question;
      const goalScope = first.mode === 'adjust' ? 'current_only' : first.mode === 'next' ? 'next_and_future' : w.scope === 'unspecified' ? (w.goal_period === 'this_week' ? 'current_only' : 'current_and_future') : w.scope;
      if (first.mode === 'adjust') patch.daysPerWeek = first.available;
      return { k: 'actions', summary: '更新计划设置', actions: [{ type: 'configure_reading_plan', planId: selected.plan.id, expectedVersion: w.expected_config_version ?? state.config.version, patch, completeSetup: w.complete_setup === true, goalScope }] };
    }

    case 'set_study_goal': {
      const pick = pickStudy(w, env);
      const summary = '调整学习目标';
      if (!pick.plan) return pick.archived ? { k: 'notice', text: `「${pick.archived.name}」已归档，恢复后才能调整目标。` } : studyChoice(idx, w, env, summary, '需要选计划');
      const first = firstWeekDecision(w, env, pick.plan.start_date);
      if (first.question) return first.question;
      const scope = first.mode === 'adjust' ? 'current_only' : first.mode === 'next' ? 'next_and_future' : w.scope === 'unspecified' ? (w.goal_period === 'this_week' ? 'current_only' : 'current_and_future') : w.scope;
      const actions: Action[] = [];
      if (w.days_per_week !== null) actions.push({ type: 'set_goal', planId: pick.plan.id, param: 'days_per_week', value: first.mode === 'adjust' && scope === 'current_only' ? first.available : w.days_per_week, scope });
      if (w.min_minutes !== null) actions.push({ type: 'set_goal', planId: pick.plan.id, param: 'min_minutes', value: w.min_minutes, scope });
      if (!actions.length) return { k: 'missing', summary, issue: '没说目标', question: '想改成每周几天、每天多少分钟？', options: [] };
      return { k: 'actions', summary, actions };
    }

    case 'rename_plan':
    case 'archive_plan':
    case 'restore_plan':
    case 'hide_component':
    case 'show_component':
    case 'reorder_components': {
      const explicit = w.plan_id ? env.plans.find((p) => p.id === w.plan_id) : undefined;
      // 用户原话里提到了现有计划的名称（且不是新名字）时，按名称定位。
      const mentioned = env.plans.filter((p) => p.name !== w.plan_name && env.text.includes(p.name));
      let plan = explicit ?? (mentioned.length === 1 ? mentioned[0]! : null) ?? env.scope ?? null;
      if (!plan && (w.op === 'hide_component' || w.op === 'show_component')) plan = w.component === 'minutes' ? (activeStudies(env).length === 1 ? activeStudies(env)[0]! : null) : ledger;
      if (!plan && w.op === 'reorder_components') {
        if (w.component_order?.includes('minutes') && activeStudies(env).length === 1) plan = activeStudies(env)[0]!;
        else if (w.component_order?.some((c) => c === 'trend' || c === 'categories')) plan = ledger;
      }
      if (!plan && w.op === 'restore_plan') {
        const archived = env.plans.filter((p) => p.status === 'archived');
        if (archived.length === 1) plan = archived[0]!;
      }
      if (!plan) {
        const pool = env.plans.filter((p) => (w.op === 'restore_plan' ? p.status === 'archived' : p.status === 'active'));
        if (!pool.length) return { k: 'notice', text: w.op === 'restore_plan' ? '没有已归档的计划。' : '还没有计划。' };
        return { k: 'missing', summary: '选择计划', issue: '需要选计划', question: '是哪个计划？', options: pool.map((p) => opt(p.name, [{ k: 'set', idx, field: 'plan_id', value: p.id }])) };
      }
      if (w.op === 'rename_plan') {
        if (!w.plan_name) return { k: 'missing', summary: `重命名「${plan.name}」`, issue: '缺少名称', question: '想改成什么名字？', options: [] };
        return { k: 'actions', summary: `重命名为「${w.plan_name}」`, actions: [{ type: 'rename_plan', planId: plan.id, name: w.plan_name }] };
      }
      if (w.op === 'archive_plan') return { k: 'actions', summary: `归档「${plan.name}」`, actions: [{ type: 'archive_plan', planId: plan.id }] };
      if (w.op === 'restore_plan') return { k: 'actions', summary: `恢复「${plan.name}」`, actions: [{ type: 'restore_plan', planId: plan.id }] };
      if (w.op === 'reorder_components') {
        const allowed = plan.kind === 'ledger' ? ['categories', 'trend', 'records'] : ['minutes', 'records'];
        const selected = w.component_order;
        if (!selected?.length || selected.some((c) => !allowed.includes(c))) return { k: 'missing', summary: '调整组件顺序', issue: '需要有效的组件顺序', question: `「${plan.name}」可以调整${plan.kind === 'ledger' ? '分类、趋势和记录' : '时长和记录'}的顺序。你希望怎么排列？指标和当前周期始终保留在顶部。`, options: [] };
        const order = componentOrder(plan.kind, [...selected, ...componentOrder(plan.kind, plan.view_config.order)]);
        return { k: 'actions', summary: '调整组件顺序', actions: [{ type: 'set_view', planId: plan.id, order }] };
      }
      const component = w.component ?? 'trend';
      const hidden = new Set(plan.view_config.hidden ?? []);
      if (w.op === 'hide_component') hidden.add(component);
      else hidden.delete(component);
      return { k: 'actions', summary: '调整页面', actions: [{ type: 'set_view', planId: plan.id, hidden: [...hidden] }] };
    }
  }
}

// ───────────────────────── 主流程 ─────────────────────────

const UNSUPPORTED_TEXT: Record<Turn['unsupported_kind'], string> = {
  income: '现在还不支持记录收入。可以继续记支出和退款，看本月净支出和预算剩余。',
  transfer: '转账、还信用卡和存钱不算新的消费，现在也还不支持记录这类资金往来。',
  reminder: '提醒功能暂时还不支持，我没有设置任何提醒。你可以随时来记录或查询进度。',
  sync: '现在还不能自动同步支付宝或银行流水，请直接告诉我每笔支出。',
  ability: '我只能根据记录的时长和天数说明进度，没法评估能力提升了多少。',
  multi_currency: '目前只支持人民币记账，可以告诉我折合人民币的金额。',
  page_progress: '暂时不支持按页码记录进度，告诉我这次读了多少分钟就可以。',
  pause: '暂停功能还没有。可以先把计划归档，之后随时恢复，历史记录都会保留。',
  other: '这个我暂时还做不到。',
  none: '',
};


function containsGenericCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsGenericCard);
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return object.kind === 'generic' || object.kind === 'generic_period' || object.type === 'generic_added' || Object.values(object).some(containsGenericCard);
}

function referencesHiddenPlan(value: unknown, hidden: ReadonlySet<string>): boolean {
  if (!hidden.size || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => referencesHiddenPlan(item, hidden));
  const object = value as Record<string, unknown>;
  return ['id', 'planId', 'plan_id', 'scopePlanId'].some(key => typeof object[key] === 'string' && hidden.has(object[key] as string))
    || Object.values(object).some(item => referencesHiddenPlan(item, hidden));
}

const inFlight = new WeakMap<Db, Map<string, Promise<ChatReply>>>();

export class Chat {
  constructor(
    private readonly db: Db,
    private readonly llm: Llm,
  ) {}

  /** Read-only recovery. Never calls the model or creates messages/operations. */
  async lookup(userId: string, clientMsgId: string): Promise<ChatReply | null> {
    const [user] = await this.db.query<MessageRow>(`SELECT * FROM messages WHERE user_id = $1 AND client_msg_id = $2 AND role = 'user'`, [userId, clientMsgId]);
    if (!user) return null;
    const [reply] = await this.db.query<MessageRow>(`SELECT * FROM messages WHERE user_id = $1 AND reply_to = $2 AND role = 'assistant' ORDER BY created_at LIMIT 1`, [userId, user.id]);
    if (reply) return { user: msgView(user), assistant: msgView(reply), dataVersion: await this.version(userId), transient: false };
    const op = await findOperation(this.db, userId, clientMsgId);
    if (!op || op.clientOpId !== user.client_msg_id) return null;
    // A committed operation can outlive a lost assistant response. Do not invent original AI prose.
    return {
      user: msgView(user),
      assistant: {
        id: `recovered:${op.operationId}`, role: 'assistant', text: '已核对到这次操作的保存结果。以下是原操作回执。',
        cards: op.templatePlan ? [{ type: 'notice', tone: 'info', text: '已核对到计划设置的保存结果。没有新增事实记录。' }] : [{ type: 'receipt', operationId: op.operationId, kind: op.kind, undoable: op.undoable, items: op.items, ...(op.growth ? { growth: op.growth } : {}) }],
        scopePlanId: user.scope_plan_id, clientMsgId: null, createdAt: op.createdAt,
      },
      dataVersion: op.dataVersion, transient: false,
    };
  }

  processing(userId: string, clientMsgId: string): boolean {
    return inFlight.get(this.db)?.has(`${userId}\0${clientMsgId}`) ?? false;
  }

  async message(userId: string, id: string): Promise<MessageView> {
    const [row] = await this.db.query<MessageRow>('SELECT * FROM messages WHERE id=$1 AND user_id=$2',[id,userId]);
    if (!row) throw new DomainError('not_found','没有找到这条消息。');
    return msgView(row);
  }

  async history(userId: string, limit = 50, before?: string, scopePlanId?: string): Promise<MessageView[]> {
    return (await this.historyPage(userId, limit, before, scopePlanId)).messages;
  }

  async historyPage(userId: string, limit = 50, before?: string, scopePlanId?: string, cursor?: string): Promise<{ messages: MessageView[]; nextCursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError('invalid_input', '分页参数不正确。');
    if (cursor && before) throw new DomainError('invalid_input', '请只使用一种历史分页方式。');
    if (scopePlanId) await getPlan(this.db, userId, scopePlanId);
    const parameters: unknown[] = [userId, limit + 1];
    let filter = '';
    if (cursor) {
      let value: { v: number; user: string; scope: string | null; at: string; id: string };
      try {
        if (cursor.length > 700 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (value.v !== 1 || value.user !== userId || value.scope !== (scopePlanId ?? null) || typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/.test(value.at) || Number.isNaN(Date.parse(value.at)) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)) throw Error();
      } catch { throw new DomainError('invalid_input', '对话分页已失效，请重新读取对话。'); }
      parameters.push(value.at, value.id); filter += ` AND (created_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`;
    }
    if (before) { parameters.push(before); filter += ` AND created_at < $${parameters.length}`; }
    if (scopePlanId) { parameters.push(scopePlanId); filter += ` AND scope_plan_id = $${parameters.length}`; }
    const found = await this.db.query<MessageRow & { cursor_at: string }>(
      `SELECT *, created_at::text AS cursor_at FROM messages WHERE user_id = $1 ${filter} ORDER BY created_at DESC, id DESC LIMIT $2`,
      parameters,
    );
    const rows = found.slice(0, limit), last = rows.at(-1);
    const nextCursor = found.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, user: userId, scope: scopePlanId ?? null, at: last.cursor_at, id: last.id })).toString('base64url') : null;
    const views = rows.reverse().map(msgView);
    for (const row of rows) if (row.role === 'user' && row.client_msg_id && !rows.some((r) => r.reply_to === row.id)) {
      const recovered = await this.lookup(userId, row.client_msg_id);
      if (recovered?.assistant.id.startsWith('recovered:')) views.push(recovered.assistant);
    }
    views.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // 历史回执保留当时的结果，同时标出相关记录现在的状态。
    const ids = new Set<string>();
    const opIds = new Set<string>();
    for (const m of views) for (const c of m.cards) if (c.type === 'receipt') {
      opIds.add(c.operationId);
      for (const id of receiptRecordIds(c.items)) ids.add(id);
    }
    if (opIds.size) {
      // 已经整次撤销的操作，历史回执不再提供撤销入口。
      const ops = await this.db.query<{ id: string; undone: boolean }>(`SELECT id, undone FROM operations WHERE id = ANY($1::uuid[])`, [[...opIds]]);
      const undone = new Set(ops.filter((o) => o.undone).map((o) => o.id));
      for (const m of views) for (const c of m.cards) if (c.type === 'receipt' && undone.has(c.operationId)) c.undoable = false;
    }
    if (ids.size) {
      const recs = await this.db.query<{ id: string; version: number; deleted: boolean }>(`SELECT id, version, deleted FROM records WHERE id = ANY($1::uuid[])`, [[...ids]]);
      const byId = new Map(recs.map((r) => [r.id, r]));
      for (const m of views)
        for (const c of m.cards)
          if (c.type === 'receipt') {
            const current: Record<string, 'same' | 'modified' | 'deleted'> = {};
            for (const it of c.items) for (const [id, version] of receiptRecordVersions(it)) {
              const r = byId.get(id);
              current[id] = !r || r.deleted ? 'deleted' : r.version !== version ? 'modified' : 'same';
            }
            c.current = current;
          }
    }
    return { messages: views, nextCursor };
  }

  async send(userId: string, input: ChatInput): Promise<ChatReply> {
    let pending = inFlight.get(this.db);
    if (!pending) { pending = new Map(); inFlight.set(this.db, pending); }
    const key = `${userId}\0${input.clientMsgId}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const task = this.sendOnce(userId, input).finally(() => pending!.delete(key));
    pending.set(key, task);
    return task;
  }

  private async sendOnce(userId: string, input: ChatInput): Promise<ChatReply> {
    const recovered = await this.lookup(userId, input.clientMsgId);
    if (recovered) return recovered;
    const text = input.text.trim().slice(0, 500);
    if (!text && !input.choice) throw new DomainError('invalid_input', '消息不能为空。');
    const [user] = await this.db.query<{ ai_consent: boolean }>(`SELECT ai_consent FROM users WHERE id = $1`, [userId]);
    if (!user?.ai_consent && !(input.pendingId && input.choice)) throw new DomainError('ai_consent_required', '使用对话前需要先同意把内容发送给云端 AI。你也可以在计划详情里直接用表单记录。');

    if (input.scopePlanId) await getPlan(this.db, userId, input.scopePlanId);

    // 幂等：同一 clientMsgId 返回原回复。
    const [existing] = await this.db.query<MessageRow>(`SELECT * FROM messages WHERE user_id = $1 AND client_msg_id = $2 AND role = 'user'`, [userId, input.clientMsgId]);
    if (existing) {
      const [reply] = await this.db.query<MessageRow>(`SELECT * FROM messages WHERE reply_to = $1`, [existing.id]);
      if (reply) return { user: msgView(existing), assistant: msgView(reply), dataVersion: await this.version(userId), transient: false };
    }
    const userMsg =
      existing ??
      (
        await this.db.query<MessageRow>(`INSERT INTO messages (user_id, role, text, scope_plan_id, client_msg_id, created_at) VALUES ($1, 'user', $2, $3, $4, $5) RETURNING *`, [
          userId,
          text,
          input.scopePlanId ?? null,
          input.clientMsgId,
          new Date(),
        ])
      )[0]!;

    const started = Date.now();
    await usage(this.db, userId, 'request', `${input.clientMsgId}:started`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), source: 'chat', status: 'started', intent: 'unknown', records: 0, clarificationRounds: 0, latencyMs: 0 });
    let out: { text: string; cards: Card[]; transient: boolean; telemetry?: { intent: import('../ai/turn.js').Turn['intent']; rounds: number } };
    try {
      out = input.pendingId && input.choice ? await this.choose(userId, input, userMsg.id) : await this.understand(userId, input, text, userMsg.id);
    } catch (e) {
      if (e instanceof LlmError) {
        await logEvent(this.db, 'model_failure', { kind: e.kind, latencyMs: Date.now() - started });
        await usage(this.db, userId, 'failure', `${input.clientMsgId}:model`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), category: 'model', code: e.kind, retryResult: 'unknown', latencyMs: Date.now() - started });
        out = { text: '', cards: [{ type: 'error', code: 'model_unavailable', message: aiFailureMessage(e.kind, 'chat'), retryable: true }], transient: true };
      } else if (e instanceof DomainError) {
        // Keep authorization failures as 403 so clients retain input and can retry after consent.
        if (e.code === 'ai_consent_required') throw e;
        out = { text: '', cards: [{ type: 'error', code: e.code, message: e.message, retryable: false }], transient: false };
      } else {
        await usage(this.db, userId, 'failure', `${input.clientMsgId}:tool`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), category: 'tool', code: 'internal', retryResult: 'unknown', latencyMs: Date.now() - started });
        await usage(this.db, userId, 'request', `${input.clientMsgId}:unknown`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), source: 'chat', status: 'unknown', intent: 'unknown', records: 0, clarificationRounds: 0, latencyMs: Date.now() - started });
        throw e;
      }
    }
    const requestStatus = out.transient ? 'model_failed' : out.cards.some(c => c.type === 'clarify') ? 'clarification' : out.cards.some(c => c.type === 'error') ? 'rejected' : 'succeeded';
    if (requestStatus === 'rejected') await usage(this.db, userId, 'failure', `${input.clientMsgId}:tool`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), category: 'tool', code: 'domain_rejected', retryResult: 'unknown', latencyMs: Date.now() - started });
    const recordCount = out.cards.flatMap(c => c.type === 'receipt' ? c.items : []).filter(i => ['expense_added', 'refund_added', 'study_added', 'generic_added'].includes(i.type)).length;
    await usage(this.db, userId, 'request', `${input.clientMsgId}:${requestStatus}`, { requestHash: attemptRequestDigest(userId, input.clientMsgId), source: 'chat', status: requestStatus, intent: out.telemetry?.intent ?? 'unknown', records: recordCount, clarificationRounds: out.telemetry?.rounds ?? 0, latencyMs: Date.now() - started });
    for (const [index, card] of out.cards.entries()) if (card.type === 'query') await usageQuery(this.db, userId, `${input.clientMsgId}:${index}`, card, Date.now() - started).catch(() => {});
    if (out.transient) {
      const now = new Date().toISOString();
      return { user: msgView(userMsg), assistant: { id: randomUUID(), role: 'assistant', text: out.text, cards: out.cards, scopePlanId: null, clientMsgId: null, createdAt: now }, dataVersion: await this.version(userId), transient: true };
    }
    const op = out.cards.find((c): c is Extract<Card, { type: 'receipt' }> => c.type === 'receipt');
    const [reply] = await this.db.query<MessageRow>(
      `INSERT INTO messages (user_id, role, text, cards, reply_to, operation_id, scope_plan_id) VALUES ($1, 'assistant', $2, $3, $4, $5, $6) RETURNING *`,
      [userId, out.text, JSON.stringify(out.cards), userMsg.id, op?.operationId ?? null, input.scopePlanId ?? null],
    );
    return { user: msgView(userMsg), assistant: msgView(reply!), dataVersion: await this.version(userId), transient: false };
  }

  private async version(userId: string) {
    const [u] = await this.db.query<{ data_version: number }>(`SELECT data_version FROM users WHERE id = $1`, [userId]);
    return u?.data_version ?? 0;
  }

  private async env(userId: string, scopePlanId: string | null | undefined, inputAt: Date, pre: Draft['pre'], templateCapability = false, genericCapability = false, ledgerTemplateCapability = false, privateTemplateCapability = false, genericTemplateV2Capability = false, communityTemplateCapability = false): Promise<Env> {
    const allPlans = await listPlans(this.db, userId);
    const unsupportedPlanIds = await unsupportedTemplatePlans(this.db,userId,{genericCapability,privateTemplateCapability,genericTemplateV2Capability,communityTemplateCapability});
    if (!genericCapability) for (const plan of allPlans) if (plan.kind === 'generic') unsupportedPlanIds.add(plan.id);
    const plans = allPlans.filter(plan => (genericCapability || plan.kind !== 'generic') && !unsupportedPlanIds.has(plan.id));
    const scope = scopePlanId ? await getPlan(this.db, userId, scopePlanId) : null;
    const reading = new Map<string, ReadingTemplate>();
    const templates = new Map<string, ReadingTemplate>();
    for (const plan of plans) {
      if (plan.kind === 'study' && !templateCapability || plan.kind === 'ledger' && !ledgerTemplateCapability) continue;
      try {
        const state = await getPlanTemplate(this.db, userId, plan.id, shanghaiDate(inputAt));
        templates.set(plan.id, state);
        if (state.source === 'official' && state.templateId === 'official.reading') reading.set(plan.id, state);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'not_found') throw error;
      }
    }
    const lastOps = await this.db.query<{ id: string; result: OperationResult }>(`SELECT id, result FROM operations WHERE user_id = $1 AND kind = 'batch' AND NOT undone ${scope ? `AND (result->'items' @> $2::jsonb OR result->'items' @> $3::jsonb)` : ''} ORDER BY created_at DESC LIMIT 1`, scope ? [userId, JSON.stringify([{ record: { planId: scope.id } }]), JSON.stringify([{ records: [{ planId: scope.id }] }])] : [userId]);
    const last = lastOps[0];
    let lastRecords: RecordRow[] = [];
    if (last) {
      const ids = receiptRecordIds(last.result.items);
      if (ids.length) lastRecords = await this.db.query<RecordRow>(`SELECT * FROM records WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY created_at`, [ids, userId]);
      if (scope) lastRecords = lastRecords.filter(record => record.plan_id === scope.id);
      if (!genericCapability) lastRecords = lastRecords.filter(record => record.kind !== 'generic');
      lastRecords = lastRecords.filter(record => !unsupportedPlanIds.has(record.plan_id));
    }
    // Chat operations are tied to their user request and visible reply. A missing
    // reply is recoverable by lookup/history; later form operations have no chat request.
    const undoReceipts = await this.db.query<{ result: OperationResult; undone: boolean }>(`SELECT o.result, o.undone FROM messages u JOIN operations o ON o.user_id = u.user_id AND o.client_op_id = u.client_msg_id LEFT JOIN LATERAL (SELECT created_at FROM messages WHERE user_id = u.user_id AND reply_to = u.id AND role = 'assistant' ORDER BY created_at LIMIT 1) reply ON true WHERE u.user_id = $1 AND u.role = 'user' AND o.kind = 'batch' ${scope ? 'AND u.scope_plan_id = $2' : ''} ORDER BY COALESCE(reply.created_at, u.created_at) DESC, u.id DESC LIMIT 12`, scope ? [userId, scope.id] : [userId]);
    return { reading, templates, templateCapability, genericCapability, ledgerTemplateCapability, privateTemplateCapability, genericTemplateV2Capability, communityTemplateCapability, unsupportedPlanIds, answering: false, plans, scope, today: shanghaiDate(inputAt), inputAt, pre, lastRecords, undoReceipts, batchStudy: null, text: '' };
  }

  private async openPending(userId: string, scopePlanId?: string | null): Promise<PendingRow | null> {
    const [p] = await this.db.query<PendingRow>(`SELECT * FROM pending_actions WHERE user_id = $1 AND status = 'open' ${scopePlanId ? `AND draft->>'scopePlanId' = $2` : ''} ORDER BY created_at DESC LIMIT 1`, scopePlanId ? [userId, scopePlanId] : [userId]);
    return p ?? null;
  }

  private async repeatDuplicateChoice(userId: string, pending: PendingRow) {
    const rows = await this.db.query<{ cards: Card[] }>(`SELECT cards FROM messages WHERE user_id=$1 AND cards @> $2::jsonb`, [userId, JSON.stringify([{ pendingId: pending.id }])]);
    const cards = rows.flatMap((r) => r.cards.filter((c) => c.type === 'clarify' && c.pendingId === pending.id)).slice(0, 1);
    return { text: '请先核对这张疑似重复卡片：选择“又发生了一次，仍要保存”或取消。还没有保存。', cards, transient: false };
  }

  private async understand(userId: string, input: ChatInput, text: string, userMsgId: string) {
    // 确定性的前置检查：不依赖模型，避免截断或把负数当正数保存。
    if (countAmountSegments(text) > 10) return { text: '一次最多记 10 条，这次什么都没有保存。请分成几次发给我。', cards: [], transient: false };
    const pending = await this.openPending(userId, input.scopePlanId);
    if (pending?.draft.options.some((o) => o.patches.some((p) => p.k === 'first_week' || p.k === 'duplicate'))) {
      const exact = pending.draft.options.find((o) => o.label === text);
      if (exact) return this.choose(userId, { ...input, pendingId: pending.id, choice: exact.id }, userMsgId);
      if (pending.draft.options.some((o) => o.patches.some((p) => p.k === 'duplicate')) && /^(是|是的|没错|又发生了一次|再记一次|仍要保存|确认|保存|又一次)[。！!]?$/u.test(text)) return this.repeatDuplicateChoice(userId, pending);
    }
    const inputAt = input.inputAt;
    const env = await this.env(userId, input.scopePlanId, inputAt, { createLedger: false, createStudy: null, restore: [] }, input.templateCapability === true, input.genericCapability === true, input.ledgerTemplateCapability === true, input.privateTemplateCapability === true, input.genericTemplateV2Capability === true, input.communityTemplateCapability === true);
    env.text = text;
    if (env.scope && env.unsupportedPlanIds.has(env.scope.id) || pending?.draft.writes.some(write => write.plan_id && env.unsupportedPlanIds.has(write.plan_id))) return { text: '这个计划需要在新版网页中查看和记录，已有内容仍会保留。', cards: [], transient: false };
    if (env.unsupportedPlanIds.size && (await listPlans(this.db, userId)).some(plan => env.unsupportedPlanIds.has(plan.id) && text.includes(plan.name))) return { text: '这个计划需要在新版网页中操作，这次没有更改已有内容。', cards: [], transient: false };
    if (!env.genericCapability && (env.scope?.kind === 'generic' || pending?.draft.writes.some(isGenericWrite))) return { text: '这个计划的内容需要在新版网页中查看和记录，已有数据仍然保留。', cards: [{ type: 'notice' as const, tone: 'info' as const, text: '请在新版网页中继续操作。' }], transient: false };
    if (!env.genericCapability) {
      const unsupported = (await listPlans(this.db, userId)).filter(plan => plan.kind === 'generic');
      if (unsupported.some(plan => text.includes(plan.name))) return { text: '这个计划需要在新版网页中查看和记录。这次没有执行写入，已有数据仍然保留。', cards: [], transient: false };
    }
    const allGoals = await segmentsForPlans(this.db, env.plans.map((p) => p.id));
    const goalOf = (p: PlanRow) => {
      if (p.kind === 'generic') return '按模板配置与真实记录分别处理';
      const segs = allGoals.get(p.id) ?? [];
      const period = p.kind === 'ledger' ? env.today.slice(0, 7) : env.today;
      if (p.kind === 'ledger') {
        const b = valueAt(segs, 'budget_cents', period);
        return b ? `月预算 ${formatYuan(b)}` : '未设预算';
      }
      const n = valueAt(segs, 'days_per_week', weekOf(env.today));
      const m = valueAt(segs, 'min_minutes', weekOf(env.today));
      return `${n ? `每周 ${n} 天` : '每周天数未设'}，${m ? `每天 ${m} 分钟` : '每天分钟数未设'}`;
    };
    const plans = [];
    for (const p of env.plans) plans.push({ id: p.id, kind: p.kind, name: p.name, status: p.status, goal: goalOf(p), layout: p.kind === 'generic' ? env.templates.get(p.id)?.definition.components.join(',') : componentOrder(p.kind, p.view_config.order).join(','), ...(env.reading.has(p.id) ? { reading: { currentBook: env.reading.get(p.id)!.config.currentBook, setupStatus: env.reading.get(p.id)!.config.setupStatus } } : {}), ...(p.kind === 'generic' && env.templates.has(p.id) ? { generic: { definition: env.templates.get(p.id)!.definition, configuration: env.templates.get(p.id)!.config.values, recordDefaults: env.templates.get(p.id)!.config.recordDefaults, proposedDefaults: env.templates.get(p.id)!.config.proposedDefaults, goals: env.templates.get(p.id)!.config.goals } } : {}), ...(p.kind === 'ledger' && env.templates.get(p.id)?.source === 'official' ? { ledgerTemplate: true } : {}) });
    const recent = await this.db.query<RecordRow>(`SELECT * FROM records WHERE user_id = $1 AND NOT deleted ${!env.genericCapability ? `AND kind <> 'generic'` : ''} ${env.scope ? 'AND plan_id = $2' : ''} ORDER BY created_at DESC LIMIT 8`, env.scope ? [userId, env.scope.id] : [userId]);
    const names = new Map(env.plans.map((p) => [p.id, p.name]));
    const historyRows = await this.db.query<{ id: string; reply_to: string | null; role: string; text: string; cards: Card[]; scope_plan_id: string | null }>(`SELECT role, text, cards, scope_plan_id, id, reply_to FROM messages WHERE user_id = $1 AND id <> $2 AND text <> '' ${env.scope ? 'AND scope_plan_id = $3' : ''} ORDER BY created_at DESC LIMIT 8`, env.scope ? [userId, userMsgId, env.scope.id] : [userId, userMsgId]);
    const hiddenHistoryIds = new Set(historyRows.filter(row => (!env.genericCapability && containsGenericCard(row.cards)) || referencesHiddenPlan(row.cards, env.unsupportedPlanIds) || row.scope_plan_id && env.unsupportedPlanIds.has(row.scope_plan_id)).flatMap(row => row.reply_to ? [row.id, row.reply_to] : [row.id]));
    const system = buildSystemPrompt({
      templateCapability: env.templateCapability,
      genericCapability: env.genericCapability,
      genericTemplateV2Capability: env.genericTemplateV2Capability,
      ledgerTemplateCapability: env.ledgerTemplateCapability,
      nowText: `${env.today} ${weekdayCN(env.today)} ${shanghaiTime(inputAt)}`,
      today: env.today,
      plans,
      scope: env.scope ? { id: env.scope.id, name: env.scope.name, kind: env.scope.kind } : null,
      recentRecords: recent.filter(r => !env.unsupportedPlanIds.has(r.plan_id)).map((r) => ({ id: r.id, text: recordText(recordView(r), names.get(r.plan_id), env.templates.get(r.plan_id)?.definition) })),
      pending: pending ? { writes: pending.draft.writes } : null,
      history: historyRows.filter(row => !hiddenHistoryIds.has(row.id) && (!row.scope_plan_id || env.plans.some(plan => plan.id === row.scope_plan_id))).reverse().map((h) => ({ role: h.role, text: h.text.slice(0, 120) })),
    });
    // Recheck at the model boundary: consent may have been revoked during context reads.
    const [consent] = await this.db.query<{ ai_consent: boolean }>('SELECT ai_consent FROM users WHERE id = $1', [userId]);
    if (!consent?.ai_consent) throw new DomainError('ai_consent_required', '使用对话前需要先同意把内容发送给云端 AI。你也可以在计划详情里直接用表单记录。');
    const res = await this.llm.plan(system, text, { userId, requestId: input.clientMsgId, recoveryCapable: input.recoveryCapability === true });
    const turn = res.turn;
    await linkRequest(this.db,userId,input.clientMsgId,turn.intent==='answer_pending' ? pending?.draft.messageId : undefined);
    await logEvent(this.db, 'turn_understood', { intent: turn.intent, writes: turn.writes.length, hasQuery: !!turn.query, latencyMs: res.latencyMs, promptTokens: res.usage?.prompt ?? null, completionTokens: res.usage?.completion ?? null });

    if (turn.intent === 'cancel_pending' && pending) {
      if (!(await this.claimPending(pending.id, 'cancelled'))) return { text: '这几项已经处理过了。', cards: [], transient: false };
      await this.syncPendingCards(pending.id, 'cancelled');
      return { text: pending.draft.writes.some(write => write.op === 'undo_last') ? '好的，保留原记录，没有撤销。' : '好的，这几项不保存了。', cards: [], transient: false };
    }
    // Even a non-action model reply must not claim that a broad deletion happened.
    if (broadRecordDeletion(text)) return { text: DELETE_REVIEW_TEXT, cards: [], transient: false };
    if (turn.intent === 'unsupported') return { text: turn.reply || UNSUPPORTED_TEXT[turn.unsupported_kind] || UNSUPPORTED_TEXT.other, cards: [], transient: false };
    if (turn.writes.length > 10) return { text: '一次最多记 10 条，请分批发给我。这次什么都没有保存。', cards: [], transient: false };
    if (HAS_NEGATIVE_AMOUNT.test(text) && turn.writes.some((x) => x.op === 'add_expense' || x.op === 'add_refund' || x.op === 'edit_record')) {
      return { text: '金额需要是大于 0 的数，这次没有保存。退款请说“某某退了多少”。', cards: [], transient: false };
    }
    if (!turn.writes.length && !turn.query) return { text: turn.question || turn.reply || questionFor(turn.missing) || '我在。可以直接告诉我一笔支出、一次阅读，或者问问进度。', cards: [], transient: false };

    let pre: Draft['pre'] = { createLedger: false, createStudy: null, restore: [] };
    let draftMsgId = userMsgId;
    let processEnv = env;
    const answering = turn.intent === 'answer_pending' && pending ? pending : null;
    if (pending?.draft.options.some((o) => o.patches.some((p) => p.k === 'first_week')) && (answering || turn.writes.some((w) => w.op === 'create_study' || w.op === 'set_study_goal' || w.op === 'configure_reading_plan'))) {
      const rows = await this.db.query<{ cards: Card[] }>(`SELECT cards FROM messages WHERE user_id = $1 AND cards @> $2::jsonb`, [userId, JSON.stringify([{ pendingId: pending.id }])]);
      const cards = rows.flatMap((r) => r.cards.filter((c) => c.type === 'clarify' && c.pendingId === pending.id)).slice(0, 1);
      return { text: '请在这张卡片中选择本周目标的处理方式，或取消。还没有保存。', cards, transient: false };
    }
    if (answering?.draft.options.some((o) => o.patches.some((p) => p.k === 'duplicate'))) return this.repeatDuplicateChoice(userId, answering);
    try {
      if (answering) {
        // 先原子地占用待补充内容：并发的两次回答只有一次能保存。
        if (!(await this.claimPending(answering.id, 'resolved'))) return { text: '这几项已经处理过了，没有重复保存。', cards: [], transient: false };
        pre = answering.draft.pre;
        draftMsgId = answering.draft.messageId;
        processEnv = await this.env(userId, answering.draft.scopePlanId, new Date(answering.input_at), pre, input.templateCapability === true, input.genericCapability === true, input.ledgerTemplateCapability === true, input.privateTemplateCapability === true, input.genericTemplateV2Capability === true, input.communityTemplateCapability === true);
        processEnv.text = `${answering.draft.originalText ?? ''}\n${text}`.trim();
        processEnv.originalWrites = structuredClone(answering.draft.writes);
        processEnv.answering = true;
        if (answering.draft.writes.some(isGenericWrite)) turn.writes = mergeGenericAnswer(answering.draft.writes, turn.writes, answering.draft.fixedWrites ?? [], input.text);
        for (const original of answering.draft.writes) {
          if (!isConfigurationWrite(original) || original.expected_config_version === undefined) continue;
          const next = turn.writes.find(write => write.op === original.op && (!write.plan_id || write.plan_id === original.plan_id));
          if (next) next.expected_config_version = original.expected_config_version;
        }
        // 前一个问题可能是同批的金额/计划归属。补充它时，模型仍不能顺便改掉未确认的首周目标。
        for (const original of answering.draft.writes) {
          if (original.op !== 'create_study' && original.op !== 'set_study_goal' && original.op !== 'configure_reading_plan') continue;
          const start = original.op === 'create_study' ? processEnv.today : pickStudy(original, processEnv).plan?.start_date;
          if (!start || !firstWeekDecision(original, processEnv, start).question) continue;
          const index = turn.writes.findIndex((w) => w.op === original.op && w.plan_id === original.plan_id && w.plan_name === original.plan_name && w.activity === original.activity);
          if (index < 0) turn.writes.push(original);
          else turn.writes[index] = { ...turn.writes[index]!, days_per_week: original.days_per_week, goal_period: original.goal_period, scope: original.scope };
        }
      }
      const out = await this.process(userId, input.clientMsgId, turn.writes, turn.query, { ...processEnv, pre }, answering ? answering.draft.scopePlanId : input.scopePlanId ?? null, draftMsgId, turn.reply, answering?.draft.rounds ?? 0);
      if (answering) await this.syncPendingCards(answering.id, 'resolved');
      return { ...out, telemetry: { intent: turn.intent, rounds: (answering?.draft.rounds ?? 0) + (out.cards.some(c => c.type === 'clarify') ? 1 : 0) } };
    } catch (e) {
      if (answering) await this.reopenPending(answering.id);
      throw e;
    }
  }

  /** 解析、必要时追问、否则整批执行，最后回答查询。 */
  private async process(userId: string, opKey: string, writes: TurnWrite[], query: TurnQuery | null, env: Env, scopePlanId: string | null, messageId: string, modelReply: string, rounds = 0): Promise<{ text: string; cards: Card[]; transient: boolean }> {
    if (scopePlanId && env.unsupportedPlanIds.has(scopePlanId) || query?.plan_id && env.unsupportedPlanIds.has(query.plan_id) || writes.some(write => write.plan_id && env.unsupportedPlanIds.has(write.plan_id))) return { text: '这个计划需要在新版网页中操作。这次没有执行任何写入，已有内容仍会保留。', cards: [], transient: false };
    writes = normalizeWrites(writes, env);
    // Reject before resolving missing fields, offering "save the rest", or
    // adding implicit create/restore actions. Pending choices cannot launder an
    // old unsafe batch by dropping a write or replacing it with a model reply.
    if (unsafeChatDeletion(writes, env) || env.originalWrites && unsafeChatDeletion(env.originalWrites, env)) return { text: DELETE_REVIEW_TEXT, cards: [], transient: false };
    if (query && env.scope && ((query.kind === 'study_progress' && env.reading.has(env.scope.id)) || (query.kind === 'generic_summary' && env.scope.kind === 'generic'))) {
      const explicit = query.plan_id ? env.plans.find(plan => plan.id === query!.plan_id) : null;
      if (!explicit || !env.text.includes(explicit.name)) query = { ...query, plan_id: env.scope.id };
    }
    if (!env.genericCapability && (writes.some(isGenericWrite) || query?.kind === 'generic_summary')) return { text: '通用计划请在新版网页中查看和记录。这次没有执行任何写入，已有数据仍然保留。', cards: [], transient: false };
    if (writes.some(write => write.op === 'undo_last') && writes.length > 1) return { text: '撤销需要单独处理，请先发送要撤销的操作。这次没有执行任何写入或撤销。', cards: [], transient: false };
    const configurations = writes.filter(isConfigurationWrite);
    const hasCapability = configurations.every(write => write.op === 'configure_reading_plan' ? env.templateCapability : write.op === 'configure_ledger_plan' ? env.ledgerTemplateCapability : env.genericCapability);
    if (configurations.length && (!hasCapability || writes.length !== 1)) return { text: !hasCapability ? '请在支持模板设置的新版网页中修改计划。这次没有保存。' : '请先单独完成一个计划的设置，再发送记录或其他计划的操作。这次都没有保存。', cards: [{ type: 'notice', tone: 'info', text: '这次没有保存任何设置或记录。' }], transient: false };
    const creating = writes.find((x) => x.op === 'create_study');
    env = { ...env, batchStudy: creating ? creating.plan_name ?? creating.activity ?? '阅读' : null };
    const resolved: Resolved[] = [];
    for (let i = 0; i < writes.length; i++) resolved.push(await duplicateChoice(this.db, userId, await resolveWrite(this.db, userId, i, writes[i]!, env), env));
    const cards: Card[] = [];
    const texts: string[] = [];
    const blocked = resolved.find((result): result is Extract<Resolved, { k: 'blocked' }> => result.k === 'blocked');
    if (blocked) return { text: `${blocked.text}这次都没有保存。`, cards: [], transient: false };
    if (writes.some(isGenericWrite) && resolved.some(result => result.k === 'notice')) return { text: '这批内容里还有未能确认的事项，请分别说明实际发生的记录。这次都没有保存。', cards: [], transient: false };
    const notices = resolved.filter((r): r is Extract<Resolved, { k: 'notice' }> => r.k === 'notice');
    for (const n of notices) {
      texts.push(n.text);
      if (n.cards) cards.push(...n.cards);
    }

    const missing = resolved.map((r, idx) => ({ r, idx })).filter((x): x is { r: Extract<Resolved, { k: 'missing' }>; idx: number } => x.r.k === 'missing');
    const ready = resolved.filter((r): r is Extract<Resolved, { k: 'actions' }> => r.k === 'actions');
    if (missing.length) {
      const first = missing[0]!;
      const options = [...first.r.options];
      const writeCount = resolved.filter((r) => r.k === 'actions' || r.k === 'missing').length;
      if (ready.length && !writes.some(isGenericWrite)) options.push(opt(`只保存其余 ${ready.length} 条`, missing.map((m) => ({ k: 'remove', idx: m.idx }) as Patch)));
      options.push(opt(writeCount > 1 ? `取消这 ${writeCount} 条` : '取消', [{ k: 'cancel' }], 'cancel'));
      const draft: Draft = { writes, query, scopePlanId, pre: env.pre, originalText: env.text, options, messageId, rounds: rounds + 1, fixedWrites: resolved.flatMap((result, index) => result.k === 'actions' ? [index] : []) };
      const [p] = await this.db.query<{ id: string }>(`INSERT INTO pending_actions (user_id, message_id, draft, input_at) VALUES ($1, $2, $3, $4) RETURNING id`, [userId, messageId, JSON.stringify(draft), env.inputAt]);
      type Item = { summary: string; ready: boolean; issue: string | null };
      const items: Item[] = [];
      for (const r of resolved) {
        if (r.k === 'actions') items.push({ summary: r.summary, ready: true, issue: null });
        else if (r.k === 'missing') items.push({ summary: r.summary, ready: false, issue: r.issue });
      }
      cards.push({
        type: 'clarify',
        pendingId: p!.id,
        question: first.r.question,
        items,
        options: options.map(({ id, label, style }) => ({ id, label, style })),
        hint: writes.some(write => write.op === 'delete_record') ? '还没有删除任何记录。选择后只删除所选记录；有关联退款时会再次核对。' : writes.some(write => write.op === 'undo_last') ? '还没有撤销任何记录。选择后只撤销对应回执中的操作。' : writeCount > 1 ? `这 ${writeCount} 条都还没有保存，补充后会一起保存。` : '还没有保存，补充后才会计入。',
        status: 'open',
      });
      texts.unshift(writeCount > 1 ? `这 ${writeCount} 条还没有保存。${first.r.question}` : first.r.question);
      await logEvent(this.db, 'clarification', { category: clarificationCategory(first.r.issue), items: writeCount });
      if (query) {
        cards.push(await runQuery(this.db, userId, query, env.today, env.scope, env.text, env.unsupportedPlanIds));
        texts.push('下面是目前已保存的数据，待保存的内容还没有计入。');
      }
      return { text: texts.join(''), cards, transient: false };
    }

    const undoReq = resolved.find((r): r is Extract<Resolved, { k: 'undo' }> => r.k === 'undo');
    if (undoReq) {
      const res = await undo(this.db, { userId, inputAt: env.inputAt, source: 'chat', messageId, genericCapability: env.genericCapability, privateTemplateCapability: env.privateTemplateCapability, genericTemplateV2Capability: env.genericTemplateV2Capability, communityTemplateCapability: env.communityTemplateCapability }, undoReq.operationId, opKey);
      cards.push({ type: 'receipt', operationId: res.operationId, kind: res.kind, undoable: false, items: res.items });
      texts.push(itemsText(res.items));
    } else {
      const actions: Action[] = [];
      if (env.pre.createLedger) actions.push({ type: 'create_ledger' });
      if (env.pre.createStudy) actions.push({ type: 'create_study', activity: env.pre.createStudy });
      for (const id of env.pre.restore) actions.push({ type: 'restore_plan', planId: id });
      // 新建计划排在最前，后面的记录才能引用它。
      const all = ready.flatMap((r) => r.actions);
      actions.push(...all.filter((a) => a.type === 'create_ledger' || a.type === 'create_study'), ...all.filter((a) => a.type !== 'create_ledger' && a.type !== 'create_study'));
      if (ready.length) {
        try {
          const res = await execute(this.db, { userId, inputAt: env.inputAt, source: 'chat', messageId, templateCapability: env.templateCapability, genericCapability: env.genericCapability, ledgerTemplateCapability: env.ledgerTemplateCapability, privateTemplateCapability: env.privateTemplateCapability, genericTemplateV2Capability: env.genericTemplateV2Capability, communityTemplateCapability: env.communityTemplateCapability }, opKey, actions);
          if (res.templatePlan) {
            cards.push({ type: 'notice', tone: 'info', text: '计划设置已更新。目标与预算不会计入已完成的记录。' });
            const updatedPlan = await getPlan(this.db, userId, res.templatePlan.planId);
            cards.push({ type: 'plan', card: await planCard(this.db, updatedPlan, env.today), note: res.templatePlan.engine === 'study' ? res.templatePlan.config.currentBook ? `当前书籍：《${res.templatePlan.config.currentBook}》` : '当前书籍未设置；记录时可以直接提供书名。' : '设置已保存，实际记录单独累计。' });
            texts.push('计划设置已更新。');
          } else {
            cards.push({ type: 'receipt', operationId: res.operationId, kind: res.kind, undoable: res.undoable, items: res.items, ...(res.growth ? { growth: res.growth } : {}) });
            texts.push(itemsText(res.items));
          }
          await logEvent(this.db, 'write_succeeded', { items: res.items.length, types: res.items.map((i) => i.type) });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          await logEvent(this.db, 'write_rejected', { code: e.code });
          if (e.code === 'plan_archived' && typeof e.details.planId === 'string') {
            const draft: Draft = { writes, query, scopePlanId, originalText: env.text, pre: { ...env.pre, restore: [...env.pre.restore, e.details.planId] }, options: [], messageId, rounds: rounds + 1 };
            const restoreOpt = opt('恢复并记录', [], 'primary');
            const cancel = opt('取消', [{ k: 'cancel' }], 'cancel');
            draft.options = [restoreOpt, cancel];
            const [p] = await this.db.query<{ id: string }>(`INSERT INTO pending_actions (user_id, message_id, draft, input_at) VALUES ($1, $2, $3, $4) RETURNING id`, [userId, messageId, JSON.stringify(draft), env.inputAt]);
            cards.push({ type: 'clarify', pendingId: p!.id, question: e.message, items: ready.map((r) => ({ summary: r.summary, ready: true, issue: null })), options: [restoreOpt, cancel].map(({ id, label, style }) => ({ id, label, style })), hint: '还没有保存。', status: 'open' });
            return { text: e.message, cards, transient: false };
          }
          cards.push({ type: 'error', code: e.code, message: e.message, retryable: false });
          texts.push('这次没有保存。');
        }
      }
    }
    if (query) {
      const qc = await runQuery(this.db, userId, query, env.today, env.scope, env.text, env.unsupportedPlanIds);
      cards.push(qc);
      texts.push(queryText(qc));
    }
    if (!texts.length && modelReply) texts.push(modelReply);
    return { text: texts.join(''), cards, transient: false };
  }

  /** 点选澄清选项：确定性地修改待补充草稿，不再调用模型。 */
  private async choose(userId: string, input: ChatInput, userMsgId: string) {
    const [p] = await this.db.query<PendingRow>(`SELECT * FROM pending_actions WHERE id = $1 AND user_id = $2`, [input.pendingId, userId]);
    if (!p) throw new DomainError('not_found', '这个待补充的内容已经不在了。');
    if (p.status !== 'open') return { text: p.status === 'cancelled' ? '这几项已经取消了。' : '这几项已经处理过了。', cards: [], transient: false };
    const option = p.draft.options.find((o) => o.id === input.choice);
    if (!option) throw new DomainError('invalid_input', '这个选项已经失效了。');
    await linkRequest(this.db,userId,input.clientMsgId,p.draft.messageId);
    const cancelling = option.patches.some((x) => x.k === 'cancel');
    // 先原子地占用这条待补充内容，再执行；同一个选项被重复点击时只有第一次会保存。
    if (!(await this.claimPending(p.id, cancelling ? 'cancelled' : 'resolved'))) return { text: '这几项已经处理过了，没有重复保存。', cards: [], transient: false };
    const draft: Draft = JSON.parse(JSON.stringify(p.draft));
    const removed = new Set<number>();
    for (const patch of option.patches) {
      if (patch.k === 'cancel') {
        await this.syncPendingCards(p.id, 'cancelled');
        return { text: draft.writes.some(write => write.op === 'undo_last') ? '好的，保留原记录，没有撤销。' : '好的，这几项不保存了。', cards: [], transient: false };
      }
      if (patch.k === 'set') (draft.writes[patch.idx] as unknown as Record<string, unknown>)[patch.field] = patch.value;
      if (patch.k === 'remove') removed.add(patch.idx);
      if (patch.k === 'duplicate') (draft.pre.duplicates ??= []).push(patch.actionKey);
      if (patch.k === 'first_week') (draft.pre.firstWeek ??= []).push({ writeKey: patch.writeKey, mode: patch.mode });
      if (patch.k === 'create_ledger_first') draft.pre.createLedger = true;
      if (patch.k === 'create_study_first') draft.pre.createStudy = patch.activity;
      if (patch.k === 'restore_first') draft.pre.restore.push(patch.planId);
      if (patch.k === 'undo_operation') draft.pre.undoOperationId = patch.operationId;
      if (patch.k === 'delete_target' && draft.writes[patch.idx]?.op === 'delete_record' && draft.writes[patch.idx]?.record_id === patch.recordId) draft.pre.deleteTargets = { ...draft.pre.deleteTargets, [patch.recordId]: patch.version };
      if (patch.k === 'confirm_refund_delete') draft.pre.refundDeleteSnapshots = { ...draft.pre.refundDeleteSnapshots, [patch.recordId]: patch.token };
    }
    draft.writes = draft.writes.filter((_, i) => !removed.has(i));
    try {
      const env = await this.env(userId, draft.scopePlanId, new Date(p.input_at), draft.pre, input.templateCapability === true, input.genericCapability === true, input.ledgerTemplateCapability === true, input.privateTemplateCapability === true, input.genericTemplateV2Capability === true, input.communityTemplateCapability === true);
      env.text = draft.originalText ?? '';
      env.originalWrites = p.draft.writes;
      env.deletionText = `${draft.originalText ?? ''}\n${input.text}`;
      const out = await this.process(userId, input.clientMsgId, draft.writes, draft.query, env, draft.scopePlanId, draft.messageId, '', draft.rounds ?? 1);
      await this.syncPendingCards(p.id, 'resolved');
      return { ...out, telemetry: { intent: 'answer_pending' as const, rounds: (draft.rounds ?? 1) + (out.cards.some(c => c.type === 'clarify') ? 1 : 0) } };
    } catch (e) {
      // 意外失败（不是业务拒绝）时放回 open，用户可以再选一次。
      await this.reopenPending(p.id);
      throw e;
    }
  }

  /** 条件更新：只有仍为 open 的待补充内容能被占用，返回是否占用成功。 */
  private async claimPending(id: string, status: 'resolved' | 'cancelled'): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(`UPDATE pending_actions SET status = $2 WHERE id = $1 AND status = 'open' RETURNING id`, [id, status]);
    return rows.length === 1;
  }

  private async reopenPending(id: string) {
    await this.db.query(`UPDATE pending_actions SET status = 'open' WHERE id = $1`, [id]);
  }

  /** 原消息里的澄清卡同步显示为已处理。 */
  private async syncPendingCards(pendingId: string, status: 'resolved' | 'cancelled') {
    const msgs = await this.db.query<{ id: string; cards: Card[] }>(`SELECT id, cards FROM messages WHERE cards @> $1::jsonb`, [JSON.stringify([{ pendingId }])]);
    for (const m of msgs) {
      const cards = m.cards.map((c) => (c.type === 'clarify' && c.pendingId === pendingId ? { ...c, status } : c));
      await this.db.query(`UPDATE messages SET cards = $2 WHERE id = $1`, [m.id, JSON.stringify(cards)]);
    }
  }
}

function receiptRecordVersions(it: ItemResult): [string, number][] {
  switch (it.type) {
    case 'expense_added':
    case 'study_added':
    case 'generic_added':
      return [[it.record.id, it.record.version]];
    case 'refund_added':
      return [[it.record.id, it.record.version]];
    case 'record_edited':
      return [[it.record.id, it.record.version]];
    case 'record_deleted':
      return it.records.map((r) => [r.id, r.version] as [string, number]);
    case 'undone':
      return it.records.map((r) => [r.id, r.version] as [string, number]);
    default:
      return [];
  }
}

function receiptRecordIds(items: ItemResult[]): string[] {
  return items.flatMap((it) => (it.type === 'record_deleted' || it.type === 'undone' ? [] : receiptRecordVersions(it).map(([id]) => id)));
}

export { formatMonthDay };
