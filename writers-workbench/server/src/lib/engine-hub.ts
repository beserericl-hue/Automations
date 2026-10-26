/**
 * CR-008 Workstream C — Path B hub cutover.
 *
 * When HUB_BACKEND=engine, chat/voice requests go to the engine hub
 * (POST /internal/hub, X-Service-Secret) instead of the n8n webhook. The engine
 * hub's Gemini router picks the tool, runs info ops synchronously, and queues
 * load-bearing ops (returning a job_id). This module is the single client +
 * response mapper so the route code stays small. Default backend is n8n, so the
 * cutover is opt-in per environment (flip on DEV, verify, then PROD).
 */
import { logger } from './logger.js';

export type HubBackend = 'n8n' | 'engine';

export function hubBackend(): HubBackend {
  return process.env.HUB_BACKEND === 'engine' ? 'engine' : 'n8n';
}

/** Internal engine gateway base URL (Railway private DNS by default). */
export function engineGatewayUrl(): string {
  return (
    process.env.ENGINE_GATEWAY_URL ||
    'http://writer-engine-gateway.railway.internal:8000'
  );
}

const PRIVATE_SUFFIX = '.railway.internal';
const RESOLVE_CACHE_MS = 5_000;
const resolved = new Map<string, { at: number; addrs: string[] }>();

/** Every address a private hostname resolves to, cached for a few seconds. */
async function privateAddresses(host: string): Promise<string[]> {
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) return hit.addrs;
  let addrs: string[] = [];
  try {
    const { lookup } = await import('node:dns/promises');
    // One family only. Each replica answers on an IPv4 and an IPv6 address and the engine binds
    // 0.0.0.0, so an IPv6 pick was refused (21 of 30 calls failed on DEV the first time this shipped).
    const all = await lookup(host, { all: true });
    const v4 = all.filter((a) => a.family === 4).map((a) => a.address);
    const v6 = all.filter((a) => a.family === 6).map((a) => a.address);
    addrs = [...new Set(v4.length ? v4 : v6)].sort();
  } catch {
    addrs = [];
  }
  resolved.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * The gateway base URL with one replica picked at random (CR-010 C1).
 *
 * Railway balances a service's public domain across its replicas, but `<service>.railway.internal`
 * has no balancer: it resolves to the replicas' addresses, and fetch connects to the first and keeps
 * that socket. Measured on DEV with two gateway replicas: 30 of 30 calls went to the same one. So we
 * resolve the name and pick an address per call. A public URL, localhost, a failed lookup or a single
 * address leaves the URL unchanged.
 */
export async function engineGatewayTarget(): Promise<string> {
  const base = engineGatewayUrl();
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return base;
  }
  if (!u.hostname.endsWith(PRIVATE_SUFFIX)) return base;
  const addrs = await privateAddresses(u.hostname);
  if (addrs.length < 2) return base;
  const ip = addrs[Math.floor(Math.random() * addrs.length)];
  u.hostname = ip.includes(':') ? `[${ip}]` : ip;
  return u.toString().replace(/\/$/, '');
}

/**
 * fetch() against the gateway, on a replica picked by engineGatewayTarget. A connection failure on
 * the picked address is retried once by hostname (the path that existed before spreading), so an
 * address that stops answering costs a retry, never a failed call.
 */
export async function engineFetch(path: string, init?: RequestInit): Promise<Response> {
  const target = await engineGatewayTarget();
  try {
    return await fetch(`${target}${path}`, init);
  } catch (err) {
    const base = engineGatewayUrl();
    if (target === base || (init?.signal && init.signal.aborted)) throw err;
    return fetch(`${base}${path}`, init);
  }
}

/** How many gateway addresses this server can see (0 if the name does not resolve). */
export async function engineGatewayAddressCount(): Promise<number> {
  try {
    return (await privateAddresses(new URL(engineGatewayUrl()).hostname)).length;
  } catch {
    return 0;
  }
}

function serviceSecret(): string {
  return process.env.ENGINE_SERVICE_SECRET || process.env.SERVICE_SHARED_SECRET || '';
}

/** The engine hub's response shape (see writer_engine.hub.schemas.HubResponse). */
export interface HubResponse {
  kind: 'reply' | 'data' | 'queued' | 'error';
  assistant_message?: string;
  tool?: string | null;
  op?: string | null;
  data?: unknown;
  job_id?: string | null;
  status?: string | null;
  error?: string | null;
}

/** POST a message to the engine hub. Throws on transport/HTTP failure. */
export async function callEngineHub(args: {
  message: string;
  userId: string;
  context?: Record<string, unknown>;
  source?: 'chat' | 'voice';
}): Promise<HubResponse> {
  const resp = await engineFetch('/internal/hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': serviceSecret() },
    body: JSON.stringify({
      message: args.message,
      user_id: args.userId,
      context: args.context ?? {},
      source: args.source ?? 'chat',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error({ status: resp.status, body: text.slice(0, 300) }, 'engine-hub: call failed');
    throw new Error(`engine hub ${resp.status}`);
  }
  return (await resp.json()) as HubResponse;
}

/**
 * Call an engine write tool directly (bypasses the hub router). Used for explicit UI actions like
 * "Fix drift" (chapter.repair) that target a specific tool/op regardless of HUB_BACKEND. Heavy tools
 * return `{ job_id, status }`; the client polls /api/jobs/engine/:id.
 */
export async function callEngineWriteTool(
  tool: string,
  body: Record<string, unknown>,
): Promise<{ job_id?: string; status?: string; [k: string]: unknown }> {
  const resp = await engineFetch(`/internal/write/${encodeURIComponent(tool)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': serviceSecret() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error({ status: resp.status, tool, body: text.slice(0, 300) }, 'engine-hub: write tool failed');
    throw new Error(`engine write ${tool} ${resp.status}`);
  }
  return (await resp.json()) as { job_id?: string; status?: string };
}

/**
 * The shape a SYNCHRONOUS write-tool call comes back in.
 *
 * The orchestrator answers a sync call with a step envelope, not with the op's own return value:
 * the data is under `payload.result`, and `error` is where a failure lands. An async call is the
 * other shape entirely — `{job_id, status}` at the top level — which is why one function cannot
 * usefully type both.
 */
export interface EngineStepEnvelope<T> {
  execution_id?: string;
  step_name?: string;
  status?: string;
  payload?: { op?: string; result?: T };
  /**
   * A string from some steps, a `{code, message, details}` object from others. Both shapes are real
   * — `media.social-posts` returns the object form — so a caller that assumes one gets
   * "[object Object]" in front of the user instead of the sentence the engine wrote.
   */
  error?: string | { code?: string; message?: string; details?: unknown } | null;
}

/** The engine's error, as a sentence worth showing someone. */
export function engineErrorMessage(error: EngineStepEnvelope<unknown>['error']): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.code || 'engine error';
}

/**
 * Call a write tool and hand back what the op actually returned.
 *
 * WHY THIS EXISTS. `callEngineWriteTool` returns the raw envelope, so reading `result.ok` off it
 * silently yields undefined — the op's real answer is one level down. That is not hypothetical: the
 * author-bio route did exactly this and reported "there is not enough here to write a bio from" on
 * a profile the engine had just written a full bio from. Every other sync call site unwraps it by
 * hand with a cast, which is how the next one gets it wrong too.
 *
 * Throws when the engine reports an error, so a caller cannot mistake a failed step for an op that
 * returned nothing.
 */
export async function callEngineWriteToolSync<T>(
  tool: string,
  body: Record<string, unknown>,
): Promise<T> {
  const envelope = (await callEngineWriteTool(tool, {
    ...body,
    async: false,
  })) as EngineStepEnvelope<T>;
  if (envelope.error) {
    const message = engineErrorMessage(envelope.error);
    logger.error({ tool, op: body.op, error: envelope.error }, 'engine-hub: sync write tool errored');
    throw new Error(message);
  }
  if (envelope.payload?.result === undefined) {
    logger.error(
      { tool, op: body.op, status: envelope.status, keys: Object.keys(envelope) },
      'engine-hub: sync write tool returned no result',
    );
    throw new Error(`engine ${tool}.${String(body.op ?? '')} returned no result`);
  }
  return envelope.payload.result;
}

/** Poll an engine async job (queued load-bearing op). */
export async function getEngineJob(jobId: string): Promise<{ status: string; result?: unknown; error?: string }> {
  const resp = await engineFetch(`/internal/write/jobs/${encodeURIComponent(jobId)}`, { headers: { 'x-service-secret': serviceSecret() } });
  if (!resp.ok) {
    return { status: 'error', error: `engine job poll ${resp.status}` };
  }
  return (await resp.json()) as { status: string; result?: unknown; error?: string };
}

/**
 * Cancel an async engine write-tool job (Fix Drift "Cancel"). Proxies the gateway's
 * POST /internal/write/jobs/{id}/abort, which sets arq's abort flag — a queued job is dropped before it
 * runs, a running job is cancelled at its next await. Idempotent: a finished job returns aborted:false.
 */
export async function abortEngineJob(jobId: string): Promise<{ aborted: boolean; error?: string }> {
  const resp = await engineFetch(`/internal/write/jobs/${encodeURIComponent(jobId)}/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': serviceSecret() },
  });
  if (!resp.ok) {
    return { aborted: false, error: `engine job abort ${resp.status}` };
  }
  const body = (await resp.json()) as { aborted?: boolean };
  return { aborted: Boolean(body.aborted) };
}

/**
 * The engine fleet (CR-010 C1/C4): every live gateway and runtime replica, the fleet-wide queues, the
 * scaling verdict and the autoscaler's last decision. Built by the orchestrator from Redis, so it is
 * the whole fleet whichever replica answers. Also reports which gateway replica served the call.
 */
export async function getEngineFleet(): Promise<{ fleet: Record<string, unknown>; gateway: string | null; gatewayAddresses: number }> {
  const resp = await engineFetch('/internal/fleet', {
    headers: { 'x-service-secret': serviceSecret() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`engine fleet ${resp.status}`);
  return {
    fleet: (await resp.json()) as Record<string, unknown>,
    gateway: resp.headers.get('x-engine-instance'),
    gatewayAddresses: await engineGatewayAddressCount(),
  };
}
