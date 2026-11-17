import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLlm, OpenAICompatibleLlm } from '../src/ai/llm.js';
import type { Turn, TurnWrite, TurnGenericField } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, undo, type Action } from '../src/services/engine.js';
import { genericSummary } from '../src/services/generic.js';
import { getPlanTemplate } from '../src/services/templates.js';
import { WATER_TEMPLATE } from '../src/templates/definitions.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { setup } from './helpers.js';
const T = new Date('2026-11-16T12:00:00+08:00'), today = '2026-11-16';
const field = (value: TurnGenericField['value'], unit: string | null = 'ml', patch: Partial<TurnGenericField> = {}): TurnGenericField => ({ field_id: 'amountMl', value, unit, unit_size: null, unit_size_unit: null, ...patch });
const w = (op: TurnWrite['op'], patch: Partial<TurnWrite> = {}): TurnWrite => ({ op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...patch });
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
const script = (map: Record<string, Partial<Turn>>) => new FakeLlm(text => map[text] ?? { intent: 'smalltalk', reply: '收到。' });
async function scenario() {
  const c = await setup();
  const context = { ...c.at(T.toISOString()), templateCapability: true, ledgerTemplateCapability: true, genericCapability: true };
  const run = (...actions: Action[]) => execute(c.db, context, randomUUID(), actions);
  const water = (await run({ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 })).templatePlan!;
  const send = (chat: Chat, text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: T, scopePlanId: water.planId, templateCapability: true, ledgerTemplateCapability: true, genericCapability: true, ...extra });
  const rows = () => c.db.query<{ id: string; plan_id: string; kind: string; fields: Record<string, unknown>; version: number; minutes: number; note: string }>('SELECT id,plan_id,kind,fields,version,minutes,note FROM records WHERE user_id=$1 AND NOT deleted ORDER BY created_at', [c.userId]);
  const summary = () => genericSummary(c.db, c.userId, water.planId, today, today);
  return { ...c, context, run, water, send, rows, summary };
}
describe('模板驱动的通用对话与跨计划原子记录', () => {
  it('归档页面仍查询原计划历史，不恢复或改查另一个进行中的计划', async () => {
    const c = await scenario();
    await c.run({ type: 'add_generic_record', planId: c.water.planId, values: { date: today, amountMl: 300 } });
    await c.run({ type: 'archive_plan', planId: c.water.planId });
    const other = (await c.run({ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 })).templatePlan!;
    await c.run({ type: 'add_generic_record', planId: other.planId, values: { date: today, amountMl: 500 } });
    const chat = new Chat(c.db, script({ 查询今天: { intent: 'query', query: { kind: 'generic_summary', plan_id: null, period: 'today', from: null, to: null, category: null } } }));
    const out = await c.send(chat, '查询今天');
    expect(card(out.assistant.cards, 'query')).toMatchObject({ kind: 'generic_period', plan: { id: c.water.planId, status: 'archived' }, summary: { recordCount: 1, metrics: expect.arrayContaining([expect.objectContaining({ value: 300 })]) } });
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.water.planId])).toEqual([{ status: 'archived' }]);
    expect(await c.rows()).toHaveLength(2);
  });

  it.each([false, true])('归档通用页面记录不转写另一个活跃计划（模型指定其他计划=%s），确认后原计划恢复且只保存一次', async modelChoosesOther => {
    const c = await scenario();
    await c.run({ type: 'archive_plan', planId: c.water.planId });
    const other = (await c.run({ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 })).templatePlan!;
    await c.run({ type: 'rename_plan', planId: other.planId, name: '另一个饮水计划' });
    const chat = new Chat(c.db, script({ 喝了300ml: { intent: 'write', writes: [w('add_generic_record', { plan_id: modelChoosesOther ? other.planId : null, generic_fields: [field(300)] })] } }));
    const first = await c.send(chat, '喝了300ml');
    const pending = card(first.assistant.cards, 'clarify')!;
    expect(pending.question).toContain('归档');
    expect(await c.rows()).toHaveLength(0);
    const choice = pending.options.find(option => option.label === '恢复并记录')!;
    const id = randomUUID();
    const restored = await c.send(chat, choice.label, { clientMsgId: id, pendingId: pending.pendingId, choice: choice.id });
    expect(card(restored.assistant.cards, 'receipt')?.items.map(item => item.type)).toEqual(['plan_updated', 'generic_added']);
    await c.send(chat, choice.label, { clientMsgId: id, pendingId: pending.pendingId, choice: choice.id });
    expect(await c.rows()).toMatchObject([{ plan_id: c.water.planId, fields: { amountMl: 300 } }]);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.water.planId])).toEqual([{ status: 'active' }]);
  });

  it('明确指定归档通用计划时先确认；取消不恢复也不记录', async () => {
    const c = await scenario();
    await c.run({ type: 'archive_plan', planId: c.water.planId });
    const chat = new Chat(c.db, script({ 饮水计划喝了300ml: { intent: 'write', writes: [w('add_generic_record', { plan_id: c.water.planId, generic_fields: [field(300)] })] } }));
    const first = await c.send(chat, '饮水计划喝了300ml', { scopePlanId: null });
    const pending = card(first.assistant.cards, 'clarify')!;
    expect(pending.question).toContain('归档');
    const cancel = pending.options.find(option => option.style === 'cancel')!;
    await c.send(chat, cancel.label, { scopePlanId: null, pendingId: pending.pendingId, choice: cancel.id });
    expect(await c.rows()).toHaveLength(0);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.water.planId])).toEqual([{ status: 'archived' }]);
  });

  it.each(['missing', 'other-user', 'wrong-kind'])('显式指定%s计划不自动回退到唯一活跃通用计划', async invalid => {
    const c = await scenario();
    let invalidId: string = randomUUID();
    if (invalid === 'wrong-kind') {
      const result = await c.run({ type: 'create_study', activity: '阅读' });
      const item = result.items[0]!; if (item.type !== 'plan_created') throw new Error('fixture'); invalidId = item.plan.id;
    }
    if (invalid === 'other-user') {
      const [other] = await c.db.query<{ id: string }>('INSERT INTO users(dev_name) VALUES($1) RETURNING id', [`archived-other-${randomUUID()}`]);
      invalidId = (await execute(c.db, { ...c.context, userId: other!.id }, randomUUID(), [{ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 }])).templatePlan!.planId;
    }
    const chat = new Chat(c.db, script({ 喝了300ml: { intent: 'write', writes: [w('add_generic_record', { plan_id: invalidId, generic_fields: [field(300)] })] } }));
    const out = await c.send(chat, '喝了300ml');
    expect(card(out.assistant.cards, 'clarify')).toBeDefined();
    expect(card(out.assistant.cards, 'receipt')).toBeUndefined();
    expect(await c.rows()).toHaveLength(0);
    expect(JSON.stringify(out.assistant)).not.toContain(invalidId);
  });

  it('HTTP归档范围：历史只读、恢复确认后保存和重放；另一个活跃计划不受影响', async () => {
    const c = await scenario();
    await c.run({ type: 'add_generic_record', planId: c.water.planId, values: { date: today, amountMl: 200 } });
    await c.run({ type: 'archive_plan', planId: c.water.planId });
    const other = (await c.run({ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 })).templatePlan!;
    await c.run({ type: 'rename_plan', planId: other.planId, name: '另一个计划' });
    const cfg = { jwtSecret: new TextEncoder().encode('isolated-generic-http-test-secret-xx'), appleAudience: null, devLogin: false };
    const token = await issueToken(cfg, c.userId, 0);
    const llm = script({
      查询今天: { intent: 'query', query: { kind: 'generic_summary', plan_id: null, period: 'today', from: null, to: null, category: null } },
      喝了300ml: { intent: 'write', writes: [w('add_generic_record', { generic_fields: [field(300)] })] },
    });
    const app = createApp(c.db, llm, cfg);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-planplan-capabilities': 'generic-record-v1,chat-recovery-v1' };
    const request = (text: string, extra: Record<string, unknown> = {}) => app.request('/v1/chat', { method: 'POST', headers, body: JSON.stringify({ clientMsgId: randomUUID(), scopePlanId: c.water.planId, inputAt: T.toISOString(), text, ...extra }) });
    const queried = await request('查询今天'); expect(queried.status).toBe(200);
    expect(card((await queried.json()).assistant.cards, 'query')).toMatchObject({ kind: 'generic_period', plan: { id: c.water.planId, status: 'archived' }, summary: { recordCount: 1 } });
    const first = await request('喝了300ml'); expect(first.status).toBe(200);
    const pending = card((await first.json()).assistant.cards, 'clarify')!;
    expect(pending.question).toContain('归档'); expect(await c.rows()).toHaveLength(1);
    const option = pending.options.find(option => option.label === '恢复并记录')!;
    const choice = { clientMsgId: randomUUID(), pendingId: pending.pendingId, choice: option.id };
    const saved = await request(option.label, choice); expect(saved.status).toBe(200);
    expect(card((await saved.json()).assistant.cards, 'receipt')?.items.map(item => item.type)).toEqual(['plan_updated', 'generic_added']);
    expect((await request(option.label, choice)).status).toBe(200);
    expect((await c.rows()).map(row => row.plan_id)).toEqual([c.water.planId, c.water.planId]);
    expect((await c.summary()).metrics[0]!.value).toBe(500);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [other.planId])).toEqual([{ status: 'active' }]);
    const before = llm.calls.length;
    const unavailable = await request('喝了300ml', { scopePlanId: randomUUID() });
    expect(unavailable.status).toBe(404);
    expect(llm.calls.length).toBe(before);
    expect(await c.rows()).toHaveLength(2);
  });

  it('目标不算事实，原始300ml+0.5L精确为800；查询只读已存事实，刷新和同体核对一致', async () => {
    const c = await scenario();
    const chat = new Chat(c.db, script({
      '目标每天2000ml': { intent: 'write', writes: [w('configure_generic_plan', { generic_fields: [field(2000, 'ml', { field_id: 'dailyGoalMl' })], complete_setup: true })] },
      '每天2000ml': { intent: 'write', writes: [w('add_generic_record', { generic_fields: [field(2000)] })] },
      '喝了300ml和0.5L': { intent: 'write_and_query', writes: [w('add_generic_record', { generic_fields: [field(300)] }), w('add_generic_record', { generic_fields: [field(.5, 'L')] })], query: { kind: 'generic_summary', plan_id: null, period: 'today', from: null, to: null, category: null } },
    }));
    await c.send(chat, '目标每天2000ml'); expect(await c.rows()).toHaveLength(0);
    expect((await getPlanTemplate(c.db,c.userId,c.water.planId,today)).config.values).toMatchObject({ dailyGoalMl: 2000 });
    const goal = await c.send(chat,'每天2000ml'); expect(card(goal.assistant.cards,'clarify')).toBeDefined(); expect(await c.rows()).toHaveLength(0);
    const cancel=card(goal.assistant.cards,'clarify')!; await c.send(chat,'取消',{pendingId:cancel.pendingId,choice:cancel.options.find(x=>x.style==='cancel')!.id});
    const key=randomUUID(); const saved=await c.send(chat,'喝了300ml和0.5L',{clientMsgId:key});
    expect(saved.assistant.text).toContain('2 条都已保存'); expect(card(saved.assistant.cards,'query')).toMatchObject({kind:'generic_period',summary:{recordCount:2,metrics:[{value:800},{value:800,target:2000,remaining:1200}]}});
    expect((await c.rows()).map(r=>r.fields.amountMl)).toEqual([300,500]);
    expect((await c.send(chat,'喝了300ml和0.5L',{clientMsgId:key})).assistant.id).toBe(saved.assistant.id);
    expect((await chat.lookup(c.userId,key))!.assistant.id).toBe(saved.assistant.id); expect(await c.rows()).toHaveLength(2);
    expect((await new Chat(c.db,script({})).history(c.userId,50,undefined,c.water.planId)).some(m=>m.id===saved.assistant.id)).toBe(true);
  });
  it('三类混合缺杯容量整批不写；补充只返回generic时保留支出/阅读/昨天，取消不写', async()=>{
    const c=await scenario(); await c.run({type:'create_ledger'}); const reading=(await c.run({type:'adopt_template',templateId:'official.reading',templateVersion:1})).templatePlan!;
    const text='昨天午饭18元，阅读25分钟，喝了两杯';
    const llm=script({[text]:{intent:'write',writes:[w('add_expense',{amount_text:'18',category:'餐饮',note:'午饭',date_kind:'yesterday'}),w('add_study',{plan_id:reading.planId,duration_value:25,duration_unit:'minute',date_kind:'yesterday'}),w('add_generic_record',{plan_id:c.water.planId,generic_fields:[field(2,'杯')],date_kind:'yesterday'})]},'每杯200ml':{intent:'answer_pending',writes:[w('add_generic_record',{generic_fields:[field(null,null,{unit_size:200,unit_size_unit:'ml'})]})]}});
    const chat=new Chat(c.db,llm); const first=await c.send(chat,text,{scopePlanId:null}); const pending=card(first.assistant.cards,'clarify')!;
    expect(pending.question).toContain('每杯'); expect(pending.items.map(x=>x.ready)).toEqual([true,true,false]);expect(pending.options.some(x=>x.label.includes('只保存'))).toBe(false);expect(await c.rows()).toHaveLength(0);
    const reply=await c.send(chat,'每杯200ml',{scopePlanId:null});expect(reply.assistant.text).toContain('3 条都已保存'); const rows=await c.rows();expect(rows.map(r=>r.kind)).toEqual(['expense','study','generic']);expect(rows[2]!.fields).toMatchObject({amountMl:400,date:'2026-11-15'});expect(rows[1]!.minutes).toBe(25);
    const next=card((await c.send(chat,'喝了两杯',{scopePlanId:null})).assistant.cards,'clarify'); // unknown input must not create records
    expect(next).toBeUndefined();expect(await c.rows()).toHaveLength(3);
    const another=card((await c.send(chat,text,{scopePlanId:null,inputAt:new Date(T.getTime()+600000)})).assistant.cards,'clarify')!;
    await c.send(chat,'取消',{scopePlanId:null,pendingId:another.pendingId,choice:another.options.find(o=>o.style==='cancel')!.id});expect(await c.rows()).toHaveLength(3);
  });
  it.each([field(0),field(-2),field(.5),field(100001),field(.0001,'L'),field(2,'杯',{unit_size:200,unit_size_unit:'ml'}),field(300,'kg'),field(300,'ml',{field_id:'invented'})])('非法或未经确认的字段阻断整批 %#',async f=>{
    const c=await scenario();await c.run({type:'create_ledger'});const chat=new Chat(c.db,script({'午饭18元，喝了两杯':{intent:'write',writes:[w('add_expense',{amount_text:'18',category:'餐饮'}),w('add_generic_record',{generic_fields:[f]})]}}));
    const reply=await c.send(chat,'午饭18元，喝了两杯');expect(card(reply.assistant.cards,'clarify')).toBeDefined();expect(await c.rows()).toHaveLength(0);
  });
  it('明确杯容量精确换算；修改同条保留未改字段，未来日期等待补充',async()=>{
    const c=await scenario();const chat=new Chat(c.db,script({'喝了两杯，每杯200ml':{intent:'write',writes:[w('add_generic_record',{generic_fields:[field(2,'杯',{unit_size:200,unit_size_unit:'ml'})],note:'午后'})]},'刚才改成0.5L':{intent:'write',writes:[w('edit_generic_record',{generic_fields:[field(.5,'L')]})]},'明天喝300ml':{intent:'write',writes:[w('add_generic_record',{date_kind:'future',generic_fields:[field(300)]})]}}));
    await c.send(chat,'喝了两杯，每杯200ml'); const before=(await c.rows())[0]!;expect(before.fields).toMatchObject({amountMl:400,note:'午后'});
    const edited=await c.send(chat,'刚才改成0.5L');expect(edited.assistant.text).toContain('记录数值或内容已更新');expect((await c.rows())[0]).toMatchObject({id:before.id,version:2,fields:{amountMl:500,note:'午后'}});
    expect(card((await c.send(chat,'明天喝300ml')).assistant.cards,'clarify')).toBeDefined();expect(await c.rows()).toHaveLength(1);
  });
  it('未选范围的两个通用计划先选归属；配置与事实混合不写',async()=>{
    const c=await scenario(),second=(await c.run({type:'adopt_template',templateId:'official.water',templateVersion:1})).templatePlan!;
    await c.run({type:'configure_generic_plan',planId:second.planId,expectedVersion:second.config.version,patch:{name:'第二个计划'}});
    const llm=script({'喝了300ml':{intent:'write',writes:[w('add_generic_record',{generic_fields:[field(300)]})]},'设目标2000ml再喝300ml':{intent:'write',writes:[w('configure_generic_plan',{generic_fields:[field(2000,'ml',{field_id:'dailyGoalMl'})]}),w('add_generic_record',{generic_fields:[field(300)]})]}}),chat=new Chat(c.db,llm);
    const pending=card((await c.send(chat,'喝了300ml',{scopePlanId:null})).assistant.cards,'clarify')!;expect(pending.options).toHaveLength(3);await c.send(chat,'第二个计划',{scopePlanId:null,pendingId:pending.pendingId,choice:pending.options.find(o=>o.label==='第二个计划')!.id});expect((await c.rows())[0]!.plan_id).toBe(second.planId);
    const mixed=await c.send(chat,'设目标2000ml再喝300ml');expect(mixed.assistant.text).toContain('这次都没有保存');expect(await c.rows()).toHaveLength(1);
  });
  it('旧客户端不调用generic模型scope；坏模型也不能让混合批次部分保存，上下文隐藏generic',async()=>{
    const c=await scenario();await c.run({type:'create_ledger'});await c.run({type:'add_generic_record',planId:c.water.planId,values:{date:today,amountMl:300,note:'不应进入旧模型'}});
    const llm=script({'旧版':{intent:'write',writes:[w('add_expense',{amount_text:'18',category:'餐饮'}),w('add_generic_record',{plan_id:c.water.planId,generic_fields:[field(300)]})]}}),chat=new Chat(c.db,llm);
    const scoped=await c.send(chat,'旧版',{genericCapability:false});expect(scoped.assistant.text).toContain('新版网页');expect(llm.calls).toHaveLength(0);
    const global=await c.send(chat,'旧版',{scopePlanId:null,genericCapability:false});expect(global.assistant.text).toContain('没有执行任何写入');expect(await c.rows()).toHaveLength(1);expect(llm.calls[0]!.system).not.toContain('不应进入旧模型');expect(llm.calls[0]!.system).not.toContain(`id=${c.water.planId}`);
  });
  it('第二种定义用不同字段/指标，AI上下文和保存查询均来自定义',async()=>{
    const c=await scenario();const definition={...WATER_TEMPLATE,id:'official.chat-synthetic',name:'容量采样',configurationFields:WATER_TEMPLATE.configurationFields.slice(0,2),recordFields:[WATER_TEMPLATE.recordFields[0],{id:'volume',label:'容量',type:'integer',required:true,unit:'ml',min:1,max:9000}],metrics:[{id:'sumVolume',label:'累计容量',operation:'sum',fieldId:'volume',period:'day'}],components:['summary','records'],example:{config:{name:'采样',startDate:today},record:{date:today,volume:100}}};
    await c.db.query('INSERT INTO template_versions(template_id,version,definition) VALUES($1,1,$2)',[definition.id,JSON.stringify(definition)]);const p=(await c.run({type:'adopt_template',templateId:definition.id,templateVersion:1})).templatePlan!;
    const llm=script({'记录0.3L':{intent:'write_and_query',writes:[w('add_generic_record',{generic_fields:[field(.3,'L',{field_id:'volume'})]})],query:{kind:'generic_summary',plan_id:null,period:'today',from:null,to:null,category:null}}}),chat=new Chat(c.db,llm);
    const reply=await c.send(chat,'记录0.3L',{scopePlanId:p.planId});expect(card(reply.assistant.cards,'query')).toMatchObject({kind:'generic_period',summary:{metrics:[{id:'sumVolume',label:'累计容量',value:300}]}});expect((await c.rows())[0]!.fields).toMatchObject({volume:300});expect(llm.calls[0]!.system).toContain('volume');
  });
  it('字段日期冲突不写；昨天记录明确改成今天，仅改数值时保留日期',async()=>{
    const c=await scenario();const chat=new Chat(c.db,script({'昨天喝300ml':{intent:'write',writes:[w('add_generic_record',{date_kind:'yesterday',generic_fields:[field(300)]})]},'刚才改成今天':{intent:'write',writes:[w('edit_generic_record')]},'改成0.5L':{intent:'write',writes:[w('edit_generic_record',{generic_fields:[field(.5,'L')]})]},'今天喝200ml':{intent:'write',writes:[w('add_generic_record',{generic_fields:[field(200),field('2026-11-15',null,{field_id:'date'})]})]}}));
    await c.send(chat,'昨天喝300ml');const before=(await c.rows())[0]!;expect(before.fields.date).toBe('2026-11-15');await c.send(chat,'改成0.5L');expect((await c.rows())[0]!.fields).toMatchObject({amountMl:500,date:'2026-11-15'});await c.send(chat,'刚才改成今天');expect((await c.rows())[0]).toMatchObject({id:before.id,fields:{date:today,amountMl:500}});expect(card((await c.send(chat,'今天喝200ml')).assistant.cards,'clarify')).toBeDefined();expect(await c.rows()).toHaveLength(1);
  });
  it('未明确清空时null配置不覆盖已有目标，明确清空才移除',async()=>{
    const c=await scenario();await c.run({type:'configure_generic_plan',planId:c.water.planId,expectedVersion:1,patch:{values:{dailyGoalMl:2000}}});
    const chat=new Chat(c.db,script({'改目标':{intent:'write',writes:[w('configure_generic_plan',{generic_fields:[field(null,null,{field_id:'dailyGoalMl'})]})]},'清空目标':{intent:'write',writes:[w('configure_generic_plan',{generic_fields:[field(null,null,{field_id:'dailyGoalMl'})]})]}}));
    expect(card((await c.send(chat,'改目标')).assistant.cards,'clarify')).toBeDefined();expect((await getPlanTemplate(c.db,c.userId,c.water.planId,today)).config.values?.dailyGoalMl).toBe(2000);await c.send(chat,'清空目标');expect((await getPlanTemplate(c.db,c.userId,c.water.planId,today)).config.values?.dailyGoalMl).toBeNull();expect(await c.rows()).toHaveLength(0);
  });
  it.each([{answer:'3天前',date_kind:'days_ago' as const,days_ago:3,date:null,expected:'2026-11-13'},{answer:'上周三',date_kind:'absolute' as const,days_ago:null,date:'2026-11-11',expected:'2026-11-11'}])('缺日期补答$answer使用原输入时区日期而非丢弃补充',async answer=>{
    const c=await scenario(),chat=new Chat(c.db,script({'那天喝300ml':{intent:'write',writes:[w('add_generic_record',{date_kind:'unknown',generic_fields:[field(300)]})]},[answer.answer]:{intent:'answer_pending',writes:[w('add_generic_record',{date_kind:answer.date_kind,days_ago:answer.days_ago,date:answer.date})]}}));
    expect(card((await c.send(chat,'那天喝300ml')).assistant.cards,'clarify')).toBeDefined();await c.send(chat,answer.answer,{inputAt:new Date('2026-11-18T04:00:00Z')});expect((await c.rows())[0]!.fields).toMatchObject({amountMl:300,date:answer.expected});
  });
  it('真实provider输出外币预算时追问人民币，不改变原预算',async()=>{
    const c=await scenario(),ledger=(await c.run({type:'adopt_template',templateId:'official.ledger',templateVersion:1})).templatePlan!;await c.run({type:'configure_ledger_plan',planId:ledger.planId,expectedVersion:ledger.config.version,patch:{budgetCents:100000}});
    const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({intent:'write',writes:[w('configure_ledger_plan',{amount_text:'200',currency:'other'})]})},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}})}),chat=new Chat(c.db,llm);
    const reply=await c.send(chat,'每月预算200美元',{scopePlanId:ledger.planId});expect(card(reply.assistant.cards,'clarify')!.question).toContain('人民币');expect((await getPlanTemplate(c.db,c.userId,ledger.planId,today)).config.budgetCents).toBe(100000);expect(await c.rows()).toHaveLength(0);
  });
  it('配置版本采用模型调用前快照，调用期间手动改目标后拒绝覆盖',async()=>{
    const c=await scenario();const fake=script({'目标2000ml':{intent:'write',writes:[w('configure_generic_plan',{generic_fields:[field(2000,'ml',{field_id:'dailyGoalMl'})]})]}});
    const chat=new Chat(c.db,{async plan(system,text,context){await c.run({type:'configure_generic_plan',planId:c.water.planId,expectedVersion:c.water.config.version,patch:{values:{dailyGoalMl:1500}}});return fake.plan(system,text);}});
    const reply=await c.send(chat,'目标2000ml');expect(card(reply.assistant.cards,'error')).toMatchObject({code:'version_conflict'});expect((await getPlanTemplate(c.db,c.userId,c.water.planId,today)).config.values?.dailyGoalMl).toBe(1500);expect(await c.rows()).toHaveLength(0);
  });
  it('三类batch撤销保留后来独立记录，任一记录被改则整批撤销拒绝',async()=>{
    const c=await scenario();await c.run({type:'create_ledger'});const p=(await c.run({type:'adopt_template',templateId:'official.reading',templateVersion:1})).templatePlan!;
    const chat=new Chat(c.db,script({'午饭18元读25分钟喝300ml':{intent:'write',writes:[w('add_expense',{amount_text:'18',category:'餐饮'}),w('add_study',{plan_id:p.planId,duration_value:25,duration_unit:'minute'}),w('add_generic_record',{plan_id:c.water.planId,generic_fields:[field(300)]})]}}));
    const batch=card((await c.send(chat,'午饭18元读25分钟喝300ml',{scopePlanId:null})).assistant.cards,'receipt')!;
    await c.run({type:'add_generic_record',planId:c.water.planId,values:{date:today,amountMl:500}});await undo(c.db,c.context,batch.operationId,randomUUID());expect(await c.rows()).toHaveLength(1);expect((await c.summary()).metrics[0]!.value).toBe(500);
    const second=card((await c.send(chat,'午饭18元读25分钟喝300ml',{scopePlanId:null,inputAt:new Date(T.getTime()+600000)})).assistant.cards,'receipt')!;const generic=second.items.find(i=>i.type==='generic_added')!;if(generic.type!=='generic_added')throw new Error('missing');await c.run({type:'edit_generic_record',recordId:generic.record.id,expectedVersion:generic.record.version,values:{date:today,amountMl:350}});
    await expect(undo(c.db,c.context,second.operationId,randomUUID())).rejects.toMatchObject({code:'undo_conflict'});expect(await c.rows()).toHaveLength(4);
  });
});
