/** 用真实的 Qwen 跑一段对话，检查理解与执行链路。需要 ../.env 里的 QWEN_API_KEY。 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/db/db.js';
import { QwenLlm } from '../src/ai/llm.js';
import { Chat, type Card } from '../src/services/chat.js';

for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) if (existsSync(p)) process.loadEnvFile(p);
const db = await openDb('pglite://memory');
const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name, ai_consent) VALUES ('smoke', true) RETURNING id`);
const chat = new Chat(db, new QwenLlm(process.env.QWEN_API_KEY!, process.env.QWEN_BASE_URL!, process.env.QWEN_MODEL ?? 'qwen3.8-max'));

const lines = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['我想省钱，帮我记账', '每月最多花3000元', '午饭20元，刚才又读了25分钟', '每周阅读5天，每天20分钟', '刚才又读了25分钟', '这个月还剩多少？', '刚才不是20元，是25元', '我准备买20元咖啡', '每天21点提醒我', '昨天打车35', '今天读书了', '工资到账了8000', '本周读了几天'];

const brief = (c: Card): string => {
  if (c.type === 'receipt') return `receipt[${c.items.map((i) => i.type).join(',')}]`;
  if (c.type === 'clarify') return `clarify(${c.question} | ${c.options.map((o) => o.label).join(' / ')})`;
  if (c.type === 'query') return `query:${c.kind}${'remainingCents' in c ? ` remaining=${c.remainingCents}` : ''}${'stats' in c ? ` met=${c.stats.metDays}/${c.stats.targetDays}` : ''}`;
  if (c.type === 'error') return `error:${c.code}`;
  return c.type;
};

let i = 0;
for (const text of lines) {
  const t0 = Date.now();
  const r = await chat.send(u!.id, { clientMsgId: `smoke-${++i}-${Date.now()}`, text, inputAt: new Date() });
  console.log(`\n> ${text}  (${Date.now() - t0}ms)\n  ${r.assistant.text || '（无文字）'}\n  ${r.assistant.cards.map(brief).join('  ')}`);
}
await db.close();
