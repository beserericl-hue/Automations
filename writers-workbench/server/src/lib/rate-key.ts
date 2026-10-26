import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * Who a request counts against: the signed-in user when the request carries a session, otherwise
 * the client's IP.
 *
 * WHY THE USER. Behind Railway's proxies (`trust proxy`), req.ip is the person's own address, and
 * keying the app's limits on it put every tab and poll of one author, and the whole E2E suite, into
 * one 100-a-minute bucket: 453 requests in one run were refused. Before `trust proxy` the key was
 * the proxy node, shared by everyone, which was almost no limit at all.
 *
 * The token's subject is read without checking its signature: this runs before requireAuth, and a
 * forged token only buys its sender a key of their own for requests that then fail auth anyway. A
 * per-IP backstop (index.ts) still bounds those.
 */
export function rateKey(req: Request): string {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
  const sub = subjectOf(token);
  return sub ? `user:${sub}` : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

function subjectOf(jwt: string): string | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length <= 100 ? payload.sub : null;
  } catch {
    return null;
  }
}
