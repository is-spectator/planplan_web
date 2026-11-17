import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { historyRead } from '../src/services/history-read.js';
import { ledgerView, studyView } from '../src/services/views.js';
import { dataVersion } from '../src/services/repo.js';
import { Chat } from '../src/services/chat.js';
import { FakeLlm } from '../src/ai/llm.js';
const T='2026-11-17T12:00:00+08:00';
describe('versioned history and stable chat cursor',()=>{
 it('ledger refuses a stale continuation after a record on page 1 is removed',async()=>{
  const c=await setup(); const created=await c.run(T,{type:'create_ledger'}); const id=(created.items[0] as any).plan.id;
  for(let i=0;i<21;i++)await c.run(T,{type:'add_expense',amountCents:100+i,category:'餐饮',date:'2026-11-17'});
  const first=await historyRead(c.db,c.userId,undefined,q=>ledgerView(q,c.userId,id,'2026-11'));
  await c.run(T,{type:'delete_record',recordId:first.records[0]!.id});
  await expect(historyRead(c.db,c.userId,first.dataVersion,q=>ledgerView(q,c.userId,id,'2026-11',20,20))).rejects.toMatchObject({code:'version_conflict',details:{kind:'history_changed'}});
  const restarted=await historyRead(c.db,c.userId,undefined,q=>ledgerView(q,c.userId,id,'2026-11'));expect(restarted.records).toHaveLength(20);
 });
 it('study SQL page is bounded, total and minutes cover all records; default legacy response remains full',async()=>{
  const c=await setup();const result=await c.run(T,{type:'create_study',name:'阅读',activity:'阅读'});const id=(result.items[0] as any).plan.id;
  for(let i=0;i<41;i++)await c.run(T,{type:'add_study',planId:id,minutes:1,date:'2026-11-17',note:`${i}`});
  const first=await historyRead(c.db,c.userId,undefined,q=>studyView(q,c.userId,id,'2026-11-16','2026-11-17',{limit:20,offset:0}));
  const second=await historyRead(c.db,c.userId,first.dataVersion,q=>studyView(q,c.userId,id,'2026-11-16','2026-11-17',{limit:20,offset:20}));
  expect(first.records).toHaveLength(20);expect(second.records).toHaveLength(20);expect(first.totalRecords).toBe(41);expect(second.stats).toEqual(first.stats);
  expect(new Set([...first.records,...second.records].map(r=>r.id)).size).toBe(40);
  expect((await studyView(c.db,c.userId,id,'2026-11-16','2026-11-17')).records).toHaveLength(41);
 });
 it.skipIf(!process.env.TEST_DATABASE_URL)('concurrent commit cannot mix old counts with new records in one page',async()=>{
  const c=await setup();await c.run(T,{type:'create_ledger'});const before=await dataVersion(c.db,c.userId);
  await historyRead(c.db,c.userId,before,async q=>{
   await c.run(T,{type:'add_expense',amountCents:100,category:'餐饮',date:'2026-11-17'});
   expect(await dataVersion(q,c.userId)).toBe(before);expect(await q.query('SELECT id FROM records')).toHaveLength(0);return null;
  });expect(await dataVersion(c.db,c.userId)).toBeGreaterThan(before);
 });
 it('same timestamp and microseconds survive all cursor pages without gaps or repeats',async()=>{
  const c=await setup();const chat=new Chat(c.db,new FakeLlm(()=>({intent:'smalltalk'})));
  for(let i=0;i<57;i++)await c.db.query("INSERT INTO messages(id,user_id,role,text,created_at) VALUES($1,$2,'assistant',$3,$4)",[randomUUID(),c.userId,`消息${i}`,i<53?'2026-11-17T04:00:00.123456Z':'2026-11-17T04:00:00.123457Z']);
  const one=await chat.historyPage(c.userId,50);const two=await chat.historyPage(c.userId,50,undefined,undefined,one.nextCursor!);
  expect(one.messages).toHaveLength(50);expect(two.messages).toHaveLength(7);expect(two.nextCursor).toBeNull();expect(new Set([...one.messages,...two.messages].map(m=>m.id)).size).toBe(57);
  const other=await setup();await expect(chat.historyPage(other.userId,50,undefined,undefined,one.nextCursor!)).rejects.toMatchObject({code:'invalid_input'});
  await expect(chat.historyPage(c.userId,50,T,undefined,one.nextCursor!)).rejects.toMatchObject({code:'invalid_input'});
  expect(await chat.history(c.userId,50,'2026-11-18T00:00:00Z')).toHaveLength(50);
 });
 it('invalid cursor is rejected rather than silently starting a different page',async()=>{
  const c=await setup();await expect(new Chat(c.db,new FakeLlm(()=>({intent:'smalltalk'}))).historyPage(c.userId,50,undefined,undefined,'invalid')).rejects.toMatchObject({code:'invalid_input'});
 });
});
