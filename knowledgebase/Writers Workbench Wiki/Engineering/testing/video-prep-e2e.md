---
name: Video-prep E2E — seed the marketing demo through chat
description: E2E tests that run the marketing-video "Pre-recording setup" (marketing-copy.md §2) as chat commands against the engine hub, verified in the DEV database. Run via scripts/e2e_video_prep.py.
type: concept
tags: [testing, e2e, marketing, video, chat]
last_reviewed: 2026-07-01
---

# Video-prep E2E

These tests seed the demo state the marketing video needs ([[marketing-copy]] §2, "Pre-recording
setup") **entirely through the chat interface** (`POST /internal/hub`), then verify each artifact in
the DEV Supabase database. Runner: `scripts/e2e_video_prep.py`.

Demo project: **The Last Signal** — post-apocalyptic, Hero's Journey, protagonist Maya Chen, 6
chapters; chapters 1–3 written + approved; cover art generated; Story Bible auto-populated; one
deliberate drift in chapter 3 (`Maya Chen` → `Maya Chan`) for the live drift-scanner demo.

## Run

```
E2E_SECRET=<64-char gateway secret> \
SUPA_URL=<dev supabase url> SUPA_KEY=<dev service role key> \
python3 scripts/e2e_video_prep.py
```

## Steps (each is a real chat message → engine)

| ID | Chat command | Engine route | Verified in DB |
|---|---|---|---|
| VP01 | Brainstorm a post-apocalyptic novel called "The Last Signal" using the Hero's Journey arc with 6 chapters. Protagonist Maya Chen … Rust Coast 2087. | `brainstorm.story` | `writing_projects_v2` row "The Last Signal" with a 6-chapter outline; `persist.persisted=true` |
| VP02 | Write chapter 1 of "The Last Signal" | `chapter.write` | `published_content_v2` chapter 1 (draft), word_count > 200 |
| VP03 | Write chapter 2 of "The Last Signal" | `chapter.write` | chapter 2 persisted |
| VP04 | Write chapter 3 of "The Last Signal" | `chapter.write` | chapter 3 persisted |
| VP05 | Approve chapter 1 of "The Last Signal" | `library.lifecycle` | status → approved |
| VP06 | Approve chapter 2 of "The Last Signal" | `library.lifecycle` | status → approved |
| VP07 | Approve chapter 3 of "The Last Signal" | `library.lifecycle` | status → approved |
| VP08 | Generate cover art for "The Last Signal" | `media.cover-art` | `generated_images_v2` row / public image URL |
| VP09 | Get the story bible for "The Last Signal" | `story_bible.list` | ≥ 3 auto-extracted entries |
| VP10 | *(DB step, not chat)* inject `Maya Chen` → `Maya Chan` in ch3 | — | ch3 `content_text` altered (1 occurrence) |

## Out of scope for chat

**The Wasteland Wire** newsletter (marketing-copy.md §2) is seeded by **VP11** directly in the DB
(there is no chat/engine op to create a newsletter edition): it inserts the `newsletter_editions_v2`
row, 5 `newsletter_subscribers_v2` rows, and copies the post-apocalyptic genre's feeds into
`newsletter_feed_sources_v2` — the same result as the UI Setup Wizard's "Copy feeds from genre"
(`POST /api/newsletter/editions/:id/feeds/import-from-genre`). Idempotent (skips if the edition exists).

## Results (2026-07-02, DEV)

Full run: **VP01–VP09 pass, VP10 fixed**. "The Last Signal" seeded with an 8-chapter Hero's-Journey
outline; ch1–3 written (7827 / 5710 / 8284 words) and **all three approved**; cover art generated;
Story Bible auto-populated to **82 entries**; a deliberate ch3 name drift injected.

Two things the live run surfaced and fixed:
- **Engine fix** — "approve/publish **chapter N of** `<project>`" returned not-found because lifecycle
  matched the *project* title against the *chapter's* title (its own outline title). Now it resolves the
  project first and scopes by chapter number (commit `283f528`; same class as G18). Verified live.
- **Protagonist name** — the brainstorm *generates* the protagonist name, so the marketing-copy
  assumption of "Maya Chen" doesn't appear in the prose (this run produced **Mara Voss**). VP10 now
  targets the real protagonist (outline character #0) and swaps one occurrence for a scanner-detectable
  near-variant (e.g. `Mara → Meara`). If the demo needs the name to be exactly "Maya Chen", lock it in
  the brainstorm prompt / edit the outline before writing.

## Notes

- VP01 uses the engine's resolve-or-create-project path, so re-running finds the existing project
  rather than duplicating it. The chapter writes auto-populate the Story Bible (VP09) and are keyed on
  (project_id, chapter_number), so re-running overwrites rather than duplicating chapters.
- Chapter writes are slow (sub-chapter fan-out + research + drift QA); use `E2E_TIMEOUT=1500` so a cold
  first-chapter write doesn't false-fail on the poll window (jobs persist when they finish regardless).
- The deliberate ch3 drift (VP10) should be re-applied each demo day — the drift scanner stores results
  and may mark the row dismissed ([[marketing-copy]] §7).
