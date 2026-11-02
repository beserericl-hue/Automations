/**
 * Settings → Integrations: secrets are encrypted before they are stored and never returned,
 * one user cannot touch another's channels, blog endpoints are SSRF-checked, impersonation is
 * read-only, and the crypto matches the engine's (writer_engine/integrations.py).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  encryptSecret, decryptSecret, loadKey, last4, IntegrationKeyError,
} from '../lib/integration-crypto.js';
import { isPublicIp } from '../lib/url-safety.js';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const auth = { userId: 'u1', impersonating: false };

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.userId = auth.userId; req.isImpersonating = auth.impersonating; next();
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Resolve every hostname to a public address unless the test says otherwise.
const dnsAnswers: Record<string, string[]> = {};
vi.mock('../lib/url-safety.js', async (orig) => {
  const real = (await orig()) as typeof import('../lib/url-safety.js');
  return {
    ...real,
    checkPublicHttpsUrl: (url: string) => real.checkPublicHttpsUrl(url, async (h) => dnsAnswers[h] ?? ['93.184.216.34']),
    safeHttpsRequest: (...a: unknown[]) => safeRequest(...a),
  };
});
const safeRequest = vi.fn();

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    const rows = () => (db[table] ??= []);
    const run = () => {
      if (op === 'insert') {
        const row = { id: `id-${rows().length + 1}`, ...payload };
        rows().push(row);
        return [row];
      }
      const hit = rows().filter((r) => f.every((x) => x(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return hit; }
      if (op === 'delete') {
        db[table] = rows().filter((r) => !hit.includes(r));
        if (table === 'social_channels_v2') {
          // FK ON DELETE CASCADE from user_integrations_v2 (migration 043)
          db.user_integrations_v2 = (db.user_integrations_v2 ?? []).filter(
            (i) => !hit.some((c) => c.user_id === i.user_id && c.channel === i.channel));
        }
        return hit;
      }
      return hit;
    };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      delete: () => ((op = 'delete'), q),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      order: () => q,
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

beforeEach(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY_B64;
  auth.userId = 'u1'; auth.impersonating = false;
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(dnsAnswers)) delete dnsAnswers[k];
  db.social_channels_v2 = [
    { user_id: 'u1', channel: 'website', kind: 'website', label: 'TechAhir website', enabled: true,
      config: { endpoint: 'https://www.techahir.com/api/blog', auth_header: 'Authorization', public_base: 'https://www.techahir.com/blog/', author: 'Tech Ahir', auth_env: 'TECHAHIR_BLOG_API_KEY' } },
    { user_id: 'u1', channel: 'li_agile', kind: 'linkedin', label: 'Agile page', enabled: true, config: { page_id: '109837978' } },
    { user_id: 'u2', channel: 'li_other', kind: 'linkedin', label: 'Not mine', enabled: true, config: {} },
  ];
  db.user_integrations_v2 = [{ id: 'b1', user_id: 'u1', provider: 'blotato', channel: null, config: { account_id: '9115' } }];
  db.social_schedule_v2 = [];
  db.radar_subscriptions_v2 = [];
  safeRequest.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any>; text: string }> {
  const { integrationsRouter } = await import('../routes/integrations.js');
  const app = express(); app.use(express.json()); app.use('/api/integrations', integrationsRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/integrations${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, json: JSON.parse(text), text };
  } finally { server.close(); }
}

describe('integration crypto', () => {
  const ctx = { userId: '+14105914612', provider: 'website', channel: 'website' };
  it('round-trips and binds the ciphertext to its row', () => {
    const key = loadKey(KEY_B64);
    const token = encryptSecret('my-blog-token-123', ctx, key);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('my-blog-token');
    expect(decryptSecret(token, ctx, key)).toBe('my-blog-token-123');
    expect(() => decryptSecret(token, { ...ctx, userId: 'someone-else' }, key)).toThrow('could not be decrypted');
    expect(() => decryptSecret(token, { ...ctx, channel: 'other' }, key)).toThrow('could not be decrypted');
    expect(() => decryptSecret(token, ctx, Buffer.alloc(32))).toThrow('could not be decrypted');
  });
  it('decrypts what the engine encrypts (shared format)', () => {
    // Made by writer_engine.integrations.encrypt with the same key.
    const fromEngine = 'v1.VoDfGBmmo3NY1VTl.4BV167RLcAqcpwdmFg04Cd7OYiPbQ5ACFhhiq7_a_4ItOKY';
    expect(decryptSecret(fromEngine, { userId: 'u9', provider: 'blotato', channel: null }, loadKey(KEY_B64))).toBe('engine-vector-token');
  });
  it('validates the key', () => {
    expect(() => loadKey('')).toThrow(IntegrationKeyError);
    expect(() => loadKey(Buffer.from('short').toString('base64'))).toThrow('32 bytes');
    expect(() => loadKey('not base64 !!')).toThrow('base64');
  });
  it('only shows last4 for values long enough to keep secret', () => {
    expect(last4('abcdefghijkl1234')).toBe('1234');
    expect(last4('short123')).toBeNull();
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0',
    '::1', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2002:a00:1::1', 'ff02::1'])(
    'rejects %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isPublicIp(ip)).toBe(true));
  it('checks scheme, credentials, names and every resolved address', async () => {
    const { checkPublicHttpsUrl } = await vi.importActual<typeof import('../lib/url-safety.js')>('../lib/url-safety.js');
    const dns = (a: string[]) => async () => a;
    expect(await checkPublicHttpsUrl('http://x.com/', dns(['8.8.8.8']))).toMatch('https://');
    expect(await checkPublicHttpsUrl('https://a:b@x.com/', dns(['8.8.8.8']))).toMatch('username');
    expect(await checkPublicHttpsUrl('https://localhost/', dns(['8.8.8.8']))).toMatch('not a public host');
    expect(await checkPublicHttpsUrl('https://svc.railway.internal/', dns(['8.8.8.8']))).toMatch('not a public host');
    expect(await checkPublicHttpsUrl('https://169.254.169.254/', dns([]))).toMatch('not a public address');
    expect(await checkPublicHttpsUrl('https://x.com/', dns(['8.8.8.8', '10.0.0.1']))).toMatch('non-public');
    expect(await checkPublicHttpsUrl('https://x.com/', dns([]))).toMatch('does not resolve');
    expect(await checkPublicHttpsUrl('https://x.com/api', dns(['8.8.8.8']))).toBeNull();
  });
});

describe('SSRF guard at connect time', () => {
  it('the socket lookup refuses a name that resolves to loopback (anti-rebinding)', async () => {
    const { publicOnlyLookup } = await vi.importActual<typeof import('../lib/url-safety.js')>('../lib/url-safety.js');
    const err = await new Promise<Error | null>((resolve) =>
      publicOnlyLookup('localhost', {}, (e) => resolve(e as Error | null)));
    expect((err as Error & { code?: string })?.code).toBe('ESSRF');
  });
  it('a real request to a loopback name is refused before connecting', async () => {
    const { safeHttpsRequest } = await vi.importActual<typeof import('../lib/url-safety.js')>('../lib/url-safety.js');
    await expect(safeHttpsRequest('https://localhost:9/x')).rejects.toMatchObject({ code: 'ESSRF' });
  });
});

describe('GET /api/integrations', () => {
  it('returns channels and secret status but never a secret', async () => {
    await call('PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234' });
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('blotato-secret-key');
    expect(r.text).not.toContain('v1.');
    const d = r.json.data;
    expect(d.encryption_ready).toBe(true);
    expect(d.blotato).toMatchObject({ account_id: '9115', key: { set: true, last4: '1234' } });
    expect(d.linkedin).toEqual([{ channel: 'li_agile', label: 'Agile page', page_id: '109837978', account_override: null, enabled: true }]);
    expect(d.websites[0]).toMatchObject({ channel: 'website', endpoint: 'https://www.techahir.com/api/blog', token: { set: false, last4: null } });
    expect(JSON.stringify(d)).not.toContain('li_other'); // another user's channel
  });
});

describe('Blotato', () => {
  it('stores the key encrypted, with last4 and a timestamp', async () => {
    const r = await call('PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234', account_id: '4242' });
    expect(r.status).toBe(200);
    const row = db.user_integrations_v2.find((x) => x.provider === 'blotato')!;
    expect(String(row.secret_ciphertext)).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('blotato-secret-key');
    expect(row).toMatchObject({ secret_last4: '1234', config: { account_id: '4242' } });
    expect(decryptSecret(String(row.secret_ciphertext), { userId: 'u1', provider: 'blotato', channel: null })).toBe('blotato-secret-key-AAAA1234');
  });
  it('refuses to save a secret without the encryption key, and saves nothing', async () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    const r = await call('PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234' });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect(db.user_integrations_v2[0].secret_ciphertext).toBeUndefined();
  });
  it('validates input', async () => {
    expect((await call('PUT', '/blotato', { api_key: 'short' })).json.error.code).toBe('VALIDATION_ERROR');
    expect((await call('PUT', '/blotato', { account_id: 'bad id!' })).status).toBe(400);
    expect((await call('PUT', '/blotato', {})).status).toBe(400);
  });
  it('removes the key', async () => {
    await call('PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234' });
    expect((await call('DELETE', '/blotato/key')).status).toBe(200);
    expect(db.user_integrations_v2[0].secret_ciphertext).toBeNull();
  });
  it('test says so when no key is saved, without calling Blotato', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', ((orig) => (u: string, o: unknown) => (String(u).includes('blotato.com') ? fetchSpy(u, o) : orig(u as never, o as never)))(fetch));
    const r = await call('POST', '/blotato/test', {});
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('NO_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('test calls the read-only accounts endpoint with the saved key and reports a rejection', async () => {
    await call('PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234' });
    const seen: Array<{ url: string; key: string | null }> = [];
    const realFetch = fetch;
    vi.stubGlobal('fetch', async (u: string, o: RequestInit) => {
      if (!String(u).includes('blotato.com')) return realFetch(u, o);
      seen.push({ url: String(u), key: new Headers(o.headers).get('blotato-api-key') });
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
    });
    const r = await call('POST', '/blotato/test', {});
    expect(seen).toEqual([{ url: 'https://backend.blotato.com/v2/users/me/accounts', key: 'blotato-secret-key-AAAA1234' }]);
    expect(r.json.data).toMatchObject({ ok: false, status: 401, message: 'Blotato rejected this API key' });
  });
  it('test lists the connected accounts on success', async () => {
    const realFetch = fetch;
    vi.stubGlobal('fetch', async (u: string, o: RequestInit) =>
      String(u).includes('blotato.com')
        ? new Response(JSON.stringify({ items: [{ id: 9115, platform: 'linkedin', fullname: 'Eric' }] }), { status: 200 })
        : realFetch(u, o));
    const r = await call('POST', '/blotato/test', { api_key: 'typed-but-not-saved-key' });
    expect(r.json.data).toMatchObject({ ok: true, accounts: [{ id: '9115', platform: 'linkedin', name: 'Eric' }] });
  });
});

describe('LinkedIn targets', () => {
  it('adds, edits and removes a target', async () => {
    const add = await call('POST', '/linkedin', { label: 'My Company Page', page_id: '12345' });
    expect(add.status).toBe(201);
    expect(add.json.data.channel).toBe('li_my_company_page');
    const personal = await call('POST', '/linkedin', { label: 'Me', page_id: null });
    expect(db.social_channels_v2.find((c) => c.channel === personal.json.data.channel)!.config).toEqual({});
    expect((await call('PATCH', '/linkedin/li_my_company_page', { label: 'Renamed', page_id: null, enabled: false })).status).toBe(200);
    expect(db.social_channels_v2.find((c) => c.channel === 'li_my_company_page')).toMatchObject({ label: 'Renamed', enabled: false, config: {} });
    expect((await call('DELETE', '/linkedin/li_my_company_page')).status).toBe(200);
    expect(db.social_channels_v2.some((c) => c.channel === 'li_my_company_page')).toBe(false);
  });
  it('gives a second target with the same label its own key', async () => {
    await call('POST', '/linkedin', { label: 'Page' });
    const second = await call('POST', '/linkedin', { label: 'Page' });
    expect(second.json.data.channel).toBe('li_page_2');
  });
  it('rejects a non-numeric page id', async () => {
    expect((await call('POST', '/linkedin', { label: 'x', page_id: 'abc' })).status).toBe(400);
  });
  it('cannot touch another user\'s channel', async () => {
    expect((await call('PATCH', '/linkedin/li_other', { label: 'mine now' })).status).toBe(404);
    expect((await call('DELETE', '/linkedin/li_other')).status).toBe(404);
    expect(db.social_channels_v2.find((c) => c.channel === 'li_other')!.label).toBe('Not mine');
  });
  it('will not delete a channel a waiting post or a radar still uses', async () => {
    db.social_schedule_v2.push({ user_id: 'u1', display_number: 12, state: 'pending', channels: ['li_agile'] });
    db.radar_subscriptions_v2.push({ user_id: 'u1', radar: 'dev', settings: { channels: ['li_agile'] } });
    const r = await call('DELETE', '/linkedin/li_agile');
    expect(r.status).toBe(409);
    expect(r.json.error.message).toContain('#12');
    expect(r.json.error.message).toContain('dev radar');
  });
});

describe('Website blogs', () => {
  const SITE = { label: 'My Blog', endpoint: 'https://blog.example.com/api/posts', auth_header: 'x-api-key', auth_token: 'blog-token-abcdef9876', public_base: 'https://blog.example.com/p/', author: 'Me' };
  it('adds a website with its token encrypted', async () => {
    const r = await call('POST', '/websites', SITE);
    expect(r.status).toBe(201);
    const ch = r.json.data.channel;
    expect(ch).toBe('web_my_blog');
    expect(db.social_channels_v2.find((c) => c.channel === ch)!.config).toEqual({
      endpoint: SITE.endpoint, auth_header: 'x-api-key', public_base: SITE.public_base, author: 'Me' });
    const secret = db.user_integrations_v2.find((i) => i.channel === ch)!;
    expect(JSON.stringify(secret)).not.toContain('blog-token');
    expect(decryptSecret(String(secret.secret_ciphertext), { userId: 'u1', provider: 'website', channel: ch })).toBe(SITE.auth_token);
    const listed = (await call('GET', '/')).json.data.websites.find((w: Row) => w.channel === ch);
    expect(listed.token).toMatchObject({ set: true, last4: '9876' });
  });
  it.each([
    ['http://blog.example.com/api', 'VALIDATION_ERROR'],
    ['https://localhost/api', 'UNSAFE_URL'],
    ['https://169.254.169.254/latest/meta-data/', 'UNSAFE_URL'],
    ['https://rebind.example.com/api', 'UNSAFE_URL'],
  ])('refuses endpoint %s', async (endpoint, code) => {
    dnsAnswers['rebind.example.com'] = ['10.0.0.5'];
    const r = await call('POST', '/websites', { ...SITE, endpoint });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(code);
    expect(db.social_channels_v2.some((c) => c.channel === 'web_my_blog')).toBe(false);
  });
  it('rejects a header that cannot carry a token', async () => {
    expect((await call('POST', '/websites', { ...SITE, auth_header: 'Host' })).status).toBe(400);
    expect((await call('POST', '/websites', { ...SITE, auth_header: 'bad header' })).status).toBe(400);
  });
  it('edits a website, replaces its token, and drops the old auth_env', async () => {
    const r = await call('PATCH', '/websites/website', { auth_token: 'replacement-token-0042', author: '' });
    expect(r.status).toBe(200);
    const cfg = db.social_channels_v2.find((c) => c.channel === 'website')!.config as Row;
    expect(cfg.auth_env).toBeUndefined();
    expect(cfg.author).toBeUndefined();
    expect(cfg.endpoint).toBe('https://www.techahir.com/api/blog');
    const secret = db.user_integrations_v2.find((i) => i.channel === 'website')!;
    expect(secret.secret_last4).toBe('0042');
  });
  it('removes a website and its token', async () => {
    await call('POST', '/websites', SITE);
    expect((await call('DELETE', '/websites/web_my_blog')).status).toBe(200);
    expect(db.user_integrations_v2.some((i) => i.channel === 'web_my_blog')).toBe(false);
  });
  it('test sends the saved token in the configured header with GET and returns no body', async () => {
    await call('POST', '/websites', SITE);
    safeRequest.mockResolvedValue({ status: 200, location: null, body: '{"headers":{"X-Api-Key":"blog-token-abcdef9876"}}' });
    const r = await call('POST', '/websites/web_my_blog/test');
    expect(safeRequest).toHaveBeenCalledWith(SITE.endpoint, expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-api-key': 'blog-token-abcdef9876' }) }));
    expect(r.json.data).toMatchObject({ ok: true, status: 200, header: 'x-api-key' });
    expect(r.text).not.toContain('blog-token'); // an echo endpoint's body never comes back
  });
  it('test prefixes Bearer for Authorization and reports a rejected token', async () => {
    await call('POST', '/websites', { ...SITE, auth_header: 'Authorization' });
    safeRequest.mockResolvedValue({ status: 401, location: null, body: '' });
    const r = await call('POST', '/websites/web_my_blog/test');
    expect(safeRequest.mock.calls[0][1].headers.Authorization).toBe('Bearer blog-token-abcdef9876');
    expect(r.json.data).toMatchObject({ ok: false, status: 401 });
  });
  it('test needs a saved token', async () => {
    const r = await call('POST', '/websites/website/test');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('NO_KEY');
    expect(safeRequest).not.toHaveBeenCalled();
  });
});

describe('impersonation', () => {
  it('can read status but not change or use credentials', async () => {
    auth.impersonating = true;
    expect((await call('GET', '/')).json.data.read_only).toBe(true);
    for (const [m, p, b] of [
      ['PUT', '/blotato', { api_key: 'blotato-secret-key-AAAA1234' }],
      ['POST', '/blotato/test', {}],
      ['POST', '/linkedin', { label: 'x' }],
      ['POST', '/websites/website/test', undefined],
      ['DELETE', '/websites/website', undefined],
    ] as const) {
      const r = await call(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.code).toBe('IMPERSONATION_READ_ONLY');
    }
  });
});
