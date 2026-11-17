import { createHash } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { covers, valueAt, type RuleSegment } from '../domain/rules.js';
import { addDays, isBizDate, monthOf, nextMonth, nextWeek, weekOf, type BizDate } from '../domain/time.js';
import { templateDefinitionSchema, adoptTemplateActionSchema, applyPrivateTemplateActionSchema, configureReadingActionSchema, configureLedgerActionSchema, configureGenericActionSchema, type AdoptTemplateAction, type ApplyPrivateTemplateAction, type ConfigureReadingAction, type ConfigureLedgerAction, type ConfigureGenericAction, type GenericValues, type TemplateDefinition, type TemplatePlanState } from '../templates/contracts.js';
import { getPlan, listPlans, segments } from './repo.js';
import { fail } from './errors.js';
import { supportsGenericRuntime, requireGenericDefinition, genericConfigurationValues, validateGenericConfigValues,validateGenericDefaults,genericPeriodBounds,genericGoalStates } from './generic.js';
import { assertCompatibleTemplate, getPrivateTemplate } from './creation-drafts.js';
import {getAdoptableCommunityTemplate} from './community.js';

type Binding = { plan_id: string; template_id: string; template_version: number; source: 'official' | 'legacy' | 'private'|'community'; definition_snapshot: TemplateDefinition; config_version: number; setup_status: 'pending' | 'ready'; current_book: string | null; config_values:GenericValues;record_defaults:GenericValues };

export async function listAvailableTemplates(q: Queryable): Promise<TemplateDefinition[]> {
  const rows = await q.query<{ definition: unknown }>(`SELECT DISTINCT ON (template_id) definition FROM template_versions WHERE template_id LIKE 'official.%' AND owner_user_id IS NULL ORDER BY template_id,version DESC`);
  return rows.map(r => templateDefinitionSchema.parse(r.definition)).filter(d => d.engine === 'study' ? d.requiredCapabilities.every(c => c === 'reading-template-v1') : d.engine === 'ledger' ? d.requiredCapabilities.every(c=>c==='ledger-template-v1') : supportsGenericRuntime(d));
}
export async function getAvailableTemplate(q: Queryable, id: string): Promise<TemplateDefinition> {
  const d = (await listAvailableTemplates(q)).find(t => t.id === id);
  return d ?? fail('not_found', '这个模板暂时无法使用。');
}
export async function getAdoptableTemplate(q:Queryable,userId:string,id:string,version?:number):Promise<TemplateDefinition> {
  if(id.startsWith('private.'))return getPrivateTemplate(q,userId,id,version);
  if(id.startsWith('community.'))return getAdoptableCommunityTemplate(q,id,version);
  const definition=await getAvailableTemplate(q,id);
  if(version!==undefined&&definition.version!==version)return fail('invalid_input','模板版本已变化，请重新打开模板后选用。');
  return definition;
}
export async function getPlanTemplate(q: Queryable, userId: string, planId: string, today: BizDate): Promise<TemplatePlanState> {
  const plan = await getPlan(q, userId, planId);
  let [b] = await q.query<Binding>('SELECT * FROM plan_template_bindings WHERE plan_id=$1 AND user_id=$2', [planId, userId]);
  if(!b&&plan.kind!=='generic') {
    // Legacy create_study/create_ledger remain valid after migration 11. Attach their
    // fixed adapter on first template access without touching facts or old goal rules.
    await q.query(`INSERT INTO plan_template_bindings(plan_id,user_id,template_id,template_version,source,definition_snapshot,setup_status)
      SELECT $1,$2,template_id,version,'legacy',definition,'ready' FROM template_versions WHERE template_id=$3 AND version=1 ON CONFLICT(plan_id) DO NOTHING`,[planId,userId,plan.kind==='study'?'legacy.study':'official.ledger']);
    [b]=await q.query<Binding>('SELECT * FROM plan_template_bindings WHERE plan_id=$1 AND user_id=$2',[planId,userId]);
  }
  if (!b) return fail('not_found', '这个计划没有模板设置。');
  const definition=templateDefinitionSchema.parse(b.definition_snapshot);
  const rules = await segments(q, planId);
  const current = plan.kind==='ledger'?monthOf(today):weekOf(today);
  const winning = (param: RuleSegment['param']) => rules.filter(s => s.param === param && covers(s, current)).at(-1);
  const [history]=await q.query<{used:boolean}>(`SELECT EXISTS(SELECT 1 FROM records WHERE plan_id=$1) OR EXISTS(SELECT 1 FROM goal_segments WHERE plan_id=$1) OR EXISTS(SELECT 1 FROM generic_goal_segments WHERE plan_id=$1) OR EXISTS(SELECT 1 FROM plan_lifecycle WHERE plan_id=$1) AS used`,[planId]);
  const values=plan.kind==='generic'?await genericConfigurationValues(q,planId,definition,b.config_values,today):undefined;
  const goals=plan.kind==='generic'?await genericGoalStates(q,planId,definition,b.config_values,today,plan.start_date):undefined;
  return { planId, templateId: b.template_id, templateVersion: b.template_version, source: b.source, engine: plan.kind, definition, config: {
    version: b.config_version, setupStatus: b.setup_status, name: plan.name, startDate: plan.start_date, currentBook: plan.kind==='study'?b.current_book:null,
    daysPerWeek: plan.kind==='study'?valueAt(rules, 'days_per_week', current):null, minMinutes: plan.kind==='study'?valueAt(rules, 'min_minutes', current):null,
    goalEffectiveFrom: { daysPerWeek: winning('days_per_week')?.fromPeriod ?? null, minMinutes: winning('min_minutes')?.fromPeriod ?? null },
    canChangeStartDate:plan.kind!=='ledger'&&b.setup_status==='pending'&&!history?.used,
    ...(plan.kind==='study'?{nextWeekGoals: { startsOn: nextWeek(current), daysPerWeek: valueAt(rules, 'days_per_week', nextWeek(current)), minMinutes: valueAt(rules, 'min_minutes', nextWeek(current)) }}:{}),
    ...(plan.kind==='ledger'?{budgetCents:valueAt(rules,'budget_cents',current),budgetEffectiveFrom:winning('budget_cents')?.fromPeriod??null,nextMonthBudget:{startsOn:nextMonth(current),value:valueAt(rules,'budget_cents',nextMonth(current))}}:{}),
    ...(values?{values,recordDefaults:b.record_defaults??{},...(definition.configurationDefaults?{proposedDefaults:definition.configurationDefaults}:{}),goals,nextPeriodValues:Object.fromEntries(goals!.map(goal=>[goal.fieldId,goal.next]))}:{}),
  } };
}

export async function prepareTemplateAdoption(q: Queryable, userId: string, raw: AdoptTemplateAction): Promise<{ definition: TemplateDefinition; name: string }> {
  const action = adoptTemplateActionSchema.parse(raw);
  const definition = await getAdoptableTemplate(q, userId, action.templateId, action.templateVersion);
  if (definition.version !== action.templateVersion) fail('invalid_input', '模板版本已变化，请重新打开模板后选用。');
  const names = new Set((await listPlans(q, userId)).filter(p => p.kind === definition.engine && p.status === 'active').map(p => p.name));
  let name = (definition.engine==='study'?'我的阅读':definition.name).slice(0,20);
  for (let n = 2; names.has(name); n++) {
    if (n > 1000) fail('invalid_input', '同名计划数量过多，请先整理现有计划。');
    const suffix=` ${n}`; name = `${(definition.engine==='study'?'我的阅读':definition.name).slice(0,20-suffix.length)}${suffix}`;
  }
  return { definition, name };
}

/** Bind goal scope to the period the user actually reviewed, while preserving original inputAt on recovery. */
export function verifyGoalPeriod(reviewedOn: string | undefined, today: BizDate, periods: ('day' | 'week' | 'month')[]) {
  if (reviewedOn === undefined) return; // Existing clients retain their original contract.
  if (!isBizDate(reviewedOn)) fail('invalid_input', '核对日期不正确。');
  if (periods.some(period => genericPeriodBounds(period, reviewedOn).from !== genericPeriodBounds(period, today).from))
    fail('version_conflict', '日期已进入新的周期，输入已保留。请核对新的目标生效范围后再保存。', { kind: 'goal_period_changed', today });
}

export async function configureOtherTemplateInTransaction(q:Queryable,userId:string,today:BizDate,raw:ConfigureLedgerAction|ConfigureGenericAction):Promise<TemplatePlanState> {
  const a=raw.type==='configure_ledger_plan'?configureLedgerActionSchema.parse(raw):configureGenericActionSchema.parse(raw);
  const state=await getPlanTemplate(q,userId,a.planId,today),plan=await getPlan(q,userId,a.planId);
  if ((a.type==='configure_ledger_plan'&&plan.kind!=='ledger')||(a.type==='configure_generic_plan'&&plan.kind!=='generic')) return fail('kind_mismatch','计划类型不匹配。');
  if (plan.status==='archived') return fail('plan_archived','请先恢复计划再修改设置。',{planId:plan.id});
  if (state.config.version!==a.expectedVersion) return fail('version_conflict','计划设置已变化，请重新核对。',{templatePlan:state});
  if (a.patch.name!==undefined) await q.query('UPDATE plans SET name=$2 WHERE id=$1',[plan.id,a.patch.name]);
  const scope=a.goalScope??'current_and_future';
  if (a.type==='configure_ledger_plan') {
    if (a.patch.budgetCents!==undefined) {
      verifyGoalPeriod(a.reviewedOn, today, ['month']);
      const month=monthOf(today),value=a.patch.budgetCents;
      await q.query('INSERT INTO goal_segments(plan_id,param,value,from_period,to_period,cleared) VALUES($1,\'budget_cents\',$2,$3,$4,$5)',[plan.id,value??1,scope==='next_and_future'?nextMonth(month):month,scope==='current_only'?month:null,value===null]);
    }
  } else {
    requireGenericDefinition(state.definition);
    if (a.patch.startDate!==undefined&&a.patch.startDate!==plan.start_date) {
      if (!state.config.canChangeStartDate||!isBizDate(a.patch.startDate)||a.patch.startDate>today) return fail('invalid_input','已有历史的计划不能更改开始日期，日期必须有效且不晚于今天。');
      await q.query('UPDATE plans SET start_date=$2 WHERE id=$1',[plan.id,a.patch.startDate]);
    }
    if(a.applyTemplateDefaults&&(state.config.setupStatus!=='pending'||!a.completeSetup))return fail('invalid_input','模板默认设置只可在确认首次设置时使用。');
    const supplied=validateGenericConfigValues(state.definition,a.patch.values??{},a.units);
    const initial=a.applyTemplateDefaults?validateGenericDefaults(state.definition,state.definition.configurationDefaults??{},'configuration'):{};
    // Defaults do not overwrite an earlier personal answer, including an explicitly cleared goal.
    const [prior]=await q.query<{config_values:GenericValues}>('SELECT config_values FROM plan_template_bindings WHERE plan_id=$1',[plan.id]);
    const answered=await q.query<{field_id:string}>('SELECT DISTINCT field_id FROM generic_goal_segments WHERE plan_id=$1',[plan.id]);
    for(const field of [...Object.keys(prior?.config_values??{}),...answered.map(r=>r.field_id)])delete initial[field];
    const changed={...initial,...supplied};
    verifyGoalPeriod(a.reviewedOn, today, state.definition.metrics.filter(m => m.goalFieldId && Object.hasOwn(changed, m.goalFieldId)).map(m => m.period));
    const [binding]=await q.query<{config_values:GenericValues}>('SELECT config_values FROM plan_template_bindings WHERE plan_id=$1',[plan.id]);
    const ordinary={...binding!.config_values};
    const goals=new Set(state.definition.metrics.map(m=>m.goalFieldId).filter(Boolean));
    for (const [field,value] of Object.entries(changed)) {
      if (goals.has(field)) {const period=state.definition.metrics.find(m=>m.goalFieldId===field)!.period,bounds=genericPeriodBounds(period,today);await q.query('INSERT INTO generic_goal_segments(plan_id,field_id,value,from_date,to_date,period) VALUES($1,$2,$3,$4,$5,$6)',[plan.id,field,JSON.stringify(value),scope==='next_and_future'?bounds.next:bounds.from,scope==='current_only'?bounds.to:null,period]);}
      else ordinary[field]=value;
    }
    if (a.completeSetup) for(const f of state.definition.configurationFields) if(f.required&&!['name','startDate'].includes(f.id)&&(changed[f.id]??ordinary[f.id]??state.config.values?.[f.id])==null) return fail('invalid_input',`请填写${f.label}。`);
    await q.query('UPDATE plan_template_bindings SET config_values=$2 WHERE plan_id=$1',[plan.id,JSON.stringify(ordinary)]);
    if(a.recordDefaults!==undefined)await q.query('UPDATE plan_template_bindings SET record_defaults=$2 WHERE plan_id=$1',[plan.id,JSON.stringify(validateGenericDefaults(state.definition,a.recordDefaults,'record'))]);
  }
  await q.query('UPDATE plan_template_bindings SET setup_status=$2,config_version=config_version+1 WHERE plan_id=$1',[plan.id,a.completeSetup?'ready':state.config.setupStatus]);
  return getPlanTemplate(q,userId,plan.id,today);
}
export async function bindAdoptedPlan(q: Queryable, userId: string, planId: string, definition: TemplateDefinition) {
  if(definition.engine==='generic')await q.query("UPDATE plans SET view_config=jsonb_set(view_config,'{order}',$2) WHERE id=$1",[planId,JSON.stringify(definition.components)]);
  await q.query(`INSERT INTO plan_template_bindings (plan_id,user_id,template_id,template_version,source,definition_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6)`, [planId, userId, definition.id, definition.version, definition.source, JSON.stringify(definition)]);
}

export async function applyPrivateTemplateInTransaction(q:Queryable,userId:string,today:BizDate,raw:ApplyPrivateTemplateAction):Promise<TemplatePlanState> {
  const action=applyPrivateTemplateActionSchema.parse(raw),state=await getPlanTemplate(q,userId,action.planId,today),plan=await getPlan(q,userId,action.planId);
  if(plan.kind!=='generic')return fail('kind_mismatch','这个计划目前只支持调整设置，不能更换记录结构。');
  if(plan.status==='archived')return fail('plan_archived','请先恢复计划再修改结构。');
  if(state.config.version!==action.expectedVersion)return fail('version_conflict','计划设置已变化，请重新核对结构修改。',{templatePlan:state});
  const next=await getPrivateTemplate(q,userId,action.templateId,action.templateVersion);
  const [draft]=await q.query<{source_plan_id:string|null;source_plan_version:number|null}>('SELECT source_plan_id,source_plan_version FROM creation_drafts WHERE template_id=$1 AND user_id=$2',[next.id,userId]);
  if(draft?.source_plan_id!==plan.id||draft.source_plan_version!==action.expectedVersion)return fail('version_conflict','请从这个计划的当前结构开始创作，再确认应用。');
  assertCompatibleTemplate(state.definition,next);
  await q.query(`UPDATE plan_template_bindings SET template_id=$2,template_version=$3,source='private',definition_snapshot=$4,config_version=config_version+1 WHERE plan_id=$1`,[plan.id,next.id,next.version,JSON.stringify(next)]);
  return getPlanTemplate(q,userId,plan.id,today);
}

/** Run inside the same account transaction as operation persistence. No standalone writes. */
export async function configureReadingPlanInTransaction(q: Queryable, userId: string, today: BizDate, raw: ConfigureReadingAction): Promise<TemplatePlanState> {
  const action = configureReadingActionSchema.parse(raw);
  const state = await getPlanTemplate(q, userId, action.planId, today);
  const plan = await getPlan(q, userId, action.planId);
  if (plan.kind !== 'study') fail('kind_mismatch', '这个计划不支持阅读或学习目标设置。');
  if(state.templateId!=='official.reading'&&action.patch.currentBook!==undefined)fail('invalid_input','这个学习计划没有当前在读设置。');
  if (plan.status === 'archived') fail('plan_archived', '请先恢复这个计划，再修改设置。');
  if (state.config.version !== action.expectedVersion) fail('version_conflict', '计划设置已经变化，请核对最新内容后再保存。', { templatePlan: state });
  const patch = action.patch;
  verifyGoalPeriod(action.reviewedOn, today, patch.daysPerWeek !== undefined || patch.minMinutes !== undefined ? ['week'] : []);
  if (patch.startDate !== undefined && patch.startDate !== plan.start_date) {
    if (!isBizDate(patch.startDate) || patch.startDate > today) fail('invalid_input', '开始日期需要是今天或之前的有效日期。');
    const [used] = await q.query<{ used: boolean }>(`SELECT EXISTS(SELECT 1 FROM records WHERE plan_id=$1)
      OR EXISTS(SELECT 1 FROM goal_segments WHERE plan_id=$1)
      OR EXISTS(SELECT 1 FROM plan_lifecycle WHERE plan_id=$1) AS used`, [plan.id]);
    if (state.config.setupStatus !== 'pending' || used?.used) fail('invalid_input', '已有目标、记录或历史的计划不能更改开始日期。');
  }
  if (patch.name !== undefined) {
    const [duplicate] = await q.query('SELECT id FROM plans WHERE user_id=$1 AND id<>$2 AND kind=\'study\' AND status=\'active\' AND name=$3', [userId, plan.id, patch.name]);
    if (duplicate) fail('duplicate_name', '已有同名的学习计划，请换一个名称。');
  }
  if (patch.name !== undefined || patch.startDate !== undefined) await q.query('UPDATE plans SET name=$2,start_date=$3 WHERE id=$1', [plan.id, patch.name ?? plan.name, patch.startDate ?? plan.start_date]);
  for (const [key, param] of [['daysPerWeek', 'days_per_week'], ['minMinutes', 'min_minutes']] as const) {
    if (patch[key] === undefined) continue;
    const current = weekOf(today), next = nextWeek(current);
    const startDate = patch.startDate ?? plan.start_date;
    let scope = action.goalScope ?? 'current_and_future';
    if (startDate > today) {
      if (scope === 'current_only') fail('invalid_input', '计划尚未开始，请从开始周设置目标。');
      if (scope === 'current_and_future') scope = 'next_and_future';
    }
    const value = patch[key]!;
    await q.query(`INSERT INTO goal_segments (plan_id,param,value,from_period,to_period,cleared) VALUES ($1,$2,$3,$4,$5,$6)`,
      [plan.id, param, value ?? 1, scope === 'next_and_future' ? next : current, scope === 'current_only' ? current : null, value === null]);
  }
  await q.query(`UPDATE plan_template_bindings SET current_book=$2, setup_status=$3, config_version=config_version+1 WHERE plan_id=$1`,
    [plan.id, patch.currentBook !== undefined ? patch.currentBook : state.config.currentBook, action.completeSetup ? 'ready' : state.config.setupStatus]);
  return getPlanTemplate(q, userId, plan.id, today);
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export const isTemplateAction = (action: { type: string }) => ['adopt_template','apply_private_template','upgrade_community_template','configure_reading_plan','configure_ledger_plan','configure_generic_plan'].includes(action.type);
export async function verifyTemplateRequest(q: Queryable, ctx: { userId: string; inputAt: Date; inputAtProvided?: boolean; templateCapability?: boolean;ledgerTemplateCapability?:boolean;genericCapability?:boolean }, clientOpId: string, actions: { type: string }[], persist = false) {
  const template = actions.some(isTemplateAction);
  if (template && actions.length !== 1) fail('invalid_input', '请将模板设置与事实记录分开提交。');
  const [stored] = await q.query<{ request_hash: string }>('SELECT request_hash FROM template_operation_requests WHERE user_id=$1 AND client_op_id=$2', [ctx.userId, clientOpId]);
  if (!stored && !template && !ctx.genericCapability) return;
  if (!stored) {
    const [existing] = await q.query('SELECT id FROM operations WHERE user_id=$1 AND client_op_id=$2', [ctx.userId, clientOpId]);
    if(existing&&!template&&!actions.some(a=>['add_generic_record','edit_generic_record','undo_generic'].includes(a.type))){
      // Old receipts predate request hashes. Preserve their original replay behavior,
      // but never mistake an unrelated old result for a new generic mutation.
      let genericTarget=false;
      for(const a of actions){
        if('planId' in a&&typeof a.planId==='string'&&/^[0-9a-f-]{36}$/i.test(a.planId)){
          const [p]=await q.query<{kind:string}>('SELECT kind FROM plans WHERE id=$1 AND user_id=$2',[a.planId,ctx.userId]);genericTarget ||= p?.kind==='generic';
        }
        if('recordId' in a&&typeof a.recordId==='string'){
          const [r]=await q.query<{kind:string}>('SELECT kind FROM records WHERE id=$1 AND user_id=$2',[a.recordId,ctx.userId]);genericTarget ||= r?.kind==='generic';
        }
      }
      if(!genericTarget)return;
    }
    if (existing) fail('operation_changed', '这个操作标识已用于其他内容，请先核对原结果。');
  }
  const digest = createHash('sha256').update(JSON.stringify(canonical({ actions, inputAt: ctx.inputAtProvided === false ? null : ctx.inputAt.toISOString() }))).digest('hex');
  if (stored && stored.request_hash !== digest) fail('operation_changed', '这个操作标识已用于其他内容，请先核对原结果。');
  if (!stored && persist) await q.query('INSERT INTO template_operation_requests (user_id,client_op_id,request_hash) VALUES ($1,$2,$3)', [ctx.userId, clientOpId, digest]);
}

export async function exportTemplatePlans(q: Queryable, userId: string, today: BizDate) {
  const rows = await q.query<{ plan_id: string }>('SELECT plan_id FROM plan_template_bindings WHERE user_id=$1 ORDER BY created_at,plan_id', [userId]);
  return Promise.all(rows.map(r => getPlanTemplate(q, userId, r.plan_id, today)));
}
