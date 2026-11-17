/** Synthetic-only candidate transport entry. It never invokes an application factory or changes the default model. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSyntheticCandidateArgs } from './candidate-config.js';

export async function runSyntheticCandidate(args:readonly string[],env:NodeJS.ProcessEnv=process.env) {
  const candidate=parseSyntheticCandidateArgs(args,env);
  // These runners use repository-owned cases and disposable in-memory PGlite only.
  // One explicit suite is executed; no retry, alternate provider or next model is launched automatically.
  if(candidate.suite==='base'){
    const {runBaseEvaluation}=await import('./run.js');
    await runBaseEvaluation(candidate,env);
  }else{
    const {runCreationEvaluation}=await import('./creation-run.js');
    await runCreationEvaluation(candidate,env);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await runSyntheticCandidate(process.argv.slice(2));
