import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Chat, type Card } from '../src/services/chat.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { setup } from './helpers.js';
const T = new Date('2026-11-17T12:00:00+08:00');
const write = (id: string | null): TurnWrite => ({ op:'delete_record',is_fact:true,amount_text:null,currency:'CNY',duration_value:null,duration_unit:null,category:null,date_kind:'today',days_ago:null,date:null,note:null,plan_id:null,plan_name:null,activity:null,days_per_week:null,min_minutes:null,scope:'unspecified',record_id:id,component:null });
const clarify = (cards: Card[]) => cards.find(c=>c.type==='clarify') as Extract<Card,{type:'clarify'}>;
async function fixture() {
 const c=await setup(); await c.run(T.toISOString(),{type:'create_ledger'});
 const result=await c.run(T.toISOString(),...['午饭','晚饭'].map(note=>({type:'add_expense' as const,amountCents:2000,category:'餐饮' as const,date:'2026-11-17',note})));
 const ids=result.items.flatMap(i=>'record' in i ? [i.record.id]:[]);
 const llm=new FakeLlm(()=>({intent:'write',writes:[write(ids[0]!)]})),chat=new Chat(c.db,llm);
 const send=(text:string,extra:Partial<Parameters<Chat['send']>[1]>={})=>chat.send(c.userId,{clientMsgId:randomUUID(),text,inputAt:T,...extra});
 const deleted=()=>c.db.query('SELECT id FROM records WHERE deleted ORDER BY id');
 return {...c,ids,chat,llm,send,deleted};
}
describe('server verified single deletion targets',()=>{
 it('C037: model concrete ID cannot select between records in the last batch; server option deletes only selected and replays',async()=>{
  const c=await fixture(); const first=await c.send('删掉刚才的记录'); expect(await c.deleted()).toEqual([]);
  const prompt=clarify(first.assistant.cards); expect(prompt.options.filter(x=>x.style!=='cancel')).toHaveLength(2);
  const choice=prompt.options.find(x=>x.label.includes('晚饭'))!; const input={clientMsgId:randomUUID(),pendingId:prompt.pendingId,choice:choice.id};
  const saved=await c.send(choice.label,input); expect(await c.deleted()).toEqual([{id:c.ids[1]}]);
  expect((await c.send(choice.label,input)).assistant.id).toBe(saved.assistant.id); expect(c.llm.calls).toHaveLength(1);
 });
 it('model followup cannot replace the server selection',async()=>{
  const c=await fixture(); await c.send('删掉刚才的记录'); await c.send('嗯，确认'); expect(await c.deleted()).toEqual([]);
 });
 it('legacy set-record-id pending cannot authorize an ambiguous target',async()=>{
  const c=await fixture(); const p=clarify((await c.send('删掉刚才的记录')).assistant.cards);
  const [row]=await c.db.query<{draft:any}>('SELECT draft FROM pending_actions WHERE id=$1',[p.pendingId]);
  const choice=p.options.find(x=>x.style!=='cancel')!; row!.draft.options.find((x:any)=>x.id===choice.id).patches=[{k:'set',idx:0,field:'record_id',value:c.ids[0]}];
  await c.db.query('UPDATE pending_actions SET draft=$2 WHERE id=$1',[p.pendingId,JSON.stringify(row!.draft)]);
  expect(clarify((await c.send(choice.label,{pendingId:p.pendingId,choice:choice.id})).assistant.cards)).toBeDefined(); expect(await c.deleted()).toEqual([]);
 });
 it('changed selected record requires a new choice rather than deleting its unseen value',async()=>{
  const c=await fixture(); const p=clarify((await c.send('删掉刚才的记录')).assistant.cards); const choice=p.options.find(x=>x.label.includes('午饭'))!;
  await c.run(T.toISOString(),{type:'edit_record',recordId:c.ids[0]!,patch:{amountCents:3000}});
  expect(clarify((await c.send(choice.label,{pendingId:p.pendingId,choice:choice.id})).assistant.cards)).toBeDefined(); expect(await c.deleted()).toEqual([]);
 });
 it('explicit unique note still deletes the named record',async()=>{
  const c=await fixture(); await c.send('删除午饭那笔'); expect(await c.deleted()).toEqual([{id:c.ids[0]}]);
 });
 it('mentioning two named records does not authorize the model to choose the negated one',async()=>{
  const c=await fixture(); const out=await c.send('不要删除午饭，删除晚饭');expect(await c.deleted()).toEqual([]);expect(clarify(out.assistant.cards)).toBeDefined();
 });
 it('a cross-kind negated target requires a server choice; selecting study preserves the expense',async()=>{
  const c=await fixture();await c.run(T.toISOString(),{type:'create_study',activity:'阅读',daysPerWeek:3,minMinutes:10});
  const [plan]=await c.db.query<{id:string}>("SELECT id FROM plans WHERE user_id=$1 AND kind='study'",[c.userId]);
  const saved=await c.run(T.toISOString(),{type:'add_study',planId:plan!.id,minutes:10,date:'2026-11-17',note:'读书'});
  const study=saved.items.find(item=>'record' in item)!;if(!('record' in study))throw Error();
  const p=clarify((await c.send('不要删除午饭，删除读书')).assistant.cards);expect(p).toBeDefined();expect(await c.deleted()).toEqual([]);
  const choice=p.options.find(option=>option.label.includes('学习 10 分钟'))!;
  await c.send(choice.label,{pendingId:p.pendingId,choice:choice.id});expect(await c.deleted()).toEqual([{id:study.record.id}]);
 });
 it('two named records across kinds are not a unique explicit deletion target',async()=>{
  const c=await fixture();await c.run(T.toISOString(),{type:'create_study',activity:'阅读',daysPerWeek:3,minMinutes:10});
  const [plan]=await c.db.query<{id:string}>("SELECT id FROM plans WHERE user_id=$1 AND kind='study'",[c.userId]);
  await c.run(T.toISOString(),{type:'add_study',planId:plan!.id,minutes:10,date:'2026-11-17',note:'读书'});
  expect(clarify((await c.send('删除午饭或读书那条')).assistant.cards)).toBeDefined();expect(await c.deleted()).toEqual([]);
 });
 it('a negated named or relative target cannot borrow a deletion verb about another target',async()=>{
  for(const text of ['不要删除午饭，删除未找到的那条','不要删刚才那笔，删除未找到的那条']) {
   const c=await fixture();
   if(text.includes('刚才'))await c.run(T.toISOString(),{type:'edit_record',recordId:c.ids[0]!,patch:{amountCents:3000}});
   expect(clarify((await c.send(text)).assistant.cards)).toBeDefined();expect(await c.deleted()).toEqual([]);
  }
 });
 it('a negated delete with one recent record never executes a model-supplied deletion',async()=>{
  const c=await fixture();const result=await c.run(T.toISOString(),{type:'add_expense',amountCents:500,category:'餐饮',date:'2026-11-17',note:'唯一最近记录'});const item=result.items[0]!;if(!('record' in item))throw Error();c.ids[0]=item.record.id;
  await c.send('不要删掉刚才那笔');expect(await c.deleted()).toEqual([]);
 });
 it('invalid model target cannot fall back to an unrelated recent record',async()=>{
  const c=await fixture(); const chat=new Chat(c.db,new FakeLlm(()=>({intent:'write',writes:[write(randomUUID())]})));
  await chat.send(c.userId,{clientMsgId:randomUUID(),text:'删除刚才那笔',inputAt:T}); expect(await c.deleted()).toEqual([]);
 });
});
