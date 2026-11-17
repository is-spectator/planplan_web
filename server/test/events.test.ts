import { expect, it } from 'vitest';
import type { Queryable } from '../src/db/db.js';
import { clarificationCategory, logEvent } from '../src/services/events.js';

function sink() {
  const received: unknown[][] = [];
  const q: Queryable = { query: async <T>(_sql: string, params: unknown[] = []) => { received.push(params); return [] as T[]; } };
  return { q, received };
}

it('追问中的金额、时长、名称仅归类，不进入事件', async () => {
  const { q, received } = sink();
  for (const issue of ['你说一共 72 分钟', '本月预算 1234 元', '私人计划名字', '缺少金额']) {
    await logEvent(q, 'clarification', { category: clarificationCategory(issue), items: 1 });
  }
  expect(received.map((r) => JSON.parse(r[1] as string))).toEqual([
    { category: 'other', items: 1 }, { category: 'other', items: 1 }, { category: 'other', items: 1 }, { category: 'amount', items: 1 },
  ]);
});

it('运行时拒绝多余原文、未知事件、错误枚举与非法数值', async () => {
  const { q, received } = sink();
  // 模拟不经过 TypeScript 的客户端/动态调用；测试不能依赖类型检查保护日志。
  const unsafe = logEvent as (q: Queryable, name: string, props: unknown) => Promise<void>;
  await unsafe(q, 'write_succeeded', { items: 1, types: ['expense_added'], amount: 12345, note: '私人备注' });
  await unsafe(q, 'clarification', { issue: '含有私人原文', items: 1 });
  await unsafe(q, 'model_failure', { kind: 'secret-provider-message', latencyMs: 12 });
  await unsafe(q, 'export', { recipient: 'private@example.test' });
  await unsafe(q, 'unreviewed_event', { text: '原文' });
  await unsafe(q, 'model_failure', { kind: 'timeout', latencyMs: Number.NaN });
  expect(received).toEqual([]);
  await logEvent(q, 'model_failure', { kind: 'timeout', latencyMs: 15 });
  expect(received).toEqual([['model_failure', JSON.stringify({ kind: 'timeout', latencyMs: 15 })]]);
});

it('事件数据库异常不会影响业务，也不向日志透出错误内容', async () => {
  const q: Queryable = { query: async () => { throw new Error('private provider payload'); } };
  await expect(logEvent(q, 'export', {})).resolves.toBeUndefined();
});
