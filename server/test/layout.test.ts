import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { Chat } from '../src/services/chat.js';
import { componentOrder, planView } from '../src/services/views.js';
import { getPlan } from '../src/services/repo.js';
import { undo } from '../src/services/engine.js';
import { INPUT_AT, makeFixture } from '../evals/fixtures.js';
import { CASES } from '../evals/cases.js';
import { runCase } from '../evals/runner.js';

const layoutTurn = (planId: string, order: string[]) => sanitizeTurn({ intent: 'write', writes: [{ op: 'reorder_components', is_fact: false, plan_id: planId, component_order: order }] })!;

describe('有限组件排序', () => {
  it('补齐遗漏组件、去除重复/无效组件并固定关键区域', () => {
    expect(componentOrder('ledger', ['records', 'records', 'unknown', 'budget', 'trend'])).toEqual(['summary', 'budget', 'records', 'trend', 'categories']);
    expect(componentOrder('study', ['records', 'goal'])).toEqual(['goal', 'calendar', 'records', 'minutes']);
    expect(componentOrder('study', 'invalid')).toEqual(['goal', 'calendar', 'minutes', 'records']);
  });

  it('对话排序保留隐藏状态和所有事实，可撤销到原布局', async () => {
    const fx = await makeFixture('default');
    try {
      const before = await fx.db.query('SELECT id, amount_cents, minutes, deleted FROM records ORDER BY id');
      await fx.db.query('UPDATE plans SET view_config = $2 WHERE id = $1', [fx.plans.ledger, JSON.stringify({ hidden: ['trend'], order: [] })]);
      const chat = new Chat(fx.db, new FakeLlm(() => layoutTurn(fx.plans.ledger!, ['records', 'categories', 'trend'])));
      const response = await chat.send(fx.userId, { clientMsgId: 'layout-request', inputAt: INPUT_AT, text: '日常记账先记录再分类和趋势' });
      const receipt = response.assistant.cards.find((c) => c.type === 'receipt');
      expect(receipt?.type).toBe('receipt');
      const plan = planView(await getPlan(fx.db, fx.userId, fx.plans.ledger!));
      expect(plan.order).toEqual(['summary', 'budget', 'records', 'categories', 'trend']);
      expect(plan.hidden).toEqual(['trend']);
      expect(await fx.db.query('SELECT id, amount_cents, minutes, deleted FROM records ORDER BY id')).toEqual(before);
      await undo(fx.db, { userId: fx.userId, inputAt: INPUT_AT, source: 'chat' }, receipt!.operationId, 'undo-layout');
      expect(planView(await getPlan(fx.db, fx.userId, fx.plans.ledger!)).order).toEqual(['summary', 'budget', 'categories', 'trend', 'records']);
    } finally { await fx.db.close(); }
  });

  it.each([
    { order: ['categories'] }, { order: ['records', 'records'] }, { order: ['goal', 'records'] },
  ])('学习计划拒绝非法/重复排序 $order，先追问不写配置', async ({ order }) => {
      const fx = await makeFixture('default');
      try {
        const before = await getPlan(fx.db, fx.userId, fx.plans.read!);
        const chat = new Chat(fx.db, new FakeLlm(() => layoutTurn(fx.plans.read!, order)));
        const reply = await chat.send(fx.userId, { clientMsgId: 'invalid-layout', inputAt: INPUT_AT, text: '调整阅读页面' });
        expect(reply.assistant.cards.some((c) => c.type === 'clarify')).toBe(true);
        expect((await getPlan(fx.db, fx.userId, fx.plans.read!)).view_config).toEqual(before.view_config);
      } finally { await fx.db.close(); }
  });

  it.each(['L001', 'L002', 'L003'])('评测%s核对实际顺序，不接受仅改变了页面', async (id) => {
    const c = CASES.find((c) => c.id === id)!;
    const study = id === 'L002';
    const llm = (wrong = false) => new FakeLlm((_text, system) => {
      const plan = system.match(new RegExp(`id=([a-f0-9-]+) 类型=${study ? '学习' : '记账'} 名称=${study ? '阅读' : '日常记账'}`))![1];
      const order = wrong ? (study ? ['minutes', 'records'] : ['categories', 'trend', 'records']) : id === 'L001' ? ['trend', 'categories', 'records'] : study ? ['records', 'minutes'] : ['records', 'categories', 'trend'];
      return layoutTurn(plan!, order);
    });
    expect((await runCase(c, 0, llm())).pass).toBe(true);
    expect((await runCase(c, 0, llm(true))).pass).toBe(false);
  });
});
