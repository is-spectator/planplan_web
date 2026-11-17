import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { Chat,type Card } from '../src/services/chat.js';
import { execute,type Action } from '../src/services/engine.js';
import { setup } from './helpers.js';
const today='2026-11-16',T=new Date('2026-11-16T04:00:00Z');
const w=(op:TurnWrite['op'],patch:Partial<TurnWrite>={}):TurnWrite=>({op,is_fact:true,amount_text:null,currency:'CNY',duration_value:null,duration_unit:null,category:null,date_kind:'today',days_ago:null,date:null,note:null,plan_id:null,plan_name:null,activity:null,days_per_week:null,min_minutes:null,scope:'unspecified',record_id:null,component:null,...patch});
const card=<K extends Card['type']>(cards:Card[],type:K)=>cards.find(c=>c.type===type) as Extract<Card,{type:K}>|undefined;
async function scenario(){
 const c=await setup();const ctx={...c.at(T.toISOString()),templateCapability:true,ledgerTemplateCapability:true,genericCapability:true};
 const run=(...actions:Action[])=>execute(c.db,ctx,randomUUID(),actions);
 await run({type:'create_ledger'});const reading=(await run({type:'adopt_template',templateId:'official.reading',templateVersion:1})).templatePlan!,water=(await run({type:'adopt_template',templateId:'official.water',templateVersion:1})).templatePlan!;
 const llm=new FakeLlm(text=>{
  if(text.includes('撤销'))return {intent:'write',writes:[w('undo_last')]};
  if(text==='目标2000ml')return {intent:'write',writes:[w('configure_generic_plan',{plan_id:water.planId,generic_fields:[{field_id:'dailyGoalMl',value:2000,unit:'ml',unit_size:null,unit_size_unit:null}]})]};
  if(text.includes('查询'))return {intent:'query',query:{kind:'generic_summary',plan_id:water.planId,period:'today',from:null,to:null,category:null}};
  if(text.includes('阅读'))return {intent:'write',writes:[w('add_expense',{amount_text:'31',category:'餐饮',note:'晚饭'}),w('add_study',{plan_id:reading.planId,duration_value:25,duration_unit:'minute'}),w('add_generic_record',{plan_id:water.planId,generic_fields:[{field_id:'amountMl',value:300,unit:'ml',unit_size:null,unit_size_unit:null}]})]};
  return {intent:'write',writes:[w('add_expense',{amount_text:text.includes('咖啡')?'12':text.includes('早餐')?'10':'18',category:'餐饮',note:text.includes('咖啡')?'咖啡':text.includes('早餐')?'早餐':'午饭'})]};
 });const chat=new Chat(c.db,llm);
 const send=(text:string,extra:Partial<Parameters<Chat['send']>[1]>={})=>chat.send(c.userId,{clientMsgId:randomUUID(),text,inputAt:T,templateCapability:true,ledgerTemplateCapability:true,genericCapability:true,...extra});
 const rows=()=>c.db.query<{id:string;kind:string;fields:Record<string,unknown>;note:string;deleted:boolean;version:number}>('SELECT id,kind,fields,note,deleted,version FROM records WHERE user_id=$1 ORDER BY created_at',[c.userId]);
 const later=()=>run({type:'add_generic_record',planId:water.planId,values:{date:today,amountMl:50,note:'后来手动'}});
 return {...c,ctx,run,reading,water,chat,send,rows,later};
}
describe('自然语言撤销绑定对话回执',()=>{
 it('三类chat→later form50→undo_last撤原整批；查询和同体恢复不漂移目标',async()=>{
  const c=await scenario(),batch=card((await c.send('晚饭31元，阅读25分钟，饮水300ml')).assistant.cards,'receipt')!;const later=await c.later();await c.send('查询饮水');
  const key=randomUUID(),reply=await c.send('撤销刚才那一组晚饭、阅读和饮水记录。',{clientMsgId:key});const undone=card(reply.assistant.cards,'receipt')!;
  expect(undone.items[0]).toMatchObject({type:'undone',of:batch.operationId});expect(undone.items[0]).not.toMatchObject({of:later.operationId});const active=(await c.rows()).filter(row=>!row.deleted);expect(active).toHaveLength(1);expect(active[0]!.fields.amountMl).toBe(50);expect(active[0]!.note).toBe('后来手动');
  expect((await c.send('撤销刚才那一组晚饭、阅读和饮水记录。',{clientMsgId:key})).assistant.id).toBe(reply.assistant.id);expect((await c.chat.lookup(c.userId,key))!.assistant.id).toBe(reply.assistant.id);
 });
 it('裸撤销列出对话候选；选择期间再保存也只撤固定原批次',async()=>{
  const c=await scenario(),first=card((await c.send('午饭18元')).assistant.cards,'receipt')!;await c.send('早餐10元');await c.later();
  const pending=card((await c.send('撤销')).assistant.cards,'clarify')!;expect(pending.hint).toContain('还没有撤销');expect(pending.options.filter(o=>o.style!=='cancel')).toHaveLength(2);expect(pending.options.some(o=>o.label.includes('后来手动'))).toBe(false);expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
  const option=pending.options.find(o=>o.label.includes('午饭'))!;await c.send('咖啡12元');const reply=await c.send(option.label,{pendingId:pending.pendingId,choice:option.id});expect(card(reply.assistant.cards,'receipt')!.items[0]).toMatchObject({type:'undone',of:first.operationId});expect((await c.rows()).filter(row=>!row.deleted).map(row=>row.note)).toEqual(['早餐','后来手动','咖啡']);
  await c.send(option.label,{pendingId:pending.pendingId,choice:option.id});expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(1);
 });
 it('描述与最新对话不符时先选较早整批，不自动撤单条',async()=>{
  const c=await scenario(),batch=card((await c.send('晚饭31元，阅读25分钟，饮水300ml')).assistant.cards,'receipt')!;await c.send('咖啡12元');const reply=await c.send('撤销刚才那一组晚饭、阅读和饮水记录');const pending=card(reply.assistant.cards,'clarify')!;expect(pending.options.filter(o=>o.style!=='cancel')).toHaveLength(1);expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
  const option=pending.options.find(o=>o.style!=='cancel')!;const chosen=await c.send(option.label,{pendingId:pending.pendingId,choice:option.id});expect(card(chosen.assistant.cards,'receipt')!.items[0]).toMatchObject({of:batch.operationId});expect((await c.rows()).filter(row=>!row.deleted).map(row=>row.note)).toEqual(['咖啡']);
 });
 it('上一批已撤销后再说撤销刚才，不自动跳到更早批次',async()=>{
  const c=await scenario();await c.send('午饭18元');await c.send('咖啡12元');await c.send('撤销刚才');const twice=await c.send('撤销刚才');expect(twice.assistant.text).toContain('已撤销或不能撤销');expect((await c.rows()).filter(row=>!row.deleted).map(row=>row.note)).toEqual(['午饭']);
 });
 it('刚才是不可撤销的模板设置时不撤更早事实，只有form时不撤form',async()=>{
  const c=await scenario();await c.later();expect((await c.send('撤销刚才')).assistant.text).toContain('没有找到');expect((await c.rows()).filter(row=>!row.deleted)).toHaveLength(1);
  await c.send('午饭18元');await c.send('目标2000ml',{scopePlanId:c.water.planId});expect((await c.send('撤销刚才')).assistant.text).toContain('不能撤销');expect((await c.rows()).filter(row=>!row.deleted)).toHaveLength(2);
 });
 it('旧客户端不跳过含generic的最后批次撤更早账本；跨scope不引用看不见的回执',async()=>{
  const c=await scenario();await c.send('午饭18元');await c.send('晚饭31元，阅读25分钟，饮水300ml');const old=await c.send('撤销刚才',{genericCapability:false});expect(old.assistant.text).toContain('新版网页');expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
  const scoped=await c.send('撤销刚才',{scopePlanId:c.water.planId});expect(scoped.assistant.text).toContain('没有找到');expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
 });
 it('丢失assistant回复仍从原chat操作恢复，撤销不偏向后来form',async()=>{
  const c=await scenario(),saved=await c.send('晚饭31元，阅读25分钟，饮水300ml'),batch=card(saved.assistant.cards,'receipt')!;await c.db.query('DELETE FROM messages WHERE user_id=$1 AND id=$2',[c.userId,saved.assistant.id]);await c.later();const history=await c.chat.history(c.userId);expect(history.some(message=>message.id.startsWith('recovered:'))).toBe(true);
  const reply=await c.send('撤销刚才那一组晚饭、阅读和饮水记录，保留后来手动新增的记录');expect(card(reply.assistant.cards,'receipt')!.items[0]).toMatchObject({of:batch.operationId});expect((await c.rows()).filter(row=>!row.deleted).map(row=>row.note)).toEqual(['后来手动']);
 });
 it('取消撤销选择明确保留原记录，之后的新记录也不受影响',async()=>{
  const c=await scenario();await c.send('午饭18元');const pending=card((await c.send('撤销')).assistant.cards,'clarify')!;await c.later();const option=pending.options.find(o=>o.style==='cancel')!;const reply=await c.send(option.label,{pendingId:pending.pendingId,choice:option.id});expect(reply.assistant.text).toBe('好的，保留原记录，没有撤销。');expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
 });
 it('明确提到未知记录名称时不把最新可见回执当成该记录',async()=>{
  const c=await scenario();await c.send('咖啡12元');const reply=await c.send('撤销刚才买药的那笔');expect(card(reply.assistant.cards,'receipt')).toBeUndefined();expect(card(reply.assistant.cards,'clarify')).toBeDefined();expect((await c.rows()).filter(row=>row.deleted)).toHaveLength(0);
 });
 it('选定批次已有修改，撤销冲突整批不变且不撤later form',async()=>{
  const c=await scenario();await c.send('晚饭31元，阅读25分钟，饮水300ml');const pending=card((await c.send('撤销')).assistant.cards,'clarify')!;const record=(await c.rows()).find(row=>row.kind==='generic')!;await c.run({type:'edit_generic_record',recordId:record.id,expectedVersion:record.version,values:{date:today,amountMl:350}});await c.later();const option=pending.options.find(o=>o.style!=='cancel')!;const reply=await c.send(option.label,{pendingId:pending.pendingId,choice:option.id});expect(card(reply.assistant.cards,'error')).toMatchObject({code:'undo_conflict'});expect((await c.rows()).filter(row=>!row.deleted)).toHaveLength(4);
 });
});
