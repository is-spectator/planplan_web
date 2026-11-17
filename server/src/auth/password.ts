import argon2 from 'argon2';
import { DomainError } from '../services/errors.js';

// Memory use is bounded even if several requests arrive before rate limits apply.
let active = 0;
const waiting: (() => void)[] = [];
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (waiting.length >= 16) throw new DomainError('rate_limited', '登录请求较多，请稍后再试。');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try { return await run(); }
  finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

export const hashPassword = (password: string) => bounded(() => argon2.hash(password, {
  type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
}));
export const checkPassword = (hash: string, password: string) => bounded(() => argon2.verify(hash, password));

// Unknown accounts still pay the same verification work; no user-controlled hash input.
let dummyHash: Promise<string> | undefined;
export async function checkUnknownPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword('unusable-placeholder-' + crypto.randomUUID());
  await checkPassword(await dummyHash, password);
}
