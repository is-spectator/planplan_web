import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';
import { execute, type Action, type ExecContext } from '../src/services/engine.js';
import { executeForm } from '../src/services/form-operations.js';
import { exportTemplatePlans, getPlanTemplate, listAvailableTemplates } from '../src/services/templates.js';
import { buildExport } from '../src/services/export.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { studyView } from '../src/services/views.js';
import { templateDefinitionSchema, type ConfigureReadingAction } from '../src/templates/contracts.js';
import { TEMPLATE_DEFINITIONS, READING_TEMPLATE, LEDGER_TEMPLATE, WATER_TEMPLATE } from '../src/templates/definitions.js';
import { MAX_EXPENSE_CENTS } from '../src/domain/money.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';

describe('模板定义契约', () => {
  it('三个官方定义与既有金额/分钟限制一致，账本明确支出与退款口径', () => {
    for (const d of TEMPLATE_DEFINITIONS) expect(templateDefinitionSchema.parse(d)).toEqual(d);
    expect(LEDGER_TEMPLATE.recordFields.find(f => f.id === 'amountCents')?.max).toBe(MAX_EXPENSE_CENTS);
    expect(LEDGER_TEMPLATE.configurationFields[0]?.max).toBe(MAX_EXPENSE_CENTS);
    expect(LEDGER_TEMPLATE.recordFields.find(f => f.id === 'recordRole')?.options).toEqual(['expense', 'refund']);
    expect(LEDGER_TEMPLATE.metrics[0]?.sourceRule).toBe('ledger_expenses');
  });
  it.each([
    (d: any) => { d.requiredCapabilities = ['execute-javascript']; },
    (d: any) => { d.example.record.date = '2026-02-31'; },
    (d: any) => { d.recordFields[0].min = 1; },
    (d: any) => { d.recordFields[1].maxLength = 20; },
    (d: any) => { d.recordFields[1].unit = 'CNY_cent'; },
    (d: any) => { d.recordFields[1].options = ['a']; },
    (d: any) => { d.recordFields[1].max = 0; },
    (d: any) => { d.metrics[0].fieldId = 'unknown'; },
    (d: any) => { d.components = ['summary']; },
    (d: any) => { d.example.record.minutes = 1441; },
    (d: any) => { d.recordFields.push(d.recordFields[0]); },
    (d: any) => { d.recordFields[1].type = 'text'; delete d.recordFields[1].unit; d.metrics = [{ id: 'bad', label: '非法目标', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'currentBook', period: 'day' }]; },
  ])('拒绝未知能力、坏字段、非法日期和指标组合 %#', change => {
    const d = structuredClone(READING_TEMPLATE); change(d);
    expect(templateDefinitionSchema.safeParse(d).success).toBe(false);
  });
  it('饮水是整数毫升，未实现能力不能因为定义合法就变成可执行', () => {
    expect(WATER_TEMPLATE.engine).toBe('generic');
    const d = structuredClone(WATER_TEMPLATE); d.example.record.amountMl = 0.5;
    expect(templateDefinitionSchema.safeParse(d).success).toBe(false);
  });
  it('退款定义保留与原支出的关联；累计金额不能混淆支出和退款', () => {
    const d = structuredClone(LEDGER_TEMPLATE); d.example.record.recordRole = 'refund';
    expect(templateDefinitionSchema.safeParse(d).success).toBe(false);
    d.example.record.refundOf = '00000000-0000-4000-8000-000000000001';
    expect(templateDefinitionSchema.safeParse(d).success).toBe(true);
    delete d.metrics[0]!.sourceRule;
    expect(templateDefinitionSchema.safeParse(d).success).toBe(false);
  });
});

describe('模板事务、配置与恢复', () => {
  let db: Db, userId: string, n = 0;
  const at = (day = '2026-11-16'): ExecContext => ({ userId, inputAt: new Date(`${day}T04:00:00Z`), source: 'form', templateCapability: true });
  const run = (actions: Action[], id = `template-${++n}`, day?: string) => executeForm(db, at(day), id, actions, { inputAtProvided: true });
  const adopt = () => run([{ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 }]);
  const configure = async (planId: string, patch: ConfigureReadingAction['patch'], extra: Partial<ConfigureReadingAction> = {}, day = '2026-11-16') => {
    const current = await getPlanTemplate(db, userId, planId, day);
    return run([{ type: 'configure_reading_plan', planId, expectedVersion: current.config.version, patch, ...extra }], undefined, day);
  };
  beforeAll(async () => { db = await openTestDb(); });
  beforeEach(async () => { const [u] = await db.query<{ id: string }>('INSERT INTO users (dev_name) VALUES ($1) RETURNING id', [`template-user-${++n}`]); userId = u!.id; });
  afterAll(async () => { await db.close(); });

  it('目录开放三个已实现模板；版本不可覆盖；未知能力版本不可选用', async () => {
    expect((await listAvailableTemplates(db)).map(d => d.id)).toEqual(['official.ledger','official.reading','official.water']);
    await expect(db.query(`UPDATE template_versions SET definition='{}' WHERE template_id='official.reading'`)).rejects.toThrow('immutable');
    await expect(adopt()).resolves.toMatchObject({ templatePlan: { templateId: 'official.reading' } });
    await expect(run([{ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 }])).rejects.toMatchObject({ code: 'invalid_input' });
    const sentinel = new Error('test rollback');
    await expect(db.tx(async q => {
      await q.query('INSERT INTO template_versions (template_id,version,definition) VALUES ($1,2,$2)', ['official.reading', JSON.stringify({ ...READING_TEMPLATE, version: 2, requiredCapabilities: ['reading-template-v1', 'generic-record-v1'] })]);
      expect((await listAvailableTemplates(q)).map(d=>d.id)).toEqual(['official.ledger','official.water']);
      throw sentinel;
    })).rejects.toBe(sentinel);
  });

  it('选用原子提交，重试返回同一个实例；明确再选用可新建且名称唯一', async () => {
    const action: Action = { type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 };
    const id = `adopt-repeat-${++n}`;
    const [first, retry] = await Promise.all([run([action], id), run([action], id)]);
    expect(first.operationId).toBe(retry.operationId);
    expect(first.templatePlan?.config).toMatchObject({ setupStatus: 'pending', currentBook: null, daysPerWeek: null });
    expect(first.undoable).toBe(false);
    const second = await adopt();
    expect(second.templatePlan?.planId).not.toBe(first.templatePlan?.planId);
    expect(second.templatePlan?.config.name).not.toBe(first.templatePlan?.config.name);
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [userId])).toEqual([]);
    await expect(run([{ ...action, templateVersion: 2 }], id)).rejects.toMatchObject({ code: 'operation_changed' });
    await expect(run([{ type: 'create_study', name: '其他' }], id)).rejects.toMatchObject({ code: 'operation_changed' });
  });

  it('普通操作的旧ID不能用于选用，模板同ID改变输入时间也拒绝', async () => {
    const id = `old-operation-${++n}`;
    await run([{ type: 'create_study', name: '旧计划' }], id);
    await expect(run([{ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 }], id)).rejects.toMatchObject({ code: 'operation_changed' });
    const created = await adopt();
    await expect(run([{ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 }], created.clientOpId, '2026-11-17')).rejects.toMatchObject({ code: 'operation_changed' });
  });

  it('能力限制/混批/跨账户均在写入前拒绝', async () => {
    const action: Action = { type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 };
    await expect(execute(db, { ...at(), templateCapability: false }, `unsupported-${++n}`, [action])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(run([action, { type: 'create_study', name: '不能部分保存' }])).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [userId])).toEqual([]);
    const created = await adopt();
    await expect(getPlanTemplate(db, '00000000-0000-4000-8000-000000000000', created.templatePlan!.planId, '2026-11-16')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('设置与事实分离，跳过目标可就绪，版本冲突不覆盖；外部改名也使配置版本失效', async () => {
    const created = await adopt(), planId = created.templatePlan!.planId;
    const configured = await configure(planId, { name: '我的书单', currentBook: '置身事内', daysPerWeek: 5, minMinutes: 20 }, { completeSetup: true });
    expect(configured.templatePlan?.config).toMatchObject({ name: '我的书单', setupStatus: 'ready', currentBook: '置身事内', daysPerWeek: 5, minMinutes: 20 });
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [userId])).toEqual([]);
    await expect(run([{ type: 'configure_reading_plan', planId, expectedVersion: 1, patch: { currentBook: '错误覆盖' } }])).rejects.toMatchObject({ code: 'version_conflict' });
    await run([{ type: 'rename_plan', planId, name: '另一设备修改' }]);
    await expect(run([{ type: 'configure_reading_plan', planId, expectedVersion: configured.templatePlan!.config.version, patch: {} }])).rejects.toMatchObject({ code: 'version_conflict' });
    const empty = await adopt();
    const ready = await configure(empty.templatePlan!.planId, {}, { completeSetup: true });
    expect(ready.templatePlan?.config).toMatchObject({ setupStatus: 'ready', daysPerWeek: null, minMinutes: null });
  });

  it('当前周清目标保留过去及未来；下周清目标立即可见且可由既有目标操作重新设置', async () => {
    const created = await run([{ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 }], undefined, '2026-11-09');
    const planId = created.templatePlan!.planId;
    await configure(planId, { daysPerWeek: 5, minMinutes: 20 }, { completeSetup: true }, '2026-11-09');
    await configure(planId, { minMinutes: null }, { goalScope: 'current_only' });
    expect((await getPlanTemplate(db, userId, planId, '2026-11-09')).config.minMinutes).toBe(20);
    expect((await getPlanTemplate(db, userId, planId, '2026-11-16')).config.minMinutes).toBe(null);
    expect((await getPlanTemplate(db, userId, planId, '2026-11-23')).config.minMinutes).toBe(20);
    const future = await configure(planId, { daysPerWeek: null }, { goalScope: 'next_and_future' });
    expect(future.templatePlan?.config).toMatchObject({ daysPerWeek: 5, nextWeekGoals: { startsOn: '2026-11-23', daysPerWeek: null, minMinutes: 20 } });
    await run([{ type: 'set_goal', planId, param: 'days_per_week', value: 4, scope: 'current_and_future' }], undefined, '2026-11-23');
    expect((await getPlanTemplate(db, userId, planId, '2026-11-23')).config.daysPerWeek).toBe(4);
  });

  it('日期只可在未开始配置/记录的待完善计划改变；归档不能设置', async () => {
    const planId = (await adopt()).templatePlan!.planId;
    await configure(planId, { startDate: '2026-11-01' });
    expect((await getPlanTemplate(db, userId, planId, '2026-11-16')).config.startDate).toBe('2026-11-01');
    await expect(configure(planId, { startDate: '2026-11-17' })).rejects.toMatchObject({ code: 'invalid_input' });
    await configure(planId, {}, { completeSetup: true });
    await expect(configure(planId, { startDate: '2026-11-02' })).rejects.toMatchObject({ code: 'invalid_input' });
    await run([{ type: 'archive_plan', planId }]);
    await expect(configure(planId, { currentBook: '书籍' })).rejects.toMatchObject({ code: 'plan_archived' });
  });

  it('无inputAt的同体重试不因服务端时钟变化而重复；失败设置事务不留部分名称或hash', async () => {
    const id = `no-input-at-${++n}`, action: Action = { type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 };
    const created = await executeForm(db, at(), id, [action], { inputAtProvided: false });
    const retry = await executeForm(db, at('2026-11-17'), id, [action], { inputAtProvided: false });
    expect(retry.operationId).toBe(created.operationId);
    const planId = created.templatePlan!.planId;
    await run([{ type: 'add_study', planId, minutes: 25, date: '2026-11-16' }]);
    const current = await getPlanTemplate(db, userId, planId, '2026-11-16');
    const failedId = `failed-config-${++n}`;
    await expect(run([{ type: 'configure_reading_plan', planId, expectedVersion: current.config.version, patch: { name: '不得留下', startDate: '2026-11-01' } }], failedId)).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await getPlanTemplate(db, userId, planId, '2026-11-16')).config.name).toBe(current.config.name);
    expect(await db.query('SELECT * FROM template_operation_requests WHERE user_id=$1 AND client_op_id=$2', [userId, failedId])).toEqual([]);
    expect(await db.query('SELECT * FROM operations WHERE user_id=$1 AND client_op_id=$2', [userId, failedId])).toEqual([]);
  });

  it('阅读25改35后备注、目标、导出一致；账户删除级联清理私人模板材料', async () => {
    const planId = (await adopt()).templatePlan!.planId;
    await configure(planId, { currentBook: '置身事内', daysPerWeek: 5, minMinutes: 20 }, { completeSetup: true });
    const saved = await run([{ type: 'add_study', planId, minutes: 25, date: '2026-11-16', note: '书名：置身事内\n阅读位置：第 35 页' }]);
    const item = saved.items[0]; if (item?.type !== 'study_added') throw new Error('expected record');
    await run([{ type: 'edit_record', recordId: item.record.id, expectedVersion: 1, patch: { minutes: 35 } }]);
    const view = await studyView(db, userId, planId, '2026-11-16', '2026-11-16');
    expect(JSON.stringify(view)).toContain('35');
    const zip = unzipSync(await buildExport(db, userId));
    expect(strFromU8(zip['study.csv']!)).toContain('书名：置身事内');
    expect(strFromU8(zip['templates.json']!)).toContain('official.reading');
    await requestAccountDeletion(db, userId);
    expect(await db.query('SELECT * FROM plan_template_bindings WHERE user_id=$1', [userId])).toEqual([]);
    expect(await db.query('SELECT * FROM template_operation_requests WHERE user_id=$1', [userId])).toEqual([]);
    expect(await listAvailableTemplates(db)).toHaveLength(3);
  });
});

describe('模板迁移兼容', () => {
  it('隔离磁盘库关闭重开后版本、配置、目标和原操作可恢复', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'planplan-template-test-'));
    const url = `pglite://${directory}/db`;
    let db: Db | undefined;
    try {
      db = await openDb(url);
      const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('persistent-reading') RETURNING id`);
      const ctx: ExecContext = { userId: u!.id, inputAt: new Date('2026-11-16T04:00:00Z'), source: 'form', templateCapability: true };
      const a: Action = { type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 };
      const created = await execute(db, ctx, 'persistent-adopt', [a]);
      const planId = created.templatePlan!.planId;
      await execute(db, ctx, 'persistent-config', [{ type: 'configure_reading_plan', planId, expectedVersion: 1, completeSetup: true, patch: { currentBook: '合成测试书', daysPerWeek: 5, minMinutes: 20 } }]);
      const before = await getPlanTemplate(db, u!.id, planId, '2026-11-16');
      await db.close(); db = await openDb(url);
      expect(await getPlanTemplate(db, u!.id, planId, '2026-11-16')).toEqual(before);
      expect((await execute(db, ctx, 'persistent-adopt', [a])).operationId).toBe(created.operationId);
      expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [u!.id])).toHaveLength(1);
    } finally { await db?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
  it('旧数据仅新增关联，重复迁移安全，旧study保持独立legacy来源', async () => {
    const db = await openTestDb({ migrations: 'none' });
    try {
      await migrate(db, MIGRATIONS.slice(0, 10));
      const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('template-legacy') RETURNING id`);
      const [p] = await db.query<{ id: string }>(`INSERT INTO plans (user_id,kind,name,activity,start_date) VALUES ($1,'study','英语','英语','2026-10-01') RETURNING id`, [u!.id]);
      await db.query(`INSERT INTO goal_segments (plan_id,param,value,from_period) VALUES ($1,'min_minutes',30,'2026-09-28')`, [p!.id]);
      const before = await db.query('SELECT id,user_id,kind,name,activity,start_date,status,view_config,created_at,last_activity_at FROM plans');
      await migrate(db); await migrate(db);
      expect(await db.query('SELECT id,user_id,kind,name,activity,start_date,status,view_config,created_at,last_activity_at FROM plans')).toEqual(before);
      const state = await getPlanTemplate(db, u!.id, p!.id, '2026-11-16');
      expect(state).toMatchObject({ templateId: 'legacy.study', source: 'legacy', config: { name: '英语', currentBook: null, minMinutes: 30 } });
      expect(await exportTemplatePlans(db, u!.id, '2026-11-16')).toHaveLength(1);
      expect(await db.query('SELECT plan_id FROM plan_template_bindings')).toHaveLength(1);
    } finally { await db.close(); }
  });
});
