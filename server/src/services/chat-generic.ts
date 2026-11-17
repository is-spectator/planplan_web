import type { TurnGenericField, TurnWrite } from '../ai/turn.js';
import type { TemplateDefinition, GenericValues, TemplateField } from '../templates/contracts.js';
import { DomainError } from './errors.js';
import { normalizeGenericFieldValue,validateGenericDefaults } from './generic.js';

function unitName(unit: string | null, field: TemplateField): string | null {
  if (unit === null) return null;
  if (unit === '分') return field.type === 'money' ? 'CNY_cent' : field.type === 'duration' ? 'minute' : unit;
  const aliases: Record<string, string> = { 毫升: 'ml', 升: 'L', l: 'L', 元: 'CNY', 块: 'CNY', 块钱: 'CNY', 人民币元: 'CNY', yuan: 'CNY', 人民币分: 'CNY_cent', 小时: 'hour', h: 'hour', 分钟: 'minute', min: 'minute' };
  return aliases[unit] ?? unit;
}

/** Decimal count times an already canonical quantity, with no rounding. */
function exactQuantity(count: number, size: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(count));
  if (!match || count <= 0 || !Number.isSafeInteger(size)) throw new DomainError('invalid_input', '数量需要是明确的正数。');
  const fraction = match[2] ?? '';
  const product = BigInt(`${match[1]}${fraction}`) * BigInt(size);
  const divisor = 10n ** BigInt(fraction.length);
  if (product % divisor !== 0n) throw new DomainError('invalid_input', '换算结果需要符合模板的整数单位，不能四舍五入。');
  const value = Number(product / divisor);
  if (!Number.isSafeInteger(value)) throw new DomainError('invalid_input', '换算后的数值超出允许范围。');
  return value;
}

function fieldValue(field: TemplateField, input: TurnGenericField, evidence: { text: string; answering: boolean }) {
  if (input.value === null) return normalizeGenericFieldValue(field, null);
  const unit = unitName(input.unit, field);
  const sizeUnit = unitName(input.unit_size_unit, field);
  if (field.type === 'money' && !['CNY', 'CNY_cent'].includes(unit ?? '')) throw new DomainError('invalid_input', '金额请明确使用人民币元或分，尚未保存。');
  if (field.type === 'duration' && unit !== null && !['minute', 'hour'].includes(unit)) throw new DomainError('invalid_input', '时长请使用分钟或小时，尚未保存。');
  const convertible = field.unit === 'ml' && unit === 'L' || field.unit === 'CNY_cent' && unit === 'CNY' || field.unit === 'minute' && unit === 'hour';
  const container = unit && unit !== field.unit && !convertible;
  if (!container) return normalizeGenericFieldValue(field, input.value, unit ?? undefined);
  const quantity = typeof input.value === 'number' ? input.value : null;
  const explicit = evidence.answering || evidence.text.replace(/\s/g, '').includes(`每${unit}`) || evidence.text.replace(/\s/g, '').includes(`一${unit}`);
  if (quantity === null || input.unit_size === null || !explicit) throw new DomainError('invalid_input', `每${unit}是多少${field.unit ?? field.label}？请告诉我本次的容量或换算数量。`);
  const size = normalizeGenericFieldValue(field, input.unit_size, sizeUnit ?? undefined);
  if (typeof size !== 'number') throw new DomainError('invalid_input', '请提供本次单位对应的明确数值。');
  return normalizeGenericFieldValue(field, exactQuantity(quantity, size), field.unit);
}

/** Only declared fields and user-provided values become an engine payload. */
export function genericTurnValues(definition: TemplateDefinition, fields: TurnGenericField[], kind: 'record' | 'configuration', evidence: { text: string; answering: boolean }): GenericValues {
  const declared = kind === 'record' ? definition.recordFields : definition.configurationFields;
  const values: GenericValues = {};
  const seen = new Set<string>();
  for (const input of fields) {
    const field = declared.find(field => field.id === input.field_id);
    if (!field || seen.has(input.field_id)) throw new DomainError('invalid_input', '这次内容包含未定义或重复的字段，请按当前模板补充。');
    seen.add(input.field_id);
    if (kind === 'configuration' && input.value === null && !/清空|取消|不设|移除|清除|去掉/u.test(evidence.text)) throw new DomainError('invalid_input', `要清除${field.label}吗？请明确说明，现有设置还没有改变。`);
    // Clearing an optional configuration is different from a missing fact.
    values[field.id] = input.value === null && kind === 'configuration' && !field.required ? null : fieldValue(field, input, evidence);
  }
  return values;
}

/** Configuration suggestions never become facts. Only an explicit settings intent may change enabled defaults. */
export function genericRecordDefaultsFromTurn(definition:TemplateDefinition,current:GenericValues,fields:TurnGenericField[]|null|undefined,text:string):GenericValues|undefined {
  if(fields==null)return undefined;
  if(!/默认|沿用|每次都|以后都/u.test(text))throw new DomainError('invalid_input','请明确说明是否要调整以后记录的默认填写内容。');
  const clearing=/清空|清除|取消|关闭|移除|删除|不再|不设/u.test(text);
  if(!fields.length){if(!clearing)throw new DomainError('invalid_input','要清空所有默认填写内容吗？请明确说明。');return {};}
  const next={...current},seen=new Set<string>();
  for(const input of fields){
    const field=definition.recordFields.find(f=>f.id===input.field_id);
    if(!field||seen.has(field.id)||['date','name','startDate'].includes(field.id))throw new DomainError('invalid_input','默认填写包含重复或不支持的项目。');
    seen.add(field.id);
    if(input.value===null){if(!clearing)throw new DomainError('invalid_input',`要取消${field.label}的默认填写吗？请明确说明。`);delete next[field.id];}
    else next[field.id]=fieldValue(field,input,{text,answering:false});
  }
  return validateGenericDefaults(definition,next,'record');
}

export const isGenericWrite = (write: TurnWrite) => write.op === 'add_generic_record' || write.op === 'edit_generic_record' || write.op === 'configure_generic_plan';
export const isConfigurationWrite = (write: TurnWrite) => write.op === 'configure_reading_plan' || write.op === 'configure_ledger_plan' || write.op === 'configure_generic_plan';

/** A short answer cannot drop previously confirmed items from a mixed batch. */
export function mergeGenericAnswer(original: TurnWrite[], answer: TurnWrite[], fixed: number[], answerText = ''): TurnWrite[] {
  const used = new Set<number>();
  return original.map((previous, index) => {
    const candidateIndex = answer.findIndex((candidate, i) => !used.has(i) && candidate.op === previous.op && (!previous.plan_id || !candidate.plan_id || previous.plan_id === candidate.plan_id) && (!previous.record_id || !candidate.record_id || previous.record_id === candidate.record_id));
    if (candidateIndex >= 0) used.add(candidateIndex);
    if (fixed.includes(index) || candidateIndex < 0) return previous;
    const candidate = answer[candidateIndex]!;
    const fields = new Map((previous.generic_fields ?? []).map(field => [field.field_id, field]));
    for (const field of candidate.generic_fields ?? []) {
      const before = fields.get(field.field_id);
      fields.set(field.field_id, before ? { ...field, value: field.value ?? before.value, unit: field.unit ?? (field.unit_size !== null ? before.unit : null), unit_size: field.unit_size ?? before.unit_size, unit_size_unit: field.unit_size_unit ?? before.unit_size_unit } : field);
    }
    let defaults = previous.record_defaults;
    if (candidate.record_defaults != null) {
      if (!candidate.record_defaults.length) defaults=[];
      else {
        const merged = new Map((previous.record_defaults ?? []).map(field => [field.field_id,field]));
        for (const field of candidate.record_defaults) merged.set(field.field_id,field);
        defaults=[...merged.values()];
      }
    }
    return { ...previous, ...candidate, complete_setup: candidate.complete_setup || previous.complete_setup && !/暂不|先不|不完成|不采用|不接受|取消初始化/u.test(answerText), plan_id: candidate.plan_id ?? previous.plan_id, record_id: candidate.record_id ?? previous.record_id,
      date_kind: /今天|今日|昨天|昨日|前天|[零〇一二三四五六七八九十百\d]+天前|[这上下]周|星期|周[一二三四五六日天]|\d+[年月日号]|\d{4}-\d{2}-\d{2}|改.*日期/u.test(answerText) ? candidate.date_kind : previous.date_kind, date: candidate.date ?? previous.date, days_ago: candidate.days_ago ?? previous.days_ago,
      amount_text: candidate.amount_text ?? previous.amount_text, duration_value: candidate.duration_value ?? previous.duration_value,
      duration_unit: candidate.duration_unit ?? previous.duration_unit, note: candidate.note ?? previous.note,
      generic_fields: [...fields.values()],record_defaults:defaults,apply_template_defaults:candidate.apply_template_defaults??previous.apply_template_defaults, expected_config_version: previous.expected_config_version };
  });
}
