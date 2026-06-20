---
name: Engine E2E parity sprints
description: The minimal set of implementation sprints required to make the full [[engine-chat-e2e-suite]] (all 161 tests) runnable end-to-end on the engine. Lists ONLY the gaps the suite depends on — the engine ops still tagged "impl: pending" — each mapped to the exact tests it unblocks. When all sprints here ship, the entire E2E suite can run.
type: concept
tags: [sprints, engine, e2e, parity, testing, acceptance]
last_reviewed: 2026-06-20
---

# Engine E2E parity sprints

This is the **exit-gate plan** for [[engine-chat-e2e-suite]]: the complete list of what still has to be coded so the
**full 161-test** suite (R01–R121 chat + V01–V40 voice) can run end-to-end on the engine. It is intentionally
**scoped to the suite** — only the engine ops the tests are blocked on appear here. Once every sprint below ships,
every `impl: pending` test in the suite flips to runnable, and the whole suite executes.

- Gap source of truth: CR-010 (`writers-workbench/docs/change-requests/CR-010-engine-parity-completion-ui-wiring-and-multi-engine-scale.md`).
- Routing source of truth: `engine/.../hub/catalog.py`. All work on DEV; never PROD.
- Out of scope here (do NOT gate the suite — the tests tolerate or don't assert them): embeddings/semantic
  retrieval (CR-010 A2 quality), token accounting completeness (CR-010 A2), content-ingestion cron (CR-010 A3 —
  blog/newsletter "recent content" tests already tolerate 0 items), Part C multi-engine scale (CR-010 C). Those
  are tracked in CR-010 / [[planned-sprints]] but are not needed to *run* the suite.

## Already built (suite prerequisites — verify, don't rebuild)

- `HUB_BACKEND=engine` cutover (DEV live); `/internal/hub` + `/internal/hub/voice` webhook; async job poll
  `/api/jobs/engine/:id` + abort. Built ops: `brainstorm.story/short-story/revise-outline/edit-outline/create-project`,
  `chapter.write/plan/rewrite/repair/qa/blog/short-story`, `research.run`, `media.cover-art/social-posts/scrape-url`,
  `library.list-outlines/retrieve/lifecycle`, `story_bible.list`.
- **Verify before the run** (assumed built by the suite; confirm in `library_step`): `library.lifecycle` covers
  `delete` / `undelete` / `unschedule` / `unpublish` (and the "can't delete published" guard) used by R94–R99, V33–V36.
  If any are missing, fold them into **Sprint E2E-2**.

## Coverage map — sprint → tests unblocked

| Sprint | Engine work | Tests unblocked |
|---|---|---|
| E2E-1 | `library.email-content` | R03, R05, R100–R105, V03, V32, V37–V40 (≈14) |
| E2E-2 | `library.versions` + `library.revert` (+ verify lifecycle delete/undelete) | R28, R29, R84–R93, V (delete/undelete already built) (≈12) |
| E2E-3 | newsletter as a hub op | R07, R16, R44, V05, V31 (≈5) |
| E2E-4 | `chapter.plan` dual-arc depth + arc fidelity | R54–R69 (arc fidelity), R110–R121 (≈28) |
| E2E-5 | `notify.eve-callback` (ElevenLabs KB + outbound call) | V26–V31 (≈6) |

---

## Sprint E2E-1 — On-demand "email me X" (`library.email-content`) ✅ SHIPPED (2026-06-20, commit `<pending>`)

**Status:** built on `develop`. `library.email-content` op (inline-content + DB-resolve + graceful not-found),
catalog entry, Gemini rule + deterministic heuristic branch (`_email_params`), shared `markdown_to_html`
helper. Tests: 4 routing + 4 op unit (all 8 E2E-1 chat prompts route correctly offline); the 14 suite tests'
tags flipped to `built (E2E-1)`. Live DEV run still validates real Postal send + DB resolution.

**Gap (CR-010 A2):** CR-009 emails fire on *generation*; there is no op to email an existing artifact on request.

**Build:**
- New `library.email-content` op in `library_step` + catalog entry (kind=task). Params: `content_type`
  (outline | short_story | chapter | newsletter | research | blog), `title`/`search_term`, `chapter_number`.
- Resolve the item: outline → `writing_projects_v2.outline`; research → `research_reports_v2`; everything else →
  `published_content_v2` (title/keyword match, chapter_number for chapters). Render markdown/JSONB → HTML, send via
  Postal using `email_recipients` (`app_config.recipient_email`/`bcc_email`). Graceful "not found" (no email).
- Voice parity: confirm the hub routes the voice phrasings to it.

**Unblocks / acceptance (must pass in [[engine-chat-e2e-suite]]):**
- R03, R05 (email a report), R100 (outline), R101 (short story), R102 (research), R103 (chapter), R104 (newsletter),
  R105 (not-found graceful); V03, V32 (centralized email), V37–V40 (voice email of outline/story/research/chapter).
- Each: routes `library.email-content`, kind=queued → complete; correct source table; HTML email to the configured
  recipient (+BCC); subject references the item; not-found returns a clear message with **no** email sent.

---

## Sprint E2E-2 — Version history + revert (`library.versions`, `library.revert`) ✅ SHIPPED (2026-06-20)

**Status:** built on `develop`. `library.versions` (outline-by-title + content-by-id list/get) and
`library.revert` (outline + chapter, snapshot-before-overwrite, no-mutation-on-error). The lifecycle
op was MISSING delete/undelete/list_deleted (the R94–R99/V33–V36 "built" tag was aspirational) — added
them: soft-delete + content_versions snapshot ("Auto-snapshot before delete"), published-delete guard
(unpublish first), undelete→draft, list_deleted (+content_type filter), and delete/undelete email verbs.
delete/undelete are forced async (queued) via a `build_dispatch_plan` per-action override; approve/
publish/schedule/list_deleted stay sync. 13 new tests (4 routing + 9 op) + the revert routing test
updated; router suite + gateway + smoke all green.

**Gap (CR-010 A2):** `content_versions_v2` / `outline_versions_v2` are written but cannot be listed or reverted via
the hub.

**Build:**
- `library.versions` op (sub-ops: list / get) + catalog. list → version entries (version_number, created_at,
  change_note, chapter count) for a content item (`content_versions_v2`) or an outline (`outline_versions_v2`);
  get → full `content_text` of a version. Zero-rows handled gracefully.
- `library.revert` op (outline + chapter) + catalog. Snapshot current state first, then load the requested version
  and PATCH `writing_projects_v2.outline` (outline) or `published_content_v2.content_text` (chapter). Clear errors for
  invalid version number and project-not-found (no mutation on error).
- **Verify** `library.lifecycle` already implements `delete`/`undelete`/`unschedule`/`unpublish` + the published-delete
  guard (R94–R99, V33–V36); if not, add them here.

**Unblocks / acceptance:**
- R28, R29 (content version history/get); R84–R86 (outline version history incl. no-revisions); R87–R88 (revert + verify);
  R89 (revert pre-epilogue); R90 (invalid version → error, no mutation); R91 (project not found → error); R92 (revision
  creates snapshot); R93 (history after multiple revisions, ≥3 entries).
- Each: correct route + kind; snapshot-before-overwrite; exact reverted outline shape; graceful error paths.

---

## Sprint E2E-3 — Newsletter as a hub op ✅ SHIPPED (2026-06-20)

**Status:** built on `develop`. **Design note / deviation:** the suite's R07/R16/R44 assertions describe a
TOPIC newsletter saved to `published_content_v2` (subject_line/pre_header/intro/sections/outro) — i.e. the
n8n `write_newsletter`, NOT the F2 curated multi-story saga (which needs ingested content and writes
`newsletter_sends`). So rather than bridge the saga (which couldn't satisfy those assertions), I added
`chapter.newsletter` — a topic newsletter op mirroring `chapter.blog` (Perplexity research with citations
preserved → genre-toned structured compose → persist `published_content_v2` content_type=newsletter →
CR-009 email, since it's under the `chapter` tool already in `_EMAIL_TOOLS`). Catalog entry + heuristic
branch + Gemini rule + `_newsletter_params` (topic/genre_slug/date). Also fixed a latent `extract_json`
import bug shared with `_op_blog` (it silently fell back to raw text). 4 tests (3 routing + 1 op).
R07/R16/R44/V05 flipped to built; V31 stays pending (needs E2E-5 callback + multi-task split).

**Gap (CR-010):** "write a newsletter" was not routable from the chat/voice hub.

**Build:**
- A hub catalog entry that maps "write a newsletter …" to the newsletter pipeline and returns a pollable `job_id`
  (wrap the durable saga so it presents the same `kind:queued` → `GET /api/jobs/engine/:id` → complete contract; or
  bridge the saga's execution_id to the write-job poller). Genre + topic + date params; result saved to
  `published_content_v2` (content_type=newsletter); CR-009 completion email.

**Unblocks / acceptance:**
- R07, R16 (newsletter by genre), R44 (newsletter Prime Directive), V05 (voice newsletter), V31 (newsletter as one of
  two parallel voice tasks).
- Each: routes to the newsletter saga, kind=queued → complete; `published_content_v2` row; subject_line/pre_header/
  intro/sections/outro structure; CR-009 email.

---

## Sprint E2E-4 — `chapter.plan` dual-arc depth + arc fidelity

**Gap:** `chapter.plan` and `brainstorm.story` exist, but the suite asserts deep arc behavior the current
implementation may not fully cover. **Start by auditing the current `chapter.plan` / brainstorm arc handling against
these assertions; build only what's missing.**

**Build / extend:**
- `brainstorm.story` honors a `story_arc` param and emits per-chapter `arc_notes` that name the chosen arc's beats
  (Freytag vs Three-Act terminology, midpoint ≠ climax, fatal flaw in Act 1, etc.).
- `chapter.plan` emits the full sub-chapter schema (number/title/brief/arc_beat/characters/setting/emotional_tone/
  connects_to_book_arc); supports a **per-chapter arc override** distinct from the book arc (dual-arc fields, no
  cross-contamination); injects **previous/next chapter context**; supports **non-conflict arcs** (Kishōtenketsu
  Ki/Shō/Ten/Ketsu, Story Circle, Fichtean); character names must match the book roster exactly.
- **Auto-plan guard:** "write chapter N" with no chapter outline routes to `chapter.plan` first (R116); "write chapter
  for a non-existent book" fails gracefully via a project-existence check (R117, already built).
- `chapter.write` auto-loads sub_chapters + injects scene breaks + applies both arcs (R114, R115, R121).

**Unblocks / acceptance:**
- R54–R69 (arc fidelity in brainstorm + write-from-outline across Freytag/Three-Act × genres); R110–R121 (book outline
  with arc → chapter outline with sub-chapters → write → verify; per-chapter arc override; Kishōtenketsu; auto-plan
  guard; consistency check; full pipeline).
- Each: arc beats named correctly; dual-arc separation; prev/next continuity; sub_chapter schema complete; auto-plan
  guard fires; names consistent with the roster.

---

## Sprint E2E-5 — `notify.eve-callback` (voice KB + outbound call)

**Gap (CR-010 A1):** `notify.eve-callback` / `eve-reset-greeting` are placeholders — no ElevenLabs KB injection, no
outbound call.

**Build:**
- Implement the n8n WF-16 flow in `notify_step`: retrieve the target content, remove stale "Eve Session:" KB docs,
  upload `content_text` as a new KB doc, attach it to the agent, set the `review`/`brainstorm` `first_message`,
  trigger the outbound call to the caller, then reset the greeting. Hub routes "… and call me back" (review/brainstorm)
  to it; when `library.retrieve` returns `found=false`, the callback is **not** invoked (V30).
- **Baseline-protected:** pointing the **PROD** Eve ElevenLabs agent at this is a protected config change and needs
  explicit user go-ahead. The op + webhook can be built and **tested with simulated input** (the suite POSTs the voice
  webhook payload and asserts the op is invoked with the right `{content_type, content_title, content_text,
  callback_mode, phone}` — no live agent required).

**Unblocks / acceptance:**
- V26 (review-mode callback), V27 (brainstorm-mode), V28 (editorial review), V29 (KB cleanup back-to-back → exactly one
  "Eve Session:" doc), V30 (not-found → no callback), V31 (callback as one of two parallel tasks).
- Each: flat voice `{response, kind:queued}` + job_id → complete; correct callback payload; KB cleanup verified;
  no-callback-on-not-found.

---

## Done = full suite runnable

When E2E-1 … E2E-5 ship (and the E2E-2 lifecycle verification passes), **every `impl: pending` tag in
[[engine-chat-e2e-suite]] is satisfied** and the entire 161-test suite can run against the DEV engine. Run order:
the `built` tests are runnable now; add each sprint's tests as it lands; the final full-suite pass is the engine
parity acceptance gate (cf. [[engine-api-system-tests]] L5 parity gate) before any PROD cutover.
