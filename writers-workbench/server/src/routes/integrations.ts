/**
 * Settings → Integrations: each user's own Blotato account, LinkedIn targets and blog websites
 * (migration 043). These are the user's accounts, not the company's, so their keys are user
 * settings — never Railway variables.
 *
 *   GET    /api/integrations                     everything below, secrets as set / last4 / updated_at only
 *   PUT    /api/integrations/blotato             { api_key?, account_id? }
 *   DELETE /api/integrations/blotato/key         forget the Blotato key
 *   POST   /api/integrations/blotato/test        { api_key? } — lists the Blotato account's connections
 *   POST   /api/integrations/linkedin            { label, page_id|null, enabled }
 *   PATCH  /api/integrations/linkedin/:channel
 *   DELETE /api/integrations/linkedin/:channel
 *   POST   /api/integrations/websites            { label, endpoint, auth_header, auth_token?, public_base?, author?, enabled }
 *   PATCH  /api/integrations/websites/:channel
 *   DELETE /api/integrations/websites/:channel
 *   POST   /api/integrations/websites/:channel/test   GET the endpoint with the saved token; nothing is posted
 *
 * Secrets are WRITE-ONLY. They are AES-256-GCM encrypted here (lib/integration-crypto.ts) before
 * they reach the database, and no response ever contains one — not even the response of a test,
 * since an echo endpoint would hand the token straight back. A superuser impersonating a user can
 * see what is set but cannot change or use it.
 *
 * Blog endpoints are user-supplied URLs the engine will call with a token attached, so they are
 * SSRF-checked (https, public addresses only) when saved, when tested, and again by the engine
 * when it sends.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { encryptSecret, encryptionReady, decryptSecret, last4, IntegrationKeyError } from '../lib/integration-crypto.js';
import { checkPublicHttpsUrl, safeHttpsRequest } from '../lib/url-safety.js';
import { logger } from '../lib/logger.js';

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

const TABLE = 'user_integrations_v2';
const CHANNELS = 'social_channels_v2';
const BLOTATO_BASE = (): string => (process.env.BLOTATO_BASE_URL || 'https://backend.blotato.com/v2').replace(/\/+$/, '');

type Row = Record<string, unknown>;

const chanParam = (req: Request): string => String(req.params.channel ?? "");

function bad(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

function parse<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const first = r.error.issues[0];
  bad(res, 400, 'VALIDATION_ERROR', `${first.path.join('.') || 'body'}: ${first.message}`);
  return null;
}

/** Changing or using a user's credentials is the user's own act; impersonation only looks. */
function refuseImpersonation(req: Request, res: Response): boolean {
  if (req.isImpersonating) {
    bad(res, 403, 'IMPERSONATION_READ_ONLY', 'Integrations cannot be changed or tested while impersonating a user');
    return true;
  }
  return false;
}

function secretStatus(row: Row | undefined): { set: boolean; last4: string | null; updated_at: string | null } {
  return {
    set: Boolean(row?.secret_ciphertext),
    last4: row?.secret_ciphertext ? ((row.secret_last4 as string | null) ?? null) : null,
    updated_at: row?.secret_ciphertext ? ((row.secret_updated_at as string | null) ?? null) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const LABEL = z.string().trim().min(1, 'is required').max(80);
const ACCOUNT_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'must be letters, digits, - or _ (up to 40)');
const PAGE_ID = z.string().trim().regex(/^\d{1,30}$/, 'must be the numeric LinkedIn page id');
const SECRET = z.string().trim().min(8, 'looks too short to be a key').max(4096).refine((s) => !/[\r\n]/.test(s), 'must be one line');
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-authorization', 'proxy-connection', 'cookie', 'expect',
]);
const HEADER = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'must be a header name such as Authorization or x-api-key')
  .refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), 'cannot be used for a token');
const HTTPS_URL = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https:// URL');

const BlotatoSchema = z
  .object({ api_key: SECRET.optional(), account_id: z.union([ACCOUNT_ID, z.literal('')]).optional() })
  .strict();
const BlotatoTestSchema = z.object({ api_key: SECRET.optional() }).strict();
const LinkedInCreate = z.object({ label: LABEL, page_id: PAGE_ID.nullable().optional(), enabled: z.boolean().optional() }).strict();
const LinkedInPatch = LinkedInCreate.partial().strict();
const WebsiteFields = {
  label: LABEL,
  endpoint: HTTPS_URL,
  auth_header: HEADER.optional(),
  auth_token: SECRET.optional(),
  public_base: z.union([HTTPS_URL, z.literal('')]).optional(),
  author: z.string().trim().max(120).optional(),
  enabled: z.boolean().optional(),
};
const WebsiteCreate = z.object(WebsiteFields).strict();
const WebsitePatch = z.object(WebsiteFields).partial().strict();

// ---------------------------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------------------------

async function integrationRows(userId: string): Promise<Row[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select('provider, channel, config, secret_ciphertext, secret_last4, secret_updated_at')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

async function channelRows(userId: string): Promise<Row[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CHANNELS)
    .select('channel, kind, label, config, enabled, updated_at')
    .eq('user_id', userId)
    .order('channel');
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

async function ownChannel(userId: string, channel: string, kind: string): Promise<Row | null> {
  const { data } = await getSupabaseAdmin()
    .from(CHANNELS)
    .select('channel, kind, label, config, enabled')
    .eq('user_id', userId)
    .eq('channel', channel)
    .eq('kind', kind)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

/** Insert or update the user's row for (provider, channel). The unique index is on an expression,
 *  which PostgREST cannot upsert against, so this is a read then a write. */
async function saveIntegration(userId: string, provider: 'blotato' | 'website', channel: string | null, patch: Row): Promise<void> {
  const sb = getSupabaseAdmin();
  let q = sb.from(TABLE).select('id').eq('user_id', userId).eq('provider', provider);
  q = channel === null ? q.is('channel', null) : q.eq('channel', channel);
  const { data: existing } = await q.maybeSingle();
  if (existing) {
    const { error } = await sb.from(TABLE).update(patch).eq('id', (existing as Row).id as string);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from(TABLE).insert({ user_id: userId, provider, channel, config: {}, ...patch });
    if (error) throw new Error(error.message);
  }
}

function sealed(userId: string, provider: 'blotato' | 'website', channel: string | null, secret: string): Row {
  return {
    secret_ciphertext: encryptSecret(secret, { userId, provider, channel }),
    secret_last4: last4(secret),
    secret_updated_at: new Date().toISOString(),
  };
}

async function storedSecret(userId: string, provider: 'blotato' | 'website', channel: string | null): Promise<string | null> {
  const rows = await integrationRows(userId);
  const row = rows.find((r) => r.provider === provider && (r.channel ?? null) === channel);
  if (!row?.secret_ciphertext) return null;
  return decryptSecret(String(row.secret_ciphertext), { userId, provider, channel });
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'channel';
}

async function newChannelKey(userId: string, prefix: 'li' | 'web', label: string): Promise<string> {
  const taken = new Set((await channelRows(userId)).map((r) => String(r.channel)));
  const base = `${prefix}_${slug(label)}`.slice(0, 36);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  throw new Error('no free channel key');
}

/** Posts still waiting to go out, and radar subscriptions, that name this channel. */
async function channelUses(userId: string, channel: string): Promise<string[]> {
  const sb = getSupabaseAdmin();
  const uses: string[] = [];
  const { data: posts } = await sb
    .from('social_schedule_v2')
    .select('display_number, channels, state')
    .eq('user_id', userId)
    .in('state', ['pending', 'posting', 'failed', 'partial']);
  const waiting = ((posts ?? []) as Row[]).filter((p) => Array.isArray(p.channels) && (p.channels as string[]).includes(channel));
  if (waiting.length) uses.push(`${waiting.length} post(s) not yet sent (#${waiting.slice(0, 5).map((p) => p.display_number).join(', #')})`);
  const { data: subs } = await sb.from('radar_subscriptions_v2').select('radar, settings').eq('user_id', userId);
  for (const s of (subs ?? []) as Row[]) {
    const chans = ((s.settings as Row | null)?.channels as string[] | undefined) ?? [];
    if (chans.includes(channel)) uses.push(`the ${String(s.radar)} radar`);
  }
  return uses;
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

integrationsRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const [integrations, channels] = await Promise.all([integrationRows(userId), channelRows(userId)]);
    const blotato = integrations.find((r) => r.provider === 'blotato');
    const tokens = new Map(integrations.filter((r) => r.provider === 'website').map((r) => [String(r.channel), r]));
    res.json({
      success: true,
      data: {
        encryption_ready: encryptionReady(),
        read_only: Boolean(req.isImpersonating),
        blotato: {
          account_id: String(((blotato?.config as Row | undefined)?.account_id as string | undefined) ?? ''),
          key: secretStatus(blotato),
        },
        linkedin: channels
          .filter((c) => c.kind === 'linkedin')
          .map((c) => {
            const cfg = (c.config ?? {}) as Row;
            return {
              channel: c.channel,
              label: c.label,
              page_id: (cfg.page_id as string | undefined) || null,
              account_override: (cfg.account_id as string | undefined) || null,
              enabled: c.enabled !== false,
            };
          }),
        websites: channels
          .filter((c) => c.kind === 'website')
          .map((c) => {
            const cfg = (c.config ?? {}) as Row;
            return {
              channel: c.channel,
              label: c.label,
              endpoint: String(cfg.endpoint ?? ''),
              auth_header: String(cfg.auth_header ?? 'Authorization'),
              public_base: String(cfg.public_base ?? ''),
              author: String(cfg.author ?? ''),
              enabled: c.enabled !== false,
              token: secretStatus(tokens.get(String(c.channel))),
            };
          }),
      },
    });
  } catch (err) {
    const message = (err as Error).message || '';
    if (/user_integrations_v2/.test(message) && /does not exist|schema cache/.test(message)) {
      return bad(res, 503, 'MIGRATION_PENDING', 'Migration 043_user_integrations.sql has not been applied to this database');
    }
    logger.error({ err: message }, 'integrations: read failed');
    bad(res, 500, 'DB_ERROR', 'Could not read your integrations');
  }
});

// ---------------------------------------------------------------------------------------------
// Blotato
// ---------------------------------------------------------------------------------------------

function keyError(res: Response, err: unknown): boolean {
  if (err instanceof IntegrationKeyError) {
    logger.error({ err: err.message }, 'integrations: encryption key problem');
    bad(res, 503, 'ENCRYPTION_NOT_CONFIGURED', 'Secret storage is not configured on this server (INTEGRATIONS_ENCRYPTION_KEY). Nothing was saved.');
    return true;
  }
  return false;
}

integrationsRouter.put('/blotato', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(BlotatoSchema, req.body, res);
  if (!body) return;
  if (body.api_key === undefined && body.account_id === undefined) return bad(res, 400, 'VALIDATION_ERROR', 'Nothing to save');
  const userId = req.userId!;
  try {
    const patch: Row = {};
    if (body.api_key !== undefined) Object.assign(patch, sealed(userId, 'blotato', null, body.api_key));
    if (body.account_id !== undefined) patch.config = { account_id: body.account_id };
    await saveIntegration(userId, 'blotato', null, patch);
    res.json({ success: true });
  } catch (err) {
    if (keyError(res, err)) return;
    logger.error({ err: (err as Error).message }, 'integrations: blotato save failed');
    bad(res, 500, 'DB_ERROR', 'Could not save the Blotato settings');
  }
});

integrationsRouter.delete('/blotato/key', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  try {
    await saveIntegration(req.userId!, 'blotato', null, { secret_ciphertext: null, secret_last4: null, secret_updated_at: null });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'integrations: blotato key delete failed');
    bad(res, 500, 'DB_ERROR', 'Could not remove the key');
  }
});

integrationsRouter.post('/blotato/test', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(BlotatoTestSchema, req.body, res);
  if (!body) return;
  let apiKey = body.api_key ?? null;
  try {
    apiKey ??= await storedSecret(req.userId!, 'blotato', null);
  } catch (err) {
    if (keyError(res, err)) return;
    return bad(res, 500, 'DECRYPT_FAILED', 'The saved Blotato key could not be read. Enter it again.');
  }
  if (!apiKey) return bad(res, 400, 'NO_KEY', 'No Blotato API key is saved. Enter one first.');
  try {
    // Read-only: lists the accounts connected to this Blotato key. Nothing is posted.
    const r = await fetch(`${BLOTATO_BASE()}/users/me/accounts`, {
      headers: { 'blotato-api-key': apiKey, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401 || r.status === 403) {
      return res.json({ success: true, data: { ok: false, status: r.status, message: 'Blotato rejected this API key' } });
    }
    if (!r.ok) {
      return res.json({ success: true, data: { ok: false, status: r.status, message: `Blotato answered HTTP ${r.status}` } });
    }
    const json = (await r.json().catch(() => ({}))) as { items?: Row[]; data?: Row[] } | Row[];
    const items = (Array.isArray(json) ? json : (json.items ?? json.data ?? [])) as Row[];
    const accounts = items.slice(0, 50).map((a) => ({
      id: String(a.id ?? ''),
      platform: String(a.platform ?? ''),
      name: String(a.fullname ?? a.username ?? a.name ?? ''),
    }));
    res.json({ success: true, data: { ok: true, status: r.status, message: `Connected: ${accounts.length} account(s) on this Blotato key`, accounts } });
  } catch (err) {
    res.json({ success: true, data: { ok: false, status: 0, message: `Could not reach Blotato (${(err as Error).name})` } });
  }
});

// ---------------------------------------------------------------------------------------------
// LinkedIn targets
// ---------------------------------------------------------------------------------------------

integrationsRouter.post('/linkedin', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(LinkedInCreate, req.body, res);
  if (!body) return;
  const userId = req.userId!;
  try {
    const channel = await newChannelKey(userId, 'li', body.label);
    const config: Row = body.page_id ? { page_id: body.page_id } : {};
    const { error } = await getSupabaseAdmin()
      .from(CHANNELS)
      .insert({ user_id: userId, channel, kind: 'linkedin', label: body.label, config, enabled: body.enabled ?? true });
    if (error) throw new Error(error.message);
    res.status(201).json({ success: true, data: { channel } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'integrations: linkedin create failed');
    bad(res, 500, 'DB_ERROR', 'Could not add the LinkedIn target');
  }
});

integrationsRouter.patch('/linkedin/:channel', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(LinkedInPatch, req.body, res);
  if (!body) return;
  const userId = req.userId!;
  const existing = await ownChannel(userId, chanParam(req), 'linkedin');
  if (!existing) return bad(res, 404, 'NOT_FOUND', 'No such LinkedIn target');
  const patch: Row = {};
  if (body.label !== undefined) patch.label = body.label;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.page_id !== undefined) {
    const config = { ...((existing.config ?? {}) as Row) };
    if (body.page_id) config.page_id = body.page_id;
    else delete config.page_id;
    patch.config = config;
  }
  const { error } = await getSupabaseAdmin().from(CHANNELS).update(patch).eq('user_id', userId).eq('channel', chanParam(req));
  if (error) return bad(res, 500, 'DB_ERROR', 'Could not save the LinkedIn target');
  res.json({ success: true });
});

async function deleteChannel(req: Request, res: Response, kind: 'linkedin' | 'website'): Promise<void> {
  if (refuseImpersonation(req, res)) return;
  const userId = req.userId!;
  const channel = chanParam(req);
  if (!(await ownChannel(userId, channel, kind))) return bad(res, 404, 'NOT_FOUND', 'No such channel');
  const uses = await channelUses(userId, channel);
  if (uses.length) {
    return bad(res, 409, 'CHANNEL_IN_USE', `Still used by ${uses.join(' and ')}. Turn it off instead, or move those first.`);
  }
  // A website's token row goes with it (FK ON DELETE CASCADE in migration 043).
  const { error } = await getSupabaseAdmin().from(CHANNELS).delete().eq('user_id', userId).eq('channel', channel);
  if (error) return bad(res, 500, 'DB_ERROR', 'Could not remove the channel');
  res.json({ success: true });
}

integrationsRouter.delete('/linkedin/:channel', (req, res) => deleteChannel(req, res, 'linkedin'));

// ---------------------------------------------------------------------------------------------
// Website blogs
// ---------------------------------------------------------------------------------------------

integrationsRouter.post('/websites', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(WebsiteCreate, req.body, res);
  if (!body) return;
  const userId = req.userId!;
  const unsafe = await checkPublicHttpsUrl(body.endpoint);
  if (unsafe) return bad(res, 400, 'UNSAFE_URL', `Endpoint refused: ${unsafe}`);
  if (body.auth_token !== undefined && !encryptionReady()) {
    return bad(res, 503, 'ENCRYPTION_NOT_CONFIGURED', 'Secret storage is not configured on this server (INTEGRATIONS_ENCRYPTION_KEY). Nothing was saved.');
  }
  try {
    const channel = await newChannelKey(userId, 'web', body.label);
    const config: Row = {
      endpoint: body.endpoint,
      auth_header: body.auth_header || 'Authorization',
      ...(body.public_base ? { public_base: body.public_base } : {}),
      ...(body.author ? { author: body.author } : {}),
    };
    const { error } = await getSupabaseAdmin()
      .from(CHANNELS)
      .insert({ user_id: userId, channel, kind: 'website', label: body.label, config, enabled: body.enabled ?? true });
    if (error) throw new Error(error.message);
    if (body.auth_token !== undefined) await saveIntegration(userId, 'website', channel, sealed(userId, 'website', channel, body.auth_token));
    res.status(201).json({ success: true, data: { channel } });
  } catch (err) {
    if (keyError(res, err)) return;
    logger.error({ err: (err as Error).message }, 'integrations: website create failed');
    bad(res, 500, 'DB_ERROR', 'Could not add the website');
  }
});

integrationsRouter.patch('/websites/:channel', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const body = parse(WebsitePatch, req.body, res);
  if (!body) return;
  const userId = req.userId!;
  const channel = chanParam(req);
  const existing = await ownChannel(userId, channel, 'website');
  if (!existing) return bad(res, 404, 'NOT_FOUND', 'No such website');
  if (body.endpoint !== undefined) {
    const unsafe = await checkPublicHttpsUrl(body.endpoint);
    if (unsafe) return bad(res, 400, 'UNSAFE_URL', `Endpoint refused: ${unsafe}`);
  }
  try {
    const config = { ...((existing.config ?? {}) as Row) };
    delete config.auth_env; // the old shared-variable path; never honoured again
    if (body.endpoint !== undefined) config.endpoint = body.endpoint;
    if (body.auth_header !== undefined) config.auth_header = body.auth_header;
    if (body.public_base !== undefined) {
      if (body.public_base) config.public_base = body.public_base;
      else delete config.public_base;
    }
    if (body.author !== undefined) {
      if (body.author) config.author = body.author;
      else delete config.author;
    }
    const patch: Row = { config };
    if (body.label !== undefined) patch.label = body.label;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.auth_token !== undefined) {
      // Encrypt first: a missing key must fail the whole save, not half of it.
      const secret = sealed(userId, 'website', channel, body.auth_token);
      const { error } = await getSupabaseAdmin().from(CHANNELS).update(patch).eq('user_id', userId).eq('channel', channel);
      if (error) throw new Error(error.message);
      await saveIntegration(userId, 'website', channel, secret);
    } else {
      const { error } = await getSupabaseAdmin().from(CHANNELS).update(patch).eq('user_id', userId).eq('channel', channel);
      if (error) throw new Error(error.message);
    }
    res.json({ success: true });
  } catch (err) {
    if (keyError(res, err)) return;
    logger.error({ err: (err as Error).message }, 'integrations: website save failed');
    bad(res, 500, 'DB_ERROR', 'Could not save the website');
  }
});

integrationsRouter.delete('/websites/:channel', (req, res) => deleteChannel(req, res, 'website'));

integrationsRouter.post('/websites/:channel/test', async (req: Request, res: Response) => {
  if (refuseImpersonation(req, res)) return;
  const userId = req.userId!;
  const channel = chanParam(req);
  const existing = await ownChannel(userId, channel, 'website');
  if (!existing) return bad(res, 404, 'NOT_FOUND', 'No such website');
  const cfg = (existing.config ?? {}) as Row;
  const endpoint = String(cfg.endpoint ?? '');
  const header = String(cfg.auth_header || 'Authorization');
  let token: string | null;
  try {
    token = await storedSecret(userId, 'website', channel);
  } catch (err) {
    if (keyError(res, err)) return;
    return bad(res, 500, 'DECRYPT_FAILED', 'The saved token could not be read. Enter it again.');
  }
  if (!token) return bad(res, 400, 'NO_KEY', 'No auth token is saved for this website. Enter one first.');
  const unsafe = await checkPublicHttpsUrl(endpoint);
  if (unsafe) return bad(res, 400, 'UNSAFE_URL', `Endpoint refused: ${unsafe}`);
  const value = header.toLowerCase() === 'authorization' && !/^bearer /i.test(token) ? `Bearer ${token}` : token;
  try {
    // GET, not POST: a test must not publish anything. The body is never returned — an echo
    // service would hand the token straight back to the browser.
    const r = await safeHttpsRequest(endpoint, { method: 'GET', headers: { [header]: value, Accept: 'application/json' } });
    const authRejected = r.status === 401 || r.status === 403;
    const redirected = r.status >= 300 && r.status < 400;
    const message = authRejected
      ? `The website rejected the token (HTTP ${r.status})`
      : redirected
        ? `The endpoint redirects (HTTP ${r.status}); posts are not sent through redirects — use the final URL`
        : r.status >= 500
          ? `The website answered HTTP ${r.status}`
          : `Reachable (HTTP ${r.status}); the token was sent in the ${header} header and not rejected`;
    res.json({ success: true, data: { ok: !authRejected && !redirected && r.status < 500, status: r.status, header, message } });
  } catch (err) {
    const e = err as Error & { code?: string };
    const message = e.code === 'ESSRF' ? `Endpoint refused: ${e.message}` : `Could not reach the website (${e.code || e.message})`;
    res.json({ success: true, data: { ok: false, status: 0, header, message } });
  }
});
