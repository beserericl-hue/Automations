/**
 * Mail to the regression-test inbox is held while a run is going (and only then, and only to that inbox).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let rowValue: string | null = null;
vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rowValue === null ? null : { value: rowValue } }) }) }) }),
  }),
}));

import { parseHold, isHeld, resetHoldCache, sendEmail } from '../lib/email.js';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 3600_000).toISOString();
const hold = (until: string, addresses: string[]) => JSON.stringify({ until, addresses });

beforeEach(() => {
  rowValue = null;
  resetHoldCache();
  process.env.DRY_RUN_EMAIL = 'true';
});

describe('parseHold', () => {
  it('lists lower-cased addresses while the hold is current', () => {
    expect([...parseHold(hold(future(), ['Eric@AgileAdTesting.com']))]).toEqual(['eric@agileadtesting.com']);
  });
  it('is empty when expired, malformed or absent', () => {
    expect(parseHold(hold(past(), ['a@b.c'])).size).toBe(0);
    expect(parseHold('not json').size).toBe(0);
    expect(parseHold(null).size).toBe(0);
  });
});

describe('isHeld', () => {
  it('holds mail only when every recipient is on the list', async () => {
    rowValue = hold(future(), ['eric@x.com']);
    expect(await isHeld(['eric@x.com'])).toBe(true);
    expect(await isHeld(['eric@x.com', 'reader@y.com'])).toBe(false);
    expect(await isHeld([])).toBe(false);
  });
  it('holds nothing when there is no row or it has expired', async () => {
    expect(await isHeld(['eric@x.com'])).toBe(false);
    resetHoldCache();
    rowValue = hold(past(), ['eric@x.com']);
    expect(await isHeld(['eric@x.com'])).toBe(false);
  });
});

describe('sendEmail', () => {
  it('reports a held message instead of sending it', async () => {
    rowValue = hold(future(), ['eric@x.com']);
    const r = await sendEmail({ to: 'eric@x.com', subject: 's', html: 'h' });
    expect(r).toMatchObject({ ok: true, messageId: 'e2e-held' });
  });
});
