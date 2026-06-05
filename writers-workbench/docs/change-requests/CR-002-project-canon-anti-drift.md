# CR-002 — Project canon / anti-drift anchoring

| | |
|---|---|
| **Status** | In progress |
| **Opened** | 2026-06-05 |
| **Tier** | DEV only |
| **Depends on** | CR-001 (engine DB persistence) |

## Problem

Regenerating a project's outline drifted badly — a fresh `brainstorm story` produced a 63-chapter
outline for a project whose established (revised) outline was 96 chapters. Generation was not anchored
to the project's existing synopsis, cast, or scale, so each run could diverge.

## Goal

Pin every generation to a stable **project canon** so it cannot drift run-to-run: same synopsis, same
locked character roster, same target chapter count.

## Design

- **Story bible is the canon home for the high-level spec + characters.** Characters already live in
  `story_bible_v2`. Add ONE `entry_type=concept`, `name="Series Bible"` row holding the **synopsis +
  target chapter count + arc** — so the bible carries synopsis + characters + chapter count together,
  and the UI can show a "Series Bible" panel.
- **The full outline stays the single source of truth in `writing_projects_v2.outline`** (do not
  duplicate it into the bible — two copies can diverge).
- **Generation reads the anchors and honors them:**
  - `brainstorm story` accepts `target_chapter_count` + `locked_synopsis`; when a `project_id` is
    given it reads the project's existing `chapter_count` + `outline.premise` as the anchor and pins
    to them ("match the target chapter count exactly; keep the synopsis").
  - `chapter`/`revise` already read the locked character roster from the bible (CR-001) — keep that.

## Work items

- W1: `persist_canon` writes/updates the "Series Bible" synopsis entry whenever the outline is
  persisted (folded into `persist_outline`).
- W2: `brainstorm story` anchors to `target_chapter_count` + `locked_synopsis` (explicit or read from
  the project canon) and the prompt forbids deviating.
- W3: chapter persist uses the **outline chapter title** (not "Project — Chapter N").

## Acceptance

- Re-running `brainstorm story` on a project with an established 96-ch outline produces ~96 chapters
  (within tolerance), not a divergent count.
- `story_bible_v2` has a "Series Bible" entry with synopsis + chapter count for the project.
- Chapters persist with their outline titles (e.g. "Prologue: What the Ground Keeps").
