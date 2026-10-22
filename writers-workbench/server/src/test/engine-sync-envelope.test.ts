/**
 * Unwrapping a synchronous engine call.
 *
 * The orchestrator answers a sync write-tool call with a step envelope — the op's own return value
 * is under `payload.result` — while an async call answers with `{job_id, status}` at the top level.
 * Reading a sync response as though it were flat does not throw; it quietly yields `undefined` for
 * every field.
 *
 * That is not a hypothetical. The author-bio route did exactly this and told an author "there is
 * not enough here to write a bio from" about a profile the engine had just written a full, accurate
 * bio from. The symptom pointed at the data; the cause was one level of nesting. These tests exist
 * so the next sync call site cannot repeat it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { callEngineWriteToolSync } from '../lib/engine-hub.js';

function respondWith(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a synchronous engine write-tool call', () => {
  it("returns the op's own result, not the envelope around it", async () => {
    respondWith({
      execution_id: 'e1',
      step_name: 'chapter',
      status: 'ok',
      payload: { op: 'author-bio', result: { ok: true, author_bio: 'He lives in Maryland.' } },
      error: null,
    });

    const result = await callEngineWriteToolSync<{ ok: boolean; author_bio: string }>('chapter', {
      op: 'author-bio',
    });

    expect(result.ok).toBe(true);
    expect(result.author_bio).toBe('He lives in Maryland.');
  });

  it('forces async off, so a sync caller cannot be handed a job id instead', async () => {
    const fetchMock = respondWith({ status: 'ok', payload: { result: { ok: true } } });
    await callEngineWriteToolSync('chapter', { op: 'author-bio', async: true });
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.async).toBe(false);
  });

  it('throws when the engine reports an error rather than returning a hollow result', async () => {
    respondWith({ status: 'error', payload: null, error: 'provider not registered' });
    await expect(callEngineWriteToolSync('chapter', { op: 'author-bio' })).rejects.toThrow(
      'provider not registered',
    );
  });

  it('throws on an envelope with no result at all', async () => {
    // The exact shape that used to pass straight through and read as "the op returned nothing
    // useful", when in fact the call had not produced a result for a different reason.
    respondWith({ status: 'ok', payload: {} });
    await expect(callEngineWriteToolSync('chapter', { op: 'author-bio' })).rejects.toThrow(
      /returned no result/,
    );
  });

  it('does not mistake a falsy-but-real result for a missing one', async () => {
    // `ok: false` from the op is a real answer — a refusal with a reason — and must reach the
    // caller rather than being turned into a transport error.
    respondWith({
      status: 'ok',
      payload: { result: { ok: false, reason: 'no facts supplied', gaps: ['name'] } },
    });
    const result = await callEngineWriteToolSync<{ ok: boolean; reason: string }>('chapter', {
      op: 'author-bio',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no facts supplied');
  });

  it('surfaces a transport failure', async () => {
    respondWith({ detail: 'missing or invalid X-Service-Secret' }, false, 403);
    await expect(callEngineWriteToolSync('chapter', { op: 'author-bio' })).rejects.toThrow(/403/);
  });
});
