/**
 * The admin Engine Fleet tab reads the engine gateway's /internal/fleet with the service secret, and
 * reports which gateway replica answered (the X-Engine-Instance header).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEngineFleet } from '../lib/engine-hub.js';

vi.mock('node:dns/promises', () => ({ lookup: async () => [] }));

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
    expect(out).toEqual({ fleet: { instance_counts: { gateway: 2, orchestrator: 2 } }, gateway: 'gw-b', gatewayAddresses: 0 });
  });

  it('throws on an engine error so the route answers 502', async () => {
    vi.stubEnv('ENGINE_GATEWAY_URL', 'http://gw.internal:8000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 503 })));
    await expect(getEngineFleet()).rejects.toThrow('engine fleet 503');
  });
});

describe('engineGatewayTarget', () => {
  it('picks one of the private name\'s addresses per call, and leaves other URLs alone', async () => {
    vi.resetModules();
    vi.doMock('node:dns/promises', () => ({
      lookup: async () => [
        { address: 'fd12::a', family: 6 }, { address: '10.0.0.1', family: 4 },
        { address: 'fd12::b', family: 6 }, { address: '10.0.0.2', family: 4 },
      ],
    }));
    vi.stubEnv('ENGINE_GATEWAY_URL', 'http://writer-engine-gateway.railway.internal:8000');
    const hub = await import('../lib/engine-hub.js');
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(await hub.engineGatewayTarget());
    // IPv4 only: the engine binds 0.0.0.0, and an IPv6 pick was refused on DEV.
    expect([...seen].sort()).toEqual(['http://10.0.0.1:8000', 'http://10.0.0.2:8000']);
    expect(await hub.engineGatewayAddressCount()).toBe(2);

    // A picked address that refuses the connection is retried once by hostname.
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(u);
      if (!u.includes('railway.internal')) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    }));
    const r = await hub.engineFetch('/internal/write/jobs/j1');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe('http://writer-engine-gateway.railway.internal:8000/internal/write/jobs/j1');

    vi.stubEnv('ENGINE_GATEWAY_URL', 'https://writer-engine-gateway-develop.up.railway.app');
    expect(await hub.engineGatewayTarget()).toBe('https://writer-engine-gateway-develop.up.railway.app');
    vi.doUnmock('node:dns/promises');
  });

  it('keeps the hostname when only one address resolves', async () => {
    vi.resetModules();
    vi.doMock('node:dns/promises', () => ({ lookup: async () => [{ address: 'fd12::a', family: 6 }] }));
    vi.stubEnv('ENGINE_GATEWAY_URL', 'http://writer-engine-gateway.railway.internal:8000');
    const hub = await import('../lib/engine-hub.js');
    expect(await hub.engineGatewayTarget()).toBe('http://writer-engine-gateway.railway.internal:8000');
    vi.doUnmock('node:dns/promises');
  });
});
