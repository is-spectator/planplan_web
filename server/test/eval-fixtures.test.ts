import { expect,it } from 'vitest';
import { makeFixture,openEvalFixtureDb } from '../evals/fixtures.js';

it('explicit test matrix fixtures are isolated and close removes only their random schema',async()=>{
  const first=await makeFixture('empty'),second=await makeFixture('empty');
  let firstClosed=false;
  try{
    expect(await second.db.query('SELECT id FROM users WHERE id=$1',[first.userId])).toEqual([]);
    const [schema]=await first.db.query<{name:string}>('SELECT current_schema() AS name');
    if(process.env.TEST_DATABASE_URL)expect(schema!.name).toMatch(/^eval_test_[a-f0-9]{32}$/);
    else expect(schema!.name).toBe('public');
    await first.db.close();firstClosed=true;
    if(process.env.TEST_DATABASE_URL)await first.db.close();
    if(process.env.TEST_DATABASE_URL)expect(await second.db.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema!.name])).toEqual([]);
    expect(await second.db.query('SELECT id FROM users WHERE id=$1',[second.userId])).toHaveLength(1);
  }finally{if(!firstClosed)await first.db.close();await second.db.close();}
});
it('non-test evaluation ignores an accidentally inherited database URL',async()=>{
  const db=await openEvalFixtureDb({NODE_ENV:'production',TEST_DATABASE_URL:'postgres://unreachable.invalid/not-a-test'});
  try{expect(await db.query('SELECT current_schema() AS name')).toEqual([{name:'public'}]);}finally{await db.close();}
});
