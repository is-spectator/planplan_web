import {describe,expect,it} from 'vitest';
import {sanitizeTurn,TURN_JSON_SCHEMA,type TurnGenericField} from '../src/ai/turn.js';
import {genericRecordDefaultsFromTurn,mergeGenericAnswer} from '../src/services/chat-generic.js';
import {normalizeCreationDefinition,creationDefinitionBody} from '../src/services/creation-drafts.js';
import {WATER_TEMPLATE} from '../src/templates/definitions.js';
import {OpenAICompatibleLlm} from '../src/ai/llm.js';

const field=(id:string,value:TurnGenericField['value'],unit:string|null=null):TurnGenericField=>({field_id:id,value,unit,unit_size:null,unit_size_unit:null});
const body=creationDefinitionBody(WATER_TEMPLATE);
body.recordFields.push({id:'finished',label:'完成',type:'boolean',required:false},{id:'tags',label:'标签',type:'multi_select',required:false,options:['早晨','晚上']});
const definition=normalizeCreationDefinition(body,'private.defaults');

describe('日常对话默认设置的受控协议',()=>{
  it('strict schema提供可空默认设置字段，省略仍兼容旧输出',()=>{
    const schema=TURN_JSON_SCHEMA.properties.writes.items;
    expect(schema.required).toContain('record_defaults');expect(schema.required).toContain('apply_template_defaults');
    const old=sanitizeTurn({intent:'write',writes:[{op:'configure_generic_plan',generic_fields:[field('dailyGoalMl',2000,'ml')]}]});
    expect(old?.writes[0]).toMatchObject({record_defaults:null});expect(old?.writes[0]?.apply_template_defaults).toBeUndefined();
    const next=sanitizeTurn({intent:'write',writes:[{op:'configure_generic_plan',record_defaults:[field('note','晨间')],apply_template_defaults:true}]});
    expect(next?.writes[0]).toMatchObject({record_defaults:[field('note','晨间')],apply_template_defaults:true});
  });
  it.each([{record_defaults:{note:'不是数组'}},{record_defaults:[{field_id:'note',value:{bad:true}}]},{record_defaults:[{field_id:'note'}]},{apply_template_defaults:'true'}])('非法默认提案整体拒绝 %#',patch=>{
    expect(sanitizeTurn({intent:'write',writes:[{op:'configure_generic_plan',...patch}]})).toBeNull();
  });
  it('事实动作不能夹带默认设置，未知字段和日期不能启用',()=>{
    expect(sanitizeTurn({intent:'write',writes:[{op:'add_generic_record',is_fact:true,record_defaults:[field('note','私自启用')]}]})).toBeNull();
    expect(()=>genericRecordDefaultsFromTurn(definition,{},[field('date','2026-11-16')],'以后默认日期')).toThrow();
    expect(()=>genericRecordDefaultsFromTurn(definition,{},[field('note','晨间')],'记一下晨间')).toThrow();
  });
  it('只合并明确的默认设置；取消一项不清空其他项；false和空多选保留',()=>{
    expect(genericRecordDefaultsFromTurn(definition,{note:'晨间'},[field('finished',false),field('tags',[])],'以后默认没有完成，标签为空')).toEqual({note:'晨间',finished:false,tags:[]});
    expect(genericRecordDefaultsFromTurn(definition,{note:'晨间',finished:false},[field('note',null)],'取消备注的默认填写')).toEqual({finished:false});
    expect(genericRecordDefaultsFromTurn(definition,{note:'晨间'},[],'清空所有默认填写')).toEqual({});
    expect(()=>genericRecordDefaultsFromTurn(definition,{note:'晨间'},[],'设置默认填写')).toThrow();
    expect(genericRecordDefaultsFromTurn(definition,{note:'晨间'},null,'今天喝了300毫升')).toBeUndefined();
  });
  it('后续回答保留已确认默认设置与首次配置意图',()=>{
    const original=sanitizeTurn({intent:'write',writes:[{op:'configure_generic_plan',record_defaults:[field('note','晨间')],apply_template_defaults:true}]})!.writes;
    const answer=sanitizeTurn({intent:'answer_pending',writes:[{op:'configure_generic_plan',generic_fields:[field('dailyGoalMl',2000,'ml')]}]})!.writes;
    expect(mergeGenericAnswer(original,answer,[])[0]).toMatchObject({record_defaults:[field('note','晨间')],apply_template_defaults:true});
  });
  it('真实SDK合成HTTP保留默认设置提案，仍只使用指定模型',async()=>{
    let requested:any;
    const next={intent:'write',writes:[{op:'configure_generic_plan',record_defaults:[field('note','晨间')],apply_template_defaults:true}]};
    const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','baidu/ernie-5.5-flash-preview:free','strict',100,{provider:'openrouter',fetch:async(_input,init)=>{requested=JSON.parse(init!.body as string);return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(next)},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});}});
    expect((await llm.plan('fixture','采用默认设置')).turn.writes[0]).toMatchObject(next.writes[0]!);expect(requested.model).toBe('baidu/ernie-5.5-flash-preview:free');
  });
});
