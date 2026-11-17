import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CASES } from '../evals/cases.js';

const hash = (files: string[]) => {
  const h = createHash('sha256');
  for (const file of files) h.update(readFileSync(new URL(file, import.meta.url)));
  return h.digest('hex');
};
const fingerprint = {
  prompt: hash(['../src/ai/prompt.ts', '../src/ai/llm.ts']),
  protocol: hash(['../src/ai/turn.ts']),
  dataset: hash(['../evals/cases.ts', '../evals/fixtures.ts', '../evals/query-expectations.ts', '../evals/first-week-expectations.ts']),
  caseIds: CASES.map((c) => c.id).sort(),
  caseRules: Object.fromEntries(CASES.map((c) => [c.id, { kind: c.expect.kind, clear: c.expect.kind === 'records' && c.expect.clear !== false }])),
};
const destination = new URL('../src/ai/build-fingerprint.json', import.meta.url);
const json = JSON.stringify(fingerprint, null, 2) + '\n';
if (!existsSync(destination) || readFileSync(destination, 'utf8') !== json) writeFileSync(destination, json);
// Creation has its own prompt and protocol; do not attribute those attempts to record chat.
const creationDestination = new URL('../src/ai/creation-build-fingerprint.json', import.meta.url);
const creation = JSON.stringify({ prompt: hash(['../src/ai/creation.ts']), protocol: hash(['../src/ai/creation.ts', '../src/ai/creation-runtime.ts', '../src/templates/contracts.ts', '../src/services/generic.ts']) }, null, 2) + '\n';
if (!existsSync(creationDestination) || readFileSync(creationDestination, 'utf8') !== creation) writeFileSync(creationDestination, creation);
if (process.argv.includes('--print')) console.log(JSON.stringify({ ...fingerprint, caseIds: undefined, caseRules: undefined, caseCount: fingerprint.caseIds.length }));
