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
function engineGatewayUrl(): string {
  return (
    process.env.ENGINE_GATEWAY_URL ||
    'http://writer-engine-gateway.railway.internal:8000'
  );
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
  const url = `${engineGatewayUrl()}/internal/hub`;
  const resp = await fetch(url, {
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

/** Poll an engine async job (queued load-bearing op). */
export async function getEngineJob(jobId: string): Promise<{ status: string; result?: unknown; error?: string }> {
  const url = `${engineGatewayUrl()}/internal/write/jobs/${encodeURIComponent(jobId)}`;
  const resp = await fetch(url, { headers: { 'x-service-secret': serviceSecret() } });
  if (!resp.ok) {
    return { status: 'error', error: `engine job poll ${resp.status}` };
  }
  return (await resp.json()) as { status: string; result?: unknown; error?: string };
}
