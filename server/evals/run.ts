/** Fixed full-denominator evaluation. Synthetic disposable fixtures, one provider call per turn. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAICompatibleLlm, LlmError, type Llm } from '../src/ai/llm.js';
import { aiProviderConfig, aiModelProfile } from '../src/ai/provider.js';
import { assertCandidateReportPaths, candidateConfiguration, candidateRunnerArgs, type SyntheticCandidateEvaluation } from './candidate-config.js';
import { evaluationMetadata } from './metadata.js';
import { runCase, type Result } from './runner.js';
import { assessGates } from './gates.js';
import { CASES, type Group } from './cases.js';
import { DATASET_REVIEW, isReviewed } from './review.js';
import { atomicEvaluationReport, evaluationCoverage, evaluationIdentity, latestEvaluationResults, readEvaluationCheckpoint, remainingEvaluationIds, type EvalAttempt } from './checkpoint.js';

export async function runBaseEvaluation(candidate?:SyntheticCandidateEvaluation, candidateEnv:NodeJS.ProcessEnv=process.env) {
if(candidate&&candidate.suite!=='base')throw new Error('Expected base candidate suite');
const candidateConfig=candidate?candidateConfiguration(candidate,candidateEnv):undefined;
const env=candidateConfig?.runtimeEnv??process.env;
// An explicit --env-file launch wins. Do not load unrelated provider credentials.
if (!candidate && !process.env.AI_PROVIDER) for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) if (existsSync(p)) process.loadEnvFile(p);
const args = candidate ? candidateRunnerArgs(candidate) : process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = arg('only')?.split(','), concurrency = Number(arg('concurrency') ?? 1);
if (concurrency !== 1) throw new Error('Fixed real evaluation requires concurrency 1');
const { provider, model, baseURL, mode, apiKeyVariable } = candidateConfig?.config ?? aiProviderConfig(env);
if (provider !== 'openrouter' || (!candidate && model !== 'baidu/ernie-5.5-flash-preview:free') || baseURL !== 'https://openrouter.ai/api/v1') throw new Error('This evaluation requires the user-specified free OpenRouter model and official endpoint');
if (!env[apiKeyVariable]?.trim()) throw new Error(`缺少 ${apiKeyVariable}`);
if (env.AI_FALLBACK_MODEL || env.AI_FALLBACK_PROVIDER) throw new Error('Fallback is forbidden');
const requestTimeoutMs = Number(arg('timeout-ms') ?? 60000), intervalMs = Number(arg('interval-ms') ?? 4000), maxRequests = Number(arg('max-requests') ?? 400);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 50 || requestTimeoutMs > 60000) throw new Error('timeout-ms must be 50–60000');
if (!Number.isInteger(intervalMs) || intervalMs < 4000 || intervalMs > 60000) throw new Error('interval-ms must be 4000–60000');
if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('max-requests must be 1–1000');
const sourceHash = (name: string) => createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex');
const aggregateHash = (names: string[]) => { const h = createHash('sha256'); for (const name of names) h.update(readFileSync(new URL(name, import.meta.url))); return h.digest('hex'); };
const currentFingerprint = { prompt: aggregateHash(['../src/ai/prompt.ts','../src/ai/llm.ts']), protocol: aggregateHash(['../src/ai/turn.ts']), dataset: aggregateHash(['./cases.ts','./fixtures.ts','./query-expectations.ts','./first-week-expectations.ts']) };
const buildMetadata = evaluationMetadata(model,mode,requestTimeoutMs,'pending');
for (const k of ['prompt','protocol','dataset'] as const) if (currentFingerprint[k] !== buildMetadata[k]) throw new Error('AI build fingerprint is stale; run scripts/ai-fingerprint.ts before evaluation');
const executionFiles = ['./run.ts','./runner.ts','./checkpoint.ts','./gates.ts','./review.ts','./metadata.ts','../src/services/chat.ts','../src/ai/user-feedback.ts','../src/services/chat-generic.ts','../src/services/query.ts','../src/services/engine.ts','../src/services/generic.ts','../src/services/duplicates.ts','../src/ai/provider.ts',...(candidate?['./candidate-run.ts','./candidate-config.ts','../src/ai/runtime-config.ts','../src/ai/usage-store.ts','../src/ai/cost.ts','../package.json','../pnpm-lock.yaml']:[])];
const modelProfile=aiModelProfile(provider,model);
const identityFields = { ...currentFingerprint, ...(candidate?{modelProfile,syntheticCandidate:true,fixtureStore:'pglite://memory',candidateSuite:'base'}:{}), executionFiles: Object.fromEntries(executionFiles.map(name => [name,sourceHash(name)])), provider,model,mode,requestTimeoutMs,fallback:false };
const identity = evaluationIdentity(identityFields), resume = arg('resume');
const output = resolve(arg('out') ?? resume ?? `evals/reports/run-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
if(candidate)assertCandidateReportPaths(output,resume);
if (!resume && existsSync(output)) throw new Error('Refusing to overwrite evidence; use --resume for the identical checkpoint');
type StoredResult = Result & { id: string };
type RecordedAttempt = EvalAttempt & { turn?: unknown; rawInvalidOutput?: string };
const checkpoint = readEvaluationCheckpoint<StoredResult>(resume,identity,CASES.map(c=>c.id));
const selectedIds = remainingEvaluationIds(checkpoint,only,args.includes('--retry-failed'));
const segment = randomUUID(), startedAt = new Date().toISOString();
let blockedReason: string | null = null, activeCase = '', activeAttempt: RecordedAttempt | undefined;
let nextAt = Math.max(0,...checkpoint.attempts.map(a=>Date.parse(a.startedAt)+intervalMs)), lastRaw: string | undefined;
const currentAttempt = (): RecordedAttempt | undefined => activeAttempt;
const metadata = { ...buildMetadata, revision:`workspace:${identity}`, identityFields,provider,model,concurrency,intervalMs,maxRequests,selectedIds,fullDatasetCount:CASES.length,startedAt,syntheticOnly:true,automaticRetries:0,fallback:false,...(candidate?{candidateOnly:true,modelProfile,productionReady:false,fixtureStore:'pglite://memory'}:{}) };
const groupNames:Record<Group,string>={finance:'财务记录',study:'学习记录',create_goal:'创建与目标调整',query:'查询',ambiguous:'歧义与非事实',correction:'纠错与边界'};
function fullResults():Result[]{const latest=new Map(latestEvaluationResults(checkpoint).map(r=>[r.id,r]));return CASES.map(c=>latest.has(c.id)?{...latest.get(c.id)!,c}:{c,pass:false,reason:'not_run',latencyMs:0,executedOneTurn:false,wrongFactWrites:0,reply:'',cards:[]});}
function writeReport(invocationComplete:boolean){
  const results=fullResults(),coverage=evaluationCoverage(checkpoint),complete=coverage.pending===0,rawGates=assessGates(results);
  const gates={...rawGates,passed:complete&&rawGates.passed,complete,humanReviewed:isReviewed(DATASET_REVIEW),releaseApproved:false};
  const summary={...coverage,blockReason:blockedReason,providerFailures:checkpoint.attempts.filter(a=>a.error&&a.error!=='invalid_output').length,invalidOutputs:checkpoint.attempts.filter(a=>a.error==='invalid_output').length,wrongFactWrites:results.reduce((n,r)=>n+r.wrongFactWrites,0)};
  atomicEvaluationReport(output,{metadata:{...metadata,attempts:checkpoint.attempts.length,blockedReason},checkpoint,complete,invocationComplete,finishedAt:invocationComplete?new Date().toISOString():null,summary,gates,results:results.map(({c,...r})=>({...r,id:c.id}))});
  const lines=['# AI 固定评测报告','',`模型：${model}；单并发，间隔至少${intervalMs}ms；无fallback、无自动重试。`,
    `完整分母${coverage.denominator}；已完成${coverage.completed}；通过${coverage.passed}；失败${coverage.failed}；未执行${coverage.pending}；实际请求${coverage.attempts}。`,
    `首轮通过${coverage.firstResultPassed}；显式复跑${coverage.explicitRetryCaseRuns}；停止原因${blockedReason??'无'}。本次${invocationComplete?'已停止/完成所选范围':'运行中'}。`,
    `数据集人工审定：${DATASET_REVIEW.status}。程序门槛${gates.passed?'通过':'未通过'}；完整覆盖${complete}；不代表人工或发布批准。`,
    `prompt ${currentFingerprint.prompt}；protocol ${currentFingerprint.protocol}；dataset ${currentFingerprint.dataset}。`,
    '', '| 指标 | 实际 | 门槛 |','| --- | --- | --- |',
    `| 关键字段正确率 | ${(100*rawGates.keyRate).toFixed(1)}% | ≥98% |`,
    `| 明确表达一轮完成率 | ${(100*rawGates.oneTurnRate).toFixed(1)}% | ≥90% |`,
    `| 查询全字段正确 | ${rawGates.queryPassed}/${rawGates.queryTotal} | 全部正确 |`,
    `| 不当事实写入 | ${rawGates.wrongWrites} | 0 |`,
    '', '| 场景 | 通过/完整分母 |','| --- | --- |',
    ...Object.entries(groupNames).map(([g,name])=>`| ${name} | ${results.filter(r=>r.c.group===g&&r.pass).length}/${results.filter(r=>r.c.group===g).length} |`),
    '', '| 用例 | 结果 | 原因 |','| --- | --- | --- |',
    ...results.filter(r=>!r.pass).map(r=>`| ${r.c.id} | ${r.reason==='not_run'?'not_run':'failed'} | ${r.reason.replaceAll('|','/').replaceAll('\n',' ')} |`),
    '', '逐例历史、原始attempt顺序、输出与供应商错误保留JSON；失败须显式--retry-failed，已通过案例不重复。未知网络结果拒绝静默续发，prompt/代码/评测集不匹配拒绝合并。',`证据：${output.split('/').at(-1)}`];
  writeFileSync(output.replace(/\.json$/,'.md'),`${lines.join('\n')}\n`,{mode:0o600});
}
const transport=new OpenAICompatibleLlm(env[apiKeyVariable]!,baseURL,model,mode,requestTimeoutMs,{provider,fetch:async(input,init)=>{
  activeAttempt={ordinal:checkpoint.attempts.length+1,caseId:activeCase,startedAt:new Date().toISOString()};checkpoint.attempts.push(activeAttempt);nextAt=Date.now()+intervalMs;writeReport(false);
  const response=await fetch(input,init);activeAttempt.httpStatus=response.status;
  try{const payload=await response.clone().json() as {choices?:{message?:{content?:string}}[]};lastRaw=payload.choices?.[0]?.message?.content?.slice(0,80000).replace(/sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{12,}/g,'[REDACTED_SYNTHETIC_OR_CREDENTIAL_LIKE_STRING]');}catch{lastRaw=undefined;}
  return response;
}});
const llm:Llm={async plan(system,user,context){
  if(blockedReason)throw new LlmError(blockedReason==='request_budget'?'unavailable':blockedReason as LlmError['kind']);
  if(checkpoint.attempts.length>=maxRequests){blockedReason='request_budget';throw new LlmError('unavailable');}
  const delay=Math.max(0,nextAt-Date.now());if(delay)await new Promise(done=>setTimeout(done,delay));
  activeAttempt=undefined;lastRaw=undefined;
  try{const result=await transport.plan(system,user,context);const attempt=currentAttempt();if(attempt){attempt.error=null;attempt.usage=result.usage;attempt.turn=result.turn;}return result;}
  catch(error){const attempt=currentAttempt();if(error instanceof LlmError){if(attempt){attempt.error=error.kind;attempt.usage=error.usage;if(error.kind==='invalid_output')attempt.rawInvalidOutput=lastRaw;}if(['rate_limited','billing','unauthorized','invalid_request'].includes(error.kind))blockedReason=error.kind;}throw error;}
  finally{const attempt=currentAttempt();if(attempt)attempt.finishedAt=new Date().toISOString();writeReport(false);}
}};
writeReport(false);
for(const c of CASES.filter(c=>selectedIds.includes(c.id))){
  if(blockedReason)break;
  if(checkpoint.attempts.length>=maxRequests){blockedReason='request_budget';break;}
  activeCase=c.id;const result=await runCase(c,CASES.indexOf(c),llm,candidateConfig?.runtimeEnv);checkpoint.history.push({segment,result:{...result,id:c.id}});writeReport(false);
  const coverage=evaluationCoverage(checkpoint);process.stdout.write(`${c.id} ${result.pass?'passed':'failed'} (${coverage.completed}/${CASES.length}, attempts=${coverage.attempts})\n`);
}
writeReport(true);process.stdout.write(`Report: ${output}\n`);
const results=latestEvaluationResults(checkpoint),complete=results.length===CASES.length;
if(blockedReason||results.some(r=>!r.pass)||(complete&&!assessGates(fullResults()).passed)||(args.includes('--release-gate')&&(!complete||!isReviewed(DATASET_REVIEW))))process.exitCode=1;

}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await runBaseEvaluation();
