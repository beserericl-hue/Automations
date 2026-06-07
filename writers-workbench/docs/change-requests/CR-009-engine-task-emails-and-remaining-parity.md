# CR-009 — Engine task-completion emails + remaining n8n→engine parity

| | |
|---|---|
| **Status** | Proposed |
| **Opened** | 2026-06-07 |
| **Tier** | DEV first; PROD at go-live |
| **Goal** | Restore the per-task **email notification** every n8n writing workflow sent (result data + task metadata), which the engine dropped — and complete the remaining n8n→engine parity gaps so the engine can fully replace n8n. |

## Part 1 — Task-completion emails (the immediate gap)

Every n8n writing workflow emailed the result on completion (Gmail node; recipient from the
`app_config` `recipient_email` + `bcc_email`; the user's original command prepended to the body). The
engine **has the machinery but never calls it**:

- `services/notify_step` `_op_email` already sends via Postal (`writer_engine.postal.send_email`).
- `writer_engine.library_helpers.email_recipients` already resolves `recipient_email`/`bcc_email` from
  `app_config` (n8n parity).
- **But no write tool (chapter / brainstorm / research / media) triggers an email.** So every engine
  chapter, repair, and brainstorm we ran completed silently — no notification was sent.

### Design

1. **Single completion chokepoint:** `orchestrator.worker.run_write_tool_job` is where every async
   load-bearing tool finishes. After a successful step return, send a completion email (best-effort;
   a mail failure must never fail the job). This covers chapter/brainstorm/research/media uniformly.
   (A `notify: false` body flag opts out, e.g. for internal/test runs.)
2. **Recipient:** resolve via `email_recipients` — request `recipient_email`/`bcc_email` overrides,
   else `app_config`. Per-user recipient (V2 `users_v2.email` / `bcc_email`) preferred when available.
3. **Content (data + metadata), mirroring n8n:**
   - subject: e.g. `[Writer's Workbench] Chapter 11 of "The Burial Mound" is ready`
   - the generated artifact (chapter prose / outline / research report) or a deep link to it in the UI
   - metadata block: op, project, chapter_number, word_count, **drift aligned + craft-QA** (CR-005),
     research topics used (CR-006), **tokens + cost** (CR-007), and the user's original command
     (`originalUserPrompt`).
4. **Async UX:** the email is the "your queued job is done" signal (the hub returns immediately with a
   job_id; the email arrives when the worker finishes) — exactly the n8n async behavior.

### Acceptance
- Writing a chapter / brainstorm / research through the hub produces an email to the configured
  recipient with the artifact + the metadata block; a mail outage doesn't fail the job; opt-out works.

## Part 2 — Remaining engine parity / completion punch-list

Tracked here so the engine can fully replace n8n:

1. **Missing write tools** the n8n hub had but the engine catalog lacks: `write_blog_post`,
   `write_short_story` (newsletter = the saga; cover-art/social/kindle/research already exist). Add as
   engine ops + hub catalog entries.
2. **Eve voice webhook** (CR-004 Sprint B): `POST /internal/hub/voice` (ElevenLabs shape, spoken
   ack/data, knowledge-callback, outbound-call) + conversation state (Redis: multi-turn, last-list,
   project anchor).
3. **Hub conversational state** — numbered-list selection + multi-turn context server-side (Sprint A
   passes it in the request; persist it).
4. **Bible cleanup + extraction hardening** — dedupe the ~1000-entry polluted bible to the canonical
   cast; canonical-name dedup + drop possessives/fragments at extraction (CR-005/006 follow-up). Needed
   for a usable story-bible tab (CR-008 B4).
5. **Drift-detector tuning** — don't flag characterization that *adds to* (vs *contradicts*) a sparse
   roster bio; clears most of the 28 residual-drift chapters.
6. **Exact tokens-per-credit** — one measured chapter write under CR-007 to finalize the credit price.
7. **Server hub cutover** (CR-008 Workstream C): `HUB_BACKEND=engine`, job/SSE bridge, `user_id`
   threading — so the UI runs on the engine instead of n8n.

## Notes
- Part 1 is the user-visible miss (silent tasks) — implement first.
- Items in Part 2 overlap CR-004 (Sprint B) and CR-008 (C); this CR is the consolidated "finish the
  engine" tracker. PROD cutover gated per CLAUDE.md.
