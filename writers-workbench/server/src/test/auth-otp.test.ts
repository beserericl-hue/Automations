import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { createHash } from 'node:crypto';

/**
 * Passwordless login. The happy path is the easy part; what these tests hold down
 * is the set of properties that make it safe to put on the open internet, because
 * `/otp/request` and `/otp/verify` are the only unauthenticated write endpoints in
 * the app:
 *
 *   * codes are stored hashed, never in clear;
 *   * a code works exactly once, even if submitted twice at the same moment;
 *   * wrong guesses are counted and capped, and the counter lives in the database
 *     so it survives a Redis restart;
 *   * an unknown email gets the same response as a known one, so the endpoint is
 *     not an account-enumeration oracle;
 *   * every rejection reads the same, so the message does not say which half of
 *     the guess was right;
 *   * an existing profile whose `supabase_auth_uid` is null gets linked on first
 *     sign-in instead of being stranded in onboarding (two of the three live DEV
 *     accounts are in exactly that state).
 */

// ---------------------------------------------------------------------------
// In-memory stand-ins for the two services the route touches
// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  email: string;
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
  request_ip: string | null;
  user_agent: string | null;
  created_at: string;
}

interface UserRow {
  user_id: string;
  email: string | null;
  supabase_auth_uid: string | null;
  updated_at?: string;
}

interface State {
  tokens: TokenRow[];
  users: UserRow[];
  sentEmails: { to: string; subject: string; text?: string; html: string }[];
  emailOk: boolean;
  generateLinkFails: boolean;
  verifyOtpFails: boolean;
  insertFails: boolean;
  mintedFor: string[];
  createdUsers: string[];
}

const state: State = {
  tokens: [],
  users: [],
  sentEmails: [],
  emailOk: true,
  generateLinkFails: false,
  verifyOtpFails: false,
  insertFails: false,
  mintedFor: [],
  createdUsers: [],
};

function reset() {
  state.tokens = [];
  state.users = [];
  state.sentEmails = [];
  state.emailOk = true;
  state.generateLinkFails = false;
  state.verifyOtpFails = false;
  state.insertFails = false;
  state.mintedFor = [];
  state.createdUsers = [];
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Enough of the PostgREST builder for this route: select/insert/update with
 *  eq/ilike/gte/is/order/limit/maybeSingle and an exact head count. */
function tableBuilder(table: string) {
  if (table !== 'user_login_tokens_v2' && table !== 'users_v2') {
    throw new Error(`Unexpected table: ${table}`);
  }
  const rows = () => (table === 'user_login_tokens_v2' ? state.tokens : state.users) as Record<string, unknown>[];

  const filters: { col: string; val: unknown; op: 'eq' | 'ilike' | 'gte' | 'isNull' }[] = [];
  let headCount = false;
  let order: { col: string; asc: boolean } | null = null;
  let limit: number | null = null;
  let updatePayload: Record<string, unknown> | null = null;
  let selectAfterUpdate = false;

  const matching = () =>
    rows().filter((r) =>
      filters.every((f) => {
        const v = r[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'ilike') return String(v ?? '').toLowerCase() === String(f.val).toLowerCase();
        if (f.op === 'gte') return String(v ?? '') >= String(f.val);
        return v === null || v === undefined;
      }),
    );

  const finish = () => {
    let out = matching();
    if (order) {
      out = [...out].sort((a, b) => {
        const av = String(a[order!.col] ?? '');
        const bv = String(b[order!.col] ?? '');
        return order!.asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (limit !== null) out = out.slice(0, limit);
    return out;
  };

  const builder: Record<string, unknown> = {
    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.head) headCount = true;
      if (updatePayload) selectAfterUpdate = true;
      return builder;
    },
    insert(row: Record<string, unknown>) {
      if (state.insertFails) return Promise.resolve({ error: { message: 'insert blew up' } });
      const now = new Date().toISOString();
      state.tokens.push({
        id: `tok-${state.tokens.length + 1}`,
        email: String(row.email),
        code_hash: String(row.code_hash),
        expires_at: String(row.expires_at),
        consumed_at: null,
        attempts: 0,
        request_ip: (row.request_ip as string) ?? null,
        user_agent: (row.user_agent as string) ?? null,
        created_at: now,
      });
      return Promise.resolve({ error: null });
    },
    update(payload: Record<string, unknown>) {
      updatePayload = payload;
      return builder;
    },
    eq(col: string, val: unknown) { filters.push({ col, val, op: 'eq' }); return builder; },
    ilike(col: string, val: unknown) { filters.push({ col, val, op: 'ilike' }); return builder; },
    gte(col: string, val: unknown) { filters.push({ col, val, op: 'gte' }); return builder; },
    is(col: string, val: unknown) {
      if (val === null) filters.push({ col, val: null, op: 'isNull' });
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      order = { col, asc: opts?.ascending ?? true };
      return builder;
    },
    limit(n: number) { limit = n; return builder; },
    maybeSingle() {
      const out = finish();
      return Promise.resolve({ data: out[0] ?? null, error: null });
    },
    then(onFulfilled: (x: unknown) => unknown) {
      if (updatePayload) {
        const targets = finish();
        for (const t of targets) Object.assign(t, updatePayload);
        const data = selectAfterUpdate ? targets.map((t) => ({ id: t.id })) : null;
        return Promise.resolve({ data, error: null }).then(onFulfilled);
      }
      if (headCount) {
        return Promise.resolve({ data: null, count: matching().length, error: null }).then(onFulfilled);
      }
      return Promise.resolve({ data: finish(), error: null }).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = {
  from: (table: string) => tableBuilder(table),
  rpc: () => Promise.resolve({ data: 0, error: null }),
  auth: {
    admin: {
      generateLink: ({ email }: { type: string; email: string }) =>
        Promise.resolve(
          state.generateLinkFails
            ? { data: null, error: { message: 'no such user' } }
            : { data: { properties: { hashed_token: `hash-for-${email}` } }, error: null },
        ),
      createUser: ({ email }: { email: string }) => {
        state.createdUsers.push(email);
        state.generateLinkFails = false; // the retry after createUser succeeds
        return Promise.resolve({ data: { user: { id: `auth-${email}` } }, error: null });
      },
    },
    getUser: () => Promise.resolve({ data: { user: null }, error: null }),
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      verifyOtp: ({ token_hash }: { token_hash: string }) => {
        if (state.verifyOtpFails) {
          return Promise.resolve({ data: { session: null }, error: { message: 'token invalid' } });
        }
        const email = token_hash.replace('hash-for-', '');
        state.mintedFor.push(email);
        return Promise.resolve({
          data: {
            session: { access_token: `access-${email}`, refresh_token: `refresh-${email}` },
            user: { id: `auth-${email}` },
          },
          error: null,
        });
      },
    },
  }),
}));

vi.mock('../lib/email.js', () => ({
  sendEmail: (input: { to: string; subject: string; html: string; text?: string }) => {
    if (!state.emailOk) return Promise.resolve({ ok: false, mode: 'error', error: 'postal down' });
    state.sentEmails.push(input);
    return Promise.resolve({ ok: true, mode: 'sent', messageId: 'msg-1' });
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key-for-test';

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { authRouter } = await import('../routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://localhost:${port}/api/auth`);
  } finally {
    server.close();
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The code the route actually generated, recovered from the email we captured. */
function codeFromEmail(): string {
  const last = state.sentEmails.at(-1);
  if (!last) throw new Error('no email was sent');
  const m = /(\d{6})/.exec(last.subject);
  if (!m) throw new Error(`no code in subject: ${last.subject}`);
  return m[1]!;
}

beforeEach(() => {
  reset();
});

// ---------------------------------------------------------------------------

describe('POST /auth/otp/request', () => {
  it('emails a 6-digit code and stores only its hash', async () => {
    await withServer(async (base) => {
      const { status, body } = await post(base, '/otp/request', { email: 'Writer@Example.com' });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      expect(state.sentEmails).toHaveLength(1);
      const code = codeFromEmail();
      expect(code).toMatch(/^\d{6}$/);
      // The code is in the subject so it is readable from a notification.
      expect(state.sentEmails[0]!.subject).toContain(code);

      expect(state.tokens).toHaveLength(1);
      const row = state.tokens[0]!;
      expect(row.code_hash).toBe(sha(code));
      // The clear code must appear nowhere in the row.
      expect(JSON.stringify(row)).not.toContain(code);
      // Email is normalised, so Writer@Example.com and writer@example.com are one account.
      expect(row.email).toBe('writer@example.com');
    });
  });

  it('answers identically for an address with no account', async () => {
    await withServer(async (base) => {
      const known = await post(base, '/otp/request', { email: 'writer@example.com' });
      reset();
      const unknown = await post(base, '/otp/request', { email: 'nobody@example.com' });
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
    });
  });

  it('rejects a malformed address', async () => {
    await withServer(async (base) => {
      const { status, body } = await post(base, '/otp/request', { email: 'not-an-email' });
      expect(status).toBe(400);
      expect(state.sentEmails).toHaveLength(0);
      expect((body.error as Record<string, string>).code).toBe('BAD_REQUEST');
    });
  });

  it('stops after five codes to one address in an hour, without saying so', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 5; i++) {
        await post(base, '/otp/request', { email: 'writer@example.com' });
      }
      expect(state.sentEmails).toHaveLength(5);

      const sixth = await post(base, '/otp/request', { email: 'writer@example.com' });
      expect(sixth.status).toBe(200);
      expect(sixth.body.success).toBe(true);
      // Nothing more was sent, and nothing more was stored.
      expect(state.sentEmails).toHaveLength(5);
      expect(state.tokens).toHaveLength(5);
    });
  });

  it('caps codes per source IP as well as per address', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 20; i++) {
        await post(base, '/otp/request', { email: `user${i}@example.com` }, { 'x-forwarded-for': '203.0.113.9' });
      }
      expect(state.sentEmails).toHaveLength(20);
      await post(base, '/otp/request', { email: 'user99@example.com' }, { 'x-forwarded-for': '203.0.113.9' });
      expect(state.sentEmails).toHaveLength(20);
      // A different IP is unaffected.
      await post(base, '/otp/request', { email: 'elsewhere@example.com' }, { 'x-forwarded-for': '198.51.100.4' });
      expect(state.sentEmails).toHaveLength(21);
    });
  });

  it('500s when the code cannot be stored, rather than claiming to have sent one', async () => {
    await withServer(async (base) => {
      state.insertFails = true;
      const { status } = await post(base, '/otp/request', { email: 'writer@example.com' });
      expect(status).toBe(500);
      expect(state.sentEmails).toHaveLength(0);
    });
  });
});

describe('POST /auth/otp/verify', () => {
  it('exchanges a correct code for a session', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();

      const { status, body } = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(status).toBe(200);
      expect(body.access_token).toBe('access-writer@example.com');
      expect(body.refresh_token).toBe('refresh-writer@example.com');
      expect(state.mintedFor).toEqual(['writer@example.com']);
      expect(state.tokens[0]!.consumed_at).not.toBeNull();
    });
  });

  it('accepts the code whatever case the email was typed in', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      const { status } = await post(base, '/otp/verify', { email: 'WRITER@Example.COM', code });
      expect(status).toBe(200);
    });
  });

  it('refuses the same code a second time', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      const first = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(first.status).toBe(200);

      const second = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(second.status).toBe(401);
      expect((second.body.error as Record<string, string>).code).toBe('INVALID_CODE');
      expect(state.mintedFor).toHaveLength(1);
    });
  });

  it('lets only one of two simultaneous submissions of the same code win', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      const [a, b] = await Promise.all([
        post(base, '/otp/verify', { email: 'writer@example.com', code }),
        post(base, '/otp/verify', { email: 'writer@example.com', code }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      expect(state.mintedFor).toHaveLength(1);
    });
  });

  it('counts wrong guesses and kills the code after five', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        const r = await post(base, '/otp/verify', { email: 'writer@example.com', code: wrong });
        expect(r.status).toBe(401);
      }
      expect(state.tokens[0]!.attempts).toBe(5);

      // Even the RIGHT code is now dead — the lockout is on the code, not the guess.
      const correct = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(correct.status).toBe(401);
      expect(state.mintedFor).toHaveLength(0);
    });
  });

  it('refuses an expired code', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      state.tokens[0]!.expires_at = new Date(Date.now() - 1000).toISOString();

      const { status } = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(status).toBe(401);
      expect(state.mintedFor).toHaveLength(0);
    });
  });

  it('uses the newest code when several were requested', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const firstCode = codeFromEmail();
      // Make the second row sort strictly later than the first.
      await new Promise((r) => setTimeout(r, 5));
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const secondCode = codeFromEmail();

      if (firstCode !== secondCode) {
        const stale = await post(base, '/otp/verify', { email: 'writer@example.com', code: firstCode });
        expect(stale.status).toBe(401);
      }
      const fresh = await post(base, '/otp/verify', { email: 'writer@example.com', code: secondCode });
      expect(fresh.status).toBe(200);
    });
  });

  it('gives the same rejection for wrong, expired, used and never-requested', async () => {
    await withServer(async (base) => {
      const never = await post(base, '/otp/verify', { email: 'nobody@example.com', code: '123456' });

      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      const wrong = code === '000000' ? '111111' : '000000';
      const wrongRes = await post(base, '/otp/verify', { email: 'writer@example.com', code: wrong });

      await post(base, '/otp/verify', { email: 'writer@example.com', code });
      const used = await post(base, '/otp/verify', { email: 'writer@example.com', code });

      expect(never.status).toBe(401);
      expect(wrongRes.status).toBe(401);
      expect(used.status).toBe(401);
      expect(never.body).toEqual(wrongRes.body);
      expect(used.body).toEqual(wrongRes.body);
    });
  });

  it('rejects a code that is not six digits without touching the store', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const before = state.tokens[0]!.attempts;
      const { status } = await post(base, '/otp/verify', { email: 'writer@example.com', code: '12345' });
      expect(status).toBe(400);
      expect(state.tokens[0]!.attempts).toBe(before);
    });
  });

  it('links an existing profile whose auth uid was never set', async () => {
    await withServer(async (base) => {
      state.users.push({ user_id: '+14105914612', email: 'eric@agileadtesting.com', supabase_auth_uid: null });
      await post(base, '/otp/request', { email: 'eric@agileadtesting.com' });
      const code = codeFromEmail();

      const { status, body } = await post(base, '/otp/verify', { email: 'eric@agileadtesting.com', code });
      expect(status).toBe(200);
      expect(body.needs_onboarding).toBe(false);
      expect(state.users[0]!.supabase_auth_uid).toBe('auth-eric@agileadtesting.com');
    });
  });

  it('tells a brand-new email that it needs onboarding', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'newcomer@example.com' });
      const code = codeFromEmail();
      const { body } = await post(base, '/otp/verify', { email: 'newcomer@example.com', code });
      expect(body.needs_onboarding).toBe(true);
    });
  });

  it('creates the auth user when none exists yet', async () => {
    await withServer(async (base) => {
      state.generateLinkFails = true; // first generateLink fails: no auth user
      await post(base, '/otp/request', { email: 'newcomer@example.com' });
      const code = codeFromEmail();
      const { status } = await post(base, '/otp/verify', { email: 'newcomer@example.com', code });
      expect(status).toBe(200);
      expect(state.createdUsers).toEqual(['newcomer@example.com']);
    });
  });

  it('does not hand out a half-login when the session cannot be minted', async () => {
    await withServer(async (base) => {
      await post(base, '/otp/request', { email: 'writer@example.com' });
      const code = codeFromEmail();
      state.verifyOtpFails = true;

      const { status, body } = await post(base, '/otp/verify', { email: 'writer@example.com', code });
      expect(status).toBe(500);
      expect(body.access_token).toBeUndefined();
    });
  });
});
