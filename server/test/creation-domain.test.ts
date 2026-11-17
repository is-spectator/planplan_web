import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { Db } from '../src/db/db.js';
import { migrate, MIGRATIONS, checkMigrations } from '../src/db/migrations.js';
import { openTestDb } from './database.js';
import { clarifyCreationDraft, createCreationDraft, creationDefinitionBody, getCreationDraft, getPrivateTemplate, listCreationDrafts, listPrivateTemplates, normalizeCreationDefinition, saveCreationDraft, undoCreationDraft, updateCreationDraft, type CreationDraft, type CreationDefinitionBody } from '../src/services/creation-drafts.js';
import { execute, undo, type Action, type ExecContext, type OperationResult } from '../src/services/engine.js';
import { getPlanTemplate, listAvailableTemplates } from '../src/services/templates.js';
import { genericSummary, normalizeGenericFieldValue, validateGenericRecordValues } from '../src/services/generic.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { buildExport } from '../src/services/export.js';
import { WATER_TEMPLATE } from '../src/templates/definitions.js';
import { getRecord } from '../src/services/repo.js';

const today='2026-11-16';
const body=():CreationDefinitionBody=>({
  name:'私人阅读',description:'记录阅读时长、位置和感受。',
  configurationFields:[{id:'name',label:'计划名称',type:'text',required:true,maxLength:20},{id:'startDate',label:'开始日期',type:'date',required:true},{id:'dailyMinutes',label:'每日目标',type:'duration',required:false,unit:'minute',min:1,max:1440}],
  recordFields:[{id:'date',label:'日期',type:'date',required:true},{id:'book',label:'书名',type:'text',required:true,maxLength:80},{id:'minutes',label:'阅读时长',type:'duration',required:true,unit:'minute',min:1,max:1440},{id:'page',label:'阅读位置',type:'integer',required:false,min:1,max:10000},{id:'mood',label:'感受',type:'single_select',required:true,options:['平静','开心']},{id:'tags',label:'标签',type:'multi_select',required:false,options:['纸书','电子书']},{id:'finished',label:'读完',type:'boolean',required:true},{id:'cost',label:'花费',type:'money',required:false,unit:'CNY_cent',min:0,max:99999999}],
  metrics:[{id:'total',label:'阅读分钟',operation:'sum',fieldId:'minutes',period:'day'},{id:'progress',label:'目标进度',operation:'goal_progress',fieldId:'minutes',goalFieldId:'dailyMinutes',period:'day'},{id:'events',label:'记录次数',operation:'count',period:'day'},{id:'average',label:'平均时长',operation:'mean',fieldId:'minutes',period:'day'},{id:'spend',label:'花费',operation:'sum',fieldId:'cost',period:'day'}],
  components:['summary','goal','records'],example:{config:{name:'私人阅读',startDate:today,dailyMinutes:60},record:{date:today,book:'示例书籍',minutes:25,page:35,mood:'平静',tags:['纸书'],finished:false,cost:2000}},
});
const record=(r:OperationResult)=>{const item=r.items.find(i=>'record'in i);if(!item||!('record'in item))throw new Error('missing record');return item.record;};

describe('私人模板领域与真实通用运行',()=>{
  let db:Db,userId:string;
  beforeAll(async()=>{db=await openTestDb();});afterAll(async()=>{await db.close();});
  beforeEach(async()=>{const [user]=await db.query<{id:string}>('INSERT INTO users(dev_name) VALUES($1) RETURNING id',[`creation-${randomUUID()}`]);userId=user!.id;});
  const ctx=():ExecContext=>({userId,inputAt:new Date(`${today}T04:00:00Z`),source:'form',templateCapability:true,ledgerTemplateCapability:true,genericCapability:true,privateTemplateCapability:true});
  const run=(actions:Action[],id=randomUUID())=>execute(db,ctx(),id,actions);
  const create=()=>db.tx(q=>createCreationDraft(q,userId),userId);
  const update=(draft:CreationDraft,value:CreationDefinitionBody=body())=>db.tx(q=>updateCreationDraft(q,userId,draft.id,draft.version,value),userId);
  const save=(draft:CreationDraft)=>db.tx(q=>saveCreationDraft(q,userId,draft.id,draft.version),userId);
  const saved=async()=>save(await update(await create()));
  const adopt=async(draft:CreationDraft)=>(await run([{type:'adopt_template',templateId:draft.savedTemplate!.id,templateVersion:draft.savedTemplate!.version}])).templatePlan!;

  it('草稿、澄清、修改、保存各有版本；无计划/事实，重复保存内容复用不可变版本',async()=>{
    let draft=await create();expect(draft).toMatchObject({version:1,definition:null,messages:[],canUndo:false,savedTemplate:null});
    draft=await db.tx(q=>clarifyCreationDraft(q,userId,draft.id,draft.version,'我想阅读','希望记录哪些内容？'),userId);
    expect(draft).toMatchObject({version:2,definition:null});expect(draft.messages.map(m=>m.role)).toEqual(['user','assistant']);
    draft=await update(draft);expect(draft).toMatchObject({version:3,definition:{source:'private',engine:'generic',requiredCapabilities:['generic-record-v1','private-template-v1']},canUndo:true});
    expect(draft.definition?.id).toBe(`private.${draft.id}`);
    expect((await listAvailableTemplates(db)).map(d=>d.id)).toEqual(['official.ledger','official.reading','official.water']);
    draft=await save(draft);expect(draft.savedTemplate?.version).toBe(1);expect(draft.version).toBe(4);
    const duplicate=await save(draft);expect(duplicate).toEqual(draft);
    const value=body();value.recordFields[1]!.label='正在读的书';draft=await update(draft,value);expect(draft.savedTemplate).toBeNull();
    draft=await save(draft);expect(draft.savedTemplate?.version).toBe(2);expect(draft.version).toBe(6);
    expect((await getPrivateTemplate(db,userId,draft.definition!.id,1)).recordFields[1]?.label).toBe('书名');
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1',[userId])).toEqual([]);expect(await db.query('SELECT id FROM records WHERE user_id=$1',[userId])).toEqual([]);
    await expect(db.query('UPDATE template_versions SET definition=definition WHERE template_id=$1',[draft.definition!.id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM template_versions WHERE template_id=$1',[draft.definition!.id])).rejects.toThrow('immutable');
    expect((await listPrivateTemplates(db,userId)).templates).toMatchObject([{id:draft.definition!.id,version:2,draftId:draft.id}]);
  });

  it('连续撤回遵循定义parent，澄清不是结构；改类型/单位或回收已删除ID被拒绝',async()=>{
    let draft=await update(await create()),original=draft.definition!;
    const changed=body();changed.name='读书日记';changed.recordFields.push({id:'reflection',label:'收获',type:'text',required:false,maxLength:100});
    draft=await update(draft,changed);draft=await db.tx(q=>clarifyCreationDraft(q,userId,draft.id,draft.version,'保留目标','已保留。'),userId);
    draft=await db.tx(q=>undoCreationDraft(q,userId,draft.id,draft.version),userId);expect(draft.definition).toEqual(original);expect(draft.version).toBe(5);
    await expect(update(draft,changed)).rejects.toMatchObject({code:'invalid_input'});
    const wrong=body();wrong.recordFields[2]={id:'minutes',label:'阅读时长',type:'integer',required:true};await expect(update(draft,wrong)).rejects.toMatchObject({code:'invalid_input'});
    draft=await db.tx(q=>undoCreationDraft(q,userId,draft.id,draft.version),userId);expect(draft.definition).toBeNull();expect(draft.canUndo).toBe(false);
    await expect(db.tx(q=>undoCreationDraft(q,userId,draft.id,draft.version),userId)).rejects.toMatchObject({code:'invalid_input'});
  });

  it('同版本并发只提交一次；错误定义和旧版本不记录对话或覆盖草稿',async()=>{
    const draft=await create();
    const results=await Promise.allSettled([update(draft),update(draft)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const current=await getCreationDraft(db,userId,draft.id);
    const bad=body();bad.metrics[0]!.fieldId='unknownField';await expect(update(current,bad)).rejects.toMatchObject({code:'invalid_input'});
    await expect(db.tx(q=>updateCreationDraft(q,userId,current.id,current.version,{...body(),source:'official'},{userText:'绕过校验',assistantText:'不会执行'}),userId)).rejects.toMatchObject({code:'invalid_input'});
    expect(await getCreationDraft(db,userId,draft.id)).toEqual(current);
  });

  it('私人读取、列表、派生、采用均校验作者；公共目录和旧能力不会获得作品',async()=>{
    const draft=await saved(),id=draft.savedTemplate!.id;
    const [other]=await db.query<{id:string}>('INSERT INTO users(dev_name) VALUES($1) RETURNING id',[randomUUID()]);
    expect((await listCreationDrafts(db,other!.id)).total).toBe(0);expect((await listPrivateTemplates(db,other!.id)).total).toBe(0);
    for(const call of [()=>getCreationDraft(db,other!.id,draft.id),()=>getPrivateTemplate(db,other!.id,id),()=>db.tx(q=>createCreationDraft(q,other!.id,{sourceTemplateId:id,sourceTemplateVersion:1}),other!.id),()=>execute(db,{...ctx(),userId:other!.id},randomUUID(),[{type:'adopt_template',templateId:id,templateVersion:1}])])await expect(call()).rejects.toMatchObject({code:'not_found'});
    await expect(execute(db,{...ctx(),privateTemplateCapability:false},randomUUID(),[{type:'adopt_template',templateId:id,templateVersion:1}])).rejects.toMatchObject({code:'invalid_input'});
    const plan=await adopt(draft);expect(plan.source).toBe('private');expect(plan.config.values?.dailyMinutes).toBeNull();
    await expect(execute(db,{...ctx(),privateTemplateCapability:false},randomUUID(),[{type:'rename_plan',planId:plan.planId,name:'不应修改'}])).rejects.toMatchObject({code:'invalid_input'});
  });

  it('8类字段真正持久化、校验、查询与导出；目标不是事实，元/小时精确换算',async()=>{
    const draft=await saved(),plan=await adopt(draft);
    await run([{type:'configure_generic_plan',planId:plan.planId,expectedVersion:plan.config.version,patch:{values:{dailyMinutes:60}},completeSetup:true}]);
    expect((await genericSummary(db,userId,plan.planId,today,today)).recordCount).toBe(0);
    const values=body().example.record as any;
    const first=record(await run([{type:'add_generic_record',planId:plan.planId,values:{...values,minutes:.5,cost:20.25},units:{minutes:'小时',cost:'元'}}]));
    expect(first).toMatchObject({definitionTemplateId:draft.savedTemplate!.id,definitionVersion:1,fields:{minutes:30,cost:2025,finished:false,tags:['纸书'],page:35}});
    const second=record(await run([{type:'add_generic_record',planId:plan.planId,values:{...values,minutes:15,cost:null,tags:[]}}]));
    expect((await genericSummary(db,userId,plan.planId,today,today)).metrics.map(m=>m.value)).toEqual([45,45,2,22.5,2025]);
    expect((await genericSummary(db,userId,plan.planId,today,today)).metrics[1]).toMatchObject({target:60,remaining:15,progressPct:75});
    const edit=await run([{type:'edit_generic_record',recordId:second.id,expectedVersion:1,values:{...values,minutes:20,mood:'开心',finished:true}}]);expect(record(edit).fields?.finished).toBe(true);
    await undo(db,ctx(),edit.operationId,randomUUID());expect((await getRecord(db,userId,second.id)).fields?.finished).toBe(false);
    const files=unzipSync(await buildExport(db,userId));expect(strFromU8(files['private-templates.json']!)).toContain('私人阅读');expect(strFromU8(files['creation-drafts.json']!)).toContain(draft.id);expect(strFromU8(files['generic-records.json']!)).toContain('definitionTemplateId');expect(strFromU8(files['templates.json']!)).toContain('recordDefinitions');
  });

  it.each([{finished:null},{finished:'false'},{mood:'未知'},{tags:['纸书','纸书']},{tags:['其他']},{minutes:.001,cost:1.001}])('非法动态字段不写入 %#',async patch=>{
    const draft=await saved(),plan=await adopt(draft);
    await expect(run([{type:'add_generic_record',planId:plan.planId,values:{...body().example.record,...patch} as any}])).rejects.toMatchObject({code:'invalid_input'});
    expect((await genericSummary(db,userId,plan.planId,today,today)).recordCount).toBe(0);
  });

  it('多选必填拒绝空数组；无单位整数目标可计算；不完整分/分钟拒绝四舍五入',()=>{
    const value=body();value.recordFields.find(f=>f.id==='tags')!.required=true;
    const definition=normalizeCreationDefinition(value,'private.test');
    expect(()=>validateGenericRecordValues(definition,{...value.example.record,tags:[]} as any,undefined,today)).toThrow();
    expect(normalizeGenericFieldValue(value.recordFields.find(f=>f.id==='minutes')!,.1,'hour')).toBe(6);
    expect(()=>normalizeGenericFieldValue(value.recordFields.find(f=>f.id==='minutes')!,.001,'hour')).toThrow();
    expect(()=>normalizeGenericFieldValue(value.recordFields.find(f=>f.id==='cost')!,1.001,'CNY')).toThrow();
    value.configurationFields.push({id:'goalPages',label:'页数目标',type:'integer',required:false,min:1});value.metrics.push({id:'pagesGoal',label:'页数进度',operation:'goal_progress',fieldId:'page',goalFieldId:'goalPages',period:'day'});expect(normalizeCreationDefinition(value,'private.pages').metrics).toHaveLength(6);
    value.configurationFields.find(f=>f.id==='goalPages')!.min=0;expect(()=>normalizeCreationDefinition(value,'private.pages')).toThrow('正数目标');
  });

  it('从计划派生只复制定义；明确兼容应用保留目标/事实/来源，旧记录修改撤销仍能解释',async()=>{
    const original=(await run([{type:'adopt_template',templateId:'official.water',templateVersion:1}])).templatePlan!;
    await run([{type:'configure_generic_plan',planId:original.planId,expectedVersion:original.config.version,patch:{values:{dailyGoalMl:1234}},completeSetup:true}]);
    const first=record(await run([{type:'add_generic_record',planId:original.planId,values:{date:today,amountMl:300,note:'原记录'}}]));
    let draft=await db.tx(q=>createCreationDraft(q,userId,{sourcePlanId:original.planId}),userId);
    expect(draft.definition?.example.config.dailyGoalMl).toBe(2000);expect(draft.definition?.example.record).not.toHaveProperty('note','原记录');
    const value=creationDefinitionBody(draft.definition!);value.recordFields.push({id:'temperature',label:'水温',type:'integer',required:false,min:0,max:100});value.recordFields.find(f=>f.id==='amountMl')!.label='喝了多少';
    draft=await save(await update(draft,value));
    const apply:Action={type:'apply_private_template',planId:original.planId,templateId:draft.savedTemplate!.id,templateVersion:1,expectedVersion:draft.sourcePlanVersion!};
    const result=await run([apply]);expect(result.undoable).toBe(false);expect(result.templatePlan).toMatchObject({source:'private',config:{values:{dailyGoalMl:1234}}});
    expect(await getRecord(db,userId,first.id)).toMatchObject({template_id:'official.water',definition_version:1,fields:{amountMl:300}});
    const changed=await run([{type:'edit_generic_record',recordId:first.id,expectedVersion:1,values:{date:today,amountMl:400,temperature:35}}]);expect(record(changed).definitionTemplateId).toBe(draft.savedTemplate!.id);
    await undo(db,ctx(),changed.operationId,randomUUID());expect(await getRecord(db,userId,first.id)).toMatchObject({template_id:'official.water',definition_version:1,fields:{date:today,amountMl:300,note:'原记录'}});
    expect((await genericSummary(db,userId,original.planId,today,today)).metrics[0]?.value).toBe(300);
    await expect(execute(db,{...ctx(),privateTemplateCapability:false},randomUUID(),[{type:'delete_record',recordId:first.id,expectedVersion:3}])).rejects.toMatchObject({code:'invalid_input'});
    await expect(undo(db,{...ctx(),privateTemplateCapability:false},changed.operationId,randomUUID())).rejects.toMatchObject({code:'invalid_input'});
    await expect(run([apply])).rejects.toMatchObject({code:'version_conflict'});
  });

  it('不兼容结构或过期计划版本拒绝应用，其他计划和旧定义保持不变',async()=>{
    const original=(await run([{type:'adopt_template',templateId:'official.water',templateVersion:1}])).templatePlan!;
    let draft=await db.tx(q=>createCreationDraft(q,userId,{sourcePlanId:original.planId}),userId);const value=creationDefinitionBody(draft.definition!);value.recordFields.push({id:'must',label:'新增必填',type:'text',required:true});value.example.record.must='示例';draft=await save(await update(draft,value));
    await expect(run([{type:'apply_private_template',planId:original.planId,templateId:draft.savedTemplate!.id,templateVersion:1,expectedVersion:draft.sourcePlanVersion!}])).rejects.toMatchObject({code:'invalid_input'});
    expect((await getPlanTemplate(db,userId,original.planId,today)).templateId).toBe('official.water');
  });

  it('分页可恢复并有边界；注销清理草稿、消息、私人版本和计划，官方版本保留',async()=>{
    const draft=await saved();const plan=await adopt(draft);await run([{type:'add_generic_record',planId:plan.planId,values:body().example.record as any}]);await create();
    expect((await listCreationDrafts(db,userId,{limit:1,offset:1})).drafts).toHaveLength(1);
    expect((await listCreationDrafts(db,userId,{limit:1,offset:2}))).toEqual({drafts:[],total:2});await expect(listPrivateTemplates(db,userId,{limit:101})).rejects.toMatchObject({code:'invalid_input'});
    const result=await requestAccountDeletion(db,userId);expect(result.status).toBe('completed');
    for(const table of ['creation_drafts','creation_revisions','creation_messages','creation_requests','plans','records'])expect(await db.query(`SELECT 1 FROM ${table} WHERE user_id=$1`,[userId])).toEqual([]);
    expect(await db.query('SELECT 1 FROM template_versions WHERE owner_user_id=$1',[userId])).toEqual([]);expect((await listAvailableTemplates(db)).length).toBe(3);
  });
});

it('迁移13重复执行保留原数据、原不可变版本及generic来源，旧库和私人版本都可重新打开',async()=>{
  const db=await openTestDb({migrations:'none'});try{
    await migrate(db,MIGRATIONS.slice(0,12));const [user]=await db.query<{id:string}>('INSERT INTO users(dev_name) VALUES($1) RETURNING id',[randomUUID()]);
    const [plan]=await db.query<{id:string}>(`INSERT INTO plans(user_id,kind,name,start_date) VALUES($1,'generic','旧饮水',$2) RETURNING id`,[user!.id,today]);
    await db.query(`INSERT INTO plan_template_bindings(plan_id,user_id,template_id,template_version,source,definition_snapshot) VALUES($1,$2,'official.water',1,'official',$3)`,[plan!.id,user!.id,JSON.stringify(WATER_TEMPLATE)]);
    await db.query(`INSERT INTO records(user_id,plan_id,kind,occurred_on,source,input_at,fields,definition_version) VALUES($1,$2,'generic',$3,'form',now(),$4,1)`,[user!.id,plan!.id,today,JSON.stringify({date:today,amountMl:300})]);
    const before=await db.query('SELECT * FROM records'),versions=await db.query('SELECT * FROM template_versions ORDER BY template_id,version');
    await migrate(db);await migrate(db);await checkMigrations(db);
    const after=await db.query<Record<string,unknown>>('SELECT * FROM records');expect(after.map(({template_id,defaulted_fields,...rest})=>rest)).toEqual(before);expect(after[0]?.template_id).toBe('official.water');
    const newVersions=await db.query<Record<string,unknown>>('SELECT * FROM template_versions ORDER BY template_id,version');expect(newVersions.map(({owner_user_id,...rest})=>rest)).toEqual(versions);
    expect((await genericSummary(db,user!.id,plan!.id,today,today)).metrics[0]?.value).toBe(300);
  }finally{await db.close();}
});
