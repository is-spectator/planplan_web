import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { execute, type Action } from '../src/services/engine.js';
import { verifyGoalPeriod } from '../src/services/templates.js';
const T='2026-11-17T12:00:00+08:00';
describe('goal period reviewed at submission',()=>{
 it.each([
  ['official.ledger','configure_ledger_plan',{budgetCents:50000},'2026-10-31'],
  ['official.reading','configure_reading_plan',{minMinutes:20},'2026-11-15'],
  ['official.water','configure_generic_plan',{values:{dailyGoalMl:2000}},'2026-11-16'],
 ] as const)('%s rejects unseen new period with zero writes and accepts a fresh review',async(templateId,type,patch,reviewedOn)=>{
  const c=await setup();const ctx={...c.at(T),templateCapability:true,ledgerTemplateCapability:true,genericCapability:true};
  const adopted=await execute(c.db,ctx,randomUUID(),[{type:'adopt_template',templateId,templateVersion:1}]);const id=adopted.templatePlan!.planId;
  const snapshot=()=>c.db.query("SELECT (SELECT row_to_json(p) FROM plans p WHERE id=$1) AS plan,(SELECT row_to_json(b) FROM plan_template_bindings b WHERE plan_id=$1) AS binding,(SELECT data_version FROM users WHERE id=$2) AS version",[id,c.userId]);
  const before=await snapshot();const action={type,planId:id,expectedVersion:1,patch:{...patch,name:'跨期不能先改名'},reviewedOn,completeSetup:true} as Action;
  await expect(execute(c.db,ctx,randomUUID(),[action])).rejects.toMatchObject({code:'version_conflict',details:{kind:'goal_period_changed',today:'2026-11-17'}});expect(await snapshot()).toEqual(before);
  const op=randomUUID();const fixed={...action,reviewedOn:'2026-11-17'} as Action;const saved=await execute(c.db,ctx,op,[fixed]);expect(saved.templatePlan!.config.version).toBeGreaterThan(1);
  // Recovery uses the original input, not tomorrow's reinterpretation.
  expect((await execute(c.db,ctx,op,[fixed])).operationId).toBe(saved.operationId);
  expect(await c.db.query('SELECT id FROM records')).toHaveLength(0);
 });
 it('only affected periods matter; changing name does not require goal confirmation',()=>{
  expect(()=>verifyGoalPeriod('2026-11-16','2026-11-17',['week','month'])).not.toThrow();
  expect(()=>verifyGoalPeriod('2026-10-31','2026-11-17',[])).not.toThrow();
  expect(()=>verifyGoalPeriod(undefined,'2026-11-17',['day'])).not.toThrow();
  expect(()=>verifyGoalPeriod('2026-11-16','2026-11-17',['day','month'])).toThrow();
 });
});
