/**
 * Three server fixes, each one a thing the logs or the docs showed.
 *
 * - Request logs no longer carry credentials: the Authorization header, the shared secrets, and the
 *   `?token=` the live-updates stream puts in its URL were all in the Railway logs.
 * - Behind Railway's two proxies, req.ip is the client, not the proxy, and a client cannot choose
 *   its own address by sending an X-Forwarded-For header.
 * - The API docs build with every route; one malformed YAML block dropped a file from them.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import express from 'express';
import type { AddressInfo } from 'net';
import pino from 'pino';
import { REDACT_PATHS, redactUrl } from '../lib/logger.js';

describe('request logs', () => {
  it('redact credentials in headers and in the URL', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, sink);
    log.info({
      req: {
        url: redactUrl('/api/callback/events?token=eyJhbGciOi.secret.sig&x=1'),
        query: { token: 'eyJhbGciOi.secret.sig' },
        headers: { authorization: 'Bearer eyJhbGciOi.secret.sig', 'x-service-secret': 's3cret', 'user-agent': 'ua' },
      },
    }, 'request completed');
    const out = lines.join('');
    expect(out).not.toContain('secret.sig');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('/api/callback/events?token=[Redacted]&x=1');
    expect(out).toContain('"user-agent":"ua"');
  });
});

describe('trust proxy', () => {
  it('reads the client address from behind exactly two proxies, and ignores one the client forged', async () => {
    const app = express();
    app.set('trust proxy', 2);
    app.get('/ip', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
    const server = app.listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      // As Railway delivers it: the client, then its edge; the router is the socket peer.
      const real = await fetch(`${base}/ip`, { headers: { 'x-forwarded-for': '34.145.205.88, 152.233.30.104', 'x-forwarded-proto': 'https' } }).then((r) => r.json());
      expect(real).toEqual({ ip: '34.145.205.88', protocol: 'https' });
      // A client that prepends its own entry does not get to be that address.
      const forged = (await fetch(`${base}/ip`, { headers: { 'x-forwarded-for': '1.2.3.4, 34.145.205.88, 152.233.30.104' } }).then((r) => r.json())) as { ip: string };
      expect(forged.ip).toBe('34.145.205.88');
    } finally {
      server.close();
    }
  });
});

describe('API docs', () => {
  it('build without a YAML error, with the newsletter-sends routes in them', async () => {
    const { swaggerSpec } = await import('../swagger.js');
    const paths = Object.keys((swaggerSpec as { paths?: Record<string, unknown> }).paths ?? {});
    expect(paths.some((p) => p.includes('newsletter-sends'))).toBe(true);
  });
});
