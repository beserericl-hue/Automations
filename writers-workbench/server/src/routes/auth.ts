/**
 * Passwordless login: email in, 6-digit code out, code in, session out.
 *
 * There are no passwords in this product. A user identifies with their EMAIL
 * and proves it by entering a short-lived code we email them. `users_v2.user_id`
 * remains the phone number, so everything keyed by it — ~13,250 rows across
 * ingestion, embeddings, bible, content, research, projects and app_config, plus
 * Eve's caller-ID lookup — is untouched. Email is the login handle only.
 *
 * Why the session still comes from Supabase
 * -----------------------------------------
 * `admin.generateLink({type:'magiclink'})` returns a `hashed_token` and sends
 * NOTHING (verified against DEV). Handing that hash to `verifyOtp` mints a real
 * Supabase session — access token, refresh token and all — so every existing JWT
 * check keeps working untouched, including `requireAuth`, the SSE `?token=` path
 * and the engine's own calls. Rolling our own JWTs would have meant rewriting
 * all three and owning key rotation for no benefit.
 *
 * The magic link itself is never emailed and never leaves this process. It is a
 * mechanism for minting a session, not a login method — which matters, because a
 * link that reaches a user's inbox is a bearer credential sitting in their mail
 * forever, and a 10-minute code is not.
 *
 * Deliberate behaviours, each with a reason
 * -----------------------------------------
 * * **Codes are hashed (SHA-256) at rest.** A table of live login codes is a
 *   table of live credentials.
 * * **`/request` always answers the same way**, whether or not the email has an
 *   account. Otherwise the endpoint is an account-enumeration oracle: anyone
 *   could discover who has an account here by watching the response.
 * * **A code is single-use**, consumed by the same UPDATE that validates it, so
 *   two parallel submissions cannot both succeed.
 * * **Attempts are counted on the row**, not in Redis, so a brute-force lockout
 *   survives a Redis restart. Redis silently died for nine days in May.
 * * **Timing-safe comparison**, because a byte-by-byte early return on a hash
 *   comparison is a (slow, but real) oracle.
 * * **Signup and login are the same call.** A first-time email gets a code too;
 *   after verification the client lands in onboarding to supply name and phone.
 *   Keeping two flows apart is what made the old signup page a dead end when a
 *   confirmation email failed to arrive.
 */

import { Router, Request, Response } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { sendEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

/** How long a code is valid. Long enough for a slow mail hop, short enough that a
 *  forwarded or shoulder-surfed code is useless by the time it is read. */
export const CODE_TTL_MINUTES = 10;

/** Wrong guesses allowed per code before it is dead. A 6-digit code has a 1-in-a-
 *  million space; five tries is 1-in-200,000 even for a determined guesser, and the
 *  code expires in ten minutes regardless. */
export const MAX_ATTEMPTS = 5;

/** Codes per email per hour. Stops someone being mail-bombed with login codes by a
 *  stranger typing their address, and stops our Postal reputation paying for it. */
export const MAX_CODES_PER_EMAIL_PER_HOUR = 5;

/** Codes per source IP per hour, so one host cannot enumerate addresses in bulk. */
export const MAX_CODES_PER_IP_PER_HOUR = 20;

const TABLE = 'user_login_tokens_v2';

const RequestSchema = z.object({
  email: z.string().trim().min(3).max(254).email(),
});

const VerifySchema = z.object({
  email: z.string().trim().min(3).max(254).email(),
  code: z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits'),
});

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** A 6-digit code from a CSPRNG. `Math.random()` is not acceptable for a credential. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0]!.trim().slice(0, 64);
  return req.ip ? req.ip.slice(0, 64) : null;
}

function codeEmail(code: string): { subject: string; html: string; text: string } {
  const subject = `${code} is your Writers Workbench sign-in code`;
  const text = [
    `Your sign-in code is ${code}`,
    ``,
    `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.`,
    ``,
    `If you did not try to sign in, you can ignore this email — nobody can get`,
    `into your account without this code.`,
  ].join('\n');
  // The code is in the SUBJECT as well as the body so it is readable from a
  // notification without opening the mail, which is where these are actually read.
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 8px;font-size:18px;font-weight:700">Your sign-in code</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280">Enter this code to finish signing in to The Writers Workbench.</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px 0;background:#f3f4f6;border-radius:8px">${code}</div>
    <p style="margin:24px 0 0;font-size:13px;color:#6b7280">
      It expires in ${CODE_TTL_MINUTES} minutes and can only be used once.
    </p>
    <p style="margin:12px 0 0;font-size:13px;color:#6b7280">
      If you did not try to sign in, ignore this email. Nobody can reach your account without this code.
    </p>
  </div>
</body></html>`;
  return { subject, html, text };
}

/**
 * @openapi
 * /auth/otp/request:
 *   post:
 *     tags: [Auth]
 *     summary: Email a one-time sign-in code
 *     description: >
 *       Sends a 6-digit code to the address given. Answers identically whether or
 *       not an account exists, so it cannot be used to discover who has an account.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Code sent (or silently rate-limited) }
 *       400: { description: Not a valid email address }
 */
router.post('/otp/request', async (req: Request, res: Response) => {
  const parsed = RequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'A valid email address is required' },
    });
    return;
  }
  const email = normaliseEmail(parsed.data.email);
  const ip = clientIp(req);
  const supabase = getSupabaseAdmin();

  // Uniform response. Every early exit below returns THIS, so the caller cannot
  // distinguish "no such account", "rate limited" or "mail failed" from success.
  const ok = { success: true, expires_in_minutes: CODE_TTL_MINUTES } as const;

  try {
    // Housekeeping first, so the table cannot grow without bound if no cron runs.
    await supabase.rpc('prune_login_tokens').then(
      () => undefined,
      () => undefined, // best-effort; a failed prune must not block a login
    );

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count: emailCount } = await supabase
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('email', email)
      .gte('created_at', hourAgo);

    if ((emailCount ?? 0) >= MAX_CODES_PER_EMAIL_PER_HOUR) {
      logger.warn({ email, emailCount }, 'otp.request rate-limited by email');
      res.json(ok);
      return;
    }

    if (ip) {
      const { count: ipCount } = await supabase
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('request_ip', ip)
        .gte('created_at', hourAgo);
      if ((ipCount ?? 0) >= MAX_CODES_PER_IP_PER_HOUR) {
        logger.warn({ ip, ipCount }, 'otp.request rate-limited by ip');
        res.json(ok);
        return;
      }
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

    const { error: insertError } = await supabase.from(TABLE).insert({
      email,
      code_hash: hashCode(code),
      expires_at: expiresAt,
      request_ip: ip,
      user_agent: String(req.headers['user-agent'] ?? '').slice(0, 256) || null,
    });
    if (insertError) {
      logger.error({ err: insertError, email }, 'otp.request could not store code');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Could not start sign-in. Try again.' },
      });
      return;
    }

    const { subject, html, text } = codeEmail(code);
    const sent = await sendEmail({ to: email, subject, html, text });
    if (!sent.ok) {
      // The code is already stored, so a retry will send a fresh one. Logged loudly
      // because a user who never receives a code cannot tell this from a typo.
      logger.error({ email, mode: sent.mode, error: sent.error }, 'otp.request email failed');
    } else {
      logger.info({ email, mode: sent.mode }, 'otp.request code sent');
    }
    res.json(ok);
  } catch (err) {
    logger.error({ err, email }, 'otp.request failed');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Could not start sign-in. Try again.' },
    });
  }
});

/**
 * Mint a Supabase session for a verified email, creating the auth user on first
 * sign-in. Returns null if the session could not be minted.
 */
async function mintSession(
  email: string,
): Promise<{ access_token: string; refresh_token: string; auth_uid: string } | null> {
  const supabase = getSupabaseAdmin();

  // generateLink creates the auth user when it does not exist for type 'magiclink'
  // on current Supabase; older behaviour required createUser first, so this falls
  // back rather than assuming. Either way the user never sees a link.
  let hashed: string | undefined;
  const first = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
  if (first.error) {
    const created = await supabase.auth.admin.createUser({ email, email_confirm: true });
    if (created.error) {
      logger.error({ err: created.error, email }, 'otp.verify could not create auth user');
      return null;
    }
    const second = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
    if (second.error) {
      logger.error({ err: second.error, email }, 'otp.verify could not generate session token');
      return null;
    }
    hashed = second.data?.properties?.hashed_token;
  } else {
    hashed = first.data?.properties?.hashed_token;
  }
  if (!hashed) return null;

  // verifyOtp must run on a NON-service-role client: the service key bypasses auth
  // and would not produce a user session.
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    logger.error('otp.verify needs SUPABASE_URL + SUPABASE_ANON_KEY to mint a session');
    return null;
  }
  const pub = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await pub.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
  if (error || !data.session) {
    logger.error({ err: error, email }, 'otp.verify session exchange failed');
    return null;
  }
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    auth_uid: data.user?.id ?? '',
  };
}

/**
 * Which `users_v2` profile does this verified email belong to, and link it if needed.
 *
 * Returns the profile's `user_id`, or null when there is no profile yet (the caller then sends the
 * client to onboarding). Never links ambiguously, for a reason learned the hard way:
 *
 * The first version of this matched the email with `.ilike(...).limit(1)` and wrote the session's
 * auth uid onto whatever row came back. On live DEV **two** profiles carry eric@agileadtesting.com
 * — the phone-first flow created one per phone number — so it stamped the uid onto the second row
 * while the first already held it. `requireAuth` looks the profile up by `supabase_auth_uid` with
 * `.single()`, which then matched two rows and answered "User profile not found": a successful
 * login that could not then call a single authenticated route. Caught by signing in for real.
 *
 * So the order of questions matters:
 *
 *   1. Does a row ALREADY hold this auth uid? Then that is the profile, full stop. No write, and no
 *      opinion about how many rows share the email.
 *   2. Otherwise, is there exactly ONE unclaimed row for this email? Then link it.
 *   3. Otherwise refuse to guess, and say so loudly. Several unclaimed profiles with the same email
 *      is a data problem a person has to resolve; picking one would silently bind an account to the
 *      wrong history.
 */
async function resolveProfile(email: string, authUid: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  if (authUid) {
    const { data: owned } = await supabase
      .from('users_v2')
      .select('user_id')
      .eq('supabase_auth_uid', authUid)
      .limit(2);
    if (owned?.length === 1) return owned[0]!.user_id as string;
    if ((owned?.length ?? 0) > 1) {
      // Pre-existing data damage: two profiles already claim one identity. Report it rather than
      // pick, because requireAuth cannot resolve it either.
      logger.error(
        { email, userIds: owned!.map((r) => r.user_id) },
        'otp.verify: several profiles share one auth uid — login will fail until this is resolved',
      );
      return null;
    }
  }

  const { data: candidates } = await supabase
    .from('users_v2')
    .select('user_id, supabase_auth_uid')
    .ilike('email', email)
    .limit(10);

  const unclaimed = (candidates ?? []).filter((r) => !r.supabase_auth_uid);
  if (unclaimed.length > 1) {
    logger.error(
      { email, userIds: unclaimed.map((r) => r.user_id) },
      'otp.verify: several unlinked profiles share this email — refusing to guess which one',
    );
    return null;
  }
  if (unclaimed.length === 0) {
    if ((candidates ?? []).length > 0) {
      logger.warn({ email }, 'otp.verify: profiles exist for this email but belong to another identity');
    }
    return null;
  }

  const target = unclaimed[0]!;
  if (!authUid) return target.user_id as string;

  const { error: linkError } = await supabase
    .from('users_v2')
    .update({ supabase_auth_uid: authUid, updated_at: new Date().toISOString() })
    .eq('user_id', target.user_id)
    .is('supabase_auth_uid', null); // lost race = somebody else linked it; harmless
  if (linkError) {
    logger.error({ err: linkError, email }, 'otp.verify profile link failed');
    return null;
  }
  logger.info({ email, userId: target.user_id }, 'otp.verify linked existing profile');
  return target.user_id as string;
}

/**
 * @openapi
 * /auth/otp/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a sign-in code for a session
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email: { type: string, format: email }
 *               code:  { type: string, example: "214905" }
 *     responses:
 *       200: { description: Session issued }
 *       400: { description: Malformed request }
 *       401: { description: Wrong, expired, used or too-often-guessed code }
 */
router.post('/otp/verify', async (req: Request, res: Response) => {
  const parsed = VerifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'An email and a 6-digit code are required' },
    });
    return;
  }
  const email = normaliseEmail(parsed.data.email);
  const supabase = getSupabaseAdmin();

  // One message for every failure mode. "Expired" vs "wrong" vs "already used" tells
  // an attacker which half of the guess was right.
  const reject = () =>
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_CODE', message: 'That code is not valid. Request a new one.' },
    });

  try {
    const { data: rows, error } = await supabase
      .from(TABLE)
      .select('id, code_hash, expires_at, consumed_at, attempts')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      logger.error({ err: error, email }, 'otp.verify lookup failed');
      res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Sign-in failed' } });
      return;
    }
    const row = rows?.[0];
    if (!row) {
      reject();
      return;
    }
    if (row.consumed_at) {
      reject();
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      reject();
      return;
    }
    if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
      logger.warn({ email }, 'otp.verify code locked out');
      reject();
      return;
    }

    if (!hashesMatch(row.code_hash, hashCode(parsed.data.code))) {
      await supabase
        .from(TABLE)
        .update({ attempts: (row.attempts ?? 0) + 1 })
        .eq('id', row.id);
      reject();
      return;
    }

    // Consume it. `.is('consumed_at', null)` makes this the atomic win: of two
    // parallel submissions of the same correct code, exactly one updates a row.
    const { data: consumed, error: consumeError } = await supabase
      .from(TABLE)
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('consumed_at', null)
      .select('id');
    if (consumeError || !consumed?.length) {
      reject();
      return;
    }

    const session = await mintSession(email);
    if (!session) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Signed in, but the session could not be created. Try again.' },
      });
      return;
    }

    const linkedUserId = await resolveProfile(email, session.auth_uid);

    logger.info({ email, userId: linkedUserId }, 'otp.verify success');
    res.json({
      success: true,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      // The client uses this only to decide whether to show onboarding; the
      // authoritative answer still comes from /api/account/me.
      needs_onboarding: !linkedUserId,
    });
  } catch (err) {
    logger.error({ err, email }, 'otp.verify failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Sign-in failed' } });
  }
});

export { router as authRouter };
