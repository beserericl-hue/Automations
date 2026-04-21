import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks — must be at top level to be effective before imports resolve.
const mocks = vi.hoisted(() => ({
  pingMock: vi.fn(),
  quitMock: vi.fn(),
  onMock: vi.fn(),
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    on = mocks.onMock;
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => {
  class FakeWorker {
    public processor: (job: unknown) => unknown;
    public queueName: string;
    constructor(queueName: string, processor: (job: unknown) => unknown) {
      this.queueName = queueName;
      this.processor = processor;
    }
    on = mocks.workerOnMock;
    close = mocks.workerCloseMock;
  }
  class FakeQueue {
    name: string;
    opts: unknown;
    close = vi.fn();
    constructor(name: string, opts: unknown) {
      this.name = name;
      this.opts = opts;
    }
  }
  class FakeQueueEvents {
    on = vi.fn();
    close = vi.fn();
  }
  return { Worker: FakeWorker, Queue: FakeQueue, QueueEvents: FakeQueueEvents };
});

import { classifyJob, CLASSIFIER_RULES } from '../lib/jobs/classifier.js';
import {
  ALL_QUEUE_NAMES,
  PRIORITY_BY_TIER,
  QUEUE_BY_TIER,
  QUEUE_SETTINGS,
} from '../lib/jobs/types.js';

// --------------------------------------------------------------------
// Classifier

describe('classifyJob', () => {
  it.each([
    ['list my projects', 'sync-ops', 'list_content'],
    ['show all outlines', 'sync-ops', 'list_content'],
    ['display drafts', 'sync-ops', 'list_content'],
    ['outline version history for Dust', 'sync-ops', 'outline_versions'],
    ['revert outline for Dust to version 2', 'sync-ops', 'revert_outline'],
    ['retrieve chapter 3 of Dust', 'sync-ops', 'retrieve_content'],
    ['pull up my draft', 'sync-ops', 'retrieve_content'],
    ['approve chapter 5', 'sync-ops', 'content_action'],
    ['publish the newsletter', 'sync-ops', 'content_action'],
  ])('"%s" -> %s / %s', (msg, queue, jobType) => {
    const c = classifyJob(msg);
    expect(c.queue).toBe(queue);
    expect(c.jobType).toBe(jobType);
  });

  it.each([
    ['write chapter 3', 'heavy-ops', 'write_chapter'],
    ['write the prologue', 'heavy-ops', 'write_chapter'],
    ['write a short story', 'heavy-ops', 'write_short_story'],
    ['run QA on chapter 4', 'heavy-ops', 'qa_chapter'],
  ])('heavy: "%s" -> %s / %s', (msg, queue, jobType) => {
    const c = classifyJob(msg);
    expect(c.queue).toBe(queue);
    expect(c.jobType).toBe(jobType);
  });

  it.each([
    ['brainstorm a story', 'medium-ops', 'brainstorm_story'],
    ['brainstorm a book about a lost astronaut', 'medium-ops', 'brainstorm_story'],
    ['edit the outline', 'medium-ops', 'edit_outline'],
    ['write a blog post on AI ethics', 'medium-ops', 'write_blog'],
    ['write newsletter', 'medium-ops', 'write_newsletter'],
    ['research report on cold war propaganda', 'medium-ops', 'research_report'],
  ])('medium: "%s" -> %s / %s', (msg, queue, jobType) => {
    const c = classifyJob(msg);
    expect(c.queue).toBe(queue);
    expect(c.jobType).toBe(jobType);
  });

  it.each([
    ['generate cover art', 'background-ops', 'cover_art'],
    ['repurpose to social posts', 'background-ops', 'repurpose_social'],
    ['format the book for kindle', 'background-ops', 'format_kindle'],
  ])('background: "%s" -> %s / %s', (msg, queue, jobType) => {
    const c = classifyJob(msg);
    expect(c.queue).toBe(queue);
    expect(c.jobType).toBe(jobType);
  });

  it('unknown message falls back to medium-ops/chat_generic', () => {
    const c = classifyJob('hello how are you');
    expect(c.queue).toBe('medium-ops');
    expect(c.jobType).toBe('chat_generic');
  });

  it('assigns BullMQ priority matching the tier', () => {
    expect(classifyJob('list drafts').priority).toBe(PRIORITY_BY_TIER.sync);
    expect(classifyJob('write chapter 2').priority).toBe(PRIORITY_BY_TIER.heavy);
    expect(classifyJob('brainstorm story').priority).toBe(PRIORITY_BY_TIER.medium);
    expect(classifyJob('cover art please').priority).toBe(PRIORITY_BY_TIER.background);
  });

  it('rule library is non-empty and every rule declares tier + jobType', () => {
    expect(CLASSIFIER_RULES.length).toBeGreaterThan(5);
    for (const r of CLASSIFIER_RULES) {
      expect(r.tier).toBeTruthy();
      expect(r.jobType).toBeTruthy();
    }
  });
});

// --------------------------------------------------------------------
// Queue-name / priority table sanity

describe('types table', () => {
  it('ALL_QUEUE_NAMES contains the 4 canonical tiers', () => {
    expect(ALL_QUEUE_NAMES).toEqual([
      'sync-ops',
      'medium-ops',
      'heavy-ops',
      'background-ops',
    ]);
  });

  it('QUEUE_BY_TIER covers every tier', () => {
    expect(Object.values(QUEUE_BY_TIER).sort()).toEqual(
      [...ALL_QUEUE_NAMES].sort(),
    );
  });

  it('QUEUE_SETTINGS enforces the concurrency contract', () => {
    expect(QUEUE_SETTINGS['sync-ops'].concurrency).toBe(10);
    expect(QUEUE_SETTINGS['medium-ops'].concurrency).toBe(4);
    expect(QUEUE_SETTINGS['heavy-ops'].concurrency).toBe(2);
    expect(QUEUE_SETTINGS['background-ops'].concurrency).toBe(3);
  });

  it('QUEUE_SETTINGS enforces the timeout contract', () => {
    expect(QUEUE_SETTINGS['sync-ops'].timeoutMs).toBe(30_000);
    expect(QUEUE_SETTINGS['medium-ops'].timeoutMs).toBe(120_000);
    expect(QUEUE_SETTINGS['heavy-ops'].timeoutMs).toBe(1_200_000);
    expect(QUEUE_SETTINGS['background-ops'].timeoutMs).toBe(300_000);
  });
});

// --------------------------------------------------------------------
// n8n-worker: processor logic, mocked HTTP + Worker

describe('n8n-worker processor', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    mocks.workerOnMock.mockReset();
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it('POSTs to the webhook URL and returns ok on 200', async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, data: { result: 'ok' } });
    http.mockResolvedValue({ status: 200, body: { result: 'ok' } });
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('medium-ops', { http }) as unknown as {
      processor: (job: unknown) => Promise<unknown>;
    };
    const job = {
      id: 'abc',
      data: {
        userId: '+1',
        jobType: 'chat',
        webhookUrl: 'https://example.test/webhook/foo',
        body: { user_message_request: 'hi' },
      },
    };
    const result = (await worker.processor(job)) as { ok: boolean; data: unknown };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 'ok' });
    expect(http).toHaveBeenCalledWith(
      'https://example.test/webhook/foo',
      { user_message_request: 'hi' },
    );
  });

  it('returns ok:false on 4xx without throwing', async () => {
    const http = vi.fn().mockResolvedValue({ status: 400, body: { error: 'bad' } });
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('sync-ops', { http }) as unknown as {
      processor: (job: unknown) => Promise<unknown>;
    };
    const result = (await worker.processor({
      id: '1',
      data: { userId: 'u', jobType: 'chat', webhookUrl: 'x', body: {} },
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('400');
  });

  it('throws on 5xx so BullMQ retries', async () => {
    const http = vi.fn().mockResolvedValue({ status: 502, body: null });
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('heavy-ops', { http }) as unknown as {
      processor: (job: unknown) => Promise<unknown>;
    };
    await expect(
      worker.processor({
        id: '2',
        data: { userId: 'u', jobType: 'chat', webhookUrl: 'x', body: {} },
      }),
    ).rejects.toThrow(/5xx.*502/);
  });

  it('throws on network error so BullMQ retries', async () => {
    const http = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('background-ops', { http }) as unknown as {
      processor: (job: unknown) => Promise<unknown>;
    };
    await expect(
      worker.processor({
        id: '3',
        data: { userId: 'u', jobType: 'chat', webhookUrl: 'x', body: {} },
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });
});
