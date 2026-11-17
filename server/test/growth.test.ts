import { describe, expect, it } from 'vitest';
import { undo } from '../src/services/engine.js';
import { chooseVariant, circleBoard, createCircle, growthView, joinCircle, leaveCircle, saveCaption, weeklyCard } from '../src/services/growth.js';
import { opId, setup } from './helpers.js';

// 2026-10-29 是周四。
const THU = '2026-10-29T12:00:00+08:00';

async function withPlans(c: Awaited<ReturnType<typeof setup>>) {
  await c.run('2026-10-01T09:00:00+08:00', { type: 'create_ledger' });
  const s = await c.run('2026-10-01T09:00:00+08:00', { type: 'create_study', activity: '阅读', name: '阅读', daysPerWeek: 5, minMinutes: 20 });
  return (s.items[0] as { plan: { id: string } }).plan.id;
}

const lunch = (date = '2026-10-29') => ({ type: 'add_expense' as const, amountCents: 2500, category: '餐饮' as const, date, note: '午饭' });

describe('行动力', () => {
  it('新增支出或学习记录各 +1，回执带上下一个解锁目标', async () => {
    const c = await setup();
    const studyId = await withPlans(c);
    const r = await c.run(THU, { type: 'add_study', planId: studyId, minutes: 20, date: '2026-10-29', note: '小王子' });
    expect(r.growth).toMatchObject({ earned: 1, total: 1, next: { key: 'desk', need: 4 } });
    expect(r.growth!.unlocked.map((u) => u.key)).toEqual(['lamp']);
    const r2 = await c.run(THU, lunch());
    expect(r2.growth).toMatchObject({ earned: 1, total: 2, unlocked: [] });
  });

  it('同一天前 5 条加分，之后正常保存但不再加分', async () => {
    const c = await setup();
    await withPlans(c);
    const r = await c.run(THU, lunch(), lunch(), lunch(), lunch(), lunch(), lunch(), lunch());
    expect(r.growth).toMatchObject({ earned: 5, total: 5 });
    expect(r.growth!.unlocked.map((u) => u.key)).toEqual(['lamp', 'desk']);
    const next = await c.run('2026-10-30T08:00:00+08:00', lunch('2026-10-30'));
    expect(next.growth).toMatchObject({ earned: 1, total: 6 });
  });

  it('修改、退款、撤销、建计划不加分；撤销也不扣分', async () => {
    const c = await setup();
    const created = await c.run(THU, { type: 'create_ledger' });
    expect(created.growth).toBeUndefined();
    const add = await c.run(THU, lunch());
    const rec = (add.items[0] as { record: { id: string } }).record.id;
    const edit = await c.run(THU, { type: 'edit_record', recordId: rec, patch: { amountCents: 3000 } });
    expect(edit.growth).toBeUndefined();
    const refund = await c.run(THU, { type: 'add_refund', expenseId: rec, amountCents: 500, date: '2026-10-29' });
    expect(refund.growth).toBeUndefined();
    const undone = await undo(c.db, c.at(THU), refund.operationId, opId());
    expect(undone.growth).toBeUndefined();
    const second = await c.run(THU, lunch());
    expect(second.growth).toMatchObject({ earned: 1, total: 2 });
    await undo(c.db, c.at(THU), second.operationId, opId());
    expect((await growthView(c.db, c.userId, '2026-10-29')).total).toBe(2);
  });

  it('技术重试返回同一份行动力结果，不重复发放', async () => {
    const c = await setup();
    await withPlans(c);
    const { execute } = await import('../src/services/engine.js');
    const id = opId();
    const a = await execute(c.db, c.at(THU), id, [lunch()]);
    const b = await execute(c.db, c.at(THU), id, [lunch()]);
    expect(b.growth).toEqual(a.growth);
    expect((await growthView(c.db, c.userId, '2026-10-29')).total).toBe(1);
  });

  it('跨过门槛时解锁，回忆引用触发解锁的那条记录；可挑选并更换样式', async () => {
    const c = await setup();
    const studyId = await withPlans(c);
    for (let d = 1; d <= 2; d++) await c.run(`2026-10-0${d}T10:00:00+08:00`, lunch(`2026-10-0${d}`), lunch(`2026-10-0${d}`), lunch(`2026-10-0${d}`), lunch(`2026-10-0${d}`), lunch(`2026-10-0${d}`));
    await c.run('2026-10-03T10:00:00+08:00', lunch('2026-10-03'), lunch('2026-10-03'), lunch('2026-10-03'), lunch('2026-10-03'));
    const r = await c.run('2026-10-03T21:00:00+08:00', { type: 'add_study', planId: studyId, minutes: 20, date: '2026-10-03', note: '小王子' });
    expect(r.growth).toMatchObject({ total: 15, unlocked: [{ key: 'plant', arrival: '你的第一盆植物到了', needsChoice: true }], next: { key: 'shelf', need: 15 } });

    const v = await growthView(c.db, c.userId, '2026-10-03');
    const plant = v.slots.find((s) => s.key === 'plant')!;
    expect(plant).toMatchObject({ unlocked: true, unlockedOn: '2026-10-03', needsChoice: true, memory: '你在记录阅读「小王子」 20 分钟时解锁了它。' });
    expect(v.slots.find((s) => s.key === 'lamp')!.memory).toBe('你在记下午饭 ¥25 时解锁了它。');
    expect(v.slots.find((s) => s.key === 'shelf')!.unlocked).toBe(false);

    const after = await chooseVariant(c.db, c.userId, 'plant', 'pothos');
    expect(after.find((s) => s.key === 'plant')).toMatchObject({ variant: 'pothos', variantName: '绿萝', needsChoice: false });
    await expect(chooseVariant(c.db, c.userId, 'plant', 'cactus')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(chooseVariant(c.db, c.userId, 'shelf', 'default')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('同行榜', () => {
  it('按本周有记录的天数排名，同天数并列；周中加入的人下周才入榜', async () => {
    const a = await setup();
    await withPlans(a);
    const db = a.db;
    const mk = async (name: string) => {
      const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name, ai_consent) VALUES ($1, true) RETURNING id`, [name]);
      const at = (iso: string) => ({ userId: u!.id, inputAt: new Date(iso), source: 'form' as const });
      const { execute } = await import('../src/services/engine.js');
      await execute(db, at('2026-10-26T08:00:00+08:00'), opId(), [{ type: 'create_ledger' }]);
      return { id: u!.id, rec: (iso: string) => execute(db, at(iso), opId(), [lunch(iso.slice(0, 10))]) };
    };
    // 周一建榜
    await createCircle(db, a.userId, '读书小组', '小明', '2026-10-26');
    const code = (await circleBoard(db, a.userId, '2026-10-26'))!.code;
    const b = await mk('b');
    const late = await mk('late');
    await joinCircle(db, b.id, code.toLowerCase(), '阿七', '2026-10-26');
    await joinCircle(db, late.id, code, '新人', '2026-10-28');
    await expect(joinCircle(db, b.id, code, '阿七', '2026-10-26')).rejects.toMatchObject({ code: 'circle_conflict' });

    for (const d of ['26', '27']) await a.run(`2026-10-${d}T12:00:00+08:00`, lunch(`2026-10-${d}`), lunch(`2026-10-${d}`));
    for (const d of ['26', '28']) await b.rec(`2026-10-${d}T12:00:00+08:00`);
    for (const d of ['28', '29']) await late.rec(`2026-10-${d}T12:00:00+08:00`);

    const board = (await circleBoard(db, a.userId, '2026-10-29'))!;
    expect(board.members.map((m) => [m.nickname, m.recordDays, m.rank, m.pendingFrom])).toEqual([
      ['小明', 2, 1, null],
      ['阿七', 2, 1, null],
      ['新人', 2, null, '2026-11-02'],
    ]);
    const next = (await circleBoard(db, a.userId, '2026-11-02'))!;
    expect(next.members.every((m) => m.rank === 1 && m.recordDays === 0)).toBe(true);

    expect((await growthView(db, a.userId, '2026-10-29')).circle).toMatchObject({ name: '读书小组', recordDays: 2, rank: 1, members: 3 });
    await leaveCircle(db, a.userId);
    expect(await circleBoard(db, a.userId, '2026-10-29')).toBeNull();
    expect((await circleBoard(db, b.id, '2026-10-29'))!.members.length).toBe(2);
  });

  it('昵称和名称要合法', async () => {
    const c = await setup();
    await expect(createCircle(c.db, c.userId, '', '小明', '2026-10-29')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createCircle(c.db, c.userId, '小组', '一二三四五六七八九十一二三', '2026-10-29')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(joinCircle(c.db, c.userId, 'NOPE00', '小明', '2026-10-29')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('每周拍立得', () => {
  it('只记录一天也能拿到周卡；满 3 天盖章；文案只来自真实记录，不含金额', async () => {
    const c = await setup();
    const studyId = await withPlans(c);
    const empty = await weeklyCard(c.db, c.userId, '2026-10-26');
    expect(empty.available).toBe(false);

    await c.run('2026-10-26T12:00:00+08:00', lunch('2026-10-26'));
    const one = await weeklyCard(c.db, c.userId, '2026-10-26');
    expect(one).toMatchObject({ available: true, recordDays: 1, stamp: false, range: '10月26日–11月1日' });
    expect(one.captionOptions).toContain('每一笔都好好记下了。');
    expect(one.captionOptions.some((x) => x.includes('阅读'))).toBe(false);

    await c.run('2026-10-27T21:00:00+08:00', { type: 'add_study', planId: studyId, minutes: 20, date: '2026-10-27' });
    await c.run('2026-10-29T12:00:00+08:00', lunch());
    const three = await weeklyCard(c.db, c.userId, '2026-10-26');
    expect(three).toMatchObject({ recordDays: 3, stamp: true });
    expect(three.captionOptions[0]).toBe('忙归忙，阅读也没落下。');
    expect(JSON.stringify(three)).not.toContain('25');

    // 下一周解锁的物品不出现在这一周的卡片上。
    for (let i = 0; i < 3; i++) await c.run(`2026-11-0${2 + i}T12:00:00+08:00`, lunch(`2026-11-0${2 + i}`), lunch(`2026-11-0${2 + i}`), lunch(`2026-11-0${2 + i}`), lunch(`2026-11-0${2 + i}`));
    const past = await weeklyCard(c.db, c.userId, '2026-10-26');
    expect(past.slots.find((s) => s.key === 'desk')).toMatchObject({ unlocked: false, variant: null });
    expect(past.slots.find((s) => s.key === 'lamp')!.unlocked).toBe(true);
    expect((await weeklyCard(c.db, c.userId, '2026-11-02')).slots.find((s) => s.key === 'desk')!.unlocked).toBe(true);

    await saveCaption(c.db, c.userId, '2026-10-26', '  慢慢来  ');
    expect((await weeklyCard(c.db, c.userId, '2026-10-26')).caption).toBe('慢慢来');
    await expect(saveCaption(c.db, c.userId, '2026-10-26', 'x'.repeat(31))).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
