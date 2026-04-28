/**
 * Test-only fixture endpoint (Compose Newsletter 2a — S9).
 *
 * `POST /api/test/newsletter/simulate-run` replays the canonical
 * fixture run end-to-end:
 *   - 9 stage events in the canonical order (matches the n8n
 *     emit_stage_* nodes added in S3)
 *   - 2 approval-created broadcasts (stories + subject)
 *   - 2 approval-resolved broadcasts (auto-approve)
 *
 * Events fan through the same publishSseEvent path production uses, so
 * the in-app ExecutionStatus + PendingApprovals pages exercise the
 * exact same listener code they will in prod.
 *
 * Mounted only when NODE_ENV === 'test'. The route file is imported
 * unconditionally (so tsc + bundlers don't object to a stale path), but
 * the mount in index.ts gates on env to keep this off prod surface area.
 */
import { Router, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../lib/logger.js';
import { pushSseEvent } from './session.js';

interface FixtureStageEvent {
  stage: string;
  detail: string;
}
interface FixtureApproval {
  token: string;
  stage: 'stories' | 'subject_line';
  execution_id: string;
  approval_url: string;
  decision: 'approve' | 'revise';
  feedback: string;
}
interface RunFixture {
  edition_id: string;
  userId: string;
  stage_events: FixtureStageEvent[];
  approvals: FixtureApproval[];
  stories_payload: Record<string, unknown>;
  subject_payload: Record<string, unknown>;
  saved_payload: Record<string, unknown>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'test', 'fixtures', 'newsletter-run.json');

let cachedFixture: RunFixture | null = null;
function getFixture(): RunFixture {
  if (cachedFixture) return cachedFixture;
  cachedFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as RunFixture;
  return cachedFixture;
}

export const testNewsletterRouter = Router();

testNewsletterRouter.post('/simulate-run', async (req: Request, res: Response) => {
  // Caller may override the executionId so the test can scope its
  // assertions. Anything else (userId, ordering, payloads) comes from
  // the fixture so the canonical flow stays consistent across tests.
  const body = (req.body ?? {}) as { executionId?: string; userId?: string; gapMs?: number };
  const fixture = getFixture();
  const executionId = body.executionId ?? 'exec-simulate';
  const userId = body.userId ?? fixture.userId;
  const gapMs = typeof body.gapMs === 'number' ? Math.max(0, Math.min(500, body.gapMs)) : 50;

  // Respond synchronously so the caller can start asserting against SSE
  // immediately. The actual emission runs in the background.
  res.json({ success: true, executionId, userId, scheduled: fixture.stage_events.length });

  void runFixture(fixture, executionId, userId, gapMs).catch((err) => {
    logger.error({ err, executionId }, 'simulate-run: failed mid-replay');
  });
});

async function runFixture(
  fixture: RunFixture,
  executionId: string,
  userId: string,
  gapMs: number,
): Promise<void> {
  for (const ev of fixture.stage_events) {
    await pushSseEvent(userId, {
      event: 'newsletter.stage',
      data: {
        userId,
        executionId,
        editionId: fixture.edition_id,
        stage: ev.stage,
        detail: ev.detail,
        ts: new Date().toISOString(),
      },
    });

    // After awaiting_*, fire the matching approval-created broadcast so
    // the inbox lights up before the ExecutionStatus advances.
    if (ev.stage === 'awaiting_stories_approval') {
      const approval = fixture.approvals.find((a) => a.stage === 'stories');
      if (approval) {
        await pushSseEvent(userId, {
          event: 'newsletter.approval.created',
          data: {
            token: approval.token,
            stage: approval.stage,
            execution_id: executionId,
            approval_url: approval.approval_url,
          },
        });
      }
    }
    if (ev.stage === 'awaiting_subject_approval') {
      const approval = fixture.approvals.find((a) => a.stage === 'subject_line');
      if (approval) {
        await pushSseEvent(userId, {
          event: 'newsletter.approval.created',
          data: {
            token: approval.token,
            stage: approval.stage,
            execution_id: executionId,
            approval_url: approval.approval_url,
          },
        });
      }
    }

    // After stories_approved / subject_approved, fire the matching
    // approval-resolved broadcast so the inbox can clear the row.
    if (ev.stage === 'stories_approved' || ev.stage === 'subject_approved') {
      const approval = fixture.approvals.find(
        (a) => (ev.stage === 'stories_approved' && a.stage === 'stories')
          || (ev.stage === 'subject_approved' && a.stage === 'subject_line'),
      );
      if (approval) {
        await pushSseEvent(userId, {
          event: 'newsletter.approval.resolved',
          data: {
            token: approval.token,
            stage: approval.stage,
            execution_id: executionId,
            decision: approval.decision,
            feedback: approval.feedback,
            resumed: true,
          },
        });
      }
    }

    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
}

/** Test helper exposed so vitest can read the canonical fixture without
 *  re-parsing the JSON file in every test. */
export function getNewsletterFixture(): RunFixture {
  return getFixture();
}
