import type { Result } from './runner.js';

/** 所有调用失败仍留在分母；空集不能证明质量达标。 */
export function assessGates(results: Result[]) {
  const key = results.filter((r) => ['records', 'plan', 'goal', 'edit', 'delete', 'undo', 'plan_update'].includes(r.c.expect.kind));
  const clear = results.filter((r) => r.c.expect.kind === 'records' && r.c.expect.clear !== false);
  const guard = results.filter((r) => ['no_write', 'clarify', 'query'].includes(r.c.expect.kind));
  const queries = results.filter((r) => r.c.expect.kind === 'query');
  const wrongWrites = guard.reduce((n, r) => n + r.wrongFactWrites, 0);
  const keyRate = key.length ? key.filter((r) => r.pass).length / key.length : 0;
  const oneTurnRate = clear.length ? clear.filter((r) => r.pass && r.executedOneTurn).length / clear.length : 0;
  const queryPassed = queries.filter((r) => r.pass).length;
  return {
    keyRate, oneTurnRate, wrongWrites, queryPassed, queryTotal: queries.length,
    passed: key.length > 0 && clear.length > 0 && guard.length > 0 && queries.length > 0 && keyRate >= 0.98 && oneTurnRate >= 0.9 && wrongWrites === 0 && queryPassed === queries.length && guard.every((r) => r.pass),
  };
}
