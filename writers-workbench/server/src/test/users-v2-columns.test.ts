/**
 * Every column the server asks users_v2 for must exist.
 *
 * Asking PostgREST for a column that is not there fails the whole query, and code that reads the
 * failed result as "no row" carries on quietly: three call sites asked for `name` (the column is
 * `display_name`), so a book with no pen name was filed under no author, and the landing-page test
 * email reported "your account has no email address". The route tests mock the database and never
 * see column names, so this reads the source instead.
 *
 * users_v2 is a base table (docs/schema-governance.md): it cannot change, so its column list is safe
 * to write down here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const USERS_V2 = new Set([
  'id', 'user_id', 'phone_number', 'display_name', 'email', 'bcc_email', 'preferences',
  'created_at', 'updated_at', 'last_seen_at', 'supabase_auth_uid', 'role',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'test' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('users_v2 selects', () => {
  it('name only columns the table has', () => {
    const bad: string[] = [];
    for (const file of files(join(__dirname, '..'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\('users_v2'\)\s*\.select\('([^']*)'/g)) {
        for (const col of m[1].split(',').map((c) => c.trim()).filter((c) => c && c !== '*')) {
          if (!USERS_V2.has(col)) bad.push(`${file.split('/src/')[1]}: ${col}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
