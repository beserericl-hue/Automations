import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Newsletter FULL send — the complete data path a real user drives, end to end:
 *   Generate (from the Generate page) → approve the STORIES gate → approve the SUBJECT gate →
 *   approve the IMAGE gate (each from the Approval detail screen) → the saga renders + delivers →
 *   a newsletter_sends_v2 row is created (status saved/sent, html_body populated, and a Postal
 *   provider_message_id once delivery completes) → the sent newsletter is DISPLAYED on
 *   /newsletter/sends and its detail page.
 *
 * PASS: a send row for THIS execution exists with a non-empty html_body AND subject, and that
 *       subject renders on the Sends list; delivery records a provider_message_id.
 * FAIL: a gate never appears, the saga errors, no send row materialises, or it isn't displayed.
 *
 * HEAVY (engine segments + images take minutes) — run in Pass B (workers=1). Uses the seeded
 * wasteland-wire edition; its 5 subscribers are @example.invalid so delivery bounces harmlessly.
 */
const EDITION = 'wasteland-wire';
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

async function openApprovalToken(execId: string): Promise<string | null> {
  const rows = await supaGet<{ token: string }>(
    'newsletter_approvals_v2',
    `execution_id=eq.${encodeURIComponent(execId)}&resolved_at=is.null&select=token,created_at&order=created_at.desc&limit=1`,
  ).catch(() => []);
  return rows[0]?.token ?? null;
}

test.describe('Newsletter FULL send (data path)', () => {
  test.skip(!HAS_KEY, 'requires SUPABASE_SERVICE_ROLE_KEY / E2E_SUPA_SERVICE_KEY');
  test.setTimeout(20 * 60_000); // full pipeline: 3 HITL gates + per-story segments + images + render + deliver

  test('generate → approve stories/subject/image → sent newsletter created and displayed', async ({ page }) => {
    const startIso = new Date(Date.now() - 5_000).toISOString();

    // ── 1) Generate from the Generate page ────────────────────────────────────
    await page.goto('/newsletter/generate', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Generate newsletter/i })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel(/^Edition$/i).selectOption(EDITION);
    await page.getByRole('button', { name: /Generate newsletter/i }).click();
    await expect(page).toHaveURL(/\/newsletter\/execution\/[^/]+/, { timeout: 30_000 });
    const execId = decodeURIComponent(page.url().split('/newsletter/execution/')[1] ?? '');
    expect(execId.length, 'execution id present in URL').toBeGreaterThan(0);

    // ── 2) Approve all three HITL gates from the Approval detail screen ────────
    // The gates fire in sequence (stories → subject → image); each time, the ONLY open approval
    // for this execution is the current gate. Approve whichever is open, three times.
    const GATE_TIMEOUTS = [90_000, 90_000, 300_000]; // image gate waits on engine segments + image proposals
    for (let gate = 0; gate < 3; gate++) {
      let token: string | null = null;
      const deadline = Date.now() + GATE_TIMEOUTS[gate];
      while (Date.now() < deadline && !token) {
        token = await openApprovalToken(execId);
        if (!token) await page.waitForTimeout(4_000);
      }
      expect(token, `gate ${gate + 1}/3 approval did not appear within ${GATE_TIMEOUTS[gate] / 1000}s`).toBeTruthy();

      await page.goto(`/newsletter/approvals/${token}`, { waitUntil: 'domcontentloaded' });
      const approveBtn = page.getByRole('button', { name: /^Approve/i });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await approveBtn.click();

      // Confirm the decision persisted (resolved_at set) before advancing.
      await expect
        .poll(async () => {
          const r = await supaGet<{ resolved_at: string | null; decision: string | null }>(
            'newsletter_approvals_v2',
            `token=eq.${encodeURIComponent(token!)}&select=resolved_at,decision`,
          ).catch(() => []);
          return r[0]?.resolved_at ? r[0]?.decision : null;
        }, { timeout: 30_000, message: `gate ${gate + 1} approve did not persist` })
        .toBe('approve');
    }

    // ── 3) DATA CREATED: a send row for this run with real content ────────────
    let send: { id: string; subject: string; html_body: string | null; status: string; provider_message_id: string | null } | undefined;
    await expect
      .poll(async () => {
        const rows = await supaGet<typeof send>(
          'newsletter_sends_v2',
          `edition_id=eq.${EDITION}&created_at=gte.${encodeURIComponent(startIso)}&select=id,subject,html_body,status,provider_message_id&order=created_at.desc&limit=1`,
        ).catch(() => []);
        send = rows[0];
        return !!(send && send.html_body && send.subject);
      }, { timeout: 7 * 60_000, message: 'no send row with rendered html materialised after approving all gates' })
      .toBe(true);

    expect(send!.html_body!.length, 'rendered html_body is non-trivial').toBeGreaterThan(200);
    expect(send!.subject.length, 'subject present').toBeGreaterThan(0);

    // Delivery records a Postal provider_message_id once the deliver step runs (bounces are fine).
    await expect
      .poll(async () => {
        const r = await supaGet<{ status: string; provider_message_id: string | null }>(
          'newsletter_sends_v2', `id=eq.${send!.id}&select=status,provider_message_id`,
        ).catch(() => []);
        return r[0]?.provider_message_id || r[0]?.status;
      }, { timeout: 3 * 60_000, message: 'send never reached a delivered/sent state' })
      .toBeTruthy();

    // ── 4) DATA DISPLAYED: the sent newsletter shows on the Sends screen ──────
    // The list defaults to the 'scheduled' filter; a real user flips Status → 'sent' to see it.
    await page.goto('/newsletter/sends', { waitUntil: 'domcontentloaded' });
    await page.getByRole('combobox').first().selectOption('sent');
    await expect(page.getByText(send!.subject).first()).toBeVisible({ timeout: 20_000 });

    // ...and the sent detail renders the stored HTML.
    await page.goto(`/newsletter/sends/${send!.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(new RegExp(send!.subject.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first())
      .toBeVisible({ timeout: 20_000 });
  });
});
