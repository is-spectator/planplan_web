import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicEvaluationReport, evaluationCoverage, evaluationIdentity, latestEvaluationResults, readEvaluationCheckpoint, remainingEvaluationIds } from '../evals/checkpoint.js';

const dirs: string[] = [];
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'eval-checkpoint-test-')); dirs.push(dir); return join(dir, 'report.json'); };
const fresh = () => readEvaluationCheckpoint<{ id: string; pass: boolean }>(undefined, 'current', ['C1', 'C2', 'C3']);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('真实评测续跑证据', () => {
  it('子集和中断保留完整分母，已完成案例不自动重试', () => {
    const c = fresh(); c.history.push({ segment: 'one', result: { id: 'C1', pass: true } }, { segment: 'one', result: { id: 'C2', pass: false } });
    expect(remainingEvaluationIds(c)).toEqual(['C3']); expect(remainingEvaluationIds(c, undefined, true)).toEqual(['C2', 'C3']);
    expect(remainingEvaluationIds(c, ['C1'], true)).toEqual([]);
    expect(evaluationCoverage(c)).toMatchObject({ denominator: 3, completed: 2, passed: 1, failed: 1, pending: 1 });
  });
  it('显式失败复跑保留首错与各次结果，不能改写成一次全过', () => {
    const c = fresh(); c.history.push({ segment: 'one', result: { id: 'C1', pass: false } }, { segment: 'two', result: { id: 'C1', pass: true } });
    expect(latestEvaluationResults(c)).toEqual([{ id: 'C1', pass: true }]);
    expect(evaluationCoverage(c)).toMatchObject({ passed: 1, firstResultPassed: 0, explicitRetryCaseRuns: 1, denominator: 3 });
    const p = file(); atomicEvaluationReport(p, { checkpoint: c });
    expect(readEvaluationCheckpoint(p, 'current', c.caseIds).history).toHaveLength(2);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
  it('原子更新输出完整JSON，身份与历史内容保留', () => {
    const p = file(), c = fresh(); atomicEvaluationReport(p, { checkpoint: c });
    c.history.push({ segment: 'one', result: { id: 'C1', pass: true } }); atomicEvaluationReport(p, { checkpoint: c });
    expect(JSON.parse(readFileSync(p, 'utf8')).checkpoint.history).toHaveLength(1);
  });
  it.each(['changed-prompt', 'changed-model', 'changed-dataset'])('拒绝不匹配身份 %s', identity => {
    const p = file(); atomicEvaluationReport(p, { checkpoint: fresh() });
    expect(() => readEvaluationCheckpoint(p, identity, ['C1', 'C2', 'C3'])).toThrow('does not match');
  });
  it('旧报告没有可审计checkpoint时拒绝冒充当前同版本', () => {
    const p = file(); atomicEvaluationReport(p, { results: [{ id: 'C1', pass: true }] });
    expect(() => readEvaluationCheckpoint(p, 'current', ['C1', 'C2', 'C3'])).toThrow('historical');
  });
  it('未知网络结果不可静默重发，已结束429可以明确保留', () => {
    const p = file(), c = fresh(); c.attempts.push({ ordinal: 1, caseId: 'C1', startedAt: new Date().toISOString() }); atomicEvaluationReport(p, { checkpoint: c });
    expect(() => readEvaluationCheckpoint(p, 'current', c.caseIds)).toThrow('unknown outcome');
    c.attempts[0]!.finishedAt = new Date().toISOString(); c.attempts[0]!.error = 'rate_limited'; atomicEvaluationReport(p, { checkpoint: c });
    expect(readEvaluationCheckpoint(p, 'current', c.caseIds).attempts[0]!.error).toBe('rate_limited');
  });
  it('未知或重复案例和同段重复结果均拒绝', () => {
    expect(() => readEvaluationCheckpoint(undefined, 'x', ['C1', 'C1'])).toThrow('unique');
    const c = fresh(); expect(() => remainingEvaluationIds(c, ['missing'])).toThrow('Unknown');
    c.history.push({ segment: 'one', result: { id: 'C1', pass: true } }, { segment: 'one', result: { id: 'C1', pass: false } });
    const p = file(); atomicEvaluationReport(p, { checkpoint: c }); expect(() => readEvaluationCheckpoint(p, 'current', c.caseIds)).toThrow('Duplicate');
  });
  it('请求完成但案例结果未落盘时，恢复也需明确授权重跑', () => {
    const c = fresh(); c.attempts.push({ ordinal: 1, caseId: 'C1', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null });
    expect(remainingEvaluationIds(c)).toEqual(['C2', 'C3']);
    expect(remainingEvaluationIds(c, ['C1'], true)).toEqual(['C1']);
    expect(evaluationCoverage(c)).toMatchObject({ denominator: 3, completed: 0, pending: 3, attempts: 1 });
  });
  it('身份比较不受对象key顺序影响，执行输入变更会失效', () => {
    expect(evaluationIdentity({ a: 1, b: 2 })).toBe(evaluationIdentity({ b: 2, a: 1 }));
    expect(evaluationIdentity({ prompt: 'old' })).not.toBe(evaluationIdentity({ prompt: 'new' }));
  });
});
