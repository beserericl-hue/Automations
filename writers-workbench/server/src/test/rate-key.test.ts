/**
 * Rate limits count per signed-in user, not per IP.
 *
 * Keyed on the IP (once `trust proxy` made it the real one), one author's tabs and polls, and the
 * whole E2E suite, shared a 100-a-minute bucket and 453 requests in one run were refused.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { AddressInfo } from 'net';
import { rateKey } from '../lib/rate-key.js';

const jwt = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;

describe('rateKey', () => {
  it('keys a signed-in request on the user, from the header or the stream token', () => {
    const req = (headers: Record<string, string>, query: Record<string, string> = {}) =>
      ({ headers, query, ip: '203.0.113.9' }) as never;
    expect(rateKey(req({ authorization: `Bearer ${jwt('u-1')}` }))).toBe('user:u-1');
    expect(rateKey(req({}, { token: jwt('u-2') }))).toBe('user:u-2');
    expect(rateKey(req({ authorization: 'Bearer not-a-jwt' }))).toBe('ip:203.0.113.9');
    expect(rateKey(req({}))).toBe('ip:203.0.113.9');
  });

  it('two users behind one address do not share a limit; one user’s tabs do', async () => {
    const app = express();
    app.set('trust proxy', 2);
    app.use(rateLimit({ windowMs: 60_000, max: 2, keyGenerator: rateKey, validate: { keyGeneratorIpFallback: false } }));
    app.get('/x', (_req, res) => res.send('ok'));
    const server = app.listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const get = (sub: string) =>
      fetch(`${base}/x`, { headers: { authorization: `Bearer ${jwt(sub)}`, 'x-forwarded-for': '198.51.100.7, 152.233.30.104' } }).then((r) => r.status);
    try {
      expect([await get('a'), await get('a'), await get('a')]).toEqual([200, 200, 429]);
      expect(await get('b')).toBe(200);
    } finally {
      server.close();
    }
  });
});
