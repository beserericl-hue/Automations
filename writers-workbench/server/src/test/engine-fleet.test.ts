/**
 * The admin Engine Fleet tab reads the engine gateway's /internal/fleet with the service secret, and
 * reports which gateway replica answered (the X-Engine-Instance header).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEngineFleet } from '../lib/engine-hub.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('getEngineFleet', () => {
  it('calls /internal/fleet with the service secret and returns the serving gateway replica', async () => {
    vi.stubEnv('ENGINE_GATEWAY_URL', 'http://gw.internal:8000');
    vi.stubEnv('ENGINE_SERVICE_SECRET', 's3cret');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ instance_counts: { gateway: 2, orchestrator: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-engine-instance': 'gw-b' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await getEngineFleet();
    expect(fetchMock.mock.calls[0][0]).toBe('http://gw.internal:8000/internal/fleet');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-service-secret': 's3cret' });
    expect(out).toEqual({ fleet: { instance_counts: { gateway: 2, orchestrator: 2 } }, gateway: 'gw-b' });
  });

  it('throws on an engine error so the route answers 502', async () => {
    vi.stubEnv('ENGINE_GATEWAY_URL', 'http://gw.internal:8000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 503 })));
    await expect(getEngineFleet()).rejects.toThrow('engine fleet 503');
  });
});
