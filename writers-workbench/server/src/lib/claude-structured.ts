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

export async function parseWith<T extends z.ZodType>(
  schema: T,
  prompt: string,
  effort: 'low' | 'medium' | 'high' = 'medium',
): Promise<z.infer<T>> {
  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort, format: zodOutputFormat(schema) },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of room before finishing.');
  if (!response.parsed_output) throw new Error('The model did not return the expected structure.');
  return response.parsed_output as z.infer<T>;
}
