import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openTestDb } from './database.js';
import { recordEntry, linkEntry, linkRequest } from '../src/services/entry.js';
import { productMetrics } from '../src/services/metrics.js';
import { usage, pruneUsage } from '../src/services/usage.js';
import { createApp } from '../src/api/app.js';
import { FakeLlm } from '../src/ai/llm.js';
import { UsageStore, attemptRequestDigest } from '../src/ai/usage-store.js';

it('未登录进入纳入成熟分母，重试不移动窗口，老账户和同账户第二设备不计新增', async () => {
  const db = await openTestDb();
  const now = new Date(), first = new Date(now.getTime()-2*86400_000);
  try {
    const unregistered=randomUUID(), entry=randomUUID(), repeat=randomUUID(), returning=randomUUID();
    for (const id of [unregistered,entry,repeat,returning]) await recordEntry(db,id,first);
    await recordEntry(db,unregistered,now);
    const [fresh] = await db.query<{id:string}>("INSERT INTO users(dev_name,created_at) VALUES('fresh',$1) RETURNING id",[new Date(first.getTime()+1000)]);
    const [old] = await db.query<{id:string}>("INSERT INTO users(dev_name,created_at) VALUES('old',$1) RETURNING id",[new Date(first.getTime()-1000)]);
    await linkEntry(db,fresh!.id,entry);
    await linkEntry(db,fresh!.id,repeat);
    await linkEntry(db,old!.id,returning);
    await linkEntry(db,old!.id,entry); // Cannot reassign a claimed entry.
    await usage(db,fresh!.id,'plan_created','plan',{kind:'ledger',hasGoal:false,latencyMs:1},new Date(first.getTime()+2000));
    await usage(db,fresh!.id,'record_saved','save',{recordId:randomUUID(),kind:'expense',source:'form',latencyMs:1},new Date(first.getTime()+3000));
    const report=await productMetrics(db,now);
    expect(report.activation24h).toEqual({eligible:2,activated:1,rate:0.5});
    const [row]=await db.query<{first_seen_at:Date}>('SELECT first_seen_at FROM usage_entries WHERE entry_id=$1',[unregistered]);
    expect(new Date(row!.first_seen_at)).toEqual(first);
    await db.query('DELETE FROM users WHERE id=$1',[fresh!.id]);
    expect(await db.query('SELECT * FROM usage_entries WHERE entry_id IN ($1,$2)',[entry,repeat])).toEqual([]);
    await db.query("UPDATE usage_entries SET first_seen_at=now()-interval '31 days'");
    await pruneUsage(db);
    expect(await db.query('SELECT * FROM usage_entries')).toEqual([]);
    // Long-lived actor remembers it is returning even after entry expiry.
    const again=randomUUID(); await recordEntry(db,again); await linkEntry(db,old!.id,again);
    expect((await db.query<{returning_user:boolean}>('SELECT returning_user FROM usage_entries'))[0]!.returning_user).toBe(true);
  } finally { await db.close(); }
});

it('首次进入 API 只接受有界随机标识；关联需要登录，不返回用户身份且按共享窗口限流',async()=>{
  const db=await openTestDb();
  const app=createApp(db,new FakeLlm(()=>({intent:'smalltalk',reply:'你好'})),{jwtSecret:new TextEncoder().encode('test-secret-test-secret-test-secret'),appleAudience:'',devLogin:true});
  const post=(path:string,body:unknown,token?:string)=>app.request(path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  try {
    const entryId=randomUUID();
    expect((await post('/v1/usage/entry',{entryId})).status).toBe(202);
    expect((await post('/v1/usage/entry',{entryId,email:'private@example.com'})).status).toBe(400);
    expect((await post('/v1/usage/entry',{entryId:'text'})).status).toBe(400);
    expect((await post('/v1/usage/entry',{entryId,padding:'x'.repeat(1100)})).status).toBe(413);
    expect((await post('/v1/usage/entry/link',{entryId})).status).toBe(401);
    const {token}=await (await post('/v1/auth/dev',{name:'entry-user'})).json() as {token:string};
    expect(await (await post('/v1/usage/entry/link',{entryId},token)).json()).toEqual({ok:true});
    for(let i=0;i<27;i++) expect((await post('/v1/usage/entry',{entryId})).status).toBe(202);
    expect((await post('/v1/usage/entry',{entryId})).status).toBe(429);
    const stored=JSON.stringify(await db.query('SELECT * FROM usage_entries'));
    expect(stored).not.toContain('private@example.com');
    expect(await db.query('SELECT * FROM usage_entries')).toHaveLength(1);
  } finally { await db.close(); }
});

it('追问链成本包含原消息、补充和同请求真实重试，其他消息及其他账户不能混入',async()=>{
  const db=await openTestDb();
  try {
    const [u]=await db.query<{id:string}>("INSERT INTO users(dev_name) VALUES('cost-chain') RETURNING id");
    const [other]=await db.query<{id:string}>("INSERT INTO users(dev_name) VALUES('other') RETURNING id");
    const userId=u!.id;
    const [m]=await db.query<{id:string}>("INSERT INTO messages(user_id,role,text,client_msg_id) VALUES($1,'user','不进入埋点','root') RETURNING id",[userId]);
    await linkRequest(db,userId,'root');
    await linkRequest(db,userId,'answer',m!.id);
    await linkRequest(db,userId,'unrelated');
    await linkRequest(db,other!.id,'answer',m!.id); // Cross-account origin is ignored.
    const store=new UsageStore(db,1000000000000000n);
    for (const [owner,requestId,cost] of [[userId,'root',2n],[userId,'answer',3n],[userId,'answer',5n],[userId,'unrelated',100n],[other!.id,'answer',200n]] as const) {
      const attemptId=randomUUID();
      await store.start({attemptId,userId:owner,requestId,model:'synthetic',role:'primary',mode:'compact',at:new Date(),priceVersion:'test'});
      await store.finish({attemptId,latencyMs:1,error:null,usage:{prompt:1,completion:1},cost:{pico:cost,status:'known',priceVersion:'test'}});
    }
    await usage(db,userId,'operation','operation',{operationId:randomUUID(),source:'chat',requestHash:attemptRequestDigest(userId,'answer'),rootHash:attemptRequestDigest(userId,'root')});
    const report=await productMetrics(db,new Date(Date.now()+1000));
    expect(report.modelCost).toMatchObject({associatedSuccessfulOperations:1,knownCostPico:'10',unknownAttempts:0,averageObservedKnownCostPico:'10'});
    expect(JSON.stringify(await db.query('SELECT * FROM usage_request_links'))).not.toContain('不进入埋点');
    await db.query('DELETE FROM users WHERE id=$1',[userId]);
    expect((await db.query('SELECT * FROM usage_request_links')).length).toBe(1);
  } finally { await db.close(); }
});
