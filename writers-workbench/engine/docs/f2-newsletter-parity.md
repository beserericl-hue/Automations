# F2 — Newsletter saga parity & system-test coverage

Status of the engine-backed newsletter pipeline (`NEWSLETTER_BACKEND=python`) on **DEV**, mapped to
the system-test plan in `knowledgebase/Writers Workbench Wiki/Engineering/testing/engine-api-system-tests.md`
(suite **S-07 … S-19**).

This document is the F2-10 deliverable: it records what was verified end-to-end on DEV, the
defects found and fixed while driving the saga to completion, and the residual gaps that gate a
PROD cutover.

## How the pipeline runs

```
gather → pick →[stories gate]→ subject →[subject gate]→ writing_segments
       → proposing_images →[image gate]→ assembling → rendering → saved → sending → SENT
```

- Durable saga (`/pipelines/newsletter/run-durable`), arq worker drives between HITL pauses.
- Gateway exposes `/internal/newsletter/{generate, executions/{id}/state, executions/{id}/review/{stage}, approvals/{token}/resolve}` (X-Service-Secret).
- WW Express proxies status (`/execution/:id/status`, F2-8) and resolves gates (`lib/approvals.ts`, F2-7) when the saga is engine-backed.

## System-test coverage matrix

| Test | What it covers | Status on DEV | Evidence / notes |
|------|----------------|---------------|------------------|
| **S-07** | generate → execution_id; stage progression | ✅ verified | runs `c661921d` / `ed9480fb`: gathering→picking→…→sent observed via saga-state |
| **S-08** | `newsletter_sends_v2` row w/ subject, bodies, masthead, metadata.execution_id | ✅ verified | run `ed9480fb` → row `ea4d6b11`: subject, preheader, html 12.6 KB, md 9.3 KB, `metadata.execution_id` matches. (status persists as `draft` — see gap below.) |
| **S-09** | stories gate review + resolve → stories_approved | ✅ verified | approved tokens across both runs; resumed to subject |
| **S-10** | subject gate review + resolve | ✅ verified | subject + 3 clean alternatives; approved |
| **S-11** | image gate review + resolve w/ chosen images | ✅ verified (text-only) | 5 stories, 0 image options (articles had none) — empty chosen_images is valid |
| **S-12** | revise loop (feedback → re-run, bounded) | ✅ verified | run `2869ba56`: stories `{revise, feedback}` → re-ran pick, `revision_counts.stories` 0→1, returned to gate; selection changed to honour the feedback (dropped GPU/hardware, added open-source/dev-tooling). Bounded by MAX_REVISIONS_PER_GATE. |
| **S-13** | delivery = Postal fan-out + web permalink | ✅ verified | run `ea8a176e`: `recipients_emailed=1`, real Postal `message_id` `1dff02bf-…@rp.postal.courseworx.media` (authorised From `eve@courseworx.media`); permalink published + HTTP 200 (12.7 KB, masthead present) |
| **S-14** | empty day → skipped_no_content, no send row | ✅ verified | run `67183196` on `1999-01-01` (no ingested rows): gather→0 articles→terminal `skipped_no_content`; no `newsletter_sends_v2` row written |
| **S-15** | expired token resolve → 404 | ✅ (by contract) | `get_approval` returns None → 404 |
| **S-16** | idempotent persist (replay → same row) | ✅ verified | runs `ed9480fb` + `ea8a176e` both upserted the **same** row `ea4d6b11` (edition_id, send_date) — no duplicate; migration 024 unique index + idempotent_call wrapper |
| **S-17** | gather reads correct content_ingestion_v2 rows | ✅ verified | 5 stories picked from 12 `2026-05-31/*` rows for the edition user |
| **S-18** | cron cadence enqueues only due editions | ✅ fixed (#93) | engine `/cron/newsletter-cadence` rewritten to derive due from cadence + last send using real columns. Canonical cadence path remains WW `/editions/run-due` (PR #88, backend-aware). |
| **S-19** | Postal bounce webhook → email_bounces_v2 + subscriber flipped | ✅ covered | WW `email.ts` webhook + test (PR #89) |

## Defects found & fixed while driving the saga (DEV)

1. **Pick — identifiers as dict** (PR #83): `_coerce_str_list` validator.
2. **Subject — envelope wrapper** (PR #85): `_unwrap_envelope` model_validator.
3. **Pick/subject — JSON truncation** (PR #90): max_tokens 4096→8192.
4. **Subject — additional_subject_lines as dicts** (PR #91): step-3 rewrite of `_unwrap_envelope`.
5. **Segment — blank body** (PR #92): `StorySegment` title/content alias coercion + authoritative
   backfill; saga now raises on segment/image step ERROR instead of silently appending `{}`.
6. **Persist — column/constraint mismatch** (PR #92): `_to_db_row` maps to real columns
   (`preheader`, status enum), supplies `user_id`; migration 024 adds the
   `(edition_id, send_date)` unique index for the upsert.
7. **Deliver — unauthorised Postal From, masked** (PR #93): deliver used a placeholder `.local`
   From that Postal rejects (`UnauthenticatedFromAddress`), and `PostalClient` reported it as a
   phantom success. Now defaults to `eve@courseworx.media`, surfaces Postal `status=error`, and
   fails the step on a total send failure.
8. **Cron — wrong columns** (PR #93): engine `/cron/newsletter-cadence` queried non-existent
   columns; rewritten to mirror WW `computeDueEditions`.
9. **Send-row stuck at draft** (PR #95): deliver-svc now advances the row to `status='sent'` with
   `sent_at`, `recipient_count`, `provider_message_id` after a successful send (guarded to the
   real row UUID).
10. **Template not rendered — raw Handlebars + empty sponsor block** (PR #96): render-svc did naive
    `.replace()` so the `newsletter_templates_v2` Handlebars template shipped with raw tokens
    (`{{{markdown_to_html body_md}}}`, `{{#if sponsor}}`), no article bodies, and sample decorative
    blocks. Now renders THROUGH the template via WW `/api/newsletter/render-html` (same contract as
    the n8n send path): `body_md` = assembled markdown, decorative sections sent `null` so the
    renderer hides them instead of using `sample_data`. Verified on the permalink HTML: 0 raw
    tokens, 6 article `<h2>`s, no sponsor block. Requires `WORKBENCH_API_URL` + `INGESTION_SECRET`
    on the engine runtime (set on DEV; **add to PROD before cutover**).

## Infra prepared on DEV

- `newsletter-archive` public storage bucket created (permalink target; was missing).
- Migration 024 applied to DEV (unique index for persist upsert).

## Residual gaps

None on DEV — all of S-07…S-19 are verified (S-12 revise loop and S-14 empty-day skip exercised
2026-06-01). The earlier send-row status-writeback gap is closed (defect #9). The only remaining
work is the PROD cutover, which is gated below.

## Before a PROD cutover (require explicit user authorization — Tier 2/3)

- Apply **migration 024** to PROD Supabase and create the **`newsletter-archive`** bucket on PROD
  (both done on DEV here; PROD is frozen without authorization).
- Verify PROD runtime env before flipping `NEWSLETTER_BACKEND=python`: `NEWSLETTER_BACKEND`, step
  URLs, `POSTAL_API_URL/KEY`, `ARCHIVE_BASE_URL`, `NEWSLETTER_FROM_ADDRESS`, and — required for the
  template render — `WORKBENCH_API_URL` (PROD WW) + `INGESTION_SECRET` (PROD WW's secret).
- A PROD cutover changes Tier-2 (PROD workflows) / Tier-3 (PROD Supabase) behaviour — **do not
  proceed without explicit user sign-off.**
