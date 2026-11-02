/**
 * One structured call to Claude: a prompt in, an object matching a zod schema out.
 *
 * Shared by the routes that ask a model for something checkable (landing-page facts, a sample
 * page's structure, character consistency, name suggestions). The structure is enforced by the API;
 * whether the CONTENT is true is not, so every caller verifies what comes back against the text it
 * was given before using it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { anthropicTokens, recordUsage } from './cost-recorder.js';

export const MODEL = 'claude-opus-5-5';

function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  // An account-level key (sk-ant-usr-...) must name its workspace; a workspace key must not.
  // Same rule as brainstorm.ts and the engine's client.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return new Anthropic({
    apiKey,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
}

/** Who and what a call is for — every call is recorded in token_usage_v2 under this label. */
export interface CallContext {
  operation: string;
  userId: string | null | undefined;
  projectId?: string | null;
  contentId?: string | null;
  chapterNumber?: number | null;
}

export async function parseWith<T extends z.ZodType>(
  schema: T,
  prompt: string,
  ctx: CallContext,
  effort: 'low' | 'medium' | 'high' = 'medium',
): Promise<z.infer<T>> {
  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort, format: zodOutputFormat(schema) },
    messages: [{ role: 'user', content: prompt }],
  });
  // Recorded before any of the checks below: a refusal or a max_tokens stop was still billed.
  await recordUsage({
    operation: ctx.operation,
    provider: 'anthropic',
    model: response.model || MODEL,
    userId: ctx.userId ?? null,
    projectId: ctx.projectId ?? null,
    contentId: ctx.contentId ?? null,
    chapterNumber: ctx.chapterNumber ?? null,
    requestId: response.id ?? null,
    tokens: anthropicTokens(response.usage),
    metadata: { stop_reason: response.stop_reason, effort },
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of room before finishing.');
  if (!response.parsed_output) throw new Error('The model did not return the expected structure.');
  return response.parsed_output as z.infer<T>;
}
