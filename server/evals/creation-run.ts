/**
 * Fixed creation semantic + domain evaluation, synthetic data only.
 * node --env-file=.env.openrouter.local --import tsx evals/creation-run.ts
 * No retry/fallback. Sequential calls start at least 15 seconds apart.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { atomicEvaluationReport, evaluationCoverage, evaluationIdentity, latestEvaluationResults, readEvaluationCheckpoint, remainingEvaluationIds, type EvalAttempt } from './checkpoint.js';
import { openDb, type Db } from '../src/db/db.js';
import { CREATION_SYSTEM_PROMPT, CREATION_RESPONSE_JSON_SCHEMA, type CreationInput, type CreationLlm, type CreationResult } from '../src/ai/creation.js';
import { MeteredCreationLlm, OpenAICompatibleCreationLlm } from '../src/ai/creation-runtime.js';
import { aiProviderConfig, aiModelProfile } from '../src/ai/provider.js';
import { assertCandidateReportPaths, candidateConfiguration, candidateRunnerArgs, type SyntheticCandidateEvaluation } from './candidate-config.js';
import { loadRuntimeConfig, decimalUnits } from '../src/ai/runtime-config.js';
import { UsageStore } from '../src/ai/usage-store.js';
import { LlmError } from '../src/ai/llm.js';
import { DomainError } from '../src/services/errors.js';
import { createCreationDraft, updateCreationDraft, clarifyCreationDraft, saveCreationDraft, normalizeCreationDefinition, creationDefinitionBody } from '../src/services/creation-drafts.js';
import { execute, type ExecContext } from '../src/services/engine.js';
import { genericOverview } from '../src/services/generic.js';
import type { GenericValues, TemplateDefinition, TemplateField, TemplateMetric } from '../src/templates/contracts.js';
import { CREATION_CASES, CREATION_DATASET, type CreationEvalCase, type ProposalExpectation } from './creation-cases.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const same = (a: unknown, b: unknown) => isDeepStrictEqual(canonical(a), canonical(b));
type StepResult = { index: number; status: 'passed' | 'failed' | 'provider_failed' | 'blocked'; expected: string[]; actual?: string; issues: string[]; latencyMs?: number; usage?: CreationResult['usage']; output?: unknown; rawInvalidOutput?: string };
export type CreationCaseResult = { id: string; title: string; category: CreationEvalCase['category']; status: 'passed' | 'failed' | 'provider_failed' | 'blocked'; pass: boolean; issues: string[]; steps: StepResult[]; wrongFactWrites: number; domain: 'passed' | 'failed' | 'not_run'; domainEvidence?: unknown };
export class CreationRateBlocked extends Error { constructor(readonly reason: string) { super(`Provider blocked: ${reason}`); } }

function fieldMap(definition: TemplateDefinition, expected: ProposalExpectation, issues: string[]) {
  const fields = new Map<string, TemplateField>();
  for (const rule of expected.fields) {
    const candidates = (rule.location === 'record' ? definition.recordFields : definition.configurationFields).filter(f => f.type === rule.type && new RegExp(rule.label, 'u').test(f.label));
    if (candidates.length !== 1) { issues.push(`field:${rule.key}: expected exactly one ${rule.type} matching ${rule.label}, got ${candidates.length}`); continue; }
    const field = candidates[0]!; fields.set(rule.key, field);
    if ((field.unit ?? null) !== (rule.unit ?? null)) issues.push(`field:${rule.key}: unit ${field.unit ?? 'none'} != ${rule.unit ?? 'none'}`);
    if (rule.required !== undefined && field.required !== rule.required) issues.push(`field:${rule.key}: required differs`);
    if (rule.options && !same(field.options, rule.options)) issues.push(`field:${rule.key}: options/order differs`);
    if (rule.id && field.id !== rule.id) issues.push(`field:${rule.key}: stable id changed`);
  }
  return fields;
}
function project(values: GenericValues, fields: Map<string, TemplateField>): GenericValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (key === 'date') return ['date', value];
    const field = fields.get(key); if (!field) throw new Error(`Missing evaluated field ${key}`);
    return [field.id, value];
  }));
}
function metricMatches(metric: TemplateMetric, rule: NonNullable<ProposalExpectation['metrics']>[number], fields: Map<string, TemplateField>) {
  return metric.operation === rule.operation && metric.period === rule.period
    && (rule.field ? metric.fieldId === fields.get(rule.field)?.id : metric.fieldId === undefined)
    && (!rule.goal || metric.goalFieldId === fields.get(rule.goal)?.id)
    && (!rule.aggregation || (metric.goalAggregation ?? 'sum') === rule.aggregation)
    && (!rule.group || metric.groupByFieldId === fields.get(rule.group)?.id);
}
function checkProposal(definition: TemplateDefinition, expected: ProposalExpectation, previous: TemplateDefinition | null) {
  const issues: string[] = [], fields = fieldMap(definition, expected, issues);
  if (expected.noDefaults && (Object.keys(definition.configurationDefaults ?? {}).length || Object.keys(definition.recordDefaults ?? {}).length)) issues.push('Unrequested defaults were invented');
  for (const key of ['configurationDefaults', 'recordDefaults'] as const) {
    if (expected[key]) {
      try { if (!same(definition[key], project(expected[key], fields))) issues.push(`${key}: missing, extra or incorrect suggestions`); }
      catch (error) { issues.push(String(error)); }
    }
  }
  for (const component of expected.components ?? []) if (!definition.components.includes(component as typeof definition.components[number])) issues.push(`Missing component ${component}`);
  for (const rule of expected.metrics ?? []) if (definition.metrics.filter(m => metricMatches(m, rule, fields)).length !== 1) issues.push(`Expected one ${rule.period}/${rule.operation}/${rule.aggregation ?? 'sum'} metric with the requested references`);
  if (expected.preservePreviousIds && previous) {
    for (const key of ['configurationFields', 'recordFields', 'metrics'] as const) for (const old of previous[key]) {
      const next = definition[key].find(f => f.id === old.id);
      if (!next) issues.push(`Existing ${key} id ${old.id} was removed/replaced`);
      if (key !== 'metrics' && next && ((next as TemplateField).type !== (old as TemplateField).type || (next as TemplateField).unit !== (old as TemplateField).unit)) issues.push(`Existing field ${old.id} changed semantic type/unit`);
    }
  }
  if (expected.onlyRename && previous) {
    const wanted = structuredClone(creationDefinitionBody(previous));
    wanted.recordFields.find(f => f.id === expected.onlyRename!.id)!.label = expected.onlyRename.label;
    if (!same(creationDefinitionBody(definition), wanted)) issues.push('Rename-only request changed other content');
  }
  if (/(?:<script|javascript:|https?:\/\/|sk-or-v1-)/i.test(JSON.stringify(creationDefinitionBody(definition)))) issues.push('Definition includes code, network target or credential-like content');
  return { issues, fields };
}
async function counts(db: Db, userId: string) {
  const [row] = await db.query<{ plans: number; records: number }>('SELECT (SELECT count(*)::int FROM plans WHERE user_id=$1) AS plans,(SELECT count(*)::int FROM records WHERE user_id=$1) AS records', [userId]); return row!;
}

/** One new user/draft per case; the supplied DB must itself be disposable. */
export async function runCreationCase(c: CreationEvalCase, db: Db, llm: CreationLlm): Promise<CreationCaseResult> {
  const [user] = await db.query<{ id: string }>('INSERT INTO users(dev_name,ai_consent) VALUES($1,true) RETURNING id', [`creation-eval-${c.id}-${randomUUID()}`]);
  const userId = user!.id, result: CreationCaseResult = { id: c.id, title: c.title, category: c.category, status: 'failed', pass: false, issues: [], steps: [], wrongFactWrites: 0, domain: 'not_run' };
  let draft = await db.tx(q => createCreationDraft(q, userId), userId);
  if (c.seed) draft = await db.tx(q => updateCreationDraft(q, userId, draft.id, draft.version, c.seed), userId);
  let lastExpected: ProposalExpectation | undefined, lastWasProposal = false;
  for (let index = 0; index < c.steps.length; index++) {
    const step = c.steps[index]!, previous = draft.definition;
    const entry: StepResult = { index: index + 1, status: 'failed', expected: step.kinds, issues: [] }; result.steps.push(entry);
    try {
      const generated = await llm.generate({ userId, requestId: randomUUID(), today: CREATION_DATASET.today, instruction: step.text, currentDefinition: previous, history: draft.messages.map(m => ({ role: m.role, text: m.text })) });
      entry.actual = generated.kind; entry.latencyMs = generated.latencyMs; entry.usage = generated.usage;
      entry.output = { kind: generated.kind, reply: generated.reply, definition: generated.definition };
      if (!step.kinds.includes(generated.kind)) entry.issues.push(`Expected ${step.kinds.join('|')}, got ${generated.kind}`);
      if (/(?:已(?:经)?(?:保存|发布|公开|采用|记录到|创建计划)|记录已保存)/u.test(generated.reply) && !/(?:尚未|还未|并未|没有|未保存)/u.test(generated.reply)) entry.issues.push('Reply claims an unconfirmed business/publish action completed');
      if (generated.kind === 'proposal') {
        const normalized = normalizeCreationDefinition(generated.definition, `private.${randomUUID()}`);
        if (step.expect) entry.issues.push(...checkProposal(normalized, step.expect, previous).issues);
        draft = await db.tx(q => updateCreationDraft(q, userId, draft.id, draft.version, generated.definition, { userText: step.text, assistantText: generated.reply }), userId);
        lastExpected = step.expect; lastWasProposal = true;
      } else {
        if (generated.definition !== null) entry.issues.push('Non-proposal carries a definition');
        draft = await db.tx(q => clarifyCreationDraft(q, userId, draft.id, draft.version, step.text, generated.reply), userId);
        if (!same(draft.definition, previous)) entry.issues.push('Clarification/refusal mutated the definition');
        lastWasProposal = false;
      }
      entry.status = entry.issues.length ? 'failed' : 'passed';
    } catch (error) {
      entry.status = error instanceof CreationRateBlocked ? 'blocked' : error instanceof LlmError ? 'provider_failed' : 'failed';
      entry.issues.push(error instanceof LlmError ? error.kind : error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Unknown failure');
      lastWasProposal = false;
    }
    const beforeConfirmation = await counts(db, userId);
    result.wrongFactWrites += beforeConfirmation.records;
    if (beforeConfirmation.plans || beforeConfirmation.records) entry.issues.push('Generation/clarification wrote business plans or records before confirmation');
    if (entry.issues.length && entry.status === 'passed') entry.status = 'failed';
    if (entry.status === 'provider_failed' || entry.status === 'blocked') break;
  }
  if (c.exercise && lastWasProposal && lastExpected && draft.definition) {
    try {
      const check = checkProposal(draft.definition, lastExpected, null), fields = check.fields;
      // A semantic failure cannot be turned into a pass by changing the exercise values.
      if (fields.size !== lastExpected.fields.length) throw new Error('Cannot project the predeclared records onto missing/ambiguous fields');
      draft = await db.tx(q => saveCreationDraft(q, userId, draft.id, draft.version), userId);
      if (!same(await counts(db, userId), { plans: 0, records: 0 })) throw new Error('Saving a private version created business data');
      const ctx: ExecContext = { userId, inputAt: new Date(`${CREATION_DATASET.today}T04:00:00Z`), source: 'form', genericCapability: true, privateTemplateCapability: true, genericTemplateV2Capability: true, communityTemplateCapability: true };
      const adopted = (await execute(db, ctx, randomUUID(), [{ type: 'adopt_template', templateId: draft.savedTemplate!.id, templateVersion: draft.savedTemplate!.version }])).templatePlan!;
      if (adopted.source !== 'private' || Object.keys(adopted.config.recordDefaults ?? {}).length || adopted.config.setupStatus !== 'pending') throw new Error('Adoption applied suggestions or lost private identity');
      for (const metric of adopted.definition.metrics.filter(m => m.operation === 'goal_progress')) if (adopted.config.values?.[metric.goalFieldId!] != null) throw new Error('Adoption applied a goal without confirmation');
      if (!same(await counts(db, userId), { plans: 1, records: 0 })) throw new Error('Adoption created records or duplicate plans');
      const enabled = c.exercise.recordDefaults ? project(c.exercise.recordDefaults, fields) : undefined;
      const configured = (await execute(db, ctx, randomUUID(), [{ type: 'configure_generic_plan', planId: adopted.planId, expectedVersion: adopted.config.version, completeSetup: true, patch: { ...(c.exercise.values ? { values: project(c.exercise.values, fields) } : {}) }, ...(c.exercise.applyTemplateDefaults ? { applyTemplateDefaults: true } : {}), ...(enabled ? { recordDefaults: enabled } : {}) }])).templatePlan!;
      if (!same(configured.config.recordDefaults ?? {}, enabled ?? {})) throw new Error('Record defaults were not explicitly and separately configured');
      if (!same(await counts(db, userId), { plans: 1, records: 0 })) throw new Error('Configuration wrote fact records');
      const projected = c.exercise.records.map(values => ({ date: CREATION_DATASET.today, ...project(values, fields) }));
      const operation = await execute(db, ctx, randomUUID(), projected.map(values => ({ type: 'add_generic_record' as const, planId: adopted.planId, values })));
      for (let i = 0; i < operation.items.length; i++) {
        const item = operation.items[i]!; if (item.type !== 'generic_added') throw new Error('Expected generic record result');
        const values = projected[i]!;
        if (!same(item.record.fields, { ...enabled, ...values })) throw new Error(`Record ${i + 1} changed explicit values or did not apply enabled defaults`);
        const defaulted = Object.keys(enabled ?? {}).filter(id => !Object.hasOwn(values, id)).sort();
        if (!same([...(item.record.defaultedFields ?? [])].sort(), defaulted)) throw new Error(`Record ${i + 1} default provenance is incorrect`);
        if (item.record.definitionTemplateId !== draft.savedTemplate!.id || item.record.definitionVersion !== draft.savedTemplate!.version) throw new Error('Record lost immutable template provenance');
      }
      const summary = await genericOverview(db, userId, adopted.planId, CREATION_DATASET.today);
      for (const rule of lastExpected.metrics ?? []) {
        const metric = adopted.definition.metrics.find(m => metricMatches(m, rule, fields)); if (!metric) throw new Error('Declared metric is missing');
        const actual = summary.metrics.find(m => m.id === metric.id); if (!actual || actual.value !== rule.value) throw new Error(`Metric ${metric.id}: value ${actual?.value} != ${rule.value}`);
        if (rule.target !== undefined && actual.target !== rule.target) throw new Error(`Metric ${metric.id}: target ${actual.target} != ${rule.target}`);
        for (const group of rule.groups ?? []) if (!actual.groups?.some(g => same(g.key, group.key) && g.value === group.value)) throw new Error(`Metric ${metric.id}: group ${group.key} is incorrect`);
        if (adopted.definition.components.includes('trend') && !actual.series?.length) throw new Error(`Metric ${metric.id}: missing actual day series`);
      }
      if (!same(await counts(db, userId), { plans: 1, records: projected.length })) throw new Error('Final fact count differs from explicit records');
      result.domain = 'passed'; result.domainEvidence = { savedPrivateVersion: draft.savedTemplate!.version, plansAfterSave: 0, recordsAfterConfiguration: 0, explicitRecords: projected.length, enabledRecordDefaultFields: Object.keys(enabled ?? {}), metrics: summary.metrics, records: operation.items.map(i => i.type === 'generic_added' ? { fields: i.record.fields, defaultedFields: i.record.defaultedFields ?? [] } : null) };
    } catch (error) { result.domain = 'failed'; result.issues.push(error instanceof Error ? error.message : 'Unknown domain failure'); }
  } else if (!c.exercise && result.steps.length === c.steps.length && result.steps.every(s => s.status === 'passed')) {
    result.domain = 'passed'; result.domainEvidence = { plans: 0, records: 0, definitionUnchangedByClarification: true };
  } else if (c.exercise) result.issues.push('The expected final proposal was not available for the saved/adopted domain exercise');
  result.issues.push(...result.steps.flatMap(s => s.issues.map(issue => `turn ${s.index}: ${issue}`)));
  result.pass = result.steps.length === c.steps.length && result.steps.every(s => s.status === 'passed') && result.domain === 'passed' && result.wrongFactWrites === 0 && result.issues.length === 0;
  result.status = result.pass ? 'passed' : result.steps.some(s => s.status === 'blocked') ? 'blocked' : result.steps.some(s => s.status === 'provider_failed') ? 'provider_failed' : 'failed';
  return result;
}

export async function runCreationEvaluation(candidate?:SyntheticCandidateEvaluation, candidateEnv:NodeJS.ProcessEnv=process.env) {
  if(candidate&&candidate.suite!=='creation')throw new Error('Expected creation candidate suite');
  const candidateConfig=candidate?candidateConfiguration(candidate,candidateEnv):undefined;
  const env=candidateConfig?.runtimeEnv??process.env;
  const args = candidate ? candidateRunnerArgs(candidate) : process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const intervalMs = Number(arg('interval-ms') ?? 15000), maxRequests = Number(arg('max-requests') ?? 40);
  if (!Number.isInteger(intervalMs) || intervalMs < (candidate ? 4000 : 15000) || intervalMs > 60000) throw new Error(`interval-ms must be ${candidate?4000:15000}–60000; concurrency is fixed at 1`);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('max-requests must be 1–1000');
  const selected = arg('only')?.split(','), cases = [...CREATION_CASES];
  const config = candidateConfig?.config ?? aiProviderConfig(env);
  if (config.provider !== 'openrouter' || (!candidate && config.model !== 'baidu/ernie-5.5-flash-preview:free') || config.baseURL !== 'https://openrouter.ai/api/v1') throw new Error('This fixed evaluation requires the user-specified OpenRouter model and official endpoint');
  const key = env[config.apiKeyVariable]; if (!key?.trim()) throw new Error(`Missing ${config.apiKeyVariable}`);
  const runtime = loadRuntimeConfig(env, config.model, 'compact'); if (runtime.fallback) throw new Error('Fallback is forbidden');
  const sourceHash = (name: string) => hash(readFileSync(new URL(name, import.meta.url), 'utf8'));
  const executionFiles = ['./creation-run.ts','./checkpoint.ts','../src/ai/creation.ts','../src/ai/creation-runtime.ts','../src/services/creation-drafts.ts','../src/services/templates.ts','../src/services/generic.ts','../src/services/engine.ts','../src/templates/contracts.ts',...(candidate?['./candidate-run.ts','./candidate-config.ts','../src/ai/provider.ts','../src/ai/llm.ts','../src/ai/runtime-config.ts','../src/ai/usage-store.ts','../src/ai/cost.ts','../package.json','../pnpm-lock.yaml']:[])];
  const modelProfile=aiModelProfile(config.provider,config.model);
  const identityFields = { ...(candidate?{modelProfile,syntheticCandidate:true,fixtureStore:'pglite://memory',candidateSuite:'creation'}:{}), datasetHash: sourceHash('./creation-cases.ts'), promptHash: hash(CREATION_SYSTEM_PROMPT), protocolHash: hash(JSON.stringify(CREATION_RESPONSE_JSON_SCHEMA)), executionFiles: Object.fromEntries(executionFiles.map(name => [name, sourceHash(name)])), provider: config.provider, model: config.model, timeoutMs: 60000, fallback: false };
  const identity = evaluationIdentity(identityFields), resume = arg('resume');
  const output = resolve(arg('out') ?? resume ?? `evals/reports/creation-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);
  if(candidate)assertCandidateReportPaths(output,resume);
  if (!resume && existsSync(output)) throw new Error('Refusing to overwrite an existing report; use --resume for a matching checkpoint');
  const checkpoint = readEvaluationCheckpoint<CreationCaseResult>(resume, identity, cases.map(c => c.id));
  const selectedIds = remainingEvaluationIds(checkpoint, selected, args.includes('--retry-failed'));
  const startedAt = new Date().toISOString(), segment = randomUUID();
  const metadata = { dataset: CREATION_DATASET, ...identityFields, runnerHash: sourceHash('./creation-run.ts'), revision: `workspace:${identity}`, provider: config.provider, model: config.model, fallback: false, concurrency: 1, intervalMs, maxRequests, timeoutMs: 60000, selectedIds, fullDatasetCount: cases.length, startedAt, environment: 'new disposable PGlite; synthetic per-case accounts; no live fixture data',...(candidate?{candidateOnly:true,productionReady:false}:{} ) };
  const db = await openDb('pglite://memory');
  let blocked: string | null = null, nextAt = Math.max(0, ...checkpoint.attempts.map(a => Date.parse(a.startedAt) + intervalMs)), lastRaw: string | undefined;
  let activeCase = '', activeAttempt: EvalAttempt | undefined;
  const currentAttempt = (): EvalAttempt | undefined => activeAttempt;
  let invocationMetered = { attempts: 0, succeeded: 0, failed: 0 };
  async function writeReport(invocationComplete: boolean) {
    const results = latestEvaluationResults(checkpoint), coverage = evaluationCoverage(checkpoint);
    const [usage] = await db.query<{ attempts: number; succeeded: number; failed: number }>("SELECT count(*)::int AS attempts,count(*) FILTER(WHERE outcome='succeeded')::int AS succeeded,count(*) FILTER(WHERE outcome='failed')::int AS failed FROM ai_attempts");
    invocationMetered = usage!;
    const summary = { ...coverage, providerFailures: checkpoint.attempts.filter(a => a.error && a.error !== 'invalid_output' && a.error !== 'accounting_unavailable').length,
      invalidOutputs: checkpoint.attempts.filter(a => a.error === 'invalid_output').length, accountingFailures: checkpoint.attempts.filter(a => a.error === 'accounting_unavailable').length,
      blockReason: blocked, wrongFactWrites: results.reduce((n,r)=>n+r.wrongFactWrites,0), meteredThisInvocation: invocationMetered,
      byCategory: Object.fromEntries([...new Set(cases.map(c=>c.category))].map(category=>[category,{ denominator: cases.filter(c=>c.category===category).length, passed:results.filter(r=>r.category===category&&r.pass).length }])) };
    const complete = coverage.pending === 0;
    const gates = { automaticPassed: complete && results.every(r=>r.pass), firstRunAllPassed: complete && coverage.firstResultPassed === cases.length && coverage.explicitRetryCaseRuns === 0, humanReviewed: false, releaseApproved: false };
    atomicEvaluationReport(output, { metadata, checkpoint, complete, invocationComplete, finishedAt: invocationComplete ? new Date().toISOString() : null, summary, gates, attemptTimes: checkpoint.attempts.map(a=>a.startedAt), results });
    const lines = ['# 创作 AI 固定评测（评测集待人工审定）','',`模型：${config.model}；无fallback；单并发，实际请求起始间隔至少${intervalMs/1000}秒，累计请求预算${maxRequests}。`,
      '',`数据集${CREATION_DATASET.version}，SHA256 ${metadata.datasetHash}；prompt ${metadata.promptHash}。评测集仍draft，无人工审批。`,
      '',`完整分母${coverage.denominator}；已完成${coverage.completed}；通过${coverage.passed}；失败${coverage.failed}；未执行${coverage.pending}。真实请求${coverage.attempts}，显式复跑${coverage.explicitRetryCaseRuns}，首轮通过${coverage.firstResultPassed}；供应商失败${summary.providerFailures}，非法输出${summary.invalidOutputs}；错写${summary.wrongFactWrites}。`,
      `本次状态：${invocationComplete?'已停止/完成所选范围':'运行中'}；停止原因：${blocked??'无'}；自动覆盖门槛：${gates.automaticPassed?'通过':'未通过'}；全部首次通过：${gates.firstRunAllPassed}。人工审定与发布批准仍为false。`,
      '', '| 用例 | 类别 | 结果 | 真实领域执行 | 问题 |','| --- | --- | --- | --- | --- |',
      ...cases.map(c=>{const r=results.find(row=>row.id===c.id);return `| ${c.id} ${c.title} | ${c.category} | ${r?.status??'not_run'} | ${r?.domain??'not_run'} | ${(r?.issues.join('；')??'').replaceAll('|','/').replaceAll('\n',' ')} |`;}),
      '', '逐例历史与每个真实attempt保留在JSON。续跑不重复已完成用例；失败复跑须显式--retry-failed且不删除首错。指纹不匹配拒绝合并。每个proposal实际保存私人版本、采用、显式配置、录入及核对统计；手工数据和AI定义分开。', '', `证据：${output.split('/').at(-1)}`];
    writeFileSync(output.replace(/\.json$/,'.md'), `${lines.join('\n')}\n`, {mode:0o600});
  }
  const transport = new OpenAICompatibleCreationLlm({ apiKey: key, baseURL: config.baseURL, model: config.model, provider: config.provider, timeoutMs: 60000, fetch: async (input, init) => {
    activeAttempt = { ordinal: checkpoint.attempts.length+1, caseId: activeCase, startedAt: new Date().toISOString() };
    checkpoint.attempts.push(activeAttempt); nextAt=Date.now()+intervalMs; await writeReport(false);
    const response = await fetch(input,init); activeAttempt.httpStatus=response.status;
    try { const payload=await response.clone().json() as {choices?:{message?:{content?:string}}[]}; lastRaw=payload.choices?.[0]?.message?.content?.slice(0,80000).replace(/sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{12,}/g,'[REDACTED_SYNTHETIC_OR_CREDENTIAL_LIKE_STRING]'); } catch { lastRaw=undefined; }
    return response;
  } });
  const metered=new MeteredCreationLlm(transport,config.model,runtime,new UsageStore(db,decimalUnits(runtime.monthlyBudgetCny,12)));
  const llm:CreationLlm={async generate(input:CreationInput){
    if(blocked)throw new CreationRateBlocked(blocked);
    if(checkpoint.attempts.length>=maxRequests){blocked='request_budget';throw new CreationRateBlocked(blocked);}
    const delay=Math.max(0,nextAt-Date.now());if(delay)await new Promise(done=>setTimeout(done,delay));
    activeAttempt=undefined;lastRaw=undefined;
    try{const result=await metered.generate(input);const attempt=currentAttempt();if(attempt){attempt.error=null;attempt.usage=result.usage;}return result;}
    catch(error){if(error instanceof LlmError){const attempt=currentAttempt();if(attempt){attempt.error=error.kind;attempt.usage=error.usage;}if(['rate_limited','billing','unauthorized','invalid_request'].includes(error.kind))blocked=error.kind;}throw error;}
    finally{const attempt=currentAttempt();if(attempt)attempt.finishedAt=new Date().toISOString();await writeReport(false);}
  }};
  try{
    await writeReport(false);
    for(const c of cases.filter(c=>selectedIds.includes(c.id))){
      if(blocked)break;
      if(checkpoint.attempts.length>=maxRequests){blocked='request_budget';break;}
      activeCase=c.id;
      const result=await runCreationCase(c,db,llm);
      if(result.steps.at(-1)?.status==='provider_failed'&&result.steps.at(-1)?.issues.includes('invalid_output')&&lastRaw)result.steps.at(-1)!.rawInvalidOutput=lastRaw;
      checkpoint.history.push({segment,result});await writeReport(false);
      const coverage=evaluationCoverage(checkpoint);
      process.stdout.write(`${c.id} ${result.status} domain=${result.domain} (${coverage.completed}/${cases.length}, attempts=${coverage.attempts})\n`);
    }
    await writeReport(true);
    process.stdout.write(`Report: ${output}\n`);
    if(blocked||latestEvaluationResults(checkpoint).some(r=>!r.pass))process.exitCode=1;
  }finally{await db.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runCreationEvaluation();
