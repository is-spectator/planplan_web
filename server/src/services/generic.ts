import type { Queryable } from '../db/db.js';
import { addDays, isBizDate, weekOf, weekEnd, monthOf, monthStart, monthEnd, type BizDate } from '../domain/time.js';
import { templateDefinitionSchema, type GenericValue, type GenericValues, type GenericSummary, type TemplateDefinition, type TemplateField, type TemplateMetric, type GenericPeriod, type GenericGoalState, type GenericMetricGroup } from '../templates/contracts.js';
import { getPlan, dataVersion, type RecordRow } from './repo.js';
import { fail } from './errors.js';
import { getPlanTemplate } from './templates.js';
import { planView, recordView, type PlanView, type RecordView } from './views.js';

export function usesGenericV2Definition(d: Pick<TemplateDefinition,'configurationDefaults'|'recordDefaults'|'metrics'|'components'>):boolean {
  return d.configurationDefaults!==undefined||d.recordDefaults!==undefined||d.metrics.some(m=>m.period!=='day'||m.groupByFieldId!==undefined||m.goalAggregation!==undefined)||d.components.some(c=>c==='trend'||c==='categories');
}
export function supportsGenericRuntime(d: TemplateDefinition): boolean {
  const fields = [...d.configurationFields, ...d.recordFields];
  return d.engine === 'generic' && d.requiredCapabilities.every(c => ['generic-record-v1','private-template-v1','generic-template-v2','community-template-v1'].includes(c))
    && fields.every(f => ['text','integer','date','duration','money','single_select','multi_select','boolean'].includes(f.type))
    && (fields.every(f => ['text','integer','date'].includes(f.type)) || d.requiredCapabilities.includes('private-template-v1')||d.requiredCapabilities.includes('community-template-v1'))
    && d.recordFields.some(f => f.id === 'date' && f.type === 'date' && f.required)
    && (!usesGenericV2Definition(d)||d.requiredCapabilities.includes('generic-template-v2'))
    && d.metrics.every(m => (m.sourceRule===undefined||m.sourceRule==='generic_records') && (m.operation!=='count'||m.fieldId===undefined)) && d.components.every(c => ['summary','goal','records','trend','categories'].includes(c))
    && d.configurationFields.filter(f => f.id === 'name' || f.id === 'startDate').every(f => f.id === 'name' ? f.type === 'text' : f.type === 'date');
}
export function requireGenericDefinition(raw: unknown): TemplateDefinition {
  const parsed = templateDefinitionSchema.safeParse(raw);
  if (!parsed.success || !supportsGenericRuntime(parsed.data)) return fail('invalid_input', '这个模板包含当前尚不支持的字段或统计规则。');
  validateGenericDefaults(parsed.data,parsed.data.configurationDefaults??{},'configuration');
  validateGenericDefaults(parsed.data,parsed.data.recordDefaults??{},'record');
  return parsed.data;
}

export function genericPeriodBounds(period:GenericPeriod,date:BizDate):{from:BizDate;to:BizDate;next:BizDate} {
  const from=period==='day'?date:period==='week'?weekOf(date):monthStart(monthOf(date));
  const to=period==='day'?date:period==='week'?weekEnd(from):monthEnd(monthOf(date));
  return {from,to,next:addDays(to,1)};
}

/** Convert decimal units exactly before integer validation; never round a partial canonical unit. */
function canonicalNumber(value: number, field: TemplateField, inputUnit?: string): number {
  if (!Number.isFinite(value)) return fail('invalid_input', `${field.label}需要是有效数值。`);
  const aliases:Record<string,string>={毫升:'ml',升:'L',分钟:'minute',小时:'hour',时:'hour',元:'CNY',yuan:'CNY',分:'CNY_cent'};
  const unit=inputUnit===undefined?undefined:aliases[inputUnit]??inputUnit;
  if (unit === undefined || unit === field.unit) return value;
  const factor=field.unit==='ml'&&unit==='L'?1000:field.unit==='CNY_cent'&&unit==='CNY'?100:field.unit==='minute'&&unit==='hour'?60:null;
  if (factor===null) return fail('invalid_input', `${field.label}的单位不明确，请使用模板支持的单位。`);
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return fail('invalid_input', `${field.label}无法精确换算为模板使用的整数单位。`);
  const fraction = match[3] ?? '';
  const scaled = BigInt(`${match[1]}${match[2]}${fraction}`) * BigInt(factor);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n) return fail('invalid_input', `${field.label}需精确到模板使用的整数单位，不能四舍五入。`);
  const result = Number(scaled / divisor);
  if (!Number.isSafeInteger(result)) return fail('invalid_input', `${field.label}超出允许范围。`);
  return result;
}
function validateValues(fields: TemplateField[], input: GenericValues, units: Record<string,string> | undefined, partial: boolean, today?: BizDate): GenericValues {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length > 20) return fail('invalid_input', '字段格式不正确。');
  const out: GenericValues = {};
  for (const key of Object.keys(input)) if (!fields.some(f => f.id === key)) fail('invalid_input', '记录包含模板尚未定义的项目，请核对后再保存。');
  for (const key of Object.keys(units ?? {})) if (!fields.some(f => f.id === key && ['integer','money','duration'].includes(f.type)) || input[key] === undefined || input[key] === null) fail('invalid_input', '单位必须对应本次输入的数值字段。');
  for (const f of fields) {
    let value = input[f.id];
    if (value === undefined) { if (!partial && f.required) fail('invalid_input', `请填写${f.label}。`, { fieldId: f.id }); continue; }
    if (value === null) { if (f.required) fail('invalid_input', `请填写${f.label}。`, { fieldId: f.id }); out[f.id] = null; continue; }
    if (['integer','money','duration'].includes(f.type)) {
      if (typeof value !== 'number') return fail('invalid_input', `${f.label}需要是数值。`, { fieldId: f.id });
      value = canonicalNumber(value, f, units?.[f.id]);
      if (!Number.isSafeInteger(value) || (f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max)) fail('invalid_input', `${f.label}需要是${f.min ?? '允许范围内'}到${f.max ?? '允许上限'}的整数。`, { fieldId: f.id });
    } else if (f.type === 'date') {
      if (typeof value !== 'string' || !isBizDate(value)) return fail('invalid_input', `${f.label}不是有效日期。`, { fieldId: f.id });
      if (today && value > today) return fail('future_date', '已经发生的记录不能填写未来日期。', { fieldId: f.id });
    } else if (f.type === 'text') {
      if (typeof value !== 'string' || value.length > (f.maxLength ?? 200) || (f.required && !value.trim())) return fail('invalid_input', `${f.label}不符合文字长度要求。`, { fieldId: f.id });
    } else if (f.type === 'boolean') {
      if (typeof value !== 'boolean') return fail('invalid_input', `${f.label}请选择是或否。`, {fieldId:f.id});
    } else if (f.type === 'single_select') {
      if (typeof value !== 'string' || !f.options?.includes(value)) return fail('invalid_input', `${f.label}请选择已有选项。`, {fieldId:f.id});
    } else if (f.type === 'multi_select') {
      if (!Array.isArray(value) || (f.required && value.length === 0) || new Set(value).size !== value.length || value.some(v=>typeof v !== 'string' || !f.options?.includes(v))) return fail('invalid_input', `${f.label}请选择不重复的已有选项。`, {fieldId:f.id});
    } else return fail('invalid_input', '当前不能执行这种字段类型。');
    out[f.id] = value;
  }
  return out;
}
export function validateGenericRecordValues(definition: TemplateDefinition, values: GenericValues, units: Record<string,string> | undefined, today: BizDate): GenericValues {
  const d = requireGenericDefinition(definition);
  return validateValues(d.recordFields, values, units, false, today);
}
export function normalizeGenericFieldValue(field: TemplateField, value: GenericValue, unit?: string): GenericValue {
  return validateValues([field],{[field.id]:value},unit ? {[field.id]:unit}:undefined,false)[field.id]!;
}
export function validateGenericConfigValues(definition: TemplateDefinition, values: GenericValues, units?: Record<string,string>): GenericValues {
  const d = requireGenericDefinition(definition);
  return validateValues(d.configurationFields.filter(f => f.id !== 'name' && f.id !== 'startDate'), values, units, true);
}
export function validateGenericDefaults(definition:TemplateDefinition,input:GenericValues,kind:'configuration'|'record'):GenericValues {
  if(Object.keys(input).some(key=>['date','name','startDate'].includes(key)))return fail('invalid_input','日期和计划身份不能设置为默认填写内容。');
  const fields=kind==='record'?definition.recordFields:definition.configurationFields;
  return validateValues(fields,input,undefined,true);
}
export async function getGenericRecordDefaults(q:Queryable,planId:string):Promise<GenericValues> {
  return (await q.query<{record_defaults:GenericValues}>('SELECT record_defaults FROM plan_template_bindings WHERE plan_id=$1',[planId]))[0]?.record_defaults??{};
}
/** Only missing keys use explicitly enabled instance defaults. Null/false/0/[] are deliberate input. */
export function prepareGenericRecordValues(definition:TemplateDefinition,input:GenericValues,units:Record<string,string>|undefined,today:BizDate,recordDefaults:GenericValues):{values:GenericValues;defaultedFields:string[]} {
  const defaults=validateGenericDefaults(definition,recordDefaults,'record');
  const defaultedFields=Object.keys(defaults).filter(key=>!Object.hasOwn(input,key));
  return {values:validateGenericRecordValues(definition,{...defaults,...input},units,today),defaultedFields};
}
export async function genericConfigurationValues(q: Queryable, planId: string, definition: TemplateDefinition, stored: GenericValues, date: BizDate): Promise<GenericValues> {
  const values: GenericValues = { ...stored };
  const rows = await q.query<{ field_id: string; value: GenericValue }>('SELECT field_id,value FROM generic_goal_segments WHERE plan_id=$1 AND from_date<=$2 AND (to_date IS NULL OR to_date>=$2) ORDER BY seq', [planId,date]);
  for (const field of definition.configurationFields) if (field.id !== 'name' && field.id !== 'startDate' && values[field.id] === undefined) values[field.id] = null;
  for (const r of rows) values[r.field_id] = r.value;
  return values;
}
export async function genericGoalStates(q:Queryable,planId:string,definition:TemplateDefinition,stored:GenericValues,date:BizDate,planStart:BizDate):Promise<GenericGoalState[]> {
  const states:GenericGoalState[]=[];
  for(const metric of definition.metrics.filter(m=>m.goalFieldId)) {
    if(states.some(s=>s.fieldId===metric.goalFieldId))continue;
    const bounds=genericPeriodBounds(metric.period,date),fieldId=metric.goalFieldId!;
    const values=await genericConfigurationValues(q,planId,definition,stored,date),next=await genericConfigurationValues(q,planId,definition,stored,bounds.next);
    const [rule]=await q.query<{from_date:string}>('SELECT from_date FROM generic_goal_segments WHERE plan_id=$1 AND field_id=$2 AND from_date<=$3 AND (to_date IS NULL OR to_date>=$3) ORDER BY seq DESC LIMIT 1',[planId,fieldId,date]);
    states.push({fieldId,period:metric.period,from:bounds.from,to:bounds.to,value:values[fieldId]??null,effectiveFrom:rule?.from_date??null,next:{startsOn:bounds.next,value:next[fieldId]??null},partialPeriod:planStart>bounds.from&&planStart<=bounds.to});
  }
  return states;
}
type AggregateRow={bucket:string|null;n:number;samples:number;total:string|null;days:number};
function aggregationOf(metric:TemplateMetric){return metric.operation==='goal_progress'?(metric.goalAggregation??'sum'):metric.operation;}
async function aggregate(q:Queryable,userId:string,planId:string,from:string,to:string,metric:TemplateMetric,group?:'date'|{fieldId:string}):Promise<AggregateRow[]> {
  const operation=aggregationOf(metric),numeric=operation==='sum'||operation==='mean';
  const bucket=group==='date'?'occurred_on':group?'fields->>$6':'NULL::text';
  return q.query<AggregateRow>(`SELECT ${bucket} AS bucket,COUNT(*)::int AS n,
    ${operation==='count'?'COUNT(*)':'COUNT(fields->>$5)'}::int AS samples,
    ${numeric?'SUM((fields->>$5)::numeric)::text':'NULL::text'} AS total,
    ${operation==='distinct_days'?'COUNT(DISTINCT fields->>$5)':'0'}::int AS days
    FROM records WHERE user_id=$1 AND plan_id=$2 AND kind='generic' AND NOT deleted AND occurred_on BETWEEN $3 AND $4 AND ($5::text IS NULL OR $5::text IS NOT NULL)
    ${group?'GROUP BY 1 ORDER BY 1':''}`,[userId,planId,from,to,metric.fieldId??null,...(group&&group!=='date'?[group.fieldId]:[])]);
}
function aggregateValue(row:AggregateRow|undefined,metric:TemplateMetric):number|null {
  const operation=aggregationOf(metric),sum=Number(row?.total??0);
  if(!Number.isSafeInteger(sum))return fail('invalid_input','累计数值超出支持范围。');
  return operation==='count'?(row?.n??0):operation==='distinct_days'?(row?.days??0):operation==='mean'?(row?.samples?sum/row.samples:null):sum;
}
async function buildSummary(q:Queryable,userId:string,planId:string,from:BizDate,to:BizDate,anchor?:BizDate):Promise<GenericSummary> {
  if(!isBizDate(from)||!isBizDate(to)||from>to||to>addDays(from,365))return fail('invalid_input','一次最多查询366天。');
  const plan=await getPlan(q,userId,planId);
  if(plan.kind!=='generic')return fail('kind_mismatch','这个计划不支持这种统计方式。');
  const state=await getPlanTemplate(q,userId,planId,anchor??from),d=requireGenericDefinition(state.definition);
  const [count]=await q.query<{n:number}>("SELECT COUNT(*)::int AS n FROM records WHERE user_id=$1 AND plan_id=$2 AND kind='generic' AND NOT deleted AND occurred_on BETWEEN $3 AND $4",[userId,planId,from,to]);
  const metrics:GenericSummary['metrics']=[];
  for(const metric of d.metrics) {
    const bounds=genericPeriodBounds(metric.period,anchor??from);
    const metricFrom=anchor?bounds.from:from,metricTo=anchor?(anchor<bounds.to?anchor:bounds.to):to;
    const [row]=await aggregate(q,userId,planId,metricFrom,metricTo,metric);
    const value=aggregateValue(row,metric),field=d.recordFields.find(f=>f.id===metric.fieldId);
    const current=anchor?state:await getPlanTemplate(q,userId,planId,metricFrom);
    const configured=metric.goalFieldId?current.config.values?.[metric.goalFieldId]:null;
    const onePeriod=metricFrom===bounds.from&&metricTo<=bounds.to;
    const target=metric.operation==='goal_progress'&&onePeriod&&metricTo>=plan.start_date&&typeof configured==='number'&&configured>0?configured:null;
    const result:GenericSummary['metrics'][number]={id:metric.id,label:metric.label,operation:metric.operation,...(metric.fieldId?{fieldId:metric.fieldId}:{}),...(field?.unit?{unit:field.unit}:{}),value,target,remaining:target!==null&&value!==null?Math.max(target-value,0):null,progressPct:target!==null&&value!==null?Math.round(value/target*10000)/100:null};
    if(d.requiredCapabilities.includes('generic-template-v2')) {
      Object.assign(result,{sampleCount:row?.samples??0,period:metric.period,from:metricFrom,to:metricTo,partialPeriod:plan.start_date>bounds.from&&plan.start_date<=bounds.to});
      if(metric.groupByFieldId) {
        const grouped=await aggregate(q,userId,planId,metricFrom,metricTo,metric,{fieldId:metric.groupByFieldId});
        const groupField=d.recordFields.find(f=>f.id===metric.groupByFieldId)!;
        const keys:Array<string|boolean|null>=groupField.type==='boolean'?[false,true]:[...groupField.options!];
        if(grouped.some(r=>r.bucket===null))keys.push(null);
        result.groups=keys.map(key=>{const found=grouped.find(r=>r.bucket===(key===null?null:String(key)));return {key,label:key===null?'未填写':key===true?'是':key===false?'否':key,value:aggregateValue(found,metric),sampleCount:found?.samples??0,recordCount:found?.n??0} satisfies GenericMetricGroup;});
      }
      if(d.components.includes('trend')) {
        const daily=await aggregate(q,userId,planId,metricFrom,metricTo,metric,'date');
        const byDate=new Map(daily.map(r=>[r.bucket,r]));result.series=[];
        for(let date=metricFrom;date<=metricTo;date=addDays(date,1)){const found=byDate.get(date);result.series.push({date,value:aggregateValue(found,metric),sampleCount:found?.samples??0,recordCount:found?.n??0});}
      }
    }
    metrics.push(result);
  }
  return {planId,from,to,recordCount:count?.n??0,metrics};
}
/** An explicitly requested range uses that range for every metric; targets never sum across periods. */
export function genericSummary(q:Queryable,userId:string,planId:string,from:BizDate,to:BizDate):Promise<GenericSummary>{return buildSummary(q,userId,planId,from,to);}
/** Overview uses each metric's declared calendar period, ending at the selected business date. */
export function genericOverview(q:Queryable,userId:string,planId:string,date:BizDate):Promise<GenericSummary>{return buildSummary(q,userId,planId,date,date,date);}
export interface GenericView { plan:PlanView; templatePlan:import('../templates/contracts.js').TemplatePlanState; today:string; summary:GenericSummary; records:RecordView[]; totalRecords:number;offset:number;limit:number;dataVersion:number }
export async function genericView(q:Queryable,userId:string,planId:string,today:BizDate,options:{date?:string;from?:string;to?:string;limit?:number;offset?:number}={}):Promise<GenericView> {
  const from=options.from??options.date??today,to=options.to??options.date??from;
  if (!isBizDate(from)||!isBizDate(to)||from>to||to>today||to>addDays(from,365)) return fail('invalid_input','请选择不超过366天且不晚于今天的有效日期范围。');
  const limit=options.limit??20,offset=options.offset??0;
  if (!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0) return fail('invalid_input','分页参数不正确。');
  const plan=await getPlan(q,userId,planId),summary=options.from?await genericSummary(q,userId,planId,from,to):await genericOverview(q,userId,planId,from);
  const rows=await q.query<RecordRow>(`SELECT * FROM records WHERE user_id=$1 AND plan_id=$2 AND kind='generic' AND NOT deleted AND occurred_on BETWEEN $3 AND $4 ORDER BY occurred_on DESC,created_at DESC,id DESC LIMIT $5 OFFSET $6`,[userId,planId,from,to,limit,offset]);
  return {plan:planView(plan),templatePlan:await getPlanTemplate(q,userId,planId,from),today,summary,records:rows.map(r=>recordView(r)),totalRecords:summary.recordCount,offset,limit,dataVersion:await dataVersion(q,userId)};
}
