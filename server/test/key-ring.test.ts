import { decodeProtectedHeader, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import { authenticate, issueToken, type AuthConfig } from '../src/api/auth.js';
import { parseJwtKeyRing } from '../src/auth/key-ring.js';
import { setup } from './helpers.js';

const current = { kid: 'new-key', secret: Buffer.alloc(32, 2).toString('base64') };
const old = { kid: 'old-key', secret: Buffer.alloc(32, 1).toString('base64') };
const config = (env = 'beta', until = Date.now() + 60_000): AuthConfig => {
  const keyRing = parseJwtKeyRing(JSON.stringify({ current, previous: [{ ...old, acceptUntil: new Date(until).toISOString() }] }), env);
  return { jwtSecret: keyRing.current.secret, keyRing, appleAudience: null, devLogin: false };
};
it('signs with current kid; accepts a finite old key and honors logout token versions', async () => {
  const { db, userId } = await setup(); const auth = config();
  const token = await issueToken(auth, userId, 0);
  expect(decodeProtectedHeader(token).kid).toBe(current.kid);
  expect(await authenticate(auth, db, `Bearer ${token}`)).toBe(userId);
  const previous = await new SignJWT({ tv: 0 }).setProtectedHeader({ alg: 'HS256', kid: old.kid }).setSubject(userId).setIssuedAt().setExpirationTime('1h').setIssuer('planplan:beta').setAudience('planplan-ios:beta').sign(Buffer.from(old.secret, 'base64'));
  expect(await authenticate(auth, db, `Bearer ${previous}`)).toBe(userId);
  await expect(authenticate(config('beta', Date.now() - 1), db, `Bearer ${previous}`)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(authenticate(config('production'), db, `Bearer ${token}`)).rejects.toMatchObject({ code: 'unauthorized' });
  await db.query('UPDATE users SET token_version = 1 WHERE id = $1', [userId]);
  await expect(authenticate(auth, db, `Bearer ${token}`)).rejects.toMatchObject({ code: 'unauthorized' });
});
it('rejects no-kid and unknown-kid tokens in managed mode', async () => {
  const { db, userId } = await setup(); const auth = config();
  for (const kid of [undefined, 'attacker-key']) {
    const token = await new SignJWT({ tv: 0 }).setProtectedHeader({ alg: 'HS256', ...(kid ? { kid } : {}) }).setSubject(userId).setExpirationTime('1h').setIssuer('planplan:beta').setAudience('planplan-ios:beta').sign(auth.jwtSecret);
    await expect(authenticate(auth, db, `Bearer ${token}`)).rejects.toMatchObject({ code: 'unauthorized' });
  }
});
it('rejects malformed rings, reused keys, and unbounded grace windows', () => {
  expect(() => parseJwtKeyRing('{bad', 'beta')).toThrow('JSON');
  expect(() => parseJwtKeyRing(JSON.stringify({ current: { ...current, secret: 'short' } }), 'beta')).toThrow('32-byte');
  expect(() => parseJwtKeyRing(JSON.stringify({ current, previous: [{ ...current, acceptUntil: new Date().toISOString() }] }), 'beta')).toThrow('reused');
  expect(() => config('beta', Date.now() + 31 * 86400_000)).toThrow('30 days');
});
