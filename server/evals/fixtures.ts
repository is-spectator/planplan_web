import { openDb, type Db } from '../src/db/db.js';
import { execute, type Action } from '../src/services/engine.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { Chat } from '../src/services/chat.js';

/** Real model evaluation stays in memory. Only the explicit test matrix uses PG. */
export async function openEvalFixtureDb(env:NodeJS.ProcessEnv=process.env):Promise<Db>{
  const url=env.NODE_ENV==='test'?env.TEST_DATABASE_URL:undefined;
  if(!url)return openDb('pglite://memory');
  const schema=`eval_test_${randomUUID().replaceAll('-','')}`;
  const withAdmin=async(sql:string)=>{
    const client=new pg.Client({connectionString:url});
    try{await client.connect();await client.query(sql);}finally{await client.end();}
  };
  await withAdmin(`CREATE SCHEMA ${schema}`);
  let db:Db;
  try{db=await openDb(url,{schema});}
  catch(error){try{await withAdmin(`DROP SCHEMA ${schema} CASCADE`);}catch(cleanup){throw new AggregateError([error,cleanup],'Evaluation fixture setup and cleanup failed');}throw error;}
  const originalClose=db.close.bind(db);let closing:Promise<void>|undefined;
  db.close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await originalClose();}catch(error){errors.push(error);}
    try{await withAdmin(`DROP SCHEMA ${schema} CASCADE`);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Evaluation fixture cleanup failed');
  })();
  return db;
}

/** 默认样例输入时刻（个别场景由 EvalCase.inputAt 显式覆盖）：2026 年 10 月 26 日周一 12:41（上海）。 */
export const INPUT_AT = new Date('2026-10-26T12:41:00+08:00');
export const TODAY = '2026-10-26';

export type FixtureName = 'default' | 'empty' | 'comparison' | 'first_week' | 'chat_receipt';

export interface Fixture {
  db: Db;
  userId: string;
  plans: { ledger?: string; read?: string; eng?: string };
  records: { lunch?: string; read25?: string; earphone?: string; grocery?: string };
}

let n = 0;

/**
 * default：已有「日常记账」（月预算 ¥3,000）、「阅读」（每周 5 天、每天 20 分钟）、「英语学习」（每周 3 天，每天分钟数未设）。
 *   历史支出：10/18 耳机 ¥199（购物）、10/20 超市 ¥128、10/24 地铁 ¥6；今天 08:30 已读 20 分钟。
 *   最近一次表单操作：午饭 ¥20（餐饮）+ 阅读 25 分钟；不产生可供聊天撤销的回执。
 * chat_receipt：只将上述末次两条改为真实 Chat 服务保存的同一批次，供明确撤销回执的案例使用。
 * empty：新账户，没有任何计划。
 */
export async function makeFixture(name: FixtureName, env?:NodeJS.ProcessEnv): Promise<Fixture> {
  const db=await openEvalFixtureDb(env);
  try{return await seedFixture(db,name);}catch(error){try{await db.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Evaluation fixture seed and cleanup failed');}throw error;}
}
async function seedFixture(db:Db,name:FixtureName):Promise<Fixture>{
  const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name, ai_consent) VALUES ($1, true) RETURNING id`, [`eval-${++n}`]);
  const userId = u!.id;
  const fx: Fixture = { db, userId, plans: {}, records: {} };
  if (name === 'empty') return fx;
  const run = async (iso: string, ...actions: Action[]) => execute(db, { userId, inputAt: new Date(iso), source: 'form' }, `fx-${++n}`, actions);
  const id = (r: { items: unknown[] }, i = 0) => {
    const it = r.items[i] as { plan?: { id: string }; record?: { id: string } };
    return (it.plan ?? it.record)!.id;
  };
  if (name === 'first_week') {
    fx.plans.read = id(await run('2026-10-31T09:00:00+08:00', { type: 'create_study', name: '阅读', activity: '阅读', daysPerWeek: 3, minMinutes: 20 }));
    return fx;
  }
  fx.plans.ledger = id(await run('2026-10-01T09:00:00+08:00', { type: 'create_ledger', budgetCents: 300000 }));
  fx.plans.read = id(await run('2026-10-01T09:00:00+08:00', { type: 'create_study', name: '阅读', activity: '阅读', daysPerWeek: 5, minMinutes: 20 }));
  fx.plans.eng = id(await run('2026-10-05T09:00:00+08:00', { type: 'create_study', name: '英语学习', activity: '英语学习', daysPerWeek: 3 }));
  fx.records.earphone = id(await run('2026-10-18T20:00:00+08:00', { type: 'add_expense', amountCents: 19900, category: '购物', date: '2026-10-18', note: '耳机' }));
  fx.records.grocery = id(await run('2026-10-20T19:00:00+08:00', { type: 'add_expense', amountCents: 12800, category: '餐饮', date: '2026-10-20', note: '超市' }));
  await run('2026-10-24T08:00:00+08:00', { type: 'add_expense', amountCents: 600, category: '交通', date: '2026-10-24', note: '地铁' });
  await run('2026-10-26T08:30:00+08:00', { type: 'add_study', planId: fx.plans.read, minutes: 20, date: TODAY });
  let last: { items: unknown[] };
  if (name === 'chat_receipt') {
    const turn = sanitizeTurn({ intent: 'write', writes: [
      { op: 'add_expense', is_fact: true, amount_text: '20', currency: 'CNY', category: '餐饮', note: '午饭', date_kind: 'today' },
      { op: 'add_study', is_fact: true, plan_id: fx.plans.read, activity: '阅读', duration_value: 25, duration_unit: 'minute', date_kind: 'today' },
    ] });
    if (!turn) throw new Error('Invalid chat receipt fixture turn');
    const chat = new Chat(db, new FakeLlm(() => turn));
    const reply = await chat.send(userId, { clientMsgId: `fx-chat-${++n}`, text: '午饭20元，阅读25分钟', inputAt: new Date('2026-10-26T12:30:00+08:00') });
    const receipt = reply.assistant.cards.find(card => card.type === 'receipt');
    if (!receipt || receipt.kind !== 'batch' || receipt.items.length !== 2) throw new Error('Chat receipt fixture did not save its exact two records');
    last = receipt;
  } else {
    last = await run('2026-10-26T12:30:00+08:00', { type: 'add_expense', amountCents: 2000, category: '餐饮', date: TODAY, note: '午饭' }, { type: 'add_study', planId: fx.plans.read, minutes: 25, date: TODAY });
  }
  fx.records.lunch = id(last, 0);
  fx.records.read25 = id(last, 1);
  if (name === 'comparison') {
    // 单独夹具，不改变原 300 条样例的事实和独立 oracle。
    const earlier = id(await run('2026-09-10T12:00:00+08:00', { type: 'add_expense', amountCents: 10000, category: '购物', date: '2026-09-10', note: '上月购买' }));
    await run('2026-09-20T12:00:00+08:00', { type: 'add_refund', amountCents: 2000, expenseId: earlier, date: '2026-09-20' });
    await run('2026-10-15T12:00:00+08:00', { type: 'add_refund', amountCents: 3000, expenseId: earlier, date: '2026-10-15' });
    await run('2026-09-10T12:00:00+08:00', { type: 'add_study', planId: fx.plans.read, minutes: 30, date: '2026-09-10' });
    await run('2026-09-11T12:00:00+08:00', { type: 'add_study', planId: fx.plans.read, minutes: 30, date: '2026-09-11' });
  }
  return fx;
}
