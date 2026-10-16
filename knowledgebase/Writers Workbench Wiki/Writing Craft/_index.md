---
name: Writing Craft — Index
description: Writer-craft principles + LLM prompt fragments distilled from Ken Follett's BBC Maestro course "Writing Bestselling Fiction." Source material for the Python engine's prompt_store; the chapter / brainstorm / research step services compose prompts from these fragments to keep generated output aligned with bestseller-craft principles.
type: index
tags: [writing-craft, prompts, follett, prompt-engineering, source]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf
last_reviewed: 2026-05-31
permission_to_use: granted by author (Ken Follett / BBC Maestro)
---

# Writing Craft

Operational distillation of Ken Follett's BBC Maestro course **Writing Bestselling Fiction** (Course Notes 2.2) into:

1. **Principles** — the rules Follett teaches, restated as imperatives our generation pipeline can follow.
2. **Prompt fragments** — copy-paste-ready LLM directives derived from the principles, in fenced code blocks, ready to be dropped into `engine/packages/writer_engine/src/writer_engine/prompt_store/follett_seeds/` and composed by the `chapter_step`, `brainstorm_step`, and `research_step` services.
3. **Examples from Follett's own work** — citations from the course notes for grounding and parity reference.
4. **Engine integration notes** — which prompt-store key each fragment maps to and which step service consumes it.

## Attribution and permission

Ken Follett gave permission for these excerpts and distillations to be used inside the Writers Workbench platform on 2026-05-31. The course notes (a PDF distributed by BBC Maestro) are the source of every principle on these pages; quotations are cited inline as `[Follett § <lesson>]`. The course itself is at <https://www.bbcmaestro.com> and remains the authoritative source — when in doubt, defer to it.

These pages are NOT a redistribution of the course. They are an operational layer that lets our generation pipeline follow Follett-aligned craft rules without re-reading the PDF every time. The full course notes live, gitignored, at `KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf` — do not commit that file to the repo.

## Pages

- [[character-development]] — Broad strokes + twist, point-of-view discipline, the 3-layer character lock, moral complications, "no milk-and-water characters." Drives `brainstorm_step` (character creation) + `chapter_step` (in-scene character behaviour).
- [[plot-and-narrative-structure]] — Dramatic question, 50-100 scenes per novel, weaving multiple storylines without breaking the thread, the soggy middle, the heightened ending. Drives `brainstorm_step` (story outline) and `chapter_qa_step` (structural drift checks).
- [[scene-pace-and-story-turns]] — Story turn every 4-6 pages, beginning/middle/end per scene, ups-and-downs diagramming, switching POV without losing the thread. Drives `chapter_step` (per-scene write) and the drift-scan in `chapter_qa_step`.
- [[research-and-local-color]] — Research feeds the outline; setbacks become opportunities; throw research away; period-appropriate detail at the moment the character needs to know it. Drives `research_step` (Perplexity + synthesis) and `chapter_step` (local-color integration).
- [[prose-style-dialogue-set-pieces]] — Transparent prose, Anglo-Saxon over Latin, dialogue without parodied accent, first-line that hooks, sex/violence as the physical expression of emotional history. Drives `chapter_step` prose generation + first-chapter generator + set-piece scenes.

## How the engine uses these

Each page's "Prompt fragment" sections produce file-level prompt seeds. The `prompt_store.follett_seeds.*` namespace is reserved for them. A typical chapter_step call composes:

```
system_prompt = (
    prompt_store.get("follett_seeds.prime_directive")
    + prompt_store.get("follett_seeds.character_lock")          # if revision
    + prompt_store.get("follett_seeds.scene_construction")
    + prompt_store.get("follett_seeds.prose_style.transparent")
    + genre_specific_block(genre_slug)
)
user_prompt = prompt_store.get("follett_seeds.sub_chapter_user_template").format(...)
```

The L5 parity rubric for each module includes a "Follett-alignment" dimension that checks the output against the principles on the corresponding page.

## Hard rules (the Prime Directive, distilled)

These are the load-bearing rules. Every other prompt fragment composes on top of them.

> "There's no formula for writing a bestseller, but there is that one simple rule: the reader must share in the emotions of the characters in the story." [Follett § 01]
>
> "Story matters more than character and story is driven by structure — within each scene, scene to scene, and overall." [Follett § 02]
>
> "If you want to write a popular bestseller, you can't have boring bits." [Follett § 03]
>
> "Every scene has a beginning, middle and end, and a dramatic question that will drive the reader through the scene." [Follett § 09]
>
> "There should be a story turn every four to six pages." [Follett § 04]

These five sentences are the [[character-development|character]], [[plot-and-narrative-structure|plot]], [[scene-pace-and-story-turns|scene]], [[research-and-local-color|research]], and [[prose-style-dialogue-set-pieces|prose]] pages in compressed form. The engine's `follett_seeds.prime_directive` prompt is exactly these five sentences.

## See also

- [[engine-framework]] — program-level architecture of the Python engine.
- [[engine-framework-sprints]] — F1-A port plan for the chapter / brainstorm / research step services.
- [[f1a-decisions]] — model lineup, rate limits, format-kindle correction.
- [[chapter-writer-architecture]] — current chapter pipeline in n8n, target architecture in Python.
