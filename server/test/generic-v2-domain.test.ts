import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {openTestDb} from './database.js';
import type {Db} from '../src/db/db.js';
import {execute,undo,type Action,type ExecContext} from '../src/services/engine.js';
import {getRecord} from '../src/services/repo.js';
import {createCreationDraft,updateCreationDraft,saveCreationDraft,normalizeCreationDefinition,type CreationDefinitionBody} from '../src/services/creation-drafts.js';
import {genericOverview,genericSummary,genericPeriodBounds,prepareGenericRecordValues,validateGenericDefaults} from '../src/services/generic.js';
import {configureOtherTemplateInTransaction,configureReadingPlanInTransaction,getPlanTemplate} from '../src/services/templates.js';
import type {ConfigureGenericAction} from '../src/templates/contracts.js';

const today='2026-11-18';
const body=():CreationDefinitionBody=>({
  name:'阅读分类',description:'每周阅读时长和每月次数。',
  configurationFields:[{id:'name',label:'名称',type:'text',required:true,maxLength:20},{id:'startDate',label:'开始日期',type:'date',required:true},{id:'weeklyMinutes',label:'每周分钟',type:'duration',unit:'minute',required:false,min:1},{id:'monthlyCount',label:'每月次数',type:'integer',required:false,min:1}],
  recordFields:[{id:'date',label:'日期',type:'date',required:true},{id:'minutes',label:'时长',type:'duration',unit:'minute',required:false,min:0},{id:'category',label:'分类',type:'single_select',required:false,options:['纸书','电子书']},{id:'finished',label:'读完',type:'boolean',required:false}],
  metrics:[{id:'weekly',label:'周进度',operation:'goal_progress',fieldId:'minutes',goalFieldId:'weeklyMinutes',period:'week'},{id:'monthly',label:'月次数',operation:'goal_progress',goalAggregation:'count',goalFieldId:'monthlyCount',period:'month'},{id:'mean',label:'平均每次时长',operation:'mean',fieldId:'minutes',period:'week',groupByFieldId:'category'}],
  components:['summary','goal','categories','trend','records'],
  configurationDefaults:{weeklyMinutes:150,monthlyCount:10},recordDefaults:{category:'纸书',finished:false},
  example:{config:{name:'我的阅读',startDate:today,weeklyMinutes:150,monthlyCount:10},record:{date:today,minutes:20,category:'纸书',finished:false}},
});

describe('通用模板周期、默认填写和聚合',()=>{
  let db:Db,userId:string;
  const ctx=(date=today):ExecContext=>({userId,inputAt:new Date(`${date}T04:00:00Z`),source:'form',genericCapability:true,privateTemplateCapability:true,templateCapability:true,ledgerTemplateCapability:true,genericTemplateV2Capability:true} as ExecContext);
  const run=(actions:Action[],date=today)=>execute(db,ctx(date),randomUUID(),actions);
  beforeAll(async()=>{db=await openTestDb();});afterAll(async()=>{await db.close();});
  beforeEach(async()=>{userId=(await db.query<{id:string}>("INSERT INTO users(dev_name)VALUES($1)RETURNING id",[`generic-v2-${randomUUID()}`]))[0]!.id;});
  const plan=async()=>{
    const saved=await db.tx(async q=>{let draft=await createCreationDraft(q,userId);draft=await updateCreationDraft(q,userId,draft.id,draft.version,body());return saveCreationDraft(q,userId,draft.id,draft.version);},userId);
    return (await run([{type:'adopt_template',templateId:saved.savedTemplate!.id,templateVersion:1}])).templatePlan!;
  };
  const configure=async(planId:string,action:Partial<ConfigureGenericAction>,date=today)=>db.tx(async q=>configureOtherTemplateInTransaction(q,userId,date,{type:'configure_generic_plan',planId,expectedVersion:(await getPlanTemplate(q,userId,planId,date)).config.version,patch:{},...action}),userId);

  it('v2能力自动声明，默认值有字段/日期限制；false与null不当成遗漏',()=>{
    const definition=normalizeCreationDefinition(body(),'private.v2');
    expect(definition.requiredCapabilities).toContain('generic-template-v2');
    expect(()=>validateGenericDefaults(definition,{date:today},'record')).toThrow();
    expect(()=>validateGenericDefaults(definition,{category:'不存在'},'record')).toThrow();
    expect(prepareGenericRecordValues(definition,{date:today,category:null},undefined,today,{category:'纸书',finished:false})).toEqual({values:{date:today,category:null,finished:false},defaultedFields:['finished']});
    expect(()=>normalizeCreationDefinition({...body(),configurationDefaults:{monthlyCount:0}},'private.v2')).toThrow();
    const invalid=body();invalid.metrics.push({id:'bad',label:'混用目标',operation:'goal_progress',fieldId:'minutes',goalFieldId:'weeklyMinutes',period:'day'});
    expect(()=>normalizeCreationDefinition(invalid,'private.v2')).toThrow();
  });

  it('采用不写默认答案；明确确认后初始化与记录默认值分别保存，仍无事实',async()=>{
    const p=await plan();expect(p.config).toMatchObject({setupStatus:'pending',values:{weeklyMinutes:null,monthlyCount:null},recordDefaults:{},proposedDefaults:{weeklyMinutes:150,monthlyCount:10},canChangeStartDate:true});
    const ready=await configure(p.planId,{applyTemplateDefaults:true,completeSetup:true,patch:{values:{monthlyCount:8}}});
    expect(ready.config).toMatchObject({setupStatus:'ready',values:{weeklyMinutes:150,monthlyCount:8},recordDefaults:{}});
    expect((await genericOverview(db,userId,p.planId,today)).recordCount).toBe(0);
    await expect(configure(p.planId,{applyTemplateDefaults:true,completeSetup:true})).rejects.toMatchObject({code:'invalid_input'});
    const enabled=await configure(p.planId,{recordDefaults:{category:'纸书',finished:false}});
    expect(enabled.config.recordDefaults).toEqual({category:'纸书',finished:false});
    expect((await configure(p.planId,{recordDefaults:{}})).config.recordDefaults).toEqual({});
  });

  it('周/月目标按各自边界生效，不满首周期不折算，清空只覆盖当前周期',async()=>{
    const p=await plan();await configure(p.planId,{applyTemplateDefaults:true,completeSetup:true});
    const initial=await genericOverview(db,userId,p.planId,today);
    expect(initial.metrics[0]).toMatchObject({target:150,partialPeriod:true,from:'2026-11-16',to:today});
    expect(initial.metrics[1]).toMatchObject({target:10,partialPeriod:true,from:'2026-11-01',to:today});
    await configure(p.planId,{patch:{values:{weeklyMinutes:90,monthlyCount:4}},goalScope:'next_and_future'});
    const current=await getPlanTemplate(db,userId,p.planId,today);
    expect(current.config.nextPeriodValues).toEqual({weeklyMinutes:{startsOn:'2026-11-23',value:90},monthlyCount:{startsOn:'2026-12-01',value:4}});
    await configure(p.planId,{patch:{values:{weeklyMinutes:null}},goalScope:'current_only'});
    expect((await genericOverview(db,userId,p.planId,today)).metrics[0]?.target).toBeNull();
    expect((await genericOverview(db,userId,p.planId,'2026-11-23')).metrics[0]?.target).toBe(90);
    expect(genericPeriodBounds('month','2028-02-29')).toEqual({from:'2028-02-01',to:'2028-02-29',next:'2028-03-01'});
  });

  it('分类与日趋势由事实计算，均值分母忽略空值，跨周期范围不叠加目标',async()=>{
    const p=await plan();await configure(p.planId,{applyTemplateDefaults:true,completeSetup:true});
    await run([{type:'add_generic_record',planId:p.planId,values:{date:today,minutes:20,category:'纸书'}},{type:'add_generic_record',planId:p.planId,values:{date:today,minutes:null,category:null}}]);
    await run([{type:'add_generic_record',planId:p.planId,values:{date:'2026-11-19',minutes:25,category:'电子书'}}],'2026-11-19');
    const summary=await genericOverview(db,userId,p.planId,'2026-11-19');
    expect(summary.metrics[0]).toMatchObject({value:45,sampleCount:2,target:150,progressPct:30});
    expect(summary.metrics[1]).toMatchObject({value:3,sampleCount:3,target:10});
    expect(summary.metrics[2]).toMatchObject({value:22.5,sampleCount:2,groups:[{key:'纸书',value:20,sampleCount:1},{key:'电子书',value:25,sampleCount:1},{key:null,value:null,sampleCount:0,recordCount:1}]});
    expect(summary.metrics[2]?.series).toEqual([{date:'2026-11-16',value:null,sampleCount:0,recordCount:0},{date:'2026-11-17',value:null,sampleCount:0,recordCount:0},{date:today,value:20,sampleCount:1,recordCount:2},{date:'2026-11-19',value:25,sampleCount:1,recordCount:1}]);
    expect((await genericSummary(db,userId,p.planId,'2026-11-01','2026-12-01')).metrics[1]?.target).toBeNull();
  });

  it('旧学习计划目标支持清空及版本冲突，旧set_goal仍推进配置版本',async()=>{
    const result=await run([{type:'create_study',name:'旧学习',daysPerWeek:5,minMinutes:20}]);
    const item=result.items[0];if(item?.type!=='plan_created')throw new Error('missing plan');
    const planId=item.plan.id,initial=await getPlanTemplate(db,userId,planId,today);
    await run([{type:'set_goal',planId,param:'min_minutes',value:30,scope:'next_and_future'}]);
    const updated=await getPlanTemplate(db,userId,planId,today);expect(updated.config.version).toBeGreaterThan(initial.config.version);
    await expect(db.tx(q=>configureReadingPlanInTransaction(q,userId,today,{type:'configure_reading_plan',planId,expectedVersion:initial.config.version,patch:{minMinutes:null}}),userId)).rejects.toMatchObject({code:'version_conflict'});
    await expect(db.tx(q=>configureReadingPlanInTransaction(q,userId,today,{type:'configure_reading_plan',planId,expectedVersion:updated.config.version,patch:{currentBook:'不支持'}}),userId)).rejects.toMatchObject({code:'invalid_input'});
    const cleared=await db.tx(q=>configureReadingPlanInTransaction(q,userId,today,{type:'configure_reading_plan',planId,expectedVersion:updated.config.version,patch:{minMinutes:null,daysPerWeek:null},goalScope:'current_only'}),userId);
    expect(cleared.config).toMatchObject({minMinutes:null,daysPerWeek:null,nextWeekGoals:{minMinutes:30,daysPerWeek:5}});
  });

  it('明确启用的默认值有来源回执，改设置不改旧事实，编辑不补值且撤回恢复来源',async()=>{
    const p=await plan();await configure(p.planId,{recordDefaults:{category:'纸书',finished:false}});
    const created=await run([{type:'add_generic_record',planId:p.planId,values:{date:today,minutes:20}}]);
    const item=created.items[0];if(item?.type!=='generic_added')throw new Error('record missing');
    expect(item.record).toMatchObject({fields:{category:'纸书',finished:false},defaultedFields:['category','finished']});
    await configure(p.planId,{recordDefaults:{category:'电子书',finished:true}});
    expect((await getRecord(db,userId,item.record.id)).fields).toMatchObject({category:'纸书',finished:false});
    const edited=await run([{type:'edit_generic_record',recordId:item.record.id,expectedVersion:1,values:{date:today,minutes:25,category:'电子书'}}]);
    const changed=await getRecord(db,userId,item.record.id);expect(changed.fields).not.toHaveProperty('finished');expect(changed.defaulted_fields).toEqual([]);
    await undo(db,ctx(),edited.operationId,randomUUID());
    const restored=await getRecord(db,userId,item.record.id);expect(restored.fields).toMatchObject({minutes:20,category:'纸书',finished:false});expect(restored.defaulted_fields).toEqual(['category','finished']);
    await expect(execute(db,{...ctx(),genericTemplateV2Capability:false},randomUUID(),[{type:'add_generic_record',planId:p.planId,values:{date:today,minutes:5}}])).rejects.toMatchObject({code:'invalid_input'});
  });
});
