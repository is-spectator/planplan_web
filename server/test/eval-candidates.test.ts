import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SYNTHETIC_CANDIDATE_MODELS, SYNTHETIC_CANDIDATE_BASE_IDS, assertCandidateReportPaths, candidateConfiguration, candidateRequestUpper, candidateRunnerArgs, parseSyntheticCandidateArgs } from '../evals/candidate-config.js';
import { runSyntheticCandidate } from '../evals/candidate-run.js';
import { evaluationIdentity, readEvaluationCheckpoint } from '../evals/checkpoint.js';
import { CASES } from '../evals/cases.js';

const dirs:string[]=[];
const lightning=SYNTHETIC_CANDIDATE_MODELS[0], superVl=SYNTHETIC_CANDIDATE_MODELS[1];
const args=(model:string=lightning,suite='base')=>['--model',model,'--suite',suite];
const reportPath=()=>{const dir=mkdtempSync(join(tmpdir(),'candidate-eval-'));dirs.push(dir);return join(dir,'report.json');};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('候选模型专用合成评测边界',()=>{
  it.each(SYNTHETIC_CANDIDATE_MODELS)('%s 仅构造公开固定profile和安全环境，默认不改变',model=>{
    const env={AI_PROVIDER:'openrouter',OPENROUTER_MODEL:'baidu/ernie-5.5-flash-preview:free',OPENROUTER_API_KEY:'synthetic-unit-test-key'};
    const candidate=parseSyntheticCandidateArgs(args(model),env), resolved=candidateConfiguration(candidate,env);
    expect(resolved.config).toMatchObject({provider:'openrouter',model,baseURL:'https://openrouter.ai/api/v1',mode:'compact'});
    expect(resolved.profile).toMatchObject({syntheticOnly:true,providerOnly:['nvidia']});
    expect(Object.keys(resolved.runtimeEnv).sort()).toEqual(['AI_PROVIDER','OPENROUTER_API_KEY','OPENROUTER_BASE_URL','OPENROUTER_MODEL','OPENROUTER_OUTPUT']);
    expect(env.OPENROUTER_MODEL).toBe('baidu/ernie-5.5-flash-preview:free');
  });
  it.each(['baidu/ernie-5.5-flash-preview:free','nvidia/nemotron-3.5-lightning','NVIDIA/nemotron-3.5-lightning:free',' nvidia/nemotron-3.5-super-vl:free','unknown:free'])('拒绝候选allowlist外模型 %s',model=>{
    expect(()=>parseSyntheticCandidateArgs(args(model),{})).toThrow('Unsupported synthetic candidate model');
  });
  it.each(['--input','--db','--only','--retry-failed','--base-url','--concurrency','--max-requests','--timeout-ms'])('不接受用户输入或执行策略覆盖 %s',flag=>{
    expect(()=>parseSyntheticCandidateArgs([...args(),flag,'custom'],{})).toThrow('Invalid or duplicate');
  });
  it('拒绝重复、缺值、未知suite和过短间隔',()=>{
    for(const invalid of [[...args(),'--model',superVl],[...args(),'--out'],args(lightning,'custom'),[...args(),'--interval-ms','3999']])expect(()=>parseSyntheticCandidateArgs(invalid,{})).toThrow();
  });
  it.each(['DATABASE_URL','TEST_DATABASE_URL','PGLITE_DATA_DIR','AI_RUNTIME_CONFIG_PATH','AI_FALLBACK_MODEL','AI_FALLBACK_PROVIDER','PGHOST','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE'])('显式拒绝外部配置 %s',key=>{
    expect(()=>parseSyntheticCandidateArgs(args(),{[key]:'forbidden-test-value'})).toThrow(key);
  });
  it.each([{NODE_ENV:'production'},{NODE_ENV:'test'},{DEPLOYMENT_ENV:'beta'},{OPENROUTER_BASE_URL:'http://127.0.0.1:9'},{OPENROUTER_OUTPUT:'strict'},{AI_PROVIDER:'qwen'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'}])('拒绝部署/不受支持的环境 %#',env=>{
    expect(()=>parseSyntheticCandidateArgs(args(),env)).toThrow();
  });
  it('固定38项包含旧8首错及原3服务失败，全分母保持330，最坏128请求',()=>{
    expect(CASES).toHaveLength(330);expect(SYNTHETIC_CANDIDATE_BASE_IDS).toHaveLength(38);expect(new Set(SYNTHETIC_CANDIDATE_BASE_IDS).size).toBe(38);
    for(const id of ['S022','Q011','Q025','A039','C008','C026','C032','C039','S011','S015','G022'])expect(SYNTHETIC_CANDIDATE_BASE_IDS).toContain(id);
    expect(candidateRequestUpper('base')).toBe(41);expect(candidateRequestUpper('creation')).toBe(23);
    expect(2*(candidateRequestUpper('base')+candidateRequestUpper('creation'))).toBe(128);
    expect(candidateRunnerArgs(parseSyntheticCandidateArgs(args(),{}))).toEqual(['--only',SYNTHETIC_CANDIDATE_BASE_IDS.join(','),'--interval-ms','4000','--max-requests','41']);
  });
});

function cleanSyntheticEnvironment(){
  for(const key of ['DATABASE_URL','TEST_DATABASE_URL','PGLITE_DATA_DIR','AI_RUNTIME_CONFIG_PATH','AI_FALLBACK_MODEL','AI_FALLBACK_PROVIDER','PGHOST','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','DEPLOYMENT_ENV','NODE_TLS_REJECT_UNAUTHORIZED'])vi.stubEnv(key,undefined);
  vi.stubEnv('NODE_ENV','development');vi.stubEnv('AI_PROVIDER','openrouter');vi.stubEnv('OPENROUTER_OUTPUT','compact');vi.stubEnv('OPENROUTER_BASE_URL','https://openrouter.ai/api/v1');vi.stubEnv('OPENROUTER_API_KEY','synthetic-unit-test-key');
}

describe('候选CLI通过真实SDK仅使用mock传输和内存数据库',()=>{
  it.each(SYNTHETIC_CANDIDATE_MODELS.flatMap(model=>['base','creation'].map(suite=>({model,suite}))))('$model $suite 首次429即停止，完整分母、模型profile和attempt独立落盘',async({model,suite})=>{
    cleanSyntheticEnvironment();const out=reportPath(), exitCode=process.exitCode;
    const requests:Record<string,unknown>[]=[];
    const fetchMock=vi.fn(async(input:unknown,init?:RequestInit)=>{
      expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions');requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({error:{message:'Synthetic rate limit',code:429}}),{status:429,headers:{'content-type':'application/json'}});
    });vi.stubGlobal('fetch',fetchMock);vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try{
      await runSyntheticCandidate([...args(model,suite),'--out',out]);
      const report=JSON.parse(readFileSync(out,'utf8'));
      expect(fetchMock).toHaveBeenCalledTimes(1);expect(requests[0]).toMatchObject({model,provider:{only:['nvidia'],allow_fallbacks:false},reasoning:{enabled:false}});
      if(model===lightning)expect(requests[0]).not.toHaveProperty('response_format');else expect(requests[0]).toHaveProperty('response_format');
      expect(report.metadata).toMatchObject({candidateOnly:true,productionReady:false,provider:'openrouter',model,concurrency:1,fallback:false});
      expect(report.summary).toMatchObject({denominator:suite==='base'?330:20,completed:1,pending:suite==='base'?329:19,attempts:1,providerFailures:1,blockReason:'rate_limited',wrongFactWrites:0});
      expect(report.checkpoint.attempts[0]).toMatchObject({ordinal:1,httpStatus:429,error:'rate_limited'});expect(report.checkpoint.attempts[0].finishedAt).toEqual(expect.any(String));
      expect(report.complete).toBe(false);expect(report.invocationComplete).toBe(true);expect(process.exitCode).toBe(1);
      if(suite==='creation')expect(report.summary.meteredThisInvocation).toEqual({attempts:1,succeeded:0,failed:1});
      const fields=suite==='base'?report.metadata.identityFields:report.metadata;
      expect(fields.modelProfile).toMatchObject({syntheticOnly:true,reasoning:{enabled:false}});
      const identityFields=suite==='base'?fields:Object.fromEntries(Object.entries(fields).filter(([key])=>['modelProfile','syntheticCandidate','fixtureStore','candidateSuite','datasetHash','promptHash','protocolHash','executionFiles','provider','model','timeoutMs','fallback'].includes(key)));
      expect(evaluationIdentity(identityFields)).toBe(report.checkpoint.identity);
      for(const changed of [{...identityFields,model:model===lightning?superVl:lightning},{...identityFields,modelProfile:{...fields.modelProfile,id:'changed'}}])expect(()=>readEvaluationCheckpoint(out,evaluationIdentity(changed),report.checkpoint.caseIds)).toThrow('does not match');
      expect(report.gates.humanReviewed).toBe(false);expect(report.gates.releaseApproved).toBe(false);
      for(const dependency of ['../src/ai/runtime-config.ts','../src/ai/usage-store.ts','../src/ai/cost.ts','../package.json','../pnpm-lock.yaml'])expect(Object.hasOwn(fields.executionFiles,dependency)).toBe(true);
      if(suite==='creation')expect(Object.hasOwn(fields.executionFiles,'../src/ai/llm.ts')).toBe(true);
      // Recover a valid pre-request checkpoint in place; it carries no prior calls or answers.
      const emptyCheckpoint=reportPath();writeFileSync(emptyCheckpoint,JSON.stringify({checkpoint:{...report.checkpoint,history:[],attempts:[]}}));
      fetchMock.mockClear();await runSyntheticCandidate([...args(model,suite),'--resume',emptyCheckpoint]);
      expect(fetchMock).toHaveBeenCalledTimes(1);expect(JSON.parse(readFileSync(emptyCheckpoint,'utf8')).summary).toMatchObject({attempts:1,completed:1,blockReason:'rate_limited'});
    }finally{process.exitCode=exitCode;}
  },30_000);
  it('原Baidu两个入口仍拒绝候选模型，不能用环境选择绕过专用入口',async()=>{
    cleanSyntheticEnvironment();vi.stubEnv('OPENROUTER_MODEL',lightning);const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    const {runBaseEvaluation}=await import('../evals/run.js');const {runCreationEvaluation}=await import('../evals/creation-run.js');
    await expect(runBaseEvaluation()).rejects.toThrow('user-specified');await expect(runCreationEvaluation()).rejects.toThrow('user-specified');expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('显式候选环境贯穿CLI、transport和fixture',()=>{
  it.each(['base','creation'])('%s 不读ambient凭据或PG测试库，只用传入env的合成key和内存库',async suite=>{
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_DATABASE_URL','postgres://unreachable.invalid/must-not-connect');vi.stubEnv('DATABASE_URL','postgres://unreachable.invalid/must-not-connect');vi.stubEnv('OPENROUTER_API_KEY','wrong-ambient-test-key');vi.stubEnv('AI_RUNTIME_CONFIG_PATH','/unreadable/runtime-must-not-read.json');
    const out=reportPath(),exitCode=process.exitCode;
    const fetchMock=vi.fn(async(_input:unknown,init?:RequestInit)=>{
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-isolated-test-key');
      return new Response(JSON.stringify({error:{message:'Synthetic stop',code:429}}),{status:429,headers:{'content-type':'application/json'}});
    });vi.stubGlobal('fetch',fetchMock);vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try{
      await runSyntheticCandidate([...args(lightning,suite),'--out',out],{OPENROUTER_API_KEY:'selected-isolated-test-key'});
      const report=JSON.parse(readFileSync(out,'utf8'));expect(fetchMock).toHaveBeenCalledTimes(1);expect(report.summary).toMatchObject({attempts:1,blockReason:'rate_limited'});
      expect(JSON.stringify(report)).not.toContain('selected-isolated-test-key');expect(JSON.stringify(report)).not.toContain('wrong-ambient-test-key');
    }finally{process.exitCode=exitCode;}
  },30_000);
  it.each([{DATABASE_URL:'postgres://forbidden.invalid/data',OPENROUTER_API_KEY:'irrelevant'},{}])('错误env在任何模型请求前拒绝 %#',async env=>{
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(runSyntheticCandidate([...args(),'--out',reportPath()],env)).rejects.toThrow();expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('候选报告路径保护不覆盖历史证据',()=>{
  it.each(['--out','--resume'])('%s 必须使用.json，拒绝Markdown同路径覆盖',async flag=>{
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(runSyntheticCandidate([...args(),flag,reportPath().replace(/\.json$/,'.md')],{OPENROUTER_API_KEY:'synthetic-key'})).rejects.toThrow('must end with .json');expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['.json','.md'])('初跑已存在%s时保留原始字节、零请求',async extension=>{
    const out=reportPath(), existing=out.replace(/\.json$/,extension), original='old-Baidu-evidence-bytes\n';writeFileSync(existing,original);
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(runSyntheticCandidate([...args(),'--out',out],{OPENROUTER_API_KEY:'synthetic-key'})).rejects.toThrow('overwrite');expect(fetchMock).not.toHaveBeenCalled();expect(readFileSync(existing,'utf8')).toBe(original);
  });
  it.each(['.json','.md'])('resume复制到已存在%s时保留旧Baidu文件、零请求',async extension=>{
    const source=reportPath(),out=reportPath(),existing=out.replace(/\.json$/,extension),original='old-Baidu-evidence-bytes\n';writeFileSync(source,'{}');writeFileSync(existing,original);
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(runSyntheticCandidate([...args(),'--resume',source,'--out',out],{OPENROUTER_API_KEY:'synthetic-key'})).rejects.toThrow('overwrite');expect(fetchMock).not.toHaveBeenCalled();expect(readFileSync(existing,'utf8')).toBe(original);expect(readFileSync(source,'utf8')).toBe('{}');
  });
  it('同路径恢复和复制到全新JSON/MD pair允许进入身份校验',()=>{
    const source=reportPath(),out=reportPath();writeFileSync(source,'checkpoint');writeFileSync(source.replace(/\.json$/,'.md'),'paired evidence');
    expect(()=>assertCandidateReportPaths(source,source)).not.toThrow();expect(()=>assertCandidateReportPaths(out,source)).not.toThrow();
  });
  it.each(['base','creation'])('%s 同路径旧Baidu身份不匹配，在写入及请求前拒绝',async suite=>{
    const source=reportPath(),original=JSON.stringify({checkpoint:{version:1,identity:'historical-baidu-checkpoint',caseIds:[],history:[],attempts:[]}});writeFileSync(source,original);writeFileSync(source.replace(/\.json$/,'.md'),'original markdown');
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(runSyntheticCandidate([...args(lightning,suite),'--resume',source],{OPENROUTER_API_KEY:'synthetic-key'})).rejects.toThrow('does not match');expect(fetchMock).not.toHaveBeenCalled();expect(readFileSync(source,'utf8')).toBe(original);expect(readFileSync(source.replace(/\.json$/,'.md'),'utf8')).toBe('original markdown');
  });
});
