/**
 * Per-user integration secrets (Blotato API keys, blog tokens) — AES-256-GCM at rest.
 *
 * The key is INTEGRATIONS_ENCRYPTION_KEY: 32 random bytes, base64. It is set on this service and on
 * the engine runtime and nowhere else (not in GitHub, not in the database). The engine decrypts
 * with the same format — writer_engine/integrations.py — and a test there decrypts a vector made
 * here, so the two cannot drift silently.
 *
 * Format: `v1.<iv b64url>.<ciphertext‖tag b64url>`. The AAD is `user_id|provider|channel`, so a
 * ciphertext copied onto another user's (or another channel's) row will not decrypt.
 *
 * Nothing in this module logs, and no error it throws carries the plaintext or the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENV_KEY = 'INTEGRATIONS_ENCRYPTION_KEY';
const VERSION = 'v1';

export class IntegrationKeyError extends Error {}

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function loadKey(raw: string | undefined = process.env[ENV_KEY]): Buffer {
  const value = (raw ?? '').trim();
  if (!value) throw new IntegrationKeyError(`${ENV_KEY} is not set on this service`);
  const std = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(std)) throw new IntegrationKeyError(`${ENV_KEY} is not valid base64`);
  const key = Buffer.from(std, 'base64');
  if (key.length !== 32) throw new IntegrationKeyError(`${ENV_KEY} must decode to 32 bytes (got ${key.length})`);
  return key;
}

export function encryptionReady(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function aadFor(userId: string, provider: string, channel: string | null): Buffer {
  return Buffer.from(`${userId}|${provider}|${channel ?? ''}`, 'utf8');
}

export function encryptSecret(
  plaintext: string,
  ctx: { userId: string; provider: string; channel: string | null },
  key: Buffer = loadKey(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(ctx.userId, ctx.provider, ctx.channel));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}.${b64u(iv)}.${b64u(Buffer.concat([ct, cipher.getAuthTag()]))}`;
}

export function decryptSecret(
  token: string,
  ctx: { userId: string; provider: string; channel: string | null },
  key: Buffer = loadKey(),
): string {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error('stored secret has an unknown format');
  try {
    const iv = unb64u(parts[1]);
    const sealed = unb64u(parts[2]);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(ctx.userId, ctx.provider, ctx.channel));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('stored secret could not be decrypted');
  }
}

/**
 * The last four characters, shown so the owner can tell which key is saved. Withheld for short
 * values: four characters of an eight-character token is half of it.
 */
export function last4(value: string): string | null {
  const v = value.trim();
  return v.length >= 12 ? v.slice(-4) : null;
}
