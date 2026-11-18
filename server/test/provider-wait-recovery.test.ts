import { describe,expect,it,vi } from 'vitest';
import { createRuntimeLlm } from '../src/ai/runtime.js';
import { recoveryTimeoutMs } from '../src/ai/provider.js';
import { loadRuntimeConfig } from '../src/ai/runtime-config.js';
import { Chat } from '../src/services/chat.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { setup } from './helpers.js';
const model='baidu/ernie-5.5-flash-preview:free';
const T=new Date('2026-11-16T04:00:00Z');
const env={AI_PROVIDER:'openrouter',OPENROUTER_MODEL:model,OPENROUTER_API_KEY:'synthetic-provider-wait-key'};
const auth={jwtSecret:new TextEncoder().encode('synthetic-wait-recovery-signing-key-32bytes'),appleAudience:null,devLogin:false};
const response=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'write',writes:[{op:'add_expense',is_fact:true,amount_text:'18',currency:'CNY',category:'餐饮',date_kind:'today',note:'合成慢响应'}]})},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}}),{headers:{'content-type':'application/json'}});

describe('免费provider长等待与原消息恢复（本地HTTP，无外部请求）',()=>{
 it('延长策略只适用OpenRouter免费模型，原预算和其它provider保持不变',()=>{
  expect(recoveryTimeoutMs({},'openrouter',model)).toBe(60000);
  expect(recoveryTimeoutMs({OPENROUTER_TIMEOUT_MS:'45000'},'openrouter',model)).toBe(45000);
  expect(recoveryTimeoutMs({OPENROUTER_TIMEOUT_MS:'60000'},'qwen','qwen3.8-max')).toBeUndefined();
  expect(recoveryTimeoutMs({},'openrouter','paid-model')).toBeUndefined();
  for(const timeout of ['19000','60001','60s','NaN','30000.5'])expect(()=>recoveryTimeoutMs({OPENROUTER_TIMEOUT_MS:timeout},'openrouter',model)).toThrow('OPENROUTER_TIMEOUT_MS');
  expect(loadRuntimeConfig({},model,'compact')).toMatchObject({timeoutMs:20000,fallback:null,monthlyBudgetCny:'1000'});
 });
 it('真实runtime工厂让恢复客户端超过30s仍processing，同ID并发/核对不再发模型，完成只写一条',async()=>{
  const c=await setup();let release!:(response:Response)=>void;let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  await c.run(T.toISOString(),{type:'create_ledger'});const token=await issueToken(auth,c.userId,0);
  vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{calls++;started();return new Promise<Response>((resolve,reject)=>{release=resolve;init?.signal?.addEventListener('abort',()=>reject(new DOMException('synthetic abort','AbortError')),{once:true});});}));
  try{
   const llm=createRuntimeLlm(c.db,env),chat=new Chat(c.db,llm),app=createApp(c.db,llm,auth);
   const input={clientMsgId:'slow-success-fixed-id',text:'午饭18元',inputAt:T,recoveryCapability:true};
   vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
   const first=chat.send(c.userId,input);await begun;await vi.advanceTimersByTimeAsync(30001);
   const lookup=await app.request(`/v1/chat/${input.clientMsgId}`,{headers:{authorization:`Bearer ${token}`}});expect(await lookup.json()).toEqual({status:'processing'});
   expect(await c.db.query('SELECT id FROM records WHERE user_id=$1',[c.userId])).toEqual([]);
   const concurrent=chat.send(c.userId,input);expect(calls).toBe(1);release(response());
   const [a,b]=await Promise.all([first,concurrent]);expect(a.transient).toBe(false);expect(a.assistant.id).toBe(b.assistant.id);
   vi.useRealTimers();expect((await chat.lookup(c.userId,input.clientMsgId))?.assistant.id).toBe(a.assistant.id);
   expect((await chat.send(c.userId,input)).assistant.id).toBe(a.assistant.id);expect(calls).toBe(1);expect(await c.db.query('SELECT id FROM records WHERE user_id=$1',[c.userId])).toHaveLength(1);
  }finally{vi.useRealTimers();vi.unstubAllGlobals();await c.db.close();}
 });
 it.each([{provider:'openrouter',recoveryCapability:false,ms:20000},{provider:'openrouter',recoveryCapability:true,ms:60000},{provider:'qwen',recoveryCapability:true,ms:20000}])('$provider 能力=$recoveryCapability 在$ms ms上限退出，核对无事实后同ID可显式重试',async({provider,recoveryCapability,ms})=>{
  const c=await setup();await c.run(T.toISOString(),{type:'create_ledger'});let calls=0;let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});
  vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{calls++;if(calls>1)return response();started();return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('synthetic timeout','AbortError')),{once:true});});}));
  try{
   const llm=createRuntimeLlm(c.db,provider==='qwen'?{AI_PROVIDER:'qwen',QWEN_API_KEY:'synthetic-qwen-key',OPENROUTER_TIMEOUT_MS:'60000'}:env),chat=new Chat(c.db,llm);const input={clientMsgId:`timeout-fixed-${ms}`,text:'午饭18元',inputAt:T,recoveryCapability};
   vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const pending=chat.send(c.userId,input);await begun;await vi.advanceTimersByTimeAsync(ms-1);expect(chat.processing(c.userId,input.clientMsgId)).toBe(true);await vi.advanceTimersByTimeAsync(2);const first=await pending;vi.useRealTimers();
   expect(first.transient).toBe(true);expect(first.assistant.cards[0]).toMatchObject({type:'error',code:'model_unavailable',retryable:true,message:'AI处理超时。这次没有更改计划或记录。可以稍后重试，或在恢复提示里取消本次重试后，到计划详情手动记录。'});expect(JSON.stringify(first)).not.toContain('什么都没有保存');expect(calls).toBe(1);expect(chat.processing(c.userId,input.clientMsgId)).toBe(false);expect(await chat.lookup(c.userId,input.clientMsgId)).toBeNull();expect(await c.db.query('SELECT id FROM records WHERE user_id=$1',[c.userId])).toEqual([]);
   const retried=await chat.send(c.userId,input);expect(retried.transient).toBe(false);expect(calls).toBe(2);expect(await c.db.query('SELECT id FROM records WHERE user_id=$1',[c.userId])).toHaveLength(1);expect(await c.db.query("SELECT id FROM messages WHERE user_id=$1 AND client_msg_id=$2 AND role='user'",[c.userId,input.clientMsgId])).toHaveLength(1);
   expect((await chat.send(c.userId,input)).assistant.id).toBe(retried.assistant.id);expect(calls).toBe(2);
  }finally{vi.useRealTimers();vi.unstubAllGlobals();await c.db.close();}
 });
});
