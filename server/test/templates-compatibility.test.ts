import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { execute, undo, type Action, type ExecContext } from '../src/services/engine.js';
import { getPlanTemplate } from '../src/services/templates.js';
import { planCards, studyView } from '../src/services/views.js';
import { runQuery } from '../src/services/query.js';
import { buildExport } from '../src/services/export.js';
import { requestAccountDeletion, retryPendingDeletions } from '../src/services/deletion.js';

describe('模板目标与旧查询、视图、撤销、删除兼容', () => {
  let db: Db, userId: string, n = 0;
  const ctx = (day = '2026-11-16'): ExecContext => ({ userId, inputAt: new Date(`${day}T04:00:00Z`), source: 'form', templateCapability: true });
  const run = (actions: Action[], day?: string) => execute(db, ctx(day), `template-compat-${++n}`, actions);
  const setupReading = async () => {
    const adopted = await run([{ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 }], '2026-11-09');
    const id = adopted.templatePlan!.planId;
    await run([{ type: 'configure_reading_plan', planId: id, expectedVersion: 1, patch: { daysPerWeek: 5, minMinutes: 20, currentBook: '合成测试书' }, completeSetup: true }], '2026-11-09');
    return id;
  };
  const clearCurrent = async (id: string) => {
    const state = await getPlanTemplate(db, userId, id, '2026-11-16');
    return run([{ type: 'configure_reading_plan', planId: id, expectedVersion: state.config.version, patch: { minMinutes: null }, goalScope: 'current_only' }]);
  };
  beforeAll(async () => { db = await openTestDb(); });
  beforeEach(async () => { const [u] = await db.query<{ id: string }>('INSERT INTO users (dev_name) VALUES ($1) RETURNING id', [`template-compat-user-${++n}`]); userId = u!.id; });
  afterAll(async () => { await db.close(); });

  it('清除当周门槛后事实不变，详情/卡片/周查询一致且上周达标保留；导出不把占位整数当目标', async () => {
    const id = await setupReading();
    await run([{ type: 'add_study', planId: id, minutes: 25, date: '2026-11-10' }], '2026-11-10');
    await run([{ type: 'add_study', planId: id, minutes: 30, date: '2026-11-16' }]);
    await clearCurrent(id);
    const expected = { totalMinutes: 30, recordDays: 1, goalComplete: false, minMinutes: null, targetDays: null, metDays: null };
    const detail = await studyView(db, userId, id, '2026-11-16', '2026-11-16');
    expect(detail.stats).toMatchObject(expected);
    expect(detail.previous).toMatchObject({ totalMinutes: 25, recordDays: 1, goalComplete: true, minMinutes: 20, metDays: 1 });
    expect((await planCards(db, userId, '2026-11-16', 'active')).plans.find(p => p.plan.id === id)?.study).toMatchObject(expected);
    const query = { kind: 'study_progress' as const, plan_id: id, period: 'this_week' as const, from: null, to: null, category: null };
    expect(await runQuery(db, userId, query, '2026-11-16', null)).toMatchObject({ kind: 'study_week', stats: expected });
    expect(await runQuery(db, userId, { ...query, period: 'last_week' }, '2026-11-16', null)).toMatchObject({ kind: 'study_week', stats: { totalMinutes: 25, minMinutes: 20, metDays: 1 } });
    expect(await runQuery(db, userId, { ...query, period: 'this_month' }, '2026-11-16', null)).toMatchObject({ kind: 'study_range', totalMinutes: 55, recordDays: 2 });
    const zip = unzipSync(await buildExport(db, userId));
    const exported = JSON.parse(strFromU8(zip['plans.json']!));
    expect(exported.plans[0].rules.find((r: { cleared?: boolean }) => r.cleared)).toMatchObject({ param: 'min_minutes', value: null, from_period: '2026-11-16', to_period: '2026-11-16' });
    expect(strFromU8(zip['README.txt']!)).toContain('cleared=true');
  });

  it('旧set_goal撤销重新露出清除区段，配置版本前进；记录编辑/删除撤销不复活已清目标', async () => {
    const id = await setupReading();
    const saved = await run([{ type: 'add_study', planId: id, minutes: 25, date: '2026-11-16', note: '阅读位置：第35页' }]);
    const added = saved.items[0]; if (added?.type !== 'study_added') throw new Error('missing study record');
    await clearCurrent(id);
    const overridden = await run([{ type: 'set_goal', planId: id, param: 'min_minutes', value: 30, scope: 'current_and_future' }]);
    const beforeUndo = await getPlanTemplate(db, userId, id, '2026-11-16');
    expect(beforeUndo.config.minMinutes).toBe(30);
    await undo(db, ctx(), overridden.operationId, `template-undo-goal-${++n}`);
    const afterUndo = await getPlanTemplate(db, userId, id, '2026-11-16');
    expect(afterUndo.config.minMinutes).toBe(null);
    expect(afterUndo.config.nextWeekGoals?.minMinutes).toBe(20);
    expect(afterUndo.config.version).toBeGreaterThan(beforeUndo.config.version);
    await expect(run([{ type: 'configure_reading_plan', planId: id, expectedVersion: beforeUndo.config.version, patch: { currentBook: '旧页面写入' } }])).rejects.toMatchObject({ code: 'version_conflict' });
    const edit = await run([{ type: 'edit_record', recordId: added.record.id, expectedVersion: 1, patch: { minutes: 35 } }]);
    await undo(db, ctx(), edit.operationId, `template-undo-edit-${++n}`);
    const view = await studyView(db, userId, id, '2026-11-16', '2026-11-16');
    expect(view.stats).toMatchObject({ totalMinutes: 25, minMinutes: null, metDays: null });
    expect(view.records[0]).toMatchObject({ minutes: 25, note: '阅读位置：第35页' });
    const deletion = await run([{ type: 'delete_record', recordId: added.record.id, expectedVersion: view.records[0]!.version }]);
    await undo(db, ctx(), deletion.operationId, `template-undo-delete-${++n}`);
    expect((await studyView(db, userId, id, '2026-11-16', '2026-11-16')).stats).toMatchObject({ totalMinutes: 25, recordDays: 1, minMinutes: null, metDays: null });
  });

  it('账户删除清理暂时失败时模板写立即停止，重试清理移除绑定与幂等材料', async () => {
    const id = await setupReading();
    await clearCurrent(id);
    const state = await getPlanTemplate(db, userId, id, '2026-11-16');
    await db.exec('CREATE TABLE template_cleanup_blocker (user_id uuid REFERENCES users(id));');
    await db.query('INSERT INTO template_cleanup_blocker VALUES ($1)', [userId]);
    const job = await requestAccountDeletion(db, userId);
    expect(job.status).toBe('pending');
    await expect(run([{ type: 'configure_reading_plan', planId: id, expectedVersion: state.config.version, patch: { currentBook: '不应保存' } }])).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await db.query<{ current_book: string }>('SELECT current_book FROM plan_template_bindings WHERE plan_id=$1', [id]))[0]?.current_book).toBe('合成测试书');
    await db.exec('DROP TABLE template_cleanup_blocker');
    expect(await retryPendingDeletions(db)).toEqual({ completed: 1, pending: 0 });
    expect(await db.query('SELECT * FROM plan_template_bindings WHERE user_id=$1', [userId])).toEqual([]);
    expect(await db.query('SELECT * FROM template_operation_requests WHERE user_id=$1', [userId])).toEqual([]);
    expect(await db.query('SELECT * FROM goal_segments WHERE plan_id=$1', [id])).toEqual([]);
  });
});
