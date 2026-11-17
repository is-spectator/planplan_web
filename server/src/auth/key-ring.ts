import { z } from 'zod';

const key = z.object({
  kid: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  secret: z.string().refine((s) => Buffer.from(s, 'base64').length === 32 && Buffer.from(s, 'base64').toString('base64') === s),
}).strict();
const schema = z.object({
  current: key,
  previous: z.array(key.extend({ acceptUntil: z.iso.datetime() }).strict()).max(2).default([]),
}).strict();

export interface JwtKeyRing {
  current: { kid: string; secret: Uint8Array };
  previous: { kid: string; secret: Uint8Array; acceptUntil: number }[];
  issuer: string;
  audience: string;
}

export function parseJwtKeyRing(raw: string, environment: string, now = Date.now()): JwtKeyRing {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('JWT_KEYS_JSON must be valid JSON'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('JWT_KEYS_JSON requires distinct kids and 32-byte base64 keys');
  const { current, previous } = parsed.data;
  const keys = [current, ...previous];
  if (new Set(keys.map((k) => k.kid)).size !== keys.length || new Set(keys.map((k) => k.secret)).size !== keys.length) throw new Error('JWT_KEYS_JSON contains reused key IDs or secrets');
  if (previous.some((k) => Date.parse(k.acceptUntil) > now + 30 * 86400_000)) throw new Error('Previous JWT keys may be accepted for at most 30 days');
  return {
    current: { kid: current.kid, secret: Buffer.from(current.secret, 'base64') },
    previous: previous.map((k) => ({ kid: k.kid, secret: Buffer.from(k.secret, 'base64'), acceptUntil: Date.parse(k.acceptUntil) })),
    issuer: `planplan:${environment}`, audience: `planplan-ios:${environment}`,
  };
}
