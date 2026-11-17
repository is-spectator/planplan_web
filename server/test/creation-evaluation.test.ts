import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { FakeCreationLlm } from '../src/ai/creation.js';
import { CREATION_CASES, CREATION_DATASET } from '../evals/creation-cases.js';
import { runCreationCase, CreationRateBlocked } from '../evals/creation-run.js';

const proposal = () => ({ kind: 'proposal', reply: '可按日期记录步数并查看每日合计；确认后再保存模板。', definition: {
  name: '步数', description: '记录每天步数并查看当日合计。',
  configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }],
  recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'steps', label: '步数', type: 'integer', required: true, min: 0 }],
  metrics: [{ id: 'total', label: '步数合计', operation: 'sum', fieldId: 'steps', period: 'day' }], components: ['summary', 'records'],
  example: { config: { name: '我的步数', startDate: CREATION_DATASET.today }, record: { date: CREATION_DATASET.today, steps: 1000 } },
} });
describe('固定创作评测运行器的实际领域判定', () => {
  let db: Db;
  beforeAll(async () => { db = await openTestDb(); }); afterAll(async () => { await db.close(); });
  it('20个唯一用例固定分母，未伪造人工审批', () => {
    expect(CREATION_CASES).toHaveLength(20); expect(new Set(CREATION_CASES.map(c => c.id)).size).toBe(20);
    expect(CREATION_DATASET.review).toEqual({ status: 'draft', productReviewer: null, testReviewer: null, reviewedAt: null });
  });
  it('有效提案实际保存采用并记录，目标和事实分别验收', async () => {
    const result = await runCreationCase(CREATION_CASES[0]!, db, new FakeCreationLlm(proposal));
    expect(result, JSON.stringify(result.issues)).toMatchObject({ pass: true, domain: 'passed', wrongFactWrites: 0, domainEvidence: { plansAfterSave: 0, recordsAfterConfiguration: 0, explicitRecords: 2, metrics: [{ value: 5000 }] } });
  });
  it('合法schema但错误统计不能通过', async () => {
    const bad = proposal(); bad.definition.metrics[0]!.period = 'week';
    const result = await runCreationCase(CREATION_CASES[0]!, db, new FakeCreationLlm(() => bad));
    expect(result.pass).toBe(false); expect(result.issues.join(' ')).toContain('Expected one day/sum');
  });
  it('澄清检查无实例和事实；供应商阻断不能伪装通过', async () => {
    const result = await runCreationCase(CREATION_CASES[10]!, db, new FakeCreationLlm(() => ({ kind: 'clarify', reply: '你希望记录什么？', definition: null })));
    expect(result).toMatchObject({ pass: true, domainEvidence: { plans: 0, records: 0 } });
    const blocked = await runCreationCase(CREATION_CASES[10]!, db, { generate: async () => { throw new CreationRateBlocked('rate_limited'); } });
    expect(blocked).toMatchObject({ pass: false, status: 'blocked', domain: 'not_run' });
  });
  it('字段含义变更必须先澄清，另建替代字段不能冒充已确认的修改', async () => {
    const c = CREATION_CASES.find(c => c.id === 'C010')!;
    const clarify = await runCreationCase(c, db, new FakeCreationLlm(() => ({ kind: 'clarify', reply: '时长不能直接转成花费。是否保留现有阅读字段，另加独立的花费字段？', definition: null })));
    expect(clarify).toMatchObject({ pass: true, wrongFactWrites: 0, domainEvidence: { plans: 0, records: 0, definitionUnchangedByClarification: true } });
    const substituted = await runCreationCase(c, db, new FakeCreationLlm(() => ({ ...proposal(), reply: '已改为独立字段，旧字段保持原样。' })));
    expect(substituted.pass).toBe(false);
    expect(substituted.issues).toContain('turn 1: Expected clarify, got proposal');
    expect(substituted.wrongFactWrites).toBe(0);
  });
  it('杯容量未定时澄清替代记录方式，不生成计划或事实', async () => {
    const c = CREATION_CASES.find(c => c.id === 'C012')!;
    const result = await runCreationCase(c, db, new FakeCreationLlm(() => ({ kind: 'clarify', reply: '目前模板不能按杯容量自动换算。是否改为直接记录每次饮水的毫升数？', definition: null })));
    expect(result).toMatchObject({ pass: true, wrongFactWrites: 0, domainEvidence: { plans: 0, records: 0, definitionUnchangedByClarification: true } });
  });
  it('杯数与毫升双填及未参与计算的容量配置仍是未经确认的替代方案', async () => {
    const c = CREATION_CASES.find(c => c.id === 'C012')!;
    const result = await runCreationCase(c, db, new FakeCreationLlm(() => ({ kind: 'proposal', reply: '杯容量未定，先同时填写杯数和实际毫升。', definition: {
      name: '饮水', description: '同时记录杯数和实际毫升，按天汇总毫升。',
      configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'cupMl', label: '每杯容量', type: 'integer', unit: 'ml', required: false, min: 1 }],
      recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'cups', label: '杯数', type: 'integer', required: true, min: 1 }, { id: 'waterMl', label: '实际毫升', type: 'integer', unit: 'ml', required: true, min: 1 }],
      metrics: [{ id: 'total', label: '当日饮水量', operation: 'sum', fieldId: 'waterMl', period: 'day' }], components: ['summary', 'records'],
      example: { config: { name: '饮水', startDate: CREATION_DATASET.today }, record: { date: CREATION_DATASET.today, cups: 1, waterMl: 250 } },
    } })));
    expect(result).toMatchObject({ pass: false, domain: 'not_run', wrongFactWrites: 0 });
    expect(result.issues).toContain('turn 1: Expected clarify, got proposal');
    expect(result.steps[0]).toMatchObject({ status: 'failed', actual: 'proposal' });
  });
});
