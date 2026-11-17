import { OpenAICompatibleLlm } from '../src/ai/llm.js';
import { runQuery } from '../src/services/query.js';
import type { TurnQuery } from '../src/ai/turn.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { unzipSync,strFromU8 } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { execute,undo,type Action,type ExecContext,type OperationResult } from '../src/services/engine.js';
import { executeForm } from '../src/services/form-operations.js';
import { genericSummary,genericView,normalizeGenericFieldValue,validateGenericRecordValues,supportsGenericRuntime } from '../src/services/generic.js';
import { getPlanTemplate,listAvailableTemplates } from '../src/services/templates.js';
import { WATER_TEMPLATE } from '../src/templates/definitions.js';
import { templateDefinitionSchema,type GenericValues,type TemplateDefinition } from '../src/templates/contracts.js';
import { buildExport } from '../src/services/export.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { getRecord } from '../src/services/repo.js';
import { planCards,ledgerView } from '../src/services/views.js';
import { migrate,MIGRATIONS } from '../src/db/migrations.js';

const today='2026-11-16';
const record=(r:OperationResult)=>{const item=r.items[0];if(!item||!('record'in item))throw new Error('record missing');return item.record;};
describe('真正的通用模板运行时',()=>{
 let db:Db,userId:string,n=0;
 const ctx=(day=today):ExecContext=>({userId,inputAt:new Date(`${day}T04:00:00Z`),source:'form',templateCapability:true,ledgerTemplateCapability:true,genericCapability:true});
 const run=(a:Action[],id=`generic-${++n}`,day=today)=>execute(db,ctx(day),id,a);
 const adopt=async(id='official.water')=>(await run([{type:'adopt_template',templateId:id,templateVersion:1}])).templatePlan!;
 const configure=async(planId:string,values:GenericValues,goalScope:'current_only'|'current_and_future'|'next_and_future'='current_and_future',day=today)=>run([{type:'configure_generic_plan',planId,expectedVersion:(await getPlanTemplate(db,userId,planId,day)).config.version,patch:{values},goalScope,completeSetup:true}],undefined,day);
 const add=(planId:string,amountMl:number,date=today,units?:Record<string,string>)=>run([{type:'add_generic_record',planId,values:{date,amountMl},units}]);
 beforeAll(async()=>{db=await openTestDb();});afterAll(async()=>{await db.close();});
 beforeEach(async()=>{const [u]=await db.query<{id:string}>('INSERT INTO users(dev_name)VALUES($1)RETURNING id',[`generic-${++n}`]);userId=u!.id;});
 it('设置目标不造事实；300ml+0.5L精确为800，退款/阅读不污染统计',async()=>{
  const p=await adopt();expect(p.config).toMatchObject({setupStatus:'pending',values:{dailyGoalMl:null},canChangeStartDate:true});
  await configure(p.planId,{dailyGoalMl:2000});expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(0);
  await run([{type:'create_ledger',budgetCents:10000},{type:'create_study',name:'阅读'}]);
  const expense=record(await run([{type:'add_expense',date:today,amountCents:500,category:'餐饮'}]));
  await run([{type:'add_refund',expenseId:expense.id,date:today,amountCents:100}]);
  await add(p.planId,300);const r=record(await add(p.planId,.5,today,{amountMl:'L'}));
  expect(r).toMatchObject({kind:'generic',fields:{date:today,amountMl:500},definitionVersion:1,amountCents:null,minutes:null});
  const s=await genericSummary(db,userId,p.planId,today,today);expect(s).toMatchObject({recordCount:2,metrics:[{id:'dailyMl',value:800},{id:'progress',value:800,target:2000,remaining:1200,progressPct:40}]});
  const cards=await planCards(db,userId,today,'active');expect(cards.plans.find(c=>c.plan.id===p.planId)?.generic).toEqual(s);
 });
 it.each([{amountMl:.5},{amountMl:0},{amountMl:-1},{amountMl:100001},{amountMl:'500'},{amountMl:500,unknown:1},{amountMl:500,date:'2026-02-31'},{amountMl:500,date:'2026-11-17'}])('字段、范围、日期不合法整次无写入 %#',async values=>{
  const p=await adopt();await expect(run([{type:'add_generic_record',planId:p.planId,values:{date:today,...values} as GenericValues}])).rejects.toBeDefined();
  expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(0);
 });
 it('L小数精确换算，不把不完整毫升四舍五入或猜测杯',()=>{
  const field=WATER_TEMPLATE.recordFields[1]!;
  expect(normalizeGenericFieldValue(field,.1,'L')).toBe(100);
  for(const [value,unit] of [[.0001,'L'],[2,'杯'],[.5,'ml']] as const)expect(()=>normalizeGenericFieldValue(field,value,unit)).toThrow();
  expect(()=>validateGenericRecordValues(WATER_TEMPLATE,{date:today,amountMl:300},{note:'ml'},today)).toThrow();
 });
 it('版本化编辑、删、撤销恢复规范字段；后来修改使整批撤销冲突而不部分保存',async()=>{
  const p=await adopt(),first=await add(p.planId,300),r=record(first);
  const edited=await run([{type:'edit_generic_record',recordId:r.id,expectedVersion:r.version,values:{date:today,amountMl:.5,note:'更新'},units:{amountMl:'L'}}]);
  const next=record(edited);expect(next.fields?.amountMl).toBe(500);
  await expect(run([{type:'edit_generic_record',recordId:r.id,expectedVersion:1,values:{date:today,amountMl:700}}])).rejects.toMatchObject({code:'version_conflict'});
  await undo(db,ctx(),edited.operationId,`undo-${++n}`);expect((await getRecord(db,userId,r.id)).fields).toEqual(r.fields);
  const restored=await getRecord(db,userId,r.id);const deleted=await run([{type:'delete_record',recordId:r.id,expectedVersion:restored.version}]);
  expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(0);
  await undo(db,ctx(),deleted.operationId,`undo-${++n}`);expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(1);
  const batch=await run([{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:100}},{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:200}}]);
  const one=batch.items[0];if(!one||one.type!=='generic_added')throw new Error('missing');
  await run([{type:'edit_generic_record',recordId:one.record.id,expectedVersion:1,values:{date:today,amountMl:150}}]);
  await expect(undo(db,ctx(),batch.operationId,`conflict-${++n}`)).rejects.toMatchObject({code:'undo_conflict'});
  expect((await genericSummary(db,userId,p.planId,today,today)).metrics[0]?.value).toBe(650);
 });
 it('同ID并发撤销只执行一次，丢响应重试允许新时刻但不能换目标',async()=>{
  const p=await adopt(),saved=await add(p.planId,300),r=record(saved),id=`undo-retry-${++n}`;
  const [a,b]=await Promise.all([undo(db,ctx(),saved.operationId,id),undo(db,ctx(),saved.operationId,id)]);
  expect(a.operationId).toBe(b.operationId);expect((await getRecord(db,userId,r.id)).version).toBe(2);
  expect((await undo(db,ctx('2026-11-17'),saved.operationId,id)).operationId).toBe(a.operationId);
  const another=await add(p.planId,500);await expect(undo(db,ctx(),another.operationId,id)).rejects.toMatchObject({code:'operation_changed'});
  expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(1);
 });
 it('三引擎事实批次原子提交，非法末项回滚；撤销只影响本批而保留后来新增',async()=>{
  const p=await adopt();const setup=await run([{type:'create_ledger'},{type:'create_study',name:'阅读'}]);const study=setup.items.find(i=>i.type==='plan_created'&&i.plan.kind==='study');if(study?.type!=='plan_created')throw new Error('study');
  const actions:Action[]=[{type:'add_expense',amountCents:1800,category:'餐饮',date:today},{type:'add_study',planId:study.plan.id,minutes:20,date:today},{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:300}}];
  await expect(run([...actions,{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:-1}}])).rejects.toMatchObject({code:'invalid_input'});
  expect(await db.query('SELECT id FROM records WHERE user_id=$1',[userId])).toEqual([]);
  const batch=await run(actions);expect(batch.items.map(i=>i.type)).toEqual(['expense_added','study_added','generic_added']);
  const later=record(await add(p.planId,500));await undo(db,ctx(),batch.operationId,`mixed-undo-${++n}`);
  expect((await genericSummary(db,userId,p.planId,today,today)).metrics[0]?.value).toBe(500);expect((await getRecord(db,userId,later.id)).deleted).toBe(false);
 });
 it('每日报目标段支持仅今天覆盖、明天生效和清空；配置不覆盖历史事实',async()=>{
  const p=await adopt();await configure(p.planId,{dailyGoalMl:2000});await add(p.planId,300);
  await configure(p.planId,{dailyGoalMl:1000},'next_and_future');
  expect((await getPlanTemplate(db,userId,p.planId,today)).config).toMatchObject({values:{dailyGoalMl:2000},nextPeriodValues:{dailyGoalMl:{startsOn:'2026-11-17',value:1000}}});
  await configure(p.planId,{dailyGoalMl:null},'current_only');
  expect((await genericSummary(db,userId,p.planId,today,today)).metrics[1]).toMatchObject({target:null,value:300});
  expect((await getPlanTemplate(db,userId,p.planId,'2026-11-17')).config.values?.dailyGoalMl).toBe(1000);
  await configure(p.planId,{dailyGoalMl:null},'next_and_future');expect((await getPlanTemplate(db,userId,p.planId,'2026-11-17')).config.values?.dailyGoalMl).toBe(null);
  const current=await getPlanTemplate(db,userId,p.planId,today);await expect(run([{type:'configure_generic_plan',planId:p.planId,expectedVersion:current.config.version,patch:{startDate:'2026-11-01'}}])).rejects.toMatchObject({code:'invalid_input'});
 });
 it('所有旧入口包括回放和undo拒绝无generic能力；跨账户归属实际校验',async()=>{
  const p=await adopt(),saved=await add(p.planId,300),r=record(saved),legacy={...ctx(),genericCapability:false};
  const actions:Action[]=[{type:'rename_plan',planId:p.planId,name:'改名'},{type:'archive_plan',planId:p.planId},{type:'restore_plan',planId:p.planId},{type:'set_view',planId:p.planId,order:['records']},{type:'delete_record',recordId:r.id,expectedVersion:1},{type:'edit_record',recordId:r.id,patch:{note:'不能改'}}];
  for(const a of actions)await expect(execute(db,legacy,`old-${++n}`,[a])).rejects.toMatchObject({code:'invalid_input'});
  await expect(execute(db,legacy,saved.clientOpId,[{type:'add_generic_record',planId:p.planId,values:r.fields!}])).rejects.toMatchObject({code:'invalid_input'});
  await expect(undo(db,legacy,saved.operationId,`old-undo-${++n}`)).rejects.toMatchObject({code:'invalid_input'});
  await expect(run([{type:'delete_record',recordId:r.id}])).rejects.toMatchObject({code:'invalid_input'});
  await expect(run([{type:'set_goal',planId:p.planId,param:'min_minutes',value:20,scope:'current_and_future'}])).rejects.toMatchObject({code:'kind_mismatch'});
  const [other]=await db.query<{id:string}>(`INSERT INTO users(dev_name)VALUES($1)RETURNING id`,[`other-${++n}`]);
  await expect(execute(db,{...ctx(),userId:other!.id},`foreign-${++n}`,[{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:300}}])).rejects.toMatchObject({code:'not_found'});
  await expect(genericView(db,other!.id,p.planId,today)).rejects.toMatchObject({code:'not_found'});
  const undone=await undo(db,ctx(),saved.operationId,`real-undo-${++n}`);await expect(undo(db,legacy,saved.operationId,undone.clientOpId)).rejects.toMatchObject({code:'invalid_input'});
 });
 it('恢复同ID同体返回同一条；异体拒绝；规范单位重复需确认且整批不保存',async()=>{
  const p=await adopt(),a:Action={type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:500}};
  const first=await executeForm(db,ctx(),'replay-'+n,[a],{inputAtProvided:true});const repeated=await executeForm(db,ctx(),first.clientOpId,[a],{inputAtProvided:true});expect(repeated.operationId).toBe(first.operationId);
  await expect(run([{...a,values:{date:today,amountMl:600}}],first.clientOpId)).rejects.toMatchObject({code:'operation_changed'});
  let token='';try{await executeForm(db,ctx(),'duplicate-'+n,[{...a,values:{date:today,amountMl:.5},units:{amountMl:'L'}}],{inputAtProvided:true});}catch(e){expect(e).toMatchObject({code:'duplicate_confirmation_required'});token=(e as any).details.confirmationId;}
  expect(token).not.toBe('');expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(1);
  await executeForm(db,ctx(),'duplicate-'+n,[{...a,values:{date:today,amountMl:.5},units:{amountMl:'L'}}],{inputAtProvided:true,confirmationId:token});expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(2);
 });
 it('第二种定义用不同字段和指标，同一引擎保存/聚合/分页/导出，注销级联清除私人数据',async()=>{
  const d:TemplateDefinition=templateDefinitionSchema.parse({...WATER_TEMPLATE,id:'official.synthetic',name:'合成容量',description:'仅内存测试',configurationFields:WATER_TEMPLATE.configurationFields.slice(0,2),recordFields:[WATER_TEMPLATE.recordFields[0],{id:'volume',label:'容量',type:'integer',required:true,unit:'ml',min:1,max:9000},{id:'label',label:'标签',type:'text',required:false,maxLength:20}],metrics:[{id:'total',label:'总量',operation:'sum',fieldId:'volume',period:'day'},{id:'events',label:'次数',operation:'count',period:'day'},{id:'days',label:'天数',operation:'distinct_days',fieldId:'date',period:'day'},{id:'average',label:'平均',operation:'mean',fieldId:'volume',period:'day'}],components:['summary','records'],example:{config:{name:'容量',startDate:today},record:{date:today,volume:20,label:'测试'}}});
  await db.query('INSERT INTO template_versions(template_id,version,definition)VALUES($1,1,$2)',[d.id,JSON.stringify(d)]);
  const p=await adopt(d.id);await run([{type:'add_generic_record',planId:p.planId,values:{date:today,volume:100,label:'一'}},{type:'add_generic_record',planId:p.planId,values:{date:today,volume:.3,label:'二'},units:{volume:'L'}}]);
  const v=await genericView(db,userId,p.planId,today,{limit:1,offset:1});expect(v).toMatchObject({totalRecords:2,limit:1,offset:1,summary:{metrics:[{value:400},{value:2},{value:1},{value:200}]}});expect(v.records).toHaveLength(1);
  const empty=await genericSummary(db,userId,p.planId,'2026-11-15','2026-11-15');expect(empty.metrics.map(m=>m.value)).toEqual([0,0,0,null]);
  const files=unzipSync(await buildExport(db,userId));expect(JSON.parse(strFromU8(files['generic-records.json']!)).records).toHaveLength(2);expect(strFromU8(files['expenses_refunds.csv']!)).not.toContain('容量');
  expect(strFromU8(files['templates.json']!)).toContain('volume');
  await requestAccountDeletion(db,userId);expect(await db.query('SELECT id FROM records WHERE user_id=$1',[userId])).toEqual([]);expect(await db.query('SELECT plan_id FROM plan_template_bindings WHERE user_id=$1',[userId])).toEqual([]);
  expect(await db.query('SELECT template_id FROM template_versions WHERE template_id=$1',[d.id])).toHaveLength(1);
 });
 it('新版能力仍可核对旧普通操作，旧ID不能改成generic保存',async()=>{
  const old=await execute(db,{...ctx(),genericCapability:false},`pre-generic-${++n}`,[{type:'create_ledger'}]);
  expect((await run([{type:'create_ledger'}],old.clientOpId)).operationId).toBe(old.operationId);
  const p=await adopt();await expect(run([{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:300}}],old.clientOpId)).rejects.toMatchObject({code:'operation_changed'});
  await expect(run([{type:'rename_plan',planId:p.planId,name:'不能复用'}],old.clientOpId)).rejects.toMatchObject({code:'operation_changed'});
  const saved=await add(p.planId,300);await expect(undo(db,ctx(),saved.operationId,old.clientOpId)).rejects.toMatchObject({code:'operation_changed'});
 });
 it('真实adapter保留筛选条件，执行层拒绝未支持的generic子集而非返回全量',async()=>{
  const p=await adopt();await run([{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:500,note:'晨间'}},{type:'add_generic_record',planId:p.planId,values:{date:today,amountMl:300,note:'晚间'}}]);
  let query:TurnQuery={kind:'generic_summary',plan_id:p.planId,period:'today',from:null,to:null,category:null,keywords:['晨间']};
  const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'query',query})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
  const executeQuery=async()=>runQuery(db,userId,(await llm.plan('fixture','fixture')).turn.query!,today,null);
  const filtered=await executeQuery();expect(filtered).toMatchObject({kind:'none',message:expect.stringContaining('暂不支持分类或关键词筛选')});expect(filtered).not.toHaveProperty('summary');
  query={...query,keywords:null,category:'餐饮'};expect(await executeQuery()).toMatchObject({kind:'none'});
  query={...query,category:null};expect(await executeQuery()).toMatchObject({kind:'generic_period',summary:{recordCount:2,metrics:[{value:800},{value:800}]}});
  expect((await genericSummary(db,userId,p.planId,today,today)).recordCount).toBe(2);
 });
 it('未支持的组件/周期/字段定义不开放选用',()=>{
  expect(supportsGenericRuntime({...WATER_TEMPLATE,components:['trend','records']})).toBe(false);
  expect(supportsGenericRuntime({...WATER_TEMPLATE,metrics:WATER_TEMPLATE.metrics.map(m=>({...m,period:'week'}))})).toBe(false);
  expect(supportsGenericRuntime({...WATER_TEMPLATE,recordFields:WATER_TEMPLATE.recordFields.map(f=>f.id==='amountMl'?{...f,type:'decimal'}:f)})).toBe(false);
 });
});

describe('官方账本模板与迁移12',()=>{
 it('原账本需明确复用/恢复，预算不静默覆盖；月目标可清空且不写事实',async()=>{
  const db=await openTestDb();try{
   const [u]=await db.query<{id:string}>(`INSERT INTO users(dev_name)VALUES('ledger-template')RETURNING id`);let n=0;const ctx:ExecContext={userId:u!.id,inputAt:new Date('2026-11-16T04:00:00Z'),source:'form',ledgerTemplateCapability:true,genericCapability:true};
   const run=(actions:Action[])=>execute(db,ctx,`ledger-${++n}`,actions);
   const setup=await run([{type:'create_ledger',budgetCents:200000}]);const created=setup.items[0];if(created?.type!=='plan_created')throw new Error('ledger');const id=created.plan.id;
   await run([{type:'archive_plan',planId:id}]);await expect(run([{type:'adopt_template',templateId:'official.ledger',templateVersion:1}])).rejects.toMatchObject({code:'ledger_exists',details:{planId:id,archived:true}});
   await expect(run([{type:'adopt_template',templateId:'official.ledger',templateVersion:1,existingPlanId:id,existingLedgerAction:'reuse'}])).rejects.toMatchObject({code:'ledger_exists'});expect((await ledgerView(db,u!.id,id,'2026-11')).plan.status).toBe('archived');
   await run([{type:'adopt_template',templateId:'official.ledger',templateVersion:1,existingPlanId:id,existingLedgerAction:'restore'}]);const state=await getPlanTemplate(db,u!.id,id,today);expect(state.config.budgetCents).toBe(200000);const reuse=await run([{type:'adopt_template',templateId:'official.ledger',templateVersion:1,existingPlanId:id,existingLedgerAction:'reuse'}]);expect(reuse.templatePlan?.planId).toBe(id);
   await run([{type:'configure_ledger_plan',planId:id,expectedVersion:state.config.version,patch:{budgetCents:null},goalScope:'current_only',completeSetup:true}]);
   expect((await getPlanTemplate(db,u!.id,id,today)).config).toMatchObject({budgetCents:null,nextMonthBudget:{value:200000}});expect(await db.query('SELECT id FROM plans WHERE user_id=$1',[u!.id])).toHaveLength(1);expect(await db.query('SELECT id FROM records WHERE user_id=$1',[u!.id])).toEqual([]);
  }finally{await db.close();}
 });
 it('首次选用并发与重放只有一个账本，另一独立选用必须明确复用',async()=>{
  const db=await openTestDb();try{
   const [u]=await db.query<{id:string}>(`INSERT INTO users(dev_name)VALUES('concurrent-ledger-template')RETURNING id`);
   const ctx:ExecContext={userId:u!.id,inputAt:new Date('2026-11-16T04:00:00Z'),source:'form',ledgerTemplateCapability:true};
   const action:Action={type:'adopt_template',templateId:'official.ledger',templateVersion:1};
   const [a,b]=await Promise.all([execute(db,ctx,'same-adoption',[action]),execute(db,ctx,'same-adoption',[action])]);
   expect(a.operationId).toBe(b.operationId);expect(a.templatePlan?.config).toMatchObject({budgetCents:null,setupStatus:'pending'});
   await expect(execute(db,ctx,'another-adoption',[action])).rejects.toMatchObject({code:'ledger_exists'});
   expect(await db.query('SELECT id FROM plans WHERE user_id=$1',[u!.id])).toHaveLength(1);
   const p=a.templatePlan!;await execute(db,ctx,'skip-budget',[{type:'configure_ledger_plan',planId:p.planId,expectedVersion:p.config.version,patch:{},completeSetup:true}]);
   expect((await getPlanTemplate(db,u!.id,p.planId,today)).config).toMatchObject({budgetCents:null,setupStatus:'ready'});
   expect(await db.query('SELECT id FROM records WHERE user_id=$1',[u!.id])).toEqual([]);
  }finally{await db.close();}
 });
 it('迁移11旧行不变，12可重复运行，仅增加账本关联和新表列',async()=>{
  const db=await openTestDb({migrations:'none'});try{
   await migrate(db,MIGRATIONS.slice(0,11));const [u]=await db.query<{id:string}>(`INSERT INTO users(dev_name)VALUES('migration12')RETURNING id`);const [p]=await db.query<{id:string}>(`INSERT INTO plans(user_id,kind,name,start_date)VALUES($1,'ledger','原账本','2026-10-01')RETURNING id`,[u!.id]);await db.query(`INSERT INTO records(user_id,plan_id,kind,amount_cents,category,occurred_on,note,source,input_at)VALUES($1,$2,'expense',1800,'餐饮','2026-11-01','旧记录','form',now())`,[u!.id,p!.id]);
   const beforePlans=await db.query('SELECT * FROM plans'),beforeRecords=await db.query('SELECT * FROM records');await migrate(db);await migrate(db);
   expect(await db.query('SELECT * FROM plans')).toEqual(beforePlans);const after=await db.query<Record<string,unknown>>('SELECT * FROM records');expect(after.map(({fields,definition_version,template_id,defaulted_fields,...old})=>old)).toEqual(beforeRecords);expect((await getPlanTemplate(db,u!.id,p!.id,today))).toMatchObject({source:'legacy',templateId:'official.ledger',config:{setupStatus:'ready'}});expect((await listAvailableTemplates(db)).map(d=>d.id)).toEqual(['official.ledger','official.reading','official.water']);
  }finally{await db.close();}
 });
});
