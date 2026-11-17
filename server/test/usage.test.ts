import { sanitizeTurn } from '../src/ai/turn.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openTestDb } from './database.js';
import { setup } from './helpers.js';
import { execute } from '../src/services/engine.js';
import { usage, usageLogin, pruneUsage } from '../src/services/usage.js';
import { productMetrics } from '../src/services/metrics.js';
import { recordEntry, linkEntry } from '../src/services/entry.js';
import { recordWithRefundSnapshot } from '../src/services/refund-snapshot.js';

it('私有原文与未知字段不能进入指标；同事件重试去重，删除账户级联清理', async () => {
  const { db, userId } = await setup();
  try {
    await usageLogin(db, userId, 'email');
    await usage(db, userId, 'query', 'opaque原始内容不应落库', { kind: 'none', hasData: false, valid: false, latencyMs: 10 });
    await usage(db, userId, 'query', 'opaque原始内容不应落库', { kind: 'none', hasData: false, valid: false, latencyMs: 11 });
    const unsafe = usage as (connection: import('../src/db/db.js').Db, id: string, name: string, key: string, props: unknown) => Promise<void>;
    await unsafe(db, userId, 'query', 'private', { kind: 'none', hasData: false, valid: false, latencyMs: 0, text: '午餐12345元' });
    const rows = await db.query('SELECT * FROM usage_events');
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain('原始内容');
    expect(JSON.stringify(rows)).not.toContain('12345');
    await db.query('DELETE FROM users WHERE id=$1', [userId]);
    expect(await db.query('SELECT * FROM usage_events')).toEqual([]);
    expect(await db.query('SELECT * FROM usage_actors')).toEqual([]);
    await usageLogin(db, userId, 'email');
    expect(await db.query('SELECT * FROM usage_actors')).toEqual([]);
  } finally { await db.close(); }
});

it('业务重试不多算记录，正常调整和理解错误明确区分，事件不含金额或备注', async () => {
  const { db, userId, at, run } = await setup();
  const time = '2026-10-27T01:00:00Z';
  try {
    await usageLogin(db, userId, 'email');
    await run(time, { type: 'create_ledger' });
    const actions = [{ type: 'add_expense' as const, amountCents: 4321, category: '餐饮' as const, date: '2026-10-27', note: 'private-note' }];
    const saved = await execute(db, at(time), 'stable-original-op', actions);
    await execute(db, at(time), 'stable-original-op', actions);
    const item = saved.items[0]!;
    if (item.type !== 'expense_added') throw new Error('missing fixture');
    await run(time, { type: 'edit_record', recordId: item.record.id, patch: { amountCents: 4399 }, correctionReason: 'normal_adjustment' });
    await run(time, { type: 'edit_record', recordId: item.record.id, patch: { amountCents: 4310 }, correctionReason: 'understanding_error' });
    const events = await db.query<{name:string;props:Record<string,unknown>}>('SELECT name,props FROM usage_events ORDER BY seq');
    expect(events.filter(e => e.name === 'record_saved')).toHaveLength(1);
    expect(events.filter(e => e.name === 'correction').map(e => e.props.reason)).toEqual(['normal_adjustment', 'understanding_error']);
    expect(events.filter(e => e.name === 'correction').every(e => e.props.originalOperationId === saved.operationId)).toBe(true);
    // UUIDs and SHA-256 digests can contain the same digits by chance. Assert
    // the privacy contract on fields, rather than scanning random identifiers.
    for (const event of events) {
      expect(event.props).not.toHaveProperty('amount');
      expect(event.props).not.toHaveProperty('amountCents');
      expect(event.props).not.toHaveProperty('note');
      expect(event.props).not.toHaveProperty('text');
    }
    expect(JSON.stringify(events)).not.toContain('private-note');
  } finally { await db.close(); }
});

it('同批多次修改与随后确认的级联删除分别保留各自纠错原因', async () => {
  const { db, userId, run } = await setup();
  const time = '2026-10-27T01:00:00Z';
  try {
    await run(time, { type: 'create_ledger' });
    const saved = await run(time, { type: 'add_expense', amountCents: 10000, category: '购物', date: '2026-10-27' });
    const expense = saved.items[0]!;
    if (expense.type !== 'expense_added') throw new Error('missing fixture');
    await run(time, { type: 'add_refund', expenseId: expense.record.id, amountCents: 1000, date: '2026-10-27' });
    await run(time,
      { type: 'edit_record', recordId: expense.record.id, patch: { amountCents: 12000 }, correctionReason: 'normal_adjustment' },
      { type: 'edit_record', recordId: expense.record.id, patch: { amountCents: 11000 }, correctionReason: 'understanding_error' });
    const detail = await recordWithRefundSnapshot(db, userId, expense.record.id);
    await run(time, { type: 'delete_record', recordId: expense.record.id, includeRefunds: true, expectedRefundSnapshot: detail.refundSnapshot!.token, correctionReason: 'unspecified' });
    const events = await db.query<{ props: { reason: string; fields: string[] } }>("SELECT props FROM usage_events WHERE name='correction' ORDER BY seq");
    expect(events.map(e => e.props.reason)).toEqual(['normal_adjustment', 'understanding_error', 'unspecified', 'unspecified']);
    expect(events.slice(2).map(e => e.props.fields)).toEqual([['deleted'], ['deleted']]);
  } finally { await db.close(); }
});

it('成熟24小时/第8至14天窗口与上海自然周三天活跃，不把未知改动或未成熟用户算成流失', async () => {
  const db = await openTestDb();
  const now = new Date('2026-10-28T12:00:00Z');
  const at = (day: number) => new Date(now.getTime() - day * 86400_000);
  try {
    async function actor(key: string, entryDays: number) {
      const [u] = await db.query<{id:string}>('INSERT INTO users(dev_name) VALUES($1) RETURNING id', [key]);
      await db.query('UPDATE users SET created_at=$2 WHERE id=$1',[u!.id,new Date(at(entryDays).getTime()+1000)]);
      const entryId = randomUUID();
      await recordEntry(db,entryId,at(entryDays));
      await linkEntry(db,u!.id,entryId);
      await usage(db, u!.id, 'entry', 'entry', { result: 'signed_in' }, at(entryDays));
      return u!.id;
    }
    const a = await actor('metric-a', 15), b = await actor('metric-b', 2), immature = await actor('metric-c', 0.1);
    const record = randomUUID();
    await usage(db,a,'plan_created','plan',{kind:'ledger',hasGoal:false,latencyMs:10},at(14.9));
    await usage(db,a,'record_saved','record',{recordId:record,kind:'expense',source:'chat',latencyMs:10},at(14.8));
    await usage(db,a,'query','return-day8',{kind:'ledger_month',hasData:true,valid:true,latencyMs:10},at(7.9));
    for(const days of [2,1,0]) await usage(db,a,'query',`week${days}`,{kind:'overview',hasData:false,valid:true,latencyMs:10},at(days));
    await usage(db,b,'query','empty',{kind:'none',hasData:false,valid:false,latencyMs:10},at(1));
    await usage(db,immature,'query','young',{kind:'none',hasData:false,valid:false,latencyMs:10},at(0));
    await usage(db,a,'correction','c1',{recordId:record,originalOperationId:null,fields:['amount'],reason:'understanding_error'},at(1));
    await usage(db,a,'correction','c2',{recordId:record,originalOperationId:null,fields:['deleted'],reason:'understanding_error'},at(0));
    await usage(db,a,'correction','c3',{recordId:record,originalOperationId:null,fields:['note'],reason:'unspecified'},at(0));
    const r = await productMetrics(db, now);
    expect(r.activation24h).toEqual({ eligible:2, activated:1, rate:0.5 });
    expect(r.retentionDays8To14).toEqual({ eligible:1, retained:1, rate:1 });
    expect(r.weeklyActiveAtLeast3Days).toBe(1);
    expect(r.understandingCorrection).toEqual({ savedRecords:1, correctedRecords:1, rate:1, unclassifiedChanges:1 });
    expect(JSON.stringify(r)).not.toContain(a);
    await db.query('DELETE FROM usage_actors');
    expect((await productMetrics(db, now)).activation24h.rate).toBeNull();
  } finally { await db.close(); }
});

it('成功操作成本关联同请求的所有真实尝试，未知费用不伪装为零', async () => {
  const { UsageStore } = await import('../src/ai/usage-store.js');
  const { db, userId, run, at } = await setup();
  const time = '2026-10-27T01:00:00Z';
  try {
    await run(time, { type: 'create_ledger' });
    await execute(db, { ...at(time), source:'chat' }, 'cost-request', [{ type:'add_expense', amountCents:100, category:'其他', date:'2026-10-27' }]);
    const store = new UsageStore(db, 1000000000000000n);
    for (const cost of [3n, 2n, null]) {
      const id = randomUUID();
      await store.start({ attemptId:id,userId,requestId:'cost-request',model:'synthetic',role:'primary',mode:'compact',at:new Date(),priceVersion:'test' });
      await store.finish({ attemptId:id,latencyMs:1,error:null,usage:cost===null?null:{prompt:1,completion:1},cost:{pico:cost,status:cost===null?'usage_missing':'known',priceVersion:'test'} });
    }
    const r = await productMetrics(db, new Date(Date.now()+1000));
    expect(r.modelCost.associatedSuccessfulOperations).toBe(1);
    expect(r.modelCost.knownCostPico).toBe('5');
    expect(r.modelCost.unknownAttempts).toBe(1);
    expect(r.modelCost.averageObservedKnownCostPico).toBeNull();
  } finally { await db.close(); }
});

it('补充选项后的成功记录保留澄清轮数，原消息重试不多计输入', async () => {
  const { FakeLlm } = await import('../src/ai/llm.js');
  const { Chat } = await import('../src/services/chat.js');
  const { db, userId } = await setup();
  try {
    const chat = new Chat(db, new FakeLlm(() => sanitizeTurn({ intent:'write', writes:[{ op:'add_expense',is_fact:true,amount_text:'20',currency:'CNY',date_kind:'today',category:'餐饮' }] })!));
    const input = { clientMsgId:'clarify-first',text:'午饭20元',inputAt:new Date('2026-10-27T01:00:00Z') };
    const first = await chat.send(userId,input);
    const card = first.assistant.cards.find(c => c.type==='clarify');
    expect(card?.type).toBe('clarify');
    if (card?.type!=='clarify') return;
    const answer = { clientMsgId:'clarify-answer',text:'',inputAt:input.inputAt,pendingId:card.pendingId,choice:card.options[0]!.id };
    const saved = await chat.send(userId,answer);
    expect(saved.assistant.cards.some(c=>c.type==='receipt')).toBe(true);
    await chat.send(userId,answer);
    const rows = await db.query<{props:{clarificationRounds:number;records:number}}>(`SELECT props FROM usage_events WHERE name='request' AND props->>'status'='succeeded'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props).toMatchObject({clarificationRounds:1,records:1});
    const {attemptRequestDigest}=await import('../src/ai/usage-store.js');
    const [operation]=await db.query<{props:{rootHash:string}}>("SELECT props FROM usage_events WHERE name='operation'");
    expect(operation!.props.rootHash).toBe(attemptRequestDigest(userId,input.clientMsgId));
    const links=await db.query<{root_hash:string}>('SELECT root_hash FROM usage_request_links');
    expect(links).toHaveLength(2);
    expect(links.every(l=>l.root_hash===operation!.props.rootHash)).toBe(true);
  } finally { await db.close(); }
});

it('不能隐藏的关键组件回退只记录生效枚举，统计表损坏不阻断对话保存', async()=>{
  const {db,userId,run}=await setup();
  try {
    const created=await run('2026-10-27T01:00:00Z',{type:'create_ledger'});
    const item=created.items[0]!;
    if(item.type!=='plan_created') throw new Error('missing fixture');
    await run('2026-10-27T01:00:00Z',{type:'set_view',planId:item.plan.id,hidden:['budget','trend']},{type:'set_view',planId:item.plan.id,hidden:['categories']});
    const [event,second]=await db.query<{props:{result:string;components:string[]}}>("SELECT props FROM usage_events WHERE name='layout' ORDER BY seq");
    expect(event!.props.result).toBe('fallback');
    expect(second!.props.result).toBe('success');
    expect(event!.props.components).toContain('budget');
    await db.exec('DROP TABLE usage_request_links; DROP TABLE usage_events');
    const {FakeLlm}=await import('../src/ai/llm.js');
    const {Chat}=await import('../src/services/chat.js');
    const chat=new Chat(db,new FakeLlm(()=>sanitizeTurn({intent:'write',writes:[{op:'add_expense',is_fact:true,amount_text:'20',currency:'CNY',date_kind:'today',category:'餐饮'}]})!));
    const saved=await chat.send(userId,{clientMsgId:'analytics-failure',text:'午饭20元',inputAt:new Date('2026-10-27T01:00:00Z')});
    expect(saved.assistant.cards.some(c=>c.type==='receipt')).toBe(true);
  } finally { await db.close(); }
});


it('清理30天事件后再次登录，不会把老用户重算为首次进入', async () => {
  const {db,userId} = await setup();
  try {
    const old = new Date(Date.now()-31*86400_000);
    await usage(db,userId,'entry','first-authenticated-entry',{result:'signed_in'},old);
    await pruneUsage(db);
    await usageLogin(db,userId,'email');
    expect(await db.query("SELECT * FROM usage_events WHERE name='entry'")).toEqual([]);
    const [actor] = await db.query<{first_authenticated_at:Date}>('SELECT first_authenticated_at FROM usage_actors');
    expect(new Date(actor!.first_authenticated_at).toISOString()).toBe(old.toISOString());
    expect((await productMetrics(db)).activation24h.eligible).toBe(0);
  } finally { await db.close(); }
});


it('对话工具的意外失败可关联原请求但不记录原始错误', async () => {
  const { FakeLlm } = await import('../src/ai/llm.js');
  const { Chat } = await import('../src/services/chat.js');
  const { db, userId } = await setup();
  try {
    const chat = new Chat(db,new FakeLlm(()=>{ throw new Error('private-user-text'); }));
    await expect(chat.send(userId,{clientMsgId:'unexpected-op',text:'测试',inputAt:new Date()})).rejects.toThrow('private-user-text');
    const rows=await db.query<{props:{code:string}}>("SELECT props FROM usage_events WHERE name='failure'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props).toMatchObject({category:'tool',code:'internal',retryResult:'unknown'});
    expect(JSON.stringify(rows)).not.toContain('private-user-text');
    expect(await db.query("SELECT * FROM usage_events WHERE name='request' AND props->>'status'='unknown'")).toHaveLength(1);
  } finally { await db.close(); }
});
