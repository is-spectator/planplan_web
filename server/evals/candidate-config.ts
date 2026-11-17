import { aiModelProfile, aiProviderConfig } from '../src/ai/provider.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASES } from './cases.js';
import { CREATION_CASES } from './creation-cases.js';

export const SYNTHETIC_CANDIDATE_MODELS = ['nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3.5-super-vl:free'] as const;
export type SyntheticCandidateModel = typeof SYNTHETIC_CANDIDATE_MODELS[number];
/** Fixed repository cases only. The full 330-case denominator and original oracle remain intact. */
export const SYNTHETIC_CANDIDATE_BASE_IDS = Object.freeze([
  'F001','F007','F035','F044','F050','F052','F060',
  'S001','S011','S015','S022',
  'G003','G005','G014','G022','G029','G030',
  'Q001','Q011','Q025','Q042','Q045',
  'A001','A012','A014','A039','A040',
  'C001','C007','C008','C021','C026','C032','C034','C037','C039',
  'K002','L001',
]);
export type SyntheticCandidateEvaluation = Readonly<{
  model: SyntheticCandidateModel;
  suite: 'base' | 'creation';
  intervalMs: number;
  out?: string;
  resume?: string;
}>;

/** A resumed checkpoint may be copied only to an unused JSON + Markdown pair. */
export function assertCandidateReportPaths(output: string, resume?: string) {
  if (!output.endsWith('.json') || (resume !== undefined && !resume.endsWith('.json'))) throw new Error('Candidate report and resume paths must end with .json');
  const sameResume = resume !== undefined && resolve(output) === resolve(resume);
  if (!sameResume && (existsSync(output) || existsSync(output.replace(/\.json$/, '.md')))) throw new Error('Refusing to overwrite existing candidate or historical evidence');
}

/** Never inherit a live/test database or a runtime configuration containing user inputs. */
export function assertSyntheticCandidateEnvironment(env: NodeJS.ProcessEnv) {
  for (const name of ['DATABASE_URL','TEST_DATABASE_URL','PGLITE_DATA_DIR','AI_RUNTIME_CONFIG_PATH','AI_FALLBACK_MODEL','AI_FALLBACK_PROVIDER','PGHOST','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE']) {
    if (env[name] !== undefined) throw new Error(`Synthetic candidate evaluation forbids ${name}`);
  }
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'production' || ['beta','production'].includes(env.DEPLOYMENT_ENV ?? '')) throw new Error('Synthetic candidate evaluation must run outside test and deployed environments');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  if (env.AI_PROVIDER !== undefined && env.AI_PROVIDER !== 'openrouter') throw new Error('Synthetic candidates require OpenRouter');
  if (env.OPENROUTER_BASE_URL !== undefined && env.OPENROUTER_BASE_URL !== 'https://openrouter.ai/api/v1') throw new Error('Synthetic candidates require the official OpenRouter endpoint');
  if (env.OPENROUTER_OUTPUT !== undefined && env.OPENROUTER_OUTPUT !== 'compact') throw new Error('Synthetic candidate evaluation uses compact output only');
}

/** No --input, --db, --only, custom endpoint, concurrency override or retry option exists. */
export function parseSyntheticCandidateArgs(args: readonly string[], env: NodeJS.ProcessEnv): SyntheticCandidateEvaluation {
  const allowed = new Set(['--model','--suite','--interval-ms','--out','--resume']);
  const values = new Map<string,string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!allowed.has(name) || values.has(name) || value === undefined || !value.trim() || value.startsWith('--')) throw new Error('Invalid or duplicate synthetic candidate option');
    values.set(name,value);
  }
  const model=values.get('--model'), suite=values.get('--suite'), intervalMs=Number(values.get('--interval-ms')??4000);
  if (!SYNTHETIC_CANDIDATE_MODELS.some(item=>item===model)) throw new Error('Unsupported synthetic candidate model');
  if (suite !== 'base' && suite !== 'creation') throw new Error('Synthetic candidate suite must be base or creation');
  if (!Number.isInteger(intervalMs) || intervalMs < 4000 || intervalMs > 60000) throw new Error('Candidate interval-ms must be 4000–60000');
  assertSyntheticCandidateEnvironment(env);
  const value: SyntheticCandidateEvaluation = Object.freeze({model:model as SyntheticCandidateModel,suite,intervalMs,...(values.has('--out')?{out:values.get('--out')!}:{}),...(values.has('--resume')?{resume:values.get('--resume')!}:{})});
  candidateConfiguration(value,env);
  return value;
}

export function candidateConfiguration(candidate: SyntheticCandidateEvaluation, env: NodeJS.ProcessEnv) {
  assertSyntheticCandidateEnvironment(env);
  if (!SYNTHETIC_CANDIDATE_MODELS.includes(candidate.model) || !['base','creation'].includes(candidate.suite) || !Number.isInteger(candidate.intervalMs) || candidate.intervalMs<4000 || candidate.intervalMs>60000) throw new Error('Invalid synthetic candidate configuration');
  if (candidate.out || candidate.resume) assertCandidateReportPaths(candidate.out ?? candidate.resume!, candidate.resume);
  const profile=aiModelProfile('openrouter',candidate.model);
  if (!profile.syntheticOnly) throw new Error('Candidate model must have an explicit synthetic-only profile');
  // Only the API credential crosses from the supplied environment. Model/base URL/output are fixed here.
  const runtimeEnv: NodeJS.ProcessEnv={AI_PROVIDER:'openrouter',OPENROUTER_MODEL:candidate.model,OPENROUTER_BASE_URL:'https://openrouter.ai/api/v1',OPENROUTER_OUTPUT:'compact',OPENROUTER_API_KEY:env.OPENROUTER_API_KEY};
  return {config:aiProviderConfig(runtimeEnv),profile,runtimeEnv};
}

export function candidateCaseIds(suite:'base'|'creation'): readonly string[] {
  return suite==='base'?SYNTHETIC_CANDIDATE_BASE_IDS:CREATION_CASES.map(c=>c.id);
}
export function candidateRequestUpper(suite:'base'|'creation'): number {
  if(suite==='creation')return CREATION_CASES.reduce((n,c)=>n+c.steps.length,0);
  return SYNTHETIC_CANDIDATE_BASE_IDS.reduce((n,id)=>{const c=CASES.find(c=>c.id===id);if(!c)throw new Error(`Missing fixed candidate case ${id}`);return n+1+(c.followUps?.length??0);},0);
}
export function candidateRunnerArgs(candidate:SyntheticCandidateEvaluation): string[] {
  return ['--only',candidateCaseIds(candidate.suite).join(','),'--interval-ms',String(candidate.intervalMs),'--max-requests',String(candidateRequestUpper(candidate.suite)),...(candidate.out?['--out',candidate.out]:[]),...(candidate.resume?['--resume',candidate.resume]:[])];
}
