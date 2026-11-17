import { expect, it } from 'vitest';
import { setup } from './helpers.js';
import { studyView } from '../src/services/views.js';

it('本周没有记录时，切换到历史周仍能导航回本周', async () => {
  const c = await setup();
  try {
    const result = await c.run('2026-10-01T10:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 4, minMinutes: 20 });
    const item = result.items[0]!;
    if (item.type !== 'plan_created') throw new Error('Expected a study plan');
    const current = await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-10-27');
    expect(current.weeks).toEqual(['2026-10-26', '2026-09-28']);
    expect(current.records).toEqual([]);
    const historical = await studyView(c.db, c.userId, item.plan.id, '2026-09-28', '2026-10-27');
    expect(historical.week).toBe('2026-09-28');
    expect(historical.weeks).toEqual(current.weeks);
    const selectedIndex = historical.weeks.indexOf(historical.week);
    expect(historical.weeks[selectedIndex - 1]).toBe('2026-10-26');
  } finally { await c.db.close(); }
});

it('下周开始的完整目标不提前计入；跨周后回看原周仍保留未开始状态和返回入口', async () => {
  const c = await setup();
  try {
    const result = await c.run('2026-10-31T10:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 4, minMinutes: 20, startNextWeek: true });
    const item = result.items[0]!;
    if (item.type !== 'plan_created') throw new Error('Expected a study plan');
    await c.run('2026-10-31T11:00:00+08:00', { type: 'add_study', planId: item.plan.id, minutes: 25, date: '2026-10-31' });
    const before = await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-10-31');
    expect(before.weeks).toEqual(['2026-10-26']);
    expect(before.stats).toMatchObject({ goalComplete: false, targetDays: null, metDays: null, totalMinutes: 25 });
    const historical = await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-11-03');
    expect(historical.plan.startDate).toBe('2026-11-02');
    expect(historical.weeks).toEqual(['2026-11-02', '2026-10-26']);
    expect(historical.stats).toMatchObject({ goalComplete: false, targetDays: null, metDays: null, totalMinutes: 25 });
    const current = await studyView(c.db, c.userId, item.plan.id, '2026-11-02', '2026-11-03');
    expect(current.stats).toMatchObject({ goalComplete: true, daysPerWeek: 4, minMinutes: 20, targetDays: 4 });
  } finally { await c.db.close(); }
});
