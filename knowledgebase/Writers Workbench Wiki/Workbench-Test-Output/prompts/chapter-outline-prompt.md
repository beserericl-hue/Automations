---
name: Chapter-outline prompt — The Burial Mound
description: How chapter outlines are produced — they are the chapters[] of the brainstorm outline
type: reference
tags: [workbench-test, prompts, chapter-outline, the-burial-mound]
---

# Chapter-outline approach — The Burial Mound

Chapter outlines are **not a separate LLM call** in the current engine — the brainstorm `story`
output's `chapters[]` array IS the chapter outline (each carries number, title, act, POV character,
`bridge_from_prior` weaving link, and scene beats). So the "chapter outline" artifact is the
chapters section of the brainstorm result (see `brainstorm-prompt.md`).

The existing project outline has **63 chapters**; first 12 for reference:
```text
- ch 0: The Recognition Testimony
- ch 1: The First Copper
- ch 2: The River's Gift
- ch 3: The Marriage Bundle
- ch 4: The Healer's Touch
- ch 5: The Three Sisters
- ch 6: The Trading Path
- ch 7: The Shell Roads
- ch 8: The Longhouse Rising
- ch 9: The Pottery Spirits
- ch 10: The Fire Keepers
- ch 11: The Bow's Song
```


> Optional deeper pass (not wired yet): expand a single chapter's beats via the brainstorm system
> prompt focused on one chapter + the `scene.event_list` seed. Flagged as a follow-up if you want
> per-chapter beat sheets beyond what the outline carries.
