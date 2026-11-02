/**
 * Chat → engine hub: conversation memory + page project threading.
 *
 * The engine hub remembers the last list shown per (user, conversation), which is what lets "pick
 * #3" follow "list my outlines". The server's job is to thread the drawer's conversation id and the
 * page's project into the hub call — the project fields were read by the route but stripped by the
 * zod schema, so the hub never saw them. Also pins the story-bible classifier rule (sync, free).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({ hubCalls: [] as Array<Record<string, unknown>> }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization;
    if (!hdr?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    req.userId = hdr.slice(7);
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async () => 0 }));
vi.mock('../services/credits.js', () => ({ deductCredits: async () => ({ ok: false }) }));

vi.mock('../lib/engine-hub.js', () => ({
  hubBackend: () => 'engine',
  callEngineHub: async (args: Record<string, unknown>) => {
    mocks.hubCalls.push(args);
    return {
      kind: 'data',
      tool: 'story_bible',
      op: 'add',
      assistant_message: 'Added Mara Voss (character) in the story bible.',
      data: { payload: { result: { saved: true } } },
      conversation_id: (args.conversationId as string) || 'chat:default',
    };
  },
}));

import { chatRouter } from '../routes/chat.js';
import { classifyJob } from '../lib/jobs/classifier.js';

async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://localhost:${port}/api/chat/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +14105914612' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('chat proxy → engine hub memory', () => {
  beforeEach(() => {
    mocks.hubCalls.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads conversation_id and the page project into the hub call', async () => {
    const { status, json } = await post({
      user_message_request: 'Add a character named Mara Voss to the story bible: a salvage pilot',
      user_id: '+14105914612',
      conversation_id: 'drawer-abc',
      project_id: '11111111-2222-3333-4444-555555555555',
      project_title: 'The Last Signal',
    });
    expect(status).toBe(200);
    expect(mocks.hubCalls).toHaveLength(1);
    expect(mocks.hubCalls[0].conversationId).toBe('drawer-abc');
    expect(mocks.hubCalls[0].context).toEqual({
      project_id: '11111111-2222-3333-4444-555555555555',
      project_title: 'The Last Signal',
    });
    expect(json.conversationId).toBe('drawer-abc');
    expect(json.tool).toBe('story_bible');
    expect(json.assistantMessage).toContain('Mara Voss');
  });

  it('works without a conversation id (engine falls back to the default conversation)', async () => {
    const { status, json } = await post({ user_message_request: 'list my projects', user_id: '+14105914612' });
    expect(status).toBe(200);
    expect(mocks.hubCalls[0].conversationId).toBeUndefined();
    expect(mocks.hubCalls[0].context).toEqual({});
    expect(json.conversationId).toBe('chat:default');
  });

  it('rejects an oversized conversation id', async () => {
    const { status } = await post({
      user_message_request: 'hi',
      user_id: '+14105914612',
      conversation_id: 'x'.repeat(200),
    });
    expect(status).toBe(400);
  });
});

describe('classifier: story-bible edits', () => {
  it('classifies add/update/rename in the story bible as a free sync op', () => {
    for (const msg of [
      'Add a character named Mara Voss to the story bible: she does research on signals',
      'Update Mara Voss in the story bible: now captain',
      'Rename Osei to Osei Asante in the story bible',
    ]) {
      const c = classifyJob(msg);
      expect(c.jobType, msg).toBe('story_bible_edit');
      expect(c.tier).toBe('sync');
    }
  });

  it('leaves a story-bible READ on the retrieve rule', () => {
    expect(classifyJob('Get the story bible for The Seed Vault').jobType).toBe('retrieve_content');
  });
});
