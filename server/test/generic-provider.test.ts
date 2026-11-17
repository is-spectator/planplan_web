import { describe, expect, it } from 'vitest';
import { OpenAICompatibleLlm } from '../src/ai/llm.js';
const response=(turn:unknown)=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(turn)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
const query={kind:'generic_summary',plan_id:'plan-fixture',period:'today',from:null,to:null,category:null};
const write={op:'add_generic_record',is_fact:true,plan_id:'plan-fixture',date_kind:'today',generic_fields:[{field_id:'volume',value:.5,unit:'L',unit_size:null,unit_size_unit:null}]};
describe('通用模板真实provider解析边界（HTTP fixture，无外部调用）',()=>{
 it.each(['compact','strict'] as const)('%s接受通用查询与带查询的写入，保留原始单位和字段',async mode=>{
  let next:unknown={intent:'query',query};let body:any;
  const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model',mode,100,{provider:'openrouter',fetch:async(_input,init)=>{body=JSON.parse(init!.body as string);return response(next);}});
  expect((await llm.plan('fixture','查询')).turn.query).toMatchObject(query);
  next={intent:'write_and_query',writes:[write],query};const result=await llm.plan('fixture','记录并查询');expect(result.turn.writes[0]).toMatchObject(write);expect(result.turn.query?.kind).toBe('generic_summary');
  if(mode==='strict'){expect(body.response_format.json_schema.schema.properties.query.anyOf[0].properties.kind.enum).toContain('generic_summary');expect(body.response_format.json_schema.schema.properties.writes.items.properties.op.enum).toContain('add_generic_record');}
 });
 it.each([
  {generic_fields:[{field_id:'dailyGoalMl',value:{amount:2000}}]},
  {generic_fields:[{field_id:'dailyGoalMl'}]},
  {generic_fields:[{field_id:'dailyGoalMl',value:[2000]}]},
  {generic_fields:{dailyGoalMl:2000}},
  {generic_fields:[{field_id:'dailyGoalMl',value:2,unit:{unit:'L'}}]},
  {generic_fields:[{field_id:'dailyGoalMl',value:2,unit:'杯',unit_size:'200'}]},
 ])('malformed generic configuration is rejected instead of clearing a goal %#',async patch=>{
  const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>response({intent:'write',writes:[{op:'configure_generic_plan',...patch}]})});
  await expect(llm.plan('fixture','目标2000ml')).rejects.toMatchObject({kind:'invalid_output'});
 });
 it('generic fact flag and query period cannot silently change meaning',async()=>{
  let next:unknown={intent:'write',writes:[{...write,is_fact:'false'}]};const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>response(next)});
  await expect(llm.plan('fixture','目标')).rejects.toMatchObject({kind:'invalid_output'});next={intent:'write',writes:[{...write,is_fact:undefined}]};await expect(llm.plan('fixture','目标')).rejects.toMatchObject({kind:'invalid_output'});
  for(const period of [undefined,'day']){next={intent:'query',query:{...query,period}};await expect(llm.plan('fixture','今天')).rejects.toMatchObject({kind:'invalid_output'});}
  next={intent:'write',writes:[{op:'configure_generic_plan',generic_fields:[{field_id:'dailyGoalMl',value:null}]}]};expect((await llm.plan('fixture','清空目标')).turn.writes[0]!.generic_fields![0]!.value).toBeNull();
 });
 it.each([{keywords:'晨间'},{keywords:[12]},{category:'invalid'},{plan_id:123},{from:20261116}])('generic query invalid filters cannot fall back to unfiltered data %#',async patch=>{
  const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>response({intent:'query',query:{...query,...patch}})});await expect(llm.plan('fixture','筛选')).rejects.toMatchObject({kind:'invalid_output'});
 });
 it('未知查询/混入未知写入时整轮拒绝，不保留可识别的半批',async()=>{
  let next:unknown={intent:'write',writes:[write,{op:'made_up_record'}]};const llm=new OpenAICompatibleLlm('synthetic-test-key','https://fixture.test/v1','fixture-model','compact',100,{provider:'openrouter',fetch:async()=>response(next)});
  await expect(llm.plan('fixture','整批')).rejects.toMatchObject({kind:'invalid_output'});next={intent:'query',query:{...query,kind:'made_up_query'}};await expect(llm.plan('fixture','查询')).rejects.toMatchObject({kind:'invalid_output'});
 });
});
