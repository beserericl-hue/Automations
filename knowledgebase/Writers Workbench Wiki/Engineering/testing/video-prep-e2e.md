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

**The Wasteland Wire** newsletter edition (marketing-copy.md §2, "Demo newsletter to seed") is created
through the Newsletter **Setup Wizard** (UI) — feed import, subscribers, cadence. There is no
engine/chat op for creating a newsletter edition, so it must be seeded by hand in the DEV Workbench.

## Notes

- VP01 uses the engine's resolve-or-create-project path, so re-running finds the existing project
  rather than duplicating it. The chapter writes auto-populate the Story Bible (VP09) and are keyed on
  (project_id, chapter_number), so re-running overwrites rather than duplicating chapters.
- The deliberate ch3 drift (VP10) should be re-applied each demo day — the drift scanner stores results
  and may mark the row dismissed ([[marketing-copy]] §7).
