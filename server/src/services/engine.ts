import { requireTemplateCapabilities, unsupportedTemplatePlans } from './template-capabilities.js';
import { getCommunityUpgrade, registerCommunityAdoption } from './community.js';
import { usageOperation } from './usage.js';
import type { Db, Queryable, Transaction } from '../db/db.js';
import { isCategory, validateRefundGroup, type Category } from '../domain/ledger.js';
import { isValidCents, formatYuan } from '../domain/money.js';
import { planRuleChange, type ChangeScope, type GoalParam } from '../domain/rules.js';
import { isValidDaysPerWeek, isValidMinutes, MAX_MINUTES_PER_DAY } from '../domain/study.js';
import { formatMonthDay, isBizDate, monthOf, nextMonth, nextWeek, shanghaiDate, weekOf, type BizDate } from '../domain/time.js';
import { DomainError, fail } from './errors.js';
import { awardForRecord, deltaOf, type GrowthDelta } from './growth.js';
import { requireActiveUser } from './deletion.js';
import { activeRefunds, getLedger, getPlan, getRecord, listPlans, segments, type PlanRow, type RecordRow } from './repo.js';
import { HIDEABLE, LEDGER_COMPONENTS, STUDY_COMPONENTS, ledgerStatsFor, planView, recordView, studyStatsFor, type PlanView, type RecordView } from './views.js';
import { addGenericActionSchema, editGenericActionSchema, type AdoptTemplateAction, type ApplyPrivateTemplateAction, type ConfigureReadingAction, type ConfigureLedgerAction, type ConfigureGenericAction, type AddGenericAction, type EditGenericAction, type GenericSummary, type GenericValues, type TemplatePlanState, type TemplateDefinition } from '../templates/contracts.js';
import { bindAdoptedPlan, applyPrivateTemplateInTransaction, configureReadingPlanInTransaction, configureOtherTemplateInTransaction, getPlanTemplate, getAdoptableTemplate, isTemplateAction, prepareTemplateAdoption, verifyTemplateRequest } from './templates.js';
import { genericSummary, validateGenericRecordValues, prepareGenericRecordValues, getGenericRecordDefaults } from './generic.js';
import { assertCompatibleTemplate, getPrivateTemplate } from './creation-drafts.js';
import { REFUND_SNAPSHOT_PATTERN, refundSnapshot } from './refund-snapshot.js';

// ───────────────────────── 动作定义 ─────────────────────────

export type Action =
  | { type: 'upgrade_community_template'; planId: string; targetVersion: number; expectedVersion: number }
  | AdoptTemplateAction | ApplyPrivateTemplateAction | ConfigureReadingAction | ConfigureLedgerAction | ConfigureGenericAction | AddGenericAction | EditGenericAction
  | { type: 'create_ledger'; budgetCents?: number | null }
  | { type: 'create_study'; name?: string | null; activity?: string | null; daysPerWeek?: number | null; minMinutes?: number | null; startNextWeek?: boolean }
  | { type: 'add_expense'; amountCents: number; category: Category; date: BizDate; note?: string }
  | { type: 'add_refund'; expenseId: string; amountCents: number; date: BizDate; note?: string }
  | { type: 'add_study'; planId: string; minutes: number; date: BizDate; note?: string }
  | { type: 'edit_record'; recordId: string; correctionReason?: 'understanding_error' | 'normal_adjustment' | 'unspecified'; expectedVersion?: number; patch: { amountCents?: number; minutes?: number; category?: Category; date?: BizDate; note?: string } }
  | { type: 'delete_record'; recordId: string; correctionReason?: 'understanding_error' | 'normal_adjustment' | 'unspecified'; includeRefunds?: boolean; expectedVersion?: number; expectedRefundSnapshot?: string }
  | { type: 'set_goal'; planId: string; param: GoalParam; value: number; scope: ChangeScope }
  | { type: 'rename_plan'; planId: string; name: string }
  | { type: 'archive_plan'; planId: string }
  | { type: 'restore_plan'; planId: string }
  | { type: 'set_view'; planId: string; hidden?: string[]; order?: string[] };

export interface ExecContext {
  userId: string;
  inputAt: Date;
  source: 'chat' | 'form';
  messageId?: string | null;
  templateCapability?: boolean;
  ledgerTemplateCapability?: boolean;
  genericCapability?: boolean;
  privateTemplateCapability?: boolean;
  genericTemplateV2Capability?: boolean;
  communityTemplateCapability?: boolean;
  inputAtProvided?: boolean;
  /** Set only after validating a server-side duplicate confirmation. */
  clarificationRounds?: 1;
}

export interface LedgerBrief {
  planId: string;
  month: string;
  spendCents: number;
  refundCents: number;
  netCents: number;
  budgetCents: number | null;
  remainingCents: number | null;
  usagePct: number | null;
  overCents: number | null;
}

export interface StudyBrief {
  planId: string;
  planName: string;
  date: BizDate;
  dayMinutes: number;
  dayStatus: string;
  week: string;
  goalComplete: boolean;
  daysPerWeek: number | null;
  minMinutes: number | null;
  metDays: number | null;
  targetDays: number | null;
  recordDays: number;
  totalMinutes: number;
}

export type ItemResult =
  | { type: 'generic_added'; record: RecordView; generic?: GenericSummary }
  | { type: 'plan_created'; plan: PlanView; budgetCents: number | null; daysPerWeek: number | null; minMinutes: number | null; firstWeekTarget: number | null; goalPending: boolean; goalStartsOn?: string }
  | { type: 'expense_added'; record: RecordView; ledger?: LedgerBrief }
  | { type: 'refund_added'; record: RecordView; expense: RecordView; ledger?: LedgerBrief }
  | { type: 'study_added'; record: RecordView; study?: StudyBrief }
  | { type: 'record_edited'; before: RecordView; record: RecordView; ledger?: LedgerBrief; study?: StudyBrief; generic?:GenericSummary }
  | { type: 'record_deleted'; records: RecordView[]; ledger?: LedgerBrief; study?: StudyBrief; generic?:GenericSummary }
  | { type: 'goal_set'; plan: PlanView; param: GoalParam; value: number; scope: ChangeScope; effectiveFrom: string; previous: number | null; replacedFuture: { fromPeriod: string; value: number }[]; study?: StudyBrief; ledger?: LedgerBrief }
  | { type: 'plan_updated'; plan: PlanView; change: 'renamed' | 'archived' | 'restored' | 'view' }
  | { type: 'undone'; of: string; records: RecordView[]; ledger?: LedgerBrief; study?: StudyBrief; generic?:GenericSummary; plans: PlanView[] };

export interface OperationResult {
  operationId: string;
  clientOpId: string;
  kind: 'batch' | 'undo';
  items: ItemResult[];
  dataVersion: number;
  createdAt: string;
  undoable: boolean;
  replayed?: boolean;
  growth?: GrowthDelta;
  clarificationRounds?: 1;
  templatePlan?: TemplatePlanState;
}

type UndoStep =
  | { t: 'record_created'; id: string; version: number }
  | { t: 'record_updated'; id: string; before: Pick<RecordRow, 'amount_cents' | 'minutes' | 'category' | 'occurred_on' | 'note'> & {fields?:GenericValues|null;template_id?:string|null;definition_version?:number|null;defaulted_fields?:string[]}; version: number }
  | { t: 'record_deleted'; id: string; version: number }
  | { t: 'plan_created'; id: string }
  | { t: 'segment_created'; seq: number }
  | { t: 'plan_updated'; id: string; field: 'name' | 'status' | 'view_config'; before: unknown; after: unknown; lifecycleSeq?: number };

// ───────────────────────── 公共入口 ─────────────────────────

export async function findOperation(db: Queryable, userId: string, clientOpId: string): Promise<OperationResult | null> {
  const [row] = await db.query<{ result: OperationResult; undone: boolean }>(`SELECT result, undone FROM operations WHERE user_id = $1 AND client_op_id = $2`, [userId, clientOpId]);
  if (!row) return null;
  return { ...row.result, undoable: row.result.undoable && !row.undone, replayed: true };
}

/** Replays authorize the saved result, independent of a listing's later visibility/version. */
export async function validateReplayCapabilities(q: Queryable, ctx: ExecContext, result: OperationResult) {
  const hidden=await unsupportedTemplatePlans(q,ctx.userId,ctx);
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    const object=value as Record<string,unknown>;
    const unsupported=(object.kind==='generic'&&!ctx.genericCapability)
      || ['planId','id','scopePlanId'].some(key=>typeof object[key]==='string'&&hidden.has(object[key] as string))
      || (!ctx.privateTemplateCapability&&['templateId','definitionTemplateId'].some(key=>typeof object[key]==='string'&&(object[key] as string).startsWith('private.')))
      || (!ctx.communityTemplateCapability&&['templateId','definitionTemplateId'].some(key=>typeof object[key]==='string'&&(object[key] as string).startsWith('community.')))
      || (!ctx.genericTemplateV2Capability&&Array.isArray(object.defaultedFields)&&object.defaultedFields.length>0);
    if(unsupported)fail('invalid_input','请在支持这个模板的新版网页核对已保存结果，无需重复提交。');
    Object.values(object).forEach(visit);
  };
  if(result.templatePlan)requireTemplateCapabilities(result.templatePlan.definition,ctx,result.templatePlan.config.recordDefaults);
  visit(result);
}

function validateBatch(clientOpId: string, actions: Action[]) {
  if (!clientOpId || clientOpId.length > 120) fail('invalid_input', '缺少请求标识。');
  if (actions.length === 0) fail('invalid_input', '没有可执行的操作。');
  if (actions.length > 10) fail('invalid_input', '一次最多保存 10 条，请分批发送。');
}

function validateChatDeletes(ctx: ExecContext, actions: Action[]) {
  // Count parent actions, not cascade members: one expense's explicitly
  // confirmed refund snapshot remains one deletion. Form behavior is unchanged.
  if (ctx.source === 'chat' && actions.filter(action => action.type === 'delete_record').length > 1)
    fail('invalid_input', '删除需要逐条核对。这次没有删除或保存任何内容，请一次处理一条明确记录。');
}
export async function validateActionCapabilities(q:Queryable,ctx:ExecContext,actions:Action[]) {
  const require=(allowed:boolean|undefined)=>{if(allowed!==true)fail('invalid_input','请使用支持这个模板的新版网页操作，本次没有保存。');};
  const hidden = await unsupportedTemplatePlans(q, ctx.userId, ctx);
  for (const a of actions) {
    if ('planId' in a && hidden.has(a.planId)) require(false);
    if (a.type === 'configure_generic_plan' && (a.recordDefaults !== undefined || a.applyTemplateDefaults !== undefined)) require(ctx.genericTemplateV2Capability);
    if (a.type === 'upgrade_community_template') { require(ctx.communityTemplateCapability); require(ctx.genericCapability); const next = await getCommunityUpgrade(q,ctx.userId,a.planId,a.targetVersion); requireTemplateCapabilities(next.next,ctx); }
    if(a.type==='adopt_template'){const d=await getAdoptableTemplate(q,ctx.userId,a.templateId);require(d.engine==='study'?ctx.templateCapability:d.engine==='ledger'?ctx.ledgerTemplateCapability:ctx.genericCapability);requireTemplateCapabilities(d,ctx);}
    if(a.type==='apply_private_template'){require(ctx.privateTemplateCapability);require(ctx.genericCapability);requireTemplateCapabilities(await getPrivateTemplate(q,ctx.userId,a.templateId,a.templateVersion),ctx);}
    if(a.type==='configure_reading_plan')require(ctx.templateCapability);
    if(a.type==='configure_ledger_plan')require(ctx.ledgerTemplateCapability);
    if(['configure_generic_plan','add_generic_record','edit_generic_record'].includes(a.type))require(ctx.genericCapability);
    if('planId' in a&&a.planId!==NEW_STUDY_PLAN){const [p]=await q.query<{kind:string;source:string}>('SELECT p.kind,b.source FROM plans p LEFT JOIN plan_template_bindings b ON b.plan_id=p.id WHERE p.id=$1 AND p.user_id=$2',[a.planId,ctx.userId]);if(p?.kind==='generic')require(ctx.genericCapability);if(p?.source==='private')require(ctx.privateTemplateCapability);}
    if('recordId' in a){const [r]=await q.query<{kind:string;source:string;plan_id:string}>('SELECT r.kind,b.source,r.plan_id FROM records r LEFT JOIN plan_template_bindings b ON b.plan_id=r.plan_id WHERE r.id=$1 AND r.user_id=$2',[a.recordId,ctx.userId]);if(r&&hidden.has(r.plan_id))require(false);if(r?.kind==='generic'){require(ctx.genericCapability);if(r.source==='private')require(ctx.privateTemplateCapability);if(a.type==='delete_record'&&a.expectedVersion===undefined)fail('invalid_input','删除通用记录需要核对当前版本。');}}
  }
}

/** Caller must hold the user's account lock for this entire transaction, including any preflight. */
export async function executeInTransaction(q: Transaction, ctx: ExecContext, clientOpId: string, actions: Action[]): Promise<OperationResult> {
  validateBatch(clientOpId, actions);
  await requireActiveUser(q, ctx.userId);
  await verifyTemplateRequest(q, ctx, clientOpId, actions);
  const existing = await findOperation(q, ctx.userId, clientOpId);
  if (existing) { await validateReplayCapabilities(q,ctx,existing); return existing; }
  validateChatDeletes(ctx, actions);
  await validateActionCapabilities(q,ctx,actions);
  await verifyTemplateRequest(q, ctx, clientOpId, actions, true);
  const state = new Exec(q, ctx);
  for (const action of actions) await state.apply(action);
  const items = await state.finish();
  const growth = state.awarded ? await deltaOf(q, ctx.userId, state.earned, state.unlocked) : undefined;
  return persist(q, ctx.userId, clientOpId, 'batch', items, state.undo, state.undoable, ctx.clarificationRounds, growth, state.templatePlan);
}

export async function execute(db: Db, ctx: ExecContext, clientOpId: string, actions: Action[]): Promise<OperationResult> {
  validateBatch(clientOpId, actions);
  await verifyTemplateRequest(db, ctx, clientOpId, actions);
  const existing = await findOperation(db, ctx.userId, clientOpId);
  if (existing) { await validateReplayCapabilities(db,ctx,existing); return existing; }
  validateChatDeletes(ctx, actions);
  await validateActionCapabilities(db,ctx,actions);
  const started = Date.now();
  try {
    const result = await db.tx(q => executeInTransaction(q, ctx, clientOpId, actions), ctx.userId);
    await usageOperation(db, ctx, result, actions, Date.now() - started).catch(() => {});
    return result;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const stored = await findOperation(db, ctx.userId, clientOpId);
      if (stored) return stored;
    }
    throw e;
  }
}

const RECORD_STEPS = new Set(['record_created', 'record_updated', 'record_deleted']);
const stepRecordId = (s: UndoStep): string | null => (s.t === 'record_created' || s.t === 'record_updated' || s.t === 'record_deleted' ? s.id : null);

/**
 * 撤销一次操作。给出 recordId 时只撤销这次操作里与该记录有关的步骤（回执里的逐条撤销）；
 * 之后再整次撤销会跳过已经逐条撤销过的记录。
 */
export async function undo(db: Db, ctx: ExecContext, operationId: string, clientOpId: string, recordId?: string): Promise<OperationResult> {
  const [target]=await db.query<{result:OperationResult}>('SELECT result FROM operations WHERE id=$1 AND user_id=$2',[operationId,ctx.userId]);
  const containsGeneric=(v:unknown):boolean=>!!v&&typeof v==='object'&&(Array.isArray(v)?v.some(containsGeneric):Object.entries(v).some(([k,x])=>k==='kind'&&x==='generic'||k==='type'&&x==='generic_added'||containsGeneric(x)));
  if(containsGeneric(target?.result)&&ctx.genericCapability!==true)fail('invalid_input','请使用支持通用记录的网页撤销，本次没有更改。');
  const checkPrivateCapability=async(q:Queryable)=>{
    if(!target)return;
    const ids=new Set<string>();
    for(const item of target.result.items){if('plan'in item)ids.add(item.plan.id);if('record'in item)ids.add(item.record.planId);if('records'in item)for(const record of item.records)ids.add(record.planId);if('plans'in item)for(const plan of item.plans)ids.add(plan.id);}
    if(target.result.templatePlan)ids.add(target.result.templatePlan.planId);
    const hidden = await unsupportedTemplatePlans(q,ctx.userId,ctx);
    if([...ids].some(id => hidden.has(id)))fail('invalid_input','请使用支持私人模板的网页撤销，本次没有更改。');
  };
  await checkPrivateCapability(db);
  const undoRequest=[{type:containsGeneric(target?.result)?'undo_generic':'undo',operationId,recordId}];
  const recoveryContext={...ctx,inputAtProvided:false};
  await verifyTemplateRequest(db,recoveryContext,clientOpId,undoRequest);
  const existing = await findOperation(db, ctx.userId, clientOpId);
  if (existing) return existing;
  return db.tx(async (q) => {
    await requireActiveUser(q, ctx.userId);
    await checkPrivateCapability(q);
    await verifyTemplateRequest(q,recoveryContext,clientOpId,undoRequest);
    const replay=await findOperation(q,ctx.userId,clientOpId);
    if(replay)return replay;
    await verifyTemplateRequest(q,recoveryContext,clientOpId,undoRequest,true);
    const [op] = await q.query<{ id: string; undo: UndoStep[] | null; undone: boolean; kind: string; undone_records: string[] }>(
      `SELECT id, undo, undone, kind, undone_records FROM operations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [operationId, ctx.userId],
    );
    if (!op) fail('not_found', '没有找到要撤销的操作。');
    if (op!.undone) fail('already_undone', '这次操作已经撤销过了。');
    if (!op!.undo || op!.kind !== 'batch') fail('undo_conflict', '这次操作不能撤销。');
    const done = new Set(op!.undone_records ?? []);
    let steps = op!.undo!.filter((s) => {
      const id = stepRecordId(s);
      return id === null || !done.has(id);
    });
    if (recordId) {
      if (done.has(recordId)) fail('already_undone', '这条记录已经撤销过了。');
      steps = steps.filter((s) => stepRecordId(s) === recordId);
      if (!steps.length) fail('not_found', '这条记录不属于这次操作。');
    }
    const state = new Exec(q, ctx);
    const touched: RecordRow[] = [];
    const plans: PlanView[] = [];
    // 本次操作自己创建的记录：撤销建计划时不算作“后来的依赖”。
    // 归属集合取自原始的全部步骤：逐条撤销过的记录仍然属于本次操作，不能被当成后来的依赖。
    const ownRecords = new Set(op!.undo!.filter((s): s is Extract<UndoStep, { t: 'record_created' }> => s.t === 'record_created').map((s) => s.id));
    for (const step of [...steps].reverse()) await state.revert(step, touched, plans, ownRecords);
    await state.validateAfterUndo(touched);
    if (recordId) {
      done.add(recordId);
      // 这次操作只剩已撤销的记录、没有其他步骤时，视为整次已撤销。
      const remaining = op!.undo!.filter((s) => { const id = stepRecordId(s); return id === null ? !RECORD_STEPS.has(s.t) : !done.has(id); });
      await q.query(`UPDATE operations SET undone_records = $2, undone = $3 WHERE id = $1`, [operationId, JSON.stringify([...done]), remaining.length === 0]);
    } else {
      await q.query(`UPDATE operations SET undone = true WHERE id = $1`, [operationId]);
    }
    const records = touched.map((r) => recordView(r));
    const item: ItemResult = { type: 'undone', of: operationId, records, plans };
    // 计划本身被撤销删除时，不再为它计算统计。
    const last = [...touched].reverse().find((r) => !state.removedPlans.has(r.plan_id));
    if (last) Object.assign(item, await state.briefFor(last));
    return persist(q, ctx.userId, clientOpId, 'undo', [item], null, false);
  }, ctx.userId);
}

async function persist(q: Queryable, userId: string, clientOpId: string, kind: 'batch' | 'undo', items: ItemResult[], undoSteps: UndoStep[] | null, undoable: boolean, clarificationRounds?: 1, growth?: GrowthDelta, templatePlan?: TemplatePlanState): Promise<OperationResult> {
  const [u] = await q.query<{ data_version: number }>(`UPDATE users SET data_version = data_version + 1 WHERE id = $1 RETURNING data_version`, [userId]);
  const [op] = await q.query<{ id: string; created_at: Date }>(
    `INSERT INTO operations (user_id, client_op_id, kind, result, undo) VALUES ($1, $2, $3, '{}'::jsonb, $4) RETURNING id, created_at`,
    [userId, clientOpId, kind, undoable && undoSteps ? JSON.stringify(undoSteps) : null],
  );
  const result: OperationResult = {
    operationId: op!.id,
    clientOpId,
    kind,
    items,
    dataVersion: u!.data_version,
    createdAt: new Date(op!.created_at).toISOString(),
    undoable,
    ...(clarificationRounds ? { clarificationRounds } : {}),
    ...(growth ? { growth } : {}),
    ...(templatePlan ? { templatePlan } : {}),
  };
  await q.query(`UPDATE operations SET result = $2 WHERE id = $1`, [op!.id, JSON.stringify(result)]);
  return result;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === '23505';
}

// ───────────────────────── 执行器 ─────────────────────────

const DEFAULT_LEDGER_NAME = '日常记账';
export const NEW_STUDY_PLAN = '@new_study_plan';

class Exec {
  readonly undo: UndoStep[] = [];
  undoable = true;
  templatePlan?: TemplatePlanState;
  /** 本批新增记录发放的行动力 */
  awarded = false;
  earned = 0;
  unlocked: string[] = [];
  private results: { item: ItemResult; recordId?: string; planId?: string }[] = [];
  private readonly today: BizDate;

  constructor(
    private readonly q: Queryable,
    private readonly ctx: ExecContext,
  ) {
    this.today = shanghaiDate(ctx.inputAt);
  }

  private checkDate(date: BizDate, what = '发生日期') {
    if (!isBizDate(date)) fail('invalid_input', `${what}不正确。`);
    if (date > this.today) fail('future_date', `${formatMonthDay(date)}还没到，已发生的记录不能填未来日期。`, { date });
  }

  /** 同一批里先建计划再记录时，用 NEW_STUDY_PLAN 指代刚建的学习计划。 */
  private createdStudyPlans: string[] = [];
  private ref(planId: string): string {
    if (planId === NEW_STUDY_PLAN) {
      const id = this.createdStudyPlans[this.createdStudyPlans.length - 1];
      return id ?? fail('not_found', '没有找到要记录的学习计划。');
    }
    return planId;
  }

  private async activePlan(planId: string, kind: 'ledger' | 'study' | 'generic', allowArchived = false): Promise<PlanRow> {
    const p = await getPlan(this.q, this.ctx.userId, this.ref(planId));
    if (p.kind !== kind) fail('kind_mismatch', kind === 'ledger' ? '这个计划不支持记账。' : '这个计划不支持记录学习时长。');
    if (!allowArchived && p.status === 'archived') fail('plan_archived', `「${p.name}」已归档，恢复后才能记录。`, { planId: p.id, planName: p.name });
    return p;
  }

  private async touchPlan(planId: string) {
    await this.q.query(`UPDATE plans SET last_activity_at = now() WHERE id = $1`, [planId]);
  }

  private async insertRecord(fields: { plan_id: string; kind: RecordRow['kind']; amount_cents?: number | null; minutes?: number | null; category?: string | null; occurred_on: string; note?: string; refund_of?: string | null; fields?:GenericValues;definition_version?:number;template_id?:string;defaulted_fields?:string[] }): Promise<RecordRow> {
    const [r] = await this.q.query<RecordRow>(
      `INSERT INTO records (user_id, plan_id, kind, amount_cents, minutes, category, occurred_on, note, refund_of, source, source_message_id, input_at,fields,definition_version,template_id,defaulted_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [this.ctx.userId, fields.plan_id, fields.kind, fields.amount_cents ?? null, fields.minutes ?? null, fields.category ?? null, fields.occurred_on, (fields.note ?? '').slice(0, 200), fields.refund_of ?? null, this.ctx.source, this.ctx.messageId ?? null, this.ctx.inputAt,fields.fields?JSON.stringify(fields.fields):null,fields.definition_version??null,fields.template_id??null,JSON.stringify(fields.defaulted_fields??[])],
    );
    this.undo.push({ t: 'record_created', id: r!.id, version: r!.version });
    await this.touchPlan(fields.plan_id);
    if (r!.kind !== 'refund'&&r!.kind!=='generic') {
      const plan = await getPlan(this.q, this.ctx.userId, fields.plan_id);
      const g = await awardForRecord(this.q, r!, plan.name, this.today);
      this.awarded = true;
      this.earned += g.earned;
      this.unlocked.push(...g.unlocked);
    }
    return r!;
  }

  private async dayMinutes(planId: string, date: BizDate, excludeId?: string): Promise<number> {
    const [r] = await this.q.query<{ total: number | null }>(
      `SELECT COALESCE(SUM(minutes), 0)::int AS total FROM records WHERE plan_id = $1 AND occurred_on = $2 AND NOT deleted AND kind = 'study' AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [planId, date, excludeId ?? null],
    );
    return Number(r?.total ?? 0);
  }

  async apply(a: Action): Promise<void> {
    switch (a.type) {
      case 'adopt_template': {
        const { definition, name } = await prepareTemplateAdoption(this.q, this.ctx.userId, a);
        let planId:string;
        if(definition.engine==='ledger'){
          const existing=await getLedger(this.q,this.ctx.userId);
          if(existing){
            if(a.existingPlanId!==existing.id||!a.existingLedgerAction||(existing.status==='archived'&&a.existingLedgerAction!=='restore'))fail('ledger_exists','计划已存在，请明确进入或恢复原计划。',{planId:existing.id,archived:existing.status==='archived'});
            if(a.existingLedgerAction==='restore'&&existing.status==='archived')await this.updatePlan({type:'restore_plan',planId:existing.id});
            planId=existing.id;
            const [binding]=await this.q.query('SELECT plan_id FROM plan_template_bindings WHERE plan_id=$1',[planId]);
            if(!binding)await bindAdoptedPlan(this.q,this.ctx.userId,planId,definition);
            if(!this.results.length)this.results.push({item:{type:'plan_updated',plan:planView(existing),change:'view'},planId});
          }else{if(a.existingPlanId||a.existingLedgerAction)fail('not_found','原计划不存在，请重新读取。');await this.createLedger(null);planId=this.results.at(-1)!.planId!;await bindAdoptedPlan(this.q,this.ctx.userId,planId,definition);}
        }else if(definition.engine==='study'){
          await this.createStudy({ type: 'create_study', name, activity: '阅读' });planId=this.createdStudyPlans.at(-1)!;await bindAdoptedPlan(this.q,this.ctx.userId,planId,definition);
        }else{
          const [p]=await this.q.query<PlanRow>(`INSERT INTO plans(user_id,kind,name,start_date) VALUES($1,'generic',$2,$3) RETURNING *`,[this.ctx.userId,name,this.today]);planId=p!.id;
          await bindAdoptedPlan(this.q,this.ctx.userId,planId,definition);
          this.results.push({item:{type:'plan_created',plan:planView(p!),budgetCents:null,daysPerWeek:null,minMinutes:null,firstWeekTarget:null,goalPending:false},planId});
        }
        await registerCommunityAdoption(this.q, this.ctx.userId, planId, definition);
        this.templatePlan = await getPlanTemplate(this.q, this.ctx.userId, planId, this.today);
        // Template removal is archive/restore, not undoing adoption into hard deletion.
        this.undoable = false;
        return;
      }
      case 'upgrade_community_template': {
        const upgrade = await getCommunityUpgrade(this.q,this.ctx.userId,a.planId,a.targetVersion);
        if (upgrade.expectedVersion !== a.expectedVersion) fail('version_conflict','计划设置已经更新，请核对最新内容后再升级。');
        requireTemplateCapabilities(upgrade.next,this.ctx);
        const rows = await this.q.query('UPDATE plan_template_bindings SET definition_snapshot=$3,template_version=$4,config_version=config_version+1 WHERE plan_id=$1 AND user_id=$2 AND config_version=$5 RETURNING plan_id',[a.planId,this.ctx.userId,JSON.stringify(upgrade.next),a.targetVersion,a.expectedVersion]);
        if (!rows.length) fail('version_conflict','计划设置已经更新，请核对最新内容后再升级。');
        this.templatePlan = await getPlanTemplate(this.q,this.ctx.userId,a.planId,this.today);
        const plan = await getPlan(this.q,this.ctx.userId,a.planId);
        this.results.push({item:{type:'plan_updated',plan:planView(plan),change:'view'},planId:plan.id});
        this.undoable=false; return;
      }
      case 'configure_reading_plan': {
        this.templatePlan = await configureReadingPlanInTransaction(this.q, this.ctx.userId, this.today, a);
        const p = await getPlan(this.q, this.ctx.userId, a.planId);
        this.results.push({ item: { type: 'plan_updated', plan: planView(p), change: 'renamed' }, planId: p.id });
        this.undoable = false;
        return;
      }
      case 'apply_private_template': {
        this.templatePlan=await applyPrivateTemplateInTransaction(this.q,this.ctx.userId,this.today,a);
        const plan=await getPlan(this.q,this.ctx.userId,a.planId);
        this.results.push({item:{type:'plan_updated',plan:planView(plan),change:'view'},planId:plan.id});this.undoable=false;return;
      }
      case 'configure_ledger_plan':
      case 'configure_generic_plan':{
        this.templatePlan=await configureOtherTemplateInTransaction(this.q,this.ctx.userId,this.today,a);
        const p=await getPlan(this.q,this.ctx.userId,a.planId);this.results.push({item:{type:'plan_updated',plan:planView(p),change:'renamed'},planId:p.id});this.undoable=false;return;
      }
      case 'add_generic_record':return this.addGeneric(a);
      case 'edit_generic_record':return this.editGeneric(a);
      case 'create_ledger':
        return this.createLedger(a.budgetCents ?? null);
      case 'create_study':
        return this.createStudy(a);
      case 'add_expense':
        return this.addExpense(a);
      case 'add_refund':
        return this.addRefund(a);
      case 'add_study':
        return this.addStudy(a);
      case 'edit_record':
        return this.editRecord(a);
      case 'delete_record':
        return this.deleteRecord(a);
      case 'set_goal':
        return this.setGoal(a);
      case 'rename_plan':
      case 'archive_plan':
      case 'restore_plan':
      case 'set_view':
        return this.updatePlan(a);
    }
  }

  private async createLedger(budgetCents: number | null) {
    const existing = await getLedger(this.q, this.ctx.userId);
    if (existing) fail('ledger_exists', existing.status === 'archived' ? '你已经有一个归档的「日常记账」，可以恢复后继续使用。' : '你已经有「日常记账」了，不会再建第二个。', { planId: existing.id, archived: existing.status === 'archived' });
    if (budgetCents !== null && !isValidCents(budgetCents)) fail('invalid_input', '预算需要大于 0。');
    const [p] = await this.q.query<PlanRow>(`INSERT INTO plans (user_id, kind, name, start_date) VALUES ($1, 'ledger', $2, $3) RETURNING *`, [this.ctx.userId, DEFAULT_LEDGER_NAME, this.today]);
    this.undo.push({ t: 'plan_created', id: p!.id });
    if (budgetCents !== null) await this.insertSegment(p!.id, 'budget_cents', budgetCents, monthOf(this.today), null);
    this.results.push({ item: { type: 'plan_created', plan: planView(p!), budgetCents, daysPerWeek: null, minMinutes: null, firstWeekTarget: null, goalPending: false }, planId: p!.id });
  }

  private async createStudy(a: Extract<Action, { type: 'create_study' }>) {
    const activity = (a.activity ?? '').trim() || '阅读';
    const name = ((a.name ?? '').trim() || activity).slice(0, 20);
    const plans = await listPlans(this.q, this.ctx.userId);
    const dup = plans.find((p) => p.kind === 'study' && p.status === 'active' && p.name === name);
    if (dup) fail('duplicate_name', `已经有一个进行中的「${name}」。要另建的话，请换个名字。`, { planId: dup.id });
    const n = a.daysPerWeek ?? null;
    const m = a.minMinutes ?? null;
    if (n !== null && !isValidDaysPerWeek(n)) fail('invalid_input', '每周天数需要是 1 到 7 的整数。');
    if (m !== null && !isValidMinutes(m)) fail('invalid_input', '每天分钟数需要是 1 到 1440 的整数。');
    const startDate = a.startNextWeek ? nextWeek(weekOf(this.today)) : this.today;
    const [p] = await this.q.query<PlanRow>(`INSERT INTO plans (user_id, kind, name, activity, start_date) VALUES ($1, 'study', $2, $3, $4) RETURNING *`, [this.ctx.userId, name, activity, startDate]);
    this.undo.push({ t: 'plan_created', id: p!.id });
    this.createdStudyPlans.push(p!.id);
    const week = weekOf(startDate);
    if (n !== null) await this.insertSegment(p!.id, 'days_per_week', n, week, null);
    if (m !== null) await this.insertSegment(p!.id, 'min_minutes', m, week, null);
    const first = n === null ? null : Math.min(n, 8 - isoDay(startDate));
    this.results.push({ item: { type: 'plan_created', plan: planView(p!), budgetCents: null, daysPerWeek: n, minMinutes: m, firstWeekTarget: first, goalPending: n === null || m === null, ...(a.startNextWeek ? { goalStartsOn: startDate } : {}) }, planId: p!.id });
  }

  private async insertSegment(planId: string, param: GoalParam, value: number, from: string, to: string | null) {
    const [s] = await this.q.query<{ seq: number }>(`INSERT INTO goal_segments (plan_id, param, value, from_period, to_period) VALUES ($1,$2,$3,$4,$5) RETURNING seq`, [planId, param, value, from, to]);
    this.undo.push({ t: 'segment_created', seq: Number(s!.seq) });
  }

  private async addGeneric(raw:AddGenericAction) {
    const a=addGenericActionSchema.parse(raw);
    const p=await this.activePlan(a.planId,'generic');
    const state=await getPlanTemplate(this.q,this.ctx.userId,p.id,this.today);
    const {values,defaultedFields}=prepareGenericRecordValues(state.definition,a.values,a.units,this.today,await getGenericRecordDefaults(this.q,p.id));
    const r=await this.insertRecord({plan_id:p.id,kind:'generic',occurred_on:values.date as string,note:typeof values.note==='string'?values.note:'',fields:values,definition_version:state.templateVersion,template_id:state.templateId,defaulted_fields:defaultedFields});
    this.results.push({item:{type:'generic_added',record:recordView(r)},recordId:r.id});
  }

  private async editGeneric(raw:EditGenericAction) {
    const a=editGenericActionSchema.parse(raw);
    const r=await getRecord(this.q,this.ctx.userId,a.recordId);
    if(r.kind!=='generic'||r.deleted)fail('not_found','没有找到这条通用记录。');
    if(r.version!==a.expectedVersion)fail('version_conflict','记录已经更新，请查看最新内容后再修改。',{record:recordView(r)});
    await this.activePlan(r.plan_id,'generic',true);
    const state=await getPlanTemplate(this.q,this.ctx.userId,r.plan_id,this.today);
    if(r.definition_version!==state.templateVersion||r.template_id!==state.templateId){
      const [old]=await this.q.query<{definition:TemplateDefinition}>('SELECT definition FROM template_versions WHERE template_id=$1 AND version=$2 AND (owner_user_id IS NULL OR owner_user_id=$3)',[r.template_id,r.definition_version,this.ctx.userId]);
      if(!old)fail('version_conflict','原记录的模板定义暂时无法读取，本次没有修改。');
      assertCompatibleTemplate(old!.definition,state.definition);
    }
    const values=validateGenericRecordValues(state.definition,a.values,a.units,this.today);
    const [updated]=await this.q.query<RecordRow>(`UPDATE records SET fields=$2,occurred_on=$3,note=$4,template_id=$5,definition_version=$6,defaulted_fields=$7,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[r.id,JSON.stringify(values),values.date,typeof values.note==='string'?values.note:'',state.templateId,state.templateVersion,JSON.stringify((r.defaulted_fields??[]).filter(key=>JSON.stringify(r.fields?.[key])===JSON.stringify(values[key])))]);
    this.undo.push({t:'record_updated',id:r.id,before:{amount_cents:r.amount_cents,minutes:r.minutes,category:r.category,occurred_on:r.occurred_on,note:r.note,fields:r.fields,template_id:r.template_id,definition_version:r.definition_version,defaulted_fields:r.defaulted_fields},version:updated!.version});
    await this.touchPlan(r.plan_id);
    this.results.push({item:{type:'record_edited',before:recordView(r),record:recordView(updated!)},recordId:r.id});
  }

  private async addExpense(a: Extract<Action, { type: 'add_expense' }>) {
    if (!isValidCents(a.amountCents)) fail('invalid_input', '金额需要大于 0，单笔不超过 ¥999,999.99。');
    if (!isCategory(a.category)) fail('invalid_input', '分类不正确。');
    this.checkDate(a.date);
    const ledger = await getLedger(this.q, this.ctx.userId);
    if (!ledger) fail('no_ledger', '还没有可用于记账的计划。');
    if (ledger!.status === 'archived') fail('plan_archived', '「日常记账」已归档，恢复后才能记录。', { planId: ledger!.id, planName: ledger!.name });
    const r = await this.insertRecord({ plan_id: ledger!.id, kind: 'expense', amount_cents: a.amountCents, category: a.category, occurred_on: a.date, note: a.note });
    this.results.push({ item: { type: 'expense_added', record: recordView(r, 0) }, recordId: r.id });
  }

  private async addRefund(a: Extract<Action, { type: 'add_refund' }>) {
    if (!isValidCents(a.amountCents)) fail('invalid_input', '退款金额需要大于 0。');
    this.checkDate(a.date, '退款日期');
    const exp = await getRecord(this.q, this.ctx.userId, a.expenseId);
    if (exp.kind !== 'expense' || exp.deleted) fail('not_found', '退款需要关联一笔还在的支出。');
    await this.activePlan(exp.plan_id, 'ledger');
    const refunds = await activeRefunds(this.q, exp.id);
    const problems = validateRefundGroup({ amountCents: exp.amount_cents!, date: exp.occurred_on }, [...refunds.map((r) => ({ amountCents: r.amount_cents!, date: r.occurred_on })), { amountCents: a.amountCents, date: a.date }]);
    this.raiseRefundProblems(problems, exp, refunds);
    const r = await this.insertRecord({ plan_id: exp.plan_id, kind: 'refund', amount_cents: a.amountCents, category: exp.category, occurred_on: a.date, note: a.note ?? exp.note, refund_of: exp.id });
    const refunded = refunds.reduce((s, x) => s + x.amount_cents!, 0) + a.amountCents;
    this.results.push({ item: { type: 'refund_added', record: recordView(r), expense: recordView(exp, refunded) }, recordId: r.id });
  }

  private raiseRefundProblems(problems: ReturnType<typeof validateRefundGroup>, exp: RecordRow, refunds: RecordRow[]) {
    for (const p of problems) {
      if (p.code === 'refund_exceeds_expense') {
        const done = refunds.reduce((s, r) => s + r.amount_cents!, 0);
        fail('refund_exceeds_expense', `累计退款不能超过原支出 ${formatYuan(exp.amount_cents!)}，已退 ${formatYuan(done)}，最多还能退 ${formatYuan(Math.max(0, exp.amount_cents! - done))}。`, { expenseId: exp.id });
      }
      fail('refund_before_expense', `退款日期不能早于原支出日期 ${formatMonthDay(exp.occurred_on)}。`, { expenseId: exp.id });
    }
  }

  private async addStudy(a: Extract<Action, { type: 'add_study' }>) {
    if (!isValidMinutes(a.minutes)) fail('invalid_input', '单次时长需要是 1 到 1440 分钟的整数。');
    this.checkDate(a.date);
    const plan = await this.activePlan(a.planId, 'study');
    const already = await this.dayMinutes(plan.id, a.date);
    if (already + a.minutes > MAX_MINUTES_PER_DAY) fail('day_minutes_exceeded', `「${plan.name}」${formatMonthDay(a.date)}已记录 ${already} 分钟，一天最多 1440 分钟。`);
    const r = await this.insertRecord({ plan_id: plan.id, kind: 'study', minutes: a.minutes, occurred_on: a.date, note: a.note });
    this.results.push({ item: { type: 'study_added', record: recordView(r) }, recordId: r.id });
  }

  private async editRecord(a: Extract<Action, { type: 'edit_record' }>) {
    const r = await getRecord(this.q, this.ctx.userId, a.recordId);
    if(r.kind==='generic')fail('kind_mismatch','请使用此模板的记录表单修改字段。');
    if (r.deleted) fail('not_found', '这条记录已经删除了。');
    if (a.expectedVersion !== undefined && a.expectedVersion !== r.version) fail('version_conflict', '这条记录刚刚在别处被修改过，请看一下最新内容再改。', { record: recordView(r) });
    const plan = await this.activePlan(r.plan_id, r.kind === 'study' ? 'study' : 'ledger', true);
    const p = a.patch;
    const next = { amount_cents: r.amount_cents, minutes: r.minutes, category: r.category, occurred_on: r.occurred_on, note: r.note };
    if (p.date !== undefined) {
      this.checkDate(p.date);
      next.occurred_on = p.date;
    }
    if (p.note !== undefined) next.note = p.note.slice(0, 200);
    if (r.kind === 'study') {
      if (p.amountCents !== undefined || p.category !== undefined) fail('invalid_input', '学习记录没有金额和分类。');
      if (p.minutes !== undefined) {
        if (!isValidMinutes(p.minutes)) fail('invalid_input', '单次时长需要是 1 到 1440 分钟的整数。');
        next.minutes = p.minutes;
      }
      const other = await this.dayMinutes(plan.id, next.occurred_on, r.id);
      if (other + next.minutes! > MAX_MINUTES_PER_DAY) fail('day_minutes_exceeded', `${formatMonthDay(next.occurred_on)}累计会超过 1440 分钟。`);
    } else {
      if (p.minutes !== undefined) fail('invalid_input', '支出没有时长。');
      if (p.amountCents !== undefined) {
        if (!isValidCents(p.amountCents)) fail('invalid_input', '金额需要大于 0，单笔不超过 ¥999,999.99。');
        next.amount_cents = p.amountCents;
      }
      if (p.category !== undefined) {
        if (r.kind === 'refund') fail('invalid_input', '退款的分类跟随原支出，请修改原支出的分类。');
        if (!isCategory(p.category)) fail('invalid_input', '分类不正确。');
        next.category = p.category;
      }
      if (r.kind === 'expense') {
        const refunds = await activeRefunds(this.q, r.id);
        if (refunds.length) {
          const total = refunds.reduce((s, x) => s + x.amount_cents!, 0);
          if (next.amount_cents! < total) fail('expense_below_refunds', `这笔支出已退款 ${formatYuan(total)}，金额不能改到低于它。`);
          this.raiseRefundProblems(validateRefundGroup({ amountCents: next.amount_cents!, date: next.occurred_on }, refunds.map((x) => ({ amountCents: x.amount_cents!, date: x.occurred_on }))), { ...r, amount_cents: next.amount_cents, occurred_on: next.occurred_on }, refunds);
          if (next.category !== r.category) await this.q.query(`UPDATE records SET category = $2, updated_at = now() WHERE refund_of = $1 AND NOT deleted`, [r.id, next.category]);
        }
      } else {
        const exp = await getRecord(this.q, this.ctx.userId, r.refund_of!);
        const siblings = (await activeRefunds(this.q, exp.id)).map((x) => (x.id === r.id ? { ...x, amount_cents: next.amount_cents, occurred_on: next.occurred_on } : x));
        this.raiseRefundProblems(validateRefundGroup({ amountCents: exp.amount_cents!, date: exp.occurred_on }, siblings.map((x) => ({ amountCents: x.amount_cents!, date: x.occurred_on }))), exp, siblings.filter((x) => x.id !== r.id));
      }
    }
    const [u] = await this.q.query<RecordRow>(
      `UPDATE records SET amount_cents = $2, minutes = $3, category = $4, occurred_on = $5, note = $6, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [r.id, next.amount_cents, next.minutes, next.category, next.occurred_on, next.note],
    );
    this.undo.push({ t: 'record_updated', id: r.id, before: { amount_cents: r.amount_cents, minutes: r.minutes, category: r.category, occurred_on: r.occurred_on, note: r.note }, version: u!.version });
    await this.touchPlan(r.plan_id);
    this.results.push({ item: { type: 'record_edited', before: recordView(r), record: recordView(u!) }, recordId: r.id });
  }

  private async deleteRecord(a: Extract<Action, { type: 'delete_record' }>) {
    const r = await getRecord(this.q, this.ctx.userId, a.recordId);
    if (r.deleted) fail('not_found', '这条记录已经删除了。');
    if (a.expectedVersion !== undefined && a.expectedVersion !== r.version) fail('version_conflict', '这条记录刚刚在别处被修改过，请看一下最新内容。', { record: recordView(r) });
    const group: RecordRow[] = [r];
    if (r.kind === 'expense') {
      const refunds = await activeRefunds(this.q, r.id);
      const snapshot = refundSnapshot(r, refunds);
      const details = { record: recordView(r, snapshot.totalCents), refundSnapshot: snapshot };
      // This runs after receipt lookup and inside the user's transaction lock.
      // A retry of an already successful old request must still recover its receipt.
      if (a.expectedRefundSnapshot !== undefined && !REFUND_SNAPSHOT_PATTERN.test(a.expectedRefundSnapshot)) fail('invalid_input', '退款确认信息无效，请重新读取这条支出。');
      if (a.expectedRefundSnapshot !== undefined && a.expectedRefundSnapshot !== snapshot.token) fail('version_conflict', '这条支出或关联退款已变化，请重新核对后再确认删除。', details);
      if (a.includeRefunds && a.expectedRefundSnapshot === undefined) fail('refund_confirmation_required', '删除关联退款前需要重新核对。请在新版网页刷新这条支出后确认当前退款；也可以先逐笔删除退款，再删除原支出。', details);
      if (refunds.length && !a.includeRefunds) {
        const total = refunds.reduce((s, x) => s + x.amount_cents!, 0);
        fail('has_refunds', `这笔支出有 ${refunds.length} 笔退款，共 ${formatYuan(total)}。删除会把它们一起移出统计。`, { refundCount: refunds.length, refundCents: total, expense: recordView(r, total) });
      }
      group.push(...refunds);
    } else if (a.expectedRefundSnapshot !== undefined) {
      fail('invalid_input', '只有原支出可以核对关联退款。');
    }
    const out: RecordRow[] = [];
    for (const g of group) {
      const [d] = await this.q.query<RecordRow>(`UPDATE records SET deleted = true, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [g.id]);
      this.undo.push({ t: 'record_deleted', id: g.id, version: d!.version });
      out.push(d!);
    }
    await this.touchPlan(r.plan_id);
    this.results.push({ item: { type: 'record_deleted', records: out.map((x) => recordView(x)) }, recordId: r.id });
  }

  private async setGoal(a: Extract<Action, { type: 'set_goal' }>) {
    const plan = await getPlan(this.q, this.ctx.userId, this.ref(a.planId));
    const isBudget = a.param === 'budget_cents';
    if (plan.kind==='generic'||isBudget !== (plan.kind === 'ledger')) fail('kind_mismatch', isBudget ? '这个计划不支持设置预算。' : '这个计划不支持设置每周天数和每日分钟数。');
    if (isBudget && !isValidCents(a.value)) fail('invalid_input', '预算需要大于 0。');
    if (a.param === 'days_per_week' && !isValidDaysPerWeek(a.value)) fail('invalid_input', '每周天数需要是 1 到 7 的整数。');
    if (a.param === 'min_minutes' && !isValidMinutes(a.value)) fail('invalid_input', '每天分钟数需要是 1 到 1440 的整数。');
    const current = isBudget ? monthOf(this.today) : weekOf(this.today);
    const next = isBudget ? nextMonth(current) : nextWeek(current);
    // 已明确选择下周开始的计划，开始前改常规参数仍从开始周生效。
    const notStarted = !isBudget && plan.start_date > this.today;
    if (notStarted && a.scope === 'current_only') fail('invalid_input', `计划从 ${plan.start_date} 开始，本周尚未执行目标。请选择从下周起调整。`);
    const scope = notStarted && a.scope === 'current_and_future' ? 'next_and_future' : a.scope;
    const ch = planRuleChange(await segments(this.q, plan.id), a.param, a.value, scope, current, next);
    await this.insertSegment(plan.id, a.param, a.value, ch.segment.fromPeriod, ch.segment.toPeriod);
    this.results.push({
      item: { type: 'goal_set', plan: planView(plan), param: a.param, value: a.value, scope, effectiveFrom: ch.segment.fromPeriod, previous: ch.previousCurrent, replacedFuture: ch.replacedFuture },
      planId: plan.id,
    });
  }

  private async updatePlan(a: Extract<Action, { type: 'rename_plan' | 'archive_plan' | 'restore_plan' | 'set_view' }>) {
    const plan = await getPlan(this.q, this.ctx.userId, this.ref(a.planId));
    let change: 'renamed' | 'archived' | 'restored' | 'view';
    if (a.type === 'rename_plan') {
      const name = a.name.trim().slice(0, 20);
      if (!name) fail('invalid_input', '名称不能为空。');
      await this.q.query(`UPDATE plans SET name = $2 WHERE id = $1`, [plan.id, name]);
      this.undo.push({ t: 'plan_updated', id: plan.id, field: 'name', before: plan.name, after: name });
      change = 'renamed';
    } else if (a.type === 'set_view') {
      const allowed: string[] = plan.kind === 'ledger' ? [...LEDGER_COMPONENTS] : plan.kind==='generic' ? (await getPlanTemplate(this.q,this.ctx.userId,plan.id,this.today)).definition.components : [...STUDY_COMPONENTS];
      const hidden = (a.hidden ?? plan.view_config.hidden ?? []).filter((h) => (HIDEABLE as readonly string[]).includes(h) && allowed.includes(h));
      const order = (a.order ?? plan.view_config.order ?? []).filter((c) => allowed.includes(c));
      const after = { hidden, order };
      await this.q.query(`UPDATE plans SET view_config = $2 WHERE id = $1`, [plan.id, JSON.stringify(after)]);
      this.undo.push({ t: 'plan_updated', id: plan.id, field: 'view_config', before: plan.view_config, after });
      change = 'view';
    } else {
      const target = a.type === 'archive_plan' ? 'archived' : 'active';
      if (plan.status === target) fail('invalid_input', target === 'archived' ? '这个计划已经归档了。' : '这个计划正在进行中。');
      await this.q.query(`UPDATE plans SET status = $2, last_activity_at = now() WHERE id = $1`, [plan.id, target]);
      const [l] = await this.q.query<{ seq: number }>(`INSERT INTO plan_lifecycle (plan_id, event, on_date) VALUES ($1, $2, $3) RETURNING seq`, [plan.id, target === 'archived' ? 'archived' : 'restored', this.today]);
      this.undo.push({ t: 'plan_updated', id: plan.id, field: 'status', before: plan.status, after: target, lifecycleSeq: Number(l!.seq) });
      change = target === 'archived' ? 'archived' : 'restored';
    }
    const updated = await getPlan(this.q, this.ctx.userId, plan.id);
    this.results.push({ item: { type: 'plan_updated', plan: planView(updated), change }, planId: plan.id });
  }

  /** 全部动作执行完后，基于最终状态计算回执里的统计。 */
  async finish(): Promise<ItemResult[]> {
    const out: ItemResult[] = [];
    for (const { item, recordId, planId } of this.results) {
      if (recordId && (item.type === 'generic_added' || item.type === 'expense_added' || item.type === 'refund_added' || item.type === 'study_added' || item.type === 'record_edited' || item.type === 'record_deleted')) {
        const r = await getRecord(this.q, this.ctx.userId, recordId);
        Object.assign(item, await this.briefFor(r));
      }
      if (planId && item.type === 'plan_created') {
        const plan = await getPlan(this.q, this.ctx.userId, planId);
        item.plan = planView(plan);
      }
      if (planId && item.type === 'goal_set') {
        const plan = await getPlan(this.q, this.ctx.userId, planId);
        if (plan.kind === 'ledger') item.ledger = await this.ledgerBrief(plan, monthOf(this.today));
        else item.study = await this.studyBrief(plan, this.today);
      }
      out.push(item);
    }
    return out;
  }

  async briefFor(r: RecordRow): Promise<{ ledger?: LedgerBrief; study?: StudyBrief; generic?:GenericSummary }> {
    const plan = await getPlan(this.q, this.ctx.userId, r.plan_id);
    if (plan.kind === 'ledger') return { ledger: await this.ledgerBrief(plan, monthOf(r.occurred_on)) };
    if(plan.kind==='generic')return {generic:await genericSummary(this.q,this.ctx.userId,plan.id,r.occurred_on,r.occurred_on)};
    return { study: await this.studyBrief(plan, r.occurred_on) };
  }

  private async ledgerBrief(plan: PlanRow, month: string): Promise<LedgerBrief> {
    const s = await ledgerStatsFor(this.q, plan, month);
    return { planId: plan.id, month, spendCents: s.spendCents, refundCents: s.refundCents, netCents: s.netCents, budgetCents: s.budgetCents, remainingCents: s.remainingCents, usagePct: s.usagePct, overCents: s.overCents };
  }

  private async studyBrief(plan: PlanRow, date: BizDate): Promise<StudyBrief> {
    const s = await studyStatsFor(this.q, plan, weekOf(date), this.today);
    const d = s.days.find((x) => x.date === date);
    return {
      planId: plan.id,
      planName: plan.name,
      date,
      dayMinutes: d?.minutes ?? 0,
      dayStatus: d?.status ?? 'none',
      week: s.week,
      goalComplete: s.goalComplete,
      daysPerWeek: s.daysPerWeek,
      minMinutes: s.minMinutes,
      metDays: s.metDays,
      targetDays: s.targetDays,
      recordDays: s.recordDays,
      totalMinutes: s.totalMinutes,
    };
  }

  // ─────────── 撤销 ───────────

  /** 被撤销删除的计划，回执不再为它计算统计。 */
  readonly removedPlans = new Set<string>();

  async revert(step: UndoStep, touched: RecordRow[], plans: PlanView[], ownRecords: Set<string>) {
    const q = this.q;
    const conflict = () => fail('undo_conflict', '这条记录后来又被修改过，不能直接撤销。请看最新内容后再决定怎么改。');
    switch (step.t) {
      case 'record_created': {
        const r = await getRecord(q, this.ctx.userId, step.id);
        if (r.deleted || r.version !== step.version) conflict();
        if (r.kind === 'expense' && (await activeRefunds(q, r.id)).length) fail('undo_conflict', '这笔支出后来有了退款，不能直接撤销。可以先删除退款。');
        const [d] = await q.query<RecordRow>(`UPDATE records SET deleted = true, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [r.id]);
        touched.push(d!);
        return;
      }
      case 'record_updated': {
        const r = await getRecord(q, this.ctx.userId, step.id);
        if (r.deleted || r.version !== step.version) conflict();
        const b = step.before;
        const [u] = await q.query<RecordRow>(
          `UPDATE records SET amount_cents = $2, minutes = $3, category = $4, occurred_on = $5, note = $6, fields=$7,template_id=$8,definition_version=$9,defaulted_fields=$10, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
          [r.id, b.amount_cents, b.minutes, b.category, b.occurred_on, b.note,r.kind==='generic'?JSON.stringify(b.fields??r.fields):null,b.template_id??r.template_id,b.definition_version??r.definition_version,JSON.stringify(b.defaulted_fields??r.defaulted_fields??[])],
        );
        if (u!.kind === 'expense') await q.query(`UPDATE records SET category = $2 WHERE refund_of = $1 AND NOT deleted`, [u!.id, u!.category]);
        touched.push(u!);
        return;
      }
      case 'record_deleted': {
        const r = await getRecord(q, this.ctx.userId, step.id);
        if (!r.deleted || r.version !== step.version) conflict();
        const [u] = await q.query<RecordRow>(`UPDATE records SET deleted = false, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [r.id]);
        touched.push(u!);
        return;
      }
      case 'plan_created': {
        // 只有本次操作之外的记录（含后来又删掉的）才算依赖；本次一起创建的记录随计划一起撤销。
        const others = await q.query<{ id: string }>(`SELECT id FROM records WHERE plan_id = $1`, [step.id]);
        if (others.some((r) => !ownRecords.has(r.id))) fail('undo_conflict', '这个计划后来又有了其他记录，不能撤销创建。可以改为归档。');
        const p = await getPlan(q, this.ctx.userId, step.id);
        plans.push(planView(p));
        await q.query(`DELETE FROM plans WHERE id = $1`, [step.id]);
        this.removedPlans.add(step.id);
        return;
      }
      case 'segment_created':
        await q.query(`UPDATE goal_segments SET revoked = true WHERE seq = $1`, [step.seq]);
        return;
      case 'plan_updated': {
        // 只恢复这次改动的那一个字段；如果它后来又被改过，拒绝覆盖。
        const p = await getPlan(q, this.ctx.userId, step.id);
        const current = step.field === 'name' ? p.name : step.field === 'status' ? p.status : p.view_config;
        if (JSON.stringify(current) !== JSON.stringify(step.after)) fail('undo_conflict', '这个计划后来又被调整过，不能直接撤销这次修改。');
        if (step.field === 'status') {
          const [later] = await q.query<{ seq: number }>(`SELECT seq FROM plan_lifecycle WHERE plan_id = $1 AND seq > $2 LIMIT 1`, [step.id, step.lifecycleSeq ?? 0]);
          if (later) fail('undo_conflict', '这个计划后来又归档或恢复过，不能直接撤销这次修改。');
          await q.query(`UPDATE plans SET status = $2 WHERE id = $1`, [step.id, step.before]);
          if (step.lifecycleSeq) await q.query(`DELETE FROM plan_lifecycle WHERE seq = $1`, [step.lifecycleSeq]);
        } else if (step.field === 'name') {
          await q.query(`UPDATE plans SET name = $2 WHERE id = $1`, [step.id, step.before]);
        } else {
          await q.query(`UPDATE plans SET view_config = $2 WHERE id = $1`, [step.id, JSON.stringify(step.before)]);
        }
        plans.push(planView(await getPlan(q, this.ctx.userId, step.id)));
        return;
      }
    }
  }

  /** 撤销后重新校验：退款关系整组成立，学习记录的单日累计不超过 1440 分钟。不合法则整次撤销失败。 */
  async validateAfterUndo(rows: RecordRow[]) {
    const expenseIds = new Set<string>();
    const studyDays = new Map<string, { planId: string; date: BizDate }>();
    for (const r of rows) {
      if (this.removedPlans.has(r.plan_id)) continue;
      if (r.kind === 'expense') expenseIds.add(r.id);
      if (r.kind === 'refund' && r.refund_of) expenseIds.add(r.refund_of);
      if (r.kind === 'study' && !r.deleted) studyDays.set(`${r.plan_id}|${r.occurred_on}`, { planId: r.plan_id, date: r.occurred_on });
    }
    for (const { planId, date } of studyDays.values()) {
      const total = await this.dayMinutes(planId, date);
      if (total > MAX_MINUTES_PER_DAY) fail('undo_conflict', `撤销后${formatMonthDay(date)}会累计 ${total} 分钟，超过一天 1440 分钟，已取消撤销。`);
    }
    for (const id of expenseIds) {
      const [exp] = await this.q.query<RecordRow>(`SELECT * FROM records WHERE id = $1 AND user_id = $2`, [id, this.ctx.userId]);
      if (!exp) continue;
      const refunds = await activeRefunds(this.q, id);
      if (exp.deleted) {
        if (refunds.length) fail('undo_conflict', '撤销后会留下没有原支出的退款，已取消撤销。');
        continue;
      }
      const problems = validateRefundGroup({ amountCents: exp.amount_cents!, date: exp.occurred_on }, refunds.map((x) => ({ amountCents: x.amount_cents!, date: x.occurred_on })));
      if (problems.length) fail('undo_conflict', '撤销后退款关系会不成立，已取消撤销。');
    }
  }
}

function isoDay(date: BizDate): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export { DomainError };
