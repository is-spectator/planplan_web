import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type EvalAttempt = { ordinal: number; caseId: string; startedAt: string; finishedAt?: string; httpStatus?: number; error?: string | null; usage?: unknown };
export type EvalHistory<T> = { segment: string; result: T };
export type EvaluationCheckpoint<T> = { version: 1; identity: string; caseIds: string[]; history: EvalHistory<T>[]; attempts: EvalAttempt[] };

/** Checkpoints identify executable inputs, not an unrelated uncommitted Git HEAD. */
export function evaluationIdentity(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function atomicEvaluationReport(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pending-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

export function readEvaluationCheckpoint<T extends { id: string; pass: boolean }>(path: string | undefined, identity: string, caseIds: string[]): EvaluationCheckpoint<T> {
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length) throw new Error('Evaluation case IDs must be unique and nonempty');
  if (!path) return { version: 1, identity, caseIds: [...caseIds], history: [], attempts: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { checkpoint?: EvaluationCheckpoint<T> };
  const c = raw.checkpoint;
  if (!c || c.version !== 1 || c.identity !== identity || JSON.stringify(c.caseIds) !== JSON.stringify(caseIds)) throw new Error('Checkpoint does not match the current complete dataset, model, prompt and executable inputs; historical results cannot be merged');
  if (!Array.isArray(c.history) || !Array.isArray(c.attempts)) throw new Error('Invalid evaluation checkpoint');
  const seen = new Set<string>();
  for (const row of c.history) {
    if (!row || typeof row.segment !== 'string' || !row.segment || !row.result || !caseIds.includes(row.result.id) || typeof row.result.pass !== 'boolean') throw new Error('Invalid case history');
    const key = `${row.segment}:${row.result.id}`;
    if (seen.has(key)) throw new Error('Duplicate result in one evaluation segment'); seen.add(key);
  }
  for (const [i, attempt] of c.attempts.entries()) {
    if (attempt.ordinal !== i + 1 || !caseIds.includes(attempt.caseId) || !Number.isFinite(Date.parse(attempt.startedAt))) throw new Error('Invalid attempt history');
    if (!attempt.finishedAt) throw new Error('Checkpoint contains an interrupted request with unknown outcome; preserve it and start an explicit new run instead of silently retrying');
    if (!Number.isFinite(Date.parse(attempt.finishedAt))) throw new Error('Invalid attempt completion');
  }
  return c;
}

export function latestEvaluationResults<T extends { id: string; pass: boolean }>(checkpoint: EvaluationCheckpoint<T>): T[] {
  const latest = new Map(checkpoint.history.map(row => [row.result.id, row.result]));
  return checkpoint.caseIds.flatMap(id => latest.has(id) ? [latest.get(id)!] : []);
}

/** Resuming skips all completed cases; retrying failures requires an explicit flag. */
export function remainingEvaluationIds<T extends { id: string; pass: boolean }>(checkpoint: EvaluationCheckpoint<T>, only?: string[], retryFailed = false): string[] {
  if (only?.some(id => !checkpoint.caseIds.includes(id))) throw new Error('Unknown evaluation case ID');
  const latest = new Map(latestEvaluationResults(checkpoint).map(result => [result.id, result]));
  const previouslyAttempted = new Set(checkpoint.attempts.map(attempt => attempt.caseId));
  return checkpoint.caseIds.filter(id => (!only || only.includes(id)) && ((!latest.has(id) && (!previouslyAttempted.has(id) || retryFailed)) || (retryFailed && latest.has(id) && !latest.get(id)!.pass)));
}

export function evaluationCoverage<T extends { id: string; pass: boolean }>(checkpoint: EvaluationCheckpoint<T>) {
  const latest = latestEvaluationResults(checkpoint), first = new Map<string, T>();
  for (const { result } of checkpoint.history) if (!first.has(result.id)) first.set(result.id, result);
  return { denominator: checkpoint.caseIds.length, completed: latest.length, passed: latest.filter(r => r.pass).length,
    failed: latest.filter(r => !r.pass).length, pending: checkpoint.caseIds.length - latest.length,
    firstResultPassed: [...first.values()].filter(r => r.pass).length, completedCaseRuns: checkpoint.history.length,
    explicitRetryCaseRuns: checkpoint.history.length - latest.length, attempts: checkpoint.attempts.length };
}
