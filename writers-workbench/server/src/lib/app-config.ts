/**
 * Settings resolution: user -> global -> default (item 8, migration 044).
 *
 * `app_config_v2` is per-user (user_id NOT NULL, FK to users_v2, unique (user_id, key)), so it has no
 * way to hold a value every account inherits. `app_config_global_v2` is that scope. The engine reads
 * the same two tables in the same order (writer_engine.library_helpers.email_recipients).
 *
 * The global table is service-role only (no RLS policy for authenticated users): a global value can be
 * a credential, so it is read here and never by the browser.
 */
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from './logger.js';

export const USER_CONFIG_TABLE = 'app_config_v2';
export const GLOBAL_CONFIG_TABLE = 'app_config_global_v2';
export const CONFIG_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export type ConfigSource = 'user' | 'global' | 'default';

export interface ResolvedSetting {
  value: string | null;
  source: ConfigSource | null;
}

export interface GlobalSettingRow {
  key: string;
  value: string;
  description: string;
  is_secret: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

function present(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

async function keyValues(table: string, keys: string[], userId?: string | null): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!keys.length) return out;
  try {
    let q = getSupabaseAdmin().from(table).select('key, value').in('key', keys);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { key: string; value: unknown }[]) {
      const v = typeof r.value === 'string' ? r.value : r.value == null ? '' : JSON.stringify(r.value);
      if (present(v)) out[r.key] = v;
    }
  } catch (err) {
    // A missing table (code shipped before the migration) or an outage is "no values", not a 500:
    // the caller still gets the user value or the default.
    logger.warn({ err, table }, 'app-config: read failed; treating as no values');
  }
  return out;
}

/** Resolve each key as user -> global -> default, reporting where each value came from. */
export async function resolveConfigDetailed(
  keys: string[],
  userId?: string | null,
  defaults: Record<string, string> = {},
): Promise<Record<string, ResolvedSetting>> {
  const [user, glob] = await Promise.all([
    userId ? keyValues(USER_CONFIG_TABLE, keys, userId) : Promise.resolve({} as Record<string, string>),
    keyValues(GLOBAL_CONFIG_TABLE, keys),
  ]);
  const out: Record<string, ResolvedSetting> = {};
  for (const k of keys) {
    if (k in user) out[k] = { value: user[k], source: 'user' };
    else if (k in glob) out[k] = { value: glob[k], source: 'global' };
    else if (k in defaults) out[k] = { value: defaults[k], source: 'default' };
    else out[k] = { value: null, source: null };
  }
  return out;
}

/** `resolveConfigDetailed` without the provenance: key -> value for every key that resolved. */
export async function resolveConfig(
  keys: string[],
  userId?: string | null,
  defaults: Record<string, string> = {},
): Promise<Record<string, string>> {
  const detailed = await resolveConfigDetailed(keys, userId, defaults);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(detailed)) if (v.value !== null) out[k] = v.value;
  return out;
}

/** One global value, or null when unset. Text as stored. */
export async function getGlobalConfig(key: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().from(GLOBAL_CONFIG_TABLE).select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data as { value?: unknown } | null)?.value;
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** A global value stored as JSON text, parsed. Null when unset or not valid JSON. */
export async function getGlobalJson<T>(key: string): Promise<T | null> {
  const raw = await getGlobalConfig(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn({ key }, 'app-config: global value is not JSON');
    return null;
  }
}

export async function setGlobalConfig(
  key: string,
  value: string,
  opts: { description?: string; isSecret?: boolean; updatedBy?: string | null } = {},
): Promise<GlobalSettingRow> {
  if (!CONFIG_KEY_RE.test(key)) throw new Error('Invalid setting key');
  const row: Record<string, unknown> = { key, value, updated_by: opts.updatedBy ?? null, updated_at: new Date().toISOString() };
  if (opts.description !== undefined) row.description = opts.description;
  if (opts.isSecret !== undefined) row.is_secret = opts.isSecret;
  const { data, error } = await getSupabaseAdmin().from(GLOBAL_CONFIG_TABLE).upsert(row, { onConflict: 'key' }).select().single();
  if (error) throw new Error(error.message);
  return data as GlobalSettingRow;
}

export async function deleteGlobalConfig(key: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().from(GLOBAL_CONFIG_TABLE).delete().eq('key', key).select('key');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function listGlobalConfig(): Promise<GlobalSettingRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(GLOBAL_CONFIG_TABLE)
    .select('key, value, description, is_secret, updated_by, updated_at')
    .order('key');
  if (error) throw new Error(error.message);
  return (data ?? []) as GlobalSettingRow[];
}

/** What the admin API shows for a secret: enough to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

export function forDisplay(row: GlobalSettingRow): GlobalSettingRow & { masked: boolean } {
  return row.is_secret ? { ...row, value: maskSecret(row.value), masked: true } : { ...row, masked: false };
}
