/**
 * A deploy of the engine briefly answers 502/503/504 or drops the connection. Polling an async job through
 * that must not report the job as failed (Eric, 2026-11-08: "Drafting 24 topics failed: engine job poll 502").
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getEngineJob } from '../lib/engine-hub.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const respond = (status: number, body: unknown = {}) =>
  (globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);

describe('getEngineJob', () => {
  it.each([502, 503, 504])('treats a %i from the gateway as still working', async (code) => {
    respond(code);
    expect(await getEngineJob('j1')).toEqual({ status: 'in_progress' });
  });

  it('treats a dropped connection as still working', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await getEngineJob('j1')).toEqual({ status: 'in_progress' });
  });

  it('still reports a real engine error', async () => {
    respond(500);
    expect(await getEngineJob('j1')).toMatchObject({ status: 'error', error: 'engine job poll 500' });
  });

  it('passes a normal status through', async () => {
    respond(200, { status: 'complete', result: { ok: 1 } });
    expect(await getEngineJob('j1')).toEqual({ status: 'complete', result: { ok: 1 } });
  });
});
