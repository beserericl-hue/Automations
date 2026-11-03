import { test, expect } from '@playwright/test';
import { DEMO_USER_ID, supaGet, supaInsert } from '../pages/api';
import { cleanupStudio, seedStudio, STUDIO_EDITION, type StudioFixture } from '../pages/studio';

/**
 * Newsletter FULL send — the complete data path a real user drives, end to end:
 *   Generate (from the Generate page) → approve the STORIES gate → approve the SUBJECT gate →
 *   approve the IMAGE gate (each from the Approval detail screen) → the saga renders + saves and
 *   STOPS at the final "Send to subscribers" gate (nothing sent yet; 2026-11-03) → approve it → delivers →
 *   a newsletter_sends_v2 row is created (status saved/sent, html_body populated, and a Postal
 *   provider_message_id once delivery completes) → the sent newsletter is DISPLAYED on
 *   /newsletter/sends and its detail page.
 *
 * PASS: a send row for THIS execution exists with a non-empty html_body AND subject, and that
 *       subject renders on the Sends list; delivery records a provider_message_id.
 * FAIL: a gate never appears, the saga errors, no send row materialises, or it isn't displayed.
 *
 * HEAVY (engine segments + images take minutes) — run in Pass B (workers=1).
 *
 * SAFE TO RUN (2026-11-03): the spec makes its OWN throwaway edition (through the real create route,
 * so it has the default template), with ZERO subscribers, and a chosen selection of two of its own
 * slate topics so the run has content without gathering anything. It used to generate a real
 * wasteland-wire issue, which overwrote that edition's issue for the day and mailed its subscribers.
 * The edition and everything the run wrote are deleted afterwards (cleanupStudio). Delivery to zero
 * subscribers still marks the issue sent, with recipient_count 0.
 */
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
    let fx: StudioFixture | null = null;
    try {
    fx = await seedStudio(`${STUDIO_EDITION}-send`, { viaApi: true });
    const EDITION = fx.edition;
    expect(await supaGet('newsletter_subscribers_v2', `edition_id=eq.${encodeURIComponent(EDITION)}&select=email`),
      'the throwaway edition has no subscribers').toEqual([]);
    const selection = await supaInsert<{ id: string }>('newsletter_issue_selections_v2', { user_id: DEMO_USER_ID, edition_id: EDITION, status: 'open' });
    for (const [i, t] of [fx.topics[0], fx.topics[2]].entries()) {
      await supaInsert('newsletter_issue_items_v2', { selection_id: selection.id, position: i + 1, kind: 'topic', radar_topic_id: t.id });
    }
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
    // Gate 1 waits on gather + pick. The saga gives the pick step 240s (newsletter_saga, timeout_s)
    // and a weekly edition hands a thinking model a whole week of stories, so 120s here was tighter
    // than the pipeline's own budget (flaky on DEV 2026-10-27). The image gate waits on 5 sequential
    // segment+image builds.
    const GATE_TIMEOUTS = [300_000, 120_000, 600_000];
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

    // ── 2b) The final "Send to subscribers" gate: the issue is rendered and saved, NOT sent ──
    let sendGate: { token: string; payload: Record<string, unknown> } | undefined;
    await expect
      .poll(async () => {
        [sendGate] = await supaGet<{ token: string; payload: Record<string, unknown> }>(
          'newsletter_approvals_v2',
          `execution_id=eq.${encodeURIComponent(execId)}&stage=eq.send&select=token,payload`,
        ).catch(() => []);
        return sendGate?.token ?? null;
      }, { timeout: 7 * 60_000, message: 'the final send gate never opened after the image gate' })
      .not.toBeNull();
    const held = (await supaGet<{ status: string; sent_at: string | null }>(
      'newsletter_sends_v2', `id=eq.${String(sendGate!.payload.send_id)}&select=status,sent_at`,
    ))[0];
    expect(held?.status, 'approving the images must not send').not.toBe('sent');
    expect(held?.sent_at ?? null).toBeNull();
    await page.goto(`/newsletter/approvals/${sendGate!.token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Send to subscribers/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('send-test-copy')).toBeVisible();
    await page.getByRole('button', { name: /^Send to \d* ?subscribers?/i }).click();
    await expect
      .poll(async () => (await supaGet<{ decision: string | null }>('newsletter_approvals_v2', `token=eq.${encodeURIComponent(sendGate!.token)}&select=decision`).catch(() => []))[0]?.decision ?? null,
        { timeout: 30_000, message: 'send approval did not persist' })
      .toBe('approve');

    // ── 3) DATA CREATED: the send row for this run with real content ──────────
    // The persist step UPSERTs on (edition_id, send_date), so a re-send for the same day updates
    // ONE row in place — created_at stays old. Assert THIS run updated a row of the edition
    // (updated_at >= start) with rendered html. Not filtered on send_date: the send is dated by the
    // edition's local day, and a UTC "today" from here is the next day every evening in US time
    // (DEV 2026-11-03 04:27Z: the send for 2026-11-02 went out and the spec looked for 2026-11-03).
    let send: { id: string; subject: string; html_body: string | null; status: string; provider_message_id: string | null } | undefined;
    await expect
      .poll(async () => {
        const rows = await supaGet<typeof send>(
          'newsletter_sends_v2',
          `edition_id=eq.${EDITION}&updated_at=gte.${encodeURIComponent(startIso)}&html_body=not.is.null&select=id,subject,html_body,status,provider_message_id&order=updated_at.desc&limit=1`,
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
        // Delivered means sent (with a Postal id when the provider reports one). The old check took
        // ANY status as done, so "sending" passed and the next step looked for a sent row ~2 min
        // before delivery finished (DEV 2026-10-27: sent_at 00:58:57, list checked at ~00:57).
        return r[0]?.status === 'sent' || r[0]?.status === 'failed' ? r[0].status : null;
      }, { timeout: 5 * 60_000, message: 'send never reached a delivered/sent state' })
      .toBe('sent');
    expect((await supaGet<{ recipient_count: number | null }>('newsletter_sends_v2', `id=eq.${send!.id}&select=recipient_count`))[0]?.recipient_count,
      'nobody was mailed (zero subscribers)').toBe(0);

    // ── 4) DATA DISPLAYED: the sent newsletter shows on the Sends screen ──────
    // The list defaults to the 'scheduled' filter; a real user flips Status → 'sent' to see it.
    await page.goto('/newsletter/sends', { waitUntil: 'domcontentloaded' });
    await page.getByRole('combobox').first().selectOption('sent');
    await expect(page.getByText(send!.subject).first()).toBeVisible({ timeout: 20_000 });

    // ...and the sent detail renders the stored HTML.
    await page.goto(`/newsletter/sends/${send!.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(new RegExp(send!.subject.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first())
      .toBeVisible({ timeout: 20_000 });

    // ── 5) COST ROWS carry the edition owner ──────────────────────────────────
    // Every paid call of this run (pick, subject, segment + humanize, assemble) is written to
    // token_usage_v2 with run_id = the execution id. They used to be written with user_id NULL
    // because the saga never told its steps whose edition it was.
    const owner = (await supaGet<{ user_id: string }>(
      'newsletter_editions_v2', `id=eq.${EDITION}&select=user_id&limit=1`,
    ))[0]?.user_id;
    expect(owner, 'edition owner').toBeTruthy();
    type CostRow = { operation: string; user_id: string | null; metadata: Record<string, unknown> | null };
    let costRows: CostRow[] = [];
    await expect
      .poll(async () => {
        costRows = await supaGet<CostRow>(
          'token_usage_v2', `run_id=eq.${encodeURIComponent(execId)}&select=operation,user_id,metadata`,
        ).catch(() => []);
        return costRows.length;
      }, { timeout: 60_000, message: 'no token_usage_v2 rows recorded for this newsletter run' })
      .toBeGreaterThan(0);
    const ops = new Set(costRows.map((r) => r.operation));
    // No 'pick': a chosen selection IS the issue, so the LLM story pick never runs.
    expect([...ops], 'the LLM steps were all costed').toEqual(expect.arrayContaining(['subject', 'segment']));
    const ownerless = costRows.filter((r) => r.user_id !== owner);
    expect(ownerless.map((r) => `${r.operation}:${r.user_id}`), 'every cost row is billed to the edition owner').toEqual([]);
    expect(costRows.every((r) => r.metadata?.edition_id === EDITION), 'cost rows name the edition').toBe(true);
    } finally {
      await cleanupStudio(fx);
    }
  });
});
