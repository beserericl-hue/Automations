---
name: Plot and Narrative Structure — Follett craft + engine prompts
description: Follett's structural rules — dramatic question, 50-100 scenes, multi-strand weaving, soggy middle, heightened ending — distilled into LLM directives for the brainstorm_step outline generator and the chapter_qa_step structural drift checks.
type: concept
tags: [writing-craft, plot, outline, structure, brainstorm, chapter-qa, follett]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf § 02, § 03, § 04, § 06, § 11
last_reviewed: 2026-05-31
---

# Plot and Narrative Structure

> "I sometimes think of the novel in terms of fractals. A novel has a beginning, middle and end, but within that overarching structure, each chapter also has a beginning, middle and end, and so too does each scene in each chapter, and even each paragraph." [Follett § 06]

## Principles

1. **Start with a single dramatic question.** Every novel begins with one. *Pillars of the Earth*: how did they build cathedrals, and why? *Eye of the Needle*: what if one German spy discovered the D-Day deception? *Never*: how does a nuclear war begin? The question must be answerable only by reading the whole book.
2. **Scene count, not word count.** An idea is a novel-grade idea only if it generates **50–100 dramatic scenes**. Two or three scenes' worth is a short story. The outline's first job is to test this — if you can't get past 30 scenes, the idea is short fiction.
3. **Anchor to a bigger world event when possible.** A character story attached to a war, a cathedral build, a revolution, a financial collapse, an exploration era — readers feel they're learning something AND following people they care about. "Readers are 'knowledge seekers'." [Follett § 02]
4. **Fractal structure.** Novel, part, chapter, scene, paragraph — every level has a beginning, middle, end, and a dramatic question. Drift at any level is the same failure mode at a different zoom.
5. **No boring bits.** Every page must do dramatic work. Information that must be conveyed gets folded INTO drama by giving the character something to worry about or strive after while the info comes out. The gun-and-the-safety-catch scene in *Lie Down With Lions* is the canonical example: the heroine *learns about the gun in the moment she needs to use it*.
6. **Multi-strand weaving requires unbroken thread.** When switching between groups of characters, the storyline must connect — the information from group A's scene must drive what group B does in the next scene. Switching groups whimsically with no link reads to the reader as "starting a new book."
7. **Introduce POVs slowly.** Never dump a cast roster. Use the storyline thread to bridge each new POV's first appearance. (See [[character-development]] § rule 7.)
8. **Story turn every 4–6 pages.** A story turn is anything — small or big — that changes the situation for the characters. (See [[scene-pace-and-story-turns]] for full treatment.)
9. **Beware the soggy middle.** Middles fail because authors set up tensions, know the ending, and can't invent enough complications between. Solution: identify the dragging scene, invent MORE STORY about the same people (not new characters — that's a creative failure mode). Five more dramatic things must happen to the cast you already have.
10. **Heighten the ending.** A satisfying ending is good; a heightened ending is great. Triple the impact by spreading the consequences across multiple characters with different emotional investments — the obsessed hero, the wronged secondary character, the second villain who knows they're next.
11. **Watch out for the ponderous ending.** Once the central question is answered, the drama is over. Tying up loose ends *after* the climax is boring. Resolve subordinate threads BEFORE the climax. (Follett's mistake with *Triple*: a Rostov scene after the ship docked, when readers no longer cared.)
12. **The wow factor.** What makes this story stand out from other stories in its genre? Hannibal Lecter EATS people. Forsyth's Jackal teaches you to forge a passport. *Da Vinci Code* commits blasphemy with cherished figures. Each novel needs one unique-selling-point hook — find it before writing.

## Outline scale (Follett's process)

His own outlines for full historical novels reach **20–30 typed pages** before draft 1 starts. *The Evening and the Morning* outline is 30 pages. *Fall of Giants* outline went through ~7 versions. The outline includes character bios, hopes/fears, chapter-by-chapter scene list, and explicit dramatic questions per chapter. **The outline is a condensed novel.**

For the engine: a brainstorm_step output that's less than 5 pages of dense outline for a full novel is too thin. For a chapter, less than 1 page is too thin.

## Prompt fragments for the engine

### `follett_seeds.plot.dramatic_question_generator`

For `brainstorm_step` at the very beginning of a new project.

```text
A novel needs ONE dramatic question that drives the entire book. It must satisfy ALL of:

1. It can be stated in one sentence.
2. It is answerable only by reading the whole novel.
3. It generates 50 to 100 distinct dramatic scenes when expanded.
4. It is grounded in something concrete (a war, a building, a crime, a journey, a discovery, an institution) — not an abstract theme like "what is love."
5. It is the kind of question a reader would tell a friend about ("I'm reading this book about how the cathedrals were built").

Generate THREE candidate dramatic questions for the requested genre and premise. For each:
- State the question in one sentence.
- Estimate how many scenes it generates (give a range, e.g. 60-80).
- Name the bigger world event or institution it can be attached to.
- Name the wow factor — what makes THIS dramatic question unique vs. others in the genre.

Reject any candidate that fails any of the 5 criteria. If all three candidates fail, regenerate.
```

### `follett_seeds.plot.outline_quality_gate`

For `brainstorm_step` to validate an outline before returning it.

```text
You have produced an outline for this novel. Before returning it, score it against these criteria. If it fails any, regenerate and try again. Do NOT return a failing outline.

1. SCENE COUNT: Count the distinct dramatic scenes (not chapters — scenes within chapters). The total must be between 50 and 100 for a novel-length work. If under 50, the idea is short fiction; add more cast and complications. If over 100, the book will sprawl; consolidate.

2. DRAMATIC QUESTION: Can the central question be stated in one sentence? Is it referenced (directly or via consequence) in every chapter? If not, the outline is unfocused.

3. CHAPTER 1 GRIP: Does chapter 1 end with the reader fully committed to reading the next chapter? If not, the opening is too gentle.

4. STORY TURN DENSITY: For chapters 1-3 and the final 2 chapters, list the story turns. There should be at least one per 4-6 pages of intended draft length.

5. SOGGY MIDDLE CHECK: Look at the middle third of chapters. For each, what NEW dramatic situation arises in this chapter that wasn't set up before? "Nothing new, but moves toward the resolution" is a fail. Each middle chapter must add a fresh dramatic complication for the existing cast.

6. WOW FACTOR: State the unique selling point in one sentence. If you cannot, the book is generic — invent one.

7. POV DISCIPLINE: Count POV characters. 2-6 is acceptable. 1 is fine but limits scope. 7+ confuses readers.

8. ENDING HEIGHTENED: Does the ending impact 3+ major characters with different emotional stakes? Or only the protagonist? Single-character resolutions are flatter than multi-character resolutions.

If all 8 pass, return the outline. Otherwise, list which failed and revise.
```

### `follett_seeds.plot.scene_count_per_chapter`

A small fragment used by `brainstorm_step` when deciding chapter granularity.

```text
Aim for 3 to 8 distinct dramatic scenes per chapter. A scene change is a shift of time, place, or POV. A scene contains: (a) a dramatic question, (b) hopes and fears for the POV character, (c) a beginning-middle-end, (d) a partial resolution that introduces the next question.

A chapter with 1-2 scenes is a vignette; only use this for opening/closing chapters or moments of high focus. A chapter with 10+ scenes feels scattered.
```

### `follett_seeds.plot.weaving_unbroken_thread`

For `brainstorm_step` when constructing multi-POV outlines.

```text
When this outline switches between groups of characters or POVs, the storyline thread MUST remain unbroken. Apply this rule:

- The scene that immediately follows a POV switch must use INFORMATION or CONSEQUENCES from the prior scene. Example pattern: scene 1 = CIA agent Tamara receives intel from contact Abdul; scene 2 = Abdul (new POV) acts on the intel he just gave; scene 3 = US President (new POV) reacts to the intel that traveled from Tamara via Abdul.
- Never switch to a new POV at the start of a chapter and have them in a completely disconnected situation with no link to what just happened. This reads as "starting a new book."
- The thread can be: information, character travel, a phone call, a consequence, a deadline. Not: "meanwhile, in a different city, completely different characters were doing different things."

For each POV switch in this outline, name the thread that bridges it. If you cannot name a thread, restructure.
```

### `follett_seeds.plot.middle_chapter_anti_sog`

For `brainstorm_step` when generating the middle third of an outline.

```text
You are writing the middle of this novel. Soggy middles are the #1 failure mode of long-form fiction. To avoid one:

For each middle chapter, invent at least ONE of the following that did NOT exist in the setup:
- A new dramatic problem for the EXISTING cast (do not introduce new POV characters to manufacture middle drama — that's a creative failure).
- A serious setback to the protagonist's plan that requires real adaptation, not just inconvenience.
- A reveal about an existing character's past that changes how other characters relate to them.
- A consequence of an earlier choice that the reader didn't see coming but, in retrospect, was inevitable.
- A new piece of information that recasts the dramatic question.

Forbidden in the middle: chapters that only restate the dramatic question, chapters that only advance one logistical step, chapters whose only function is to move characters geographically.

Pillars of the Earth example for reference: in the middle, Alfred takes over from Tom Builder and the ceiling collapses; Aliena marries the wrong person; the builders go on strike; the monks run out of money. Four BIG new dramas, none requiring new cast.
```

### `follett_seeds.plot.heightened_ending`

For `brainstorm_step` when generating the final act.

```text
The ending must be heightened — its impact spread across multiple characters with different emotional stakes, not concentrated on the protagonist alone.

To heighten the climax of this novel:
1. State the central resolution that answers the dramatic question.
2. Identify THREE characters whose lives are materially changed by this resolution. They must have different emotional investments — the obsessed hero, the wronged secondary character (a relative, a friend), and ideally an antagonist or rival whose own fate hinges on the outcome.
3. For each of the three, write one sentence on what the resolution costs them or grants them. The costs/grants must differ in kind, not just degree.
4. The climactic scene should show the resolution from the POV of the character with the highest emotional stake (per the POV selector rule), but its consequences must reach the other two within the same or adjacent scenes.

Avoid the ponderous ending: any subplot that needs tidying up should be RESOLVED BEFORE the climactic scene, not after. After the central question is answered, the drama is over; readers won't tolerate a long denouement.
```

### `follett_seeds.plot.wow_factor_finder`

For `brainstorm_step` to ensure every project has a unique selling point.

```text
Every bestseller has a wow factor — the one element that makes the book stand out from its genre peers. Examples:

- Thomas Harris: Hannibal Lecter doesn't just kill, he EATS.
- Frederick Forsyth (Day of the Jackal): teaches the reader, in correct detail, how to forge a passport and adjust a rifle sight.
- Dan Brown (Da Vinci Code): treats sacred religious figures and great artists as ordinary people involved in conspiracy. Calculated blasphemy.
- Ken Follett (Pillars of the Earth): a 1000-page novel about building a cathedral, with brutal medieval realism rather than romanticized knights.

For THIS project, name the wow factor in ONE sentence. It must be:
(a) Specific and concrete, not abstract ("compelling characters" is not a wow factor).
(b) Unusual within the genre.
(c) Something a reader will mention when describing the book to a friend.
(d) Defensible to a publisher's marketing team in one breath.

If you cannot produce one, generate three candidate wow factors and select the strongest. If none of the three are strong, the project's premise needs reworking — say so explicitly.
```

## Examples from Follett

- *The Pillars of the Earth* — dramatic question: "how were the cathedrals built?" → 50-year story, 800+ pages, hundreds of scenes. Multiple intertwining storylines: builder Tom, prior Philip, knight Jack, lady Aliena, villain William Hamleigh. The unbroken thread = the cathedral itself, which every character's destiny revolves around.
- *Never* — dramatic question: "how does a nuclear war begin?" — political thriller across Chad, Beijing, White House. Thread = the intelligence Tamara collects from Abdul, which travels into political decisions in Washington and Beijing. POV switches always carry the intel forward.
- *Eye of the Needle* — dramatic question: "what if a German spy discovered the D-Day deception?" — Wow factor: realistic depiction of the wartime British countryside + a strong female lead in an outdoor adventure thriller (genre-first at the time).
- *Fall of Giants* — multi-volume saga; Follett needed more babies in Volume 1 because Volume 2 needed populating across five families. The outline math drives the plot math.

## Engine integration

| Prompt fragment | prompt_store key | Consumed by | When |
|---|---|---|---|
| dramatic_question_generator | `follett_seeds.plot.dramatic_question` | brainstorm_step | New project / story brainstorm |
| outline_quality_gate | `follett_seeds.plot.outline_gate` | brainstorm_step | Self-validation before returning outline |
| scene_count_per_chapter | `follett_seeds.plot.scene_density` | brainstorm_step | Chapter granularity decisions |
| weaving_unbroken_thread | `follett_seeds.plot.weaving` | brainstorm_step | Multi-POV outlines |
| middle_chapter_anti_sog | `follett_seeds.plot.anti_sog` | brainstorm_step | Generating middle act |
| heightened_ending | `follett_seeds.plot.heightened_ending` | brainstorm_step | Generating final act |
| wow_factor_finder | `follett_seeds.plot.wow_factor` | brainstorm_step | Story-level brainstorm |

L5 parity check for `brainstorm_step` outline output: scene count between 50-100 (±10%), every chapter has a dramatic question stated in the outline, POV switches all have named bridges, middle third has fresh dramatic complications, wow factor is stated.

`chapter_qa_step` structural drift check: every N chapters during a long generation, run the outline_quality_gate against the actual generated content and flag drift if the running scene count is off-pace or the dramatic question is no longer being advanced.

## See also

- [[character-development]] — the cast that serves the plot.
- [[scene-pace-and-story-turns]] — scene-level structure under the chapter-level structure here.
- [[research-and-local-color]] — research feeds the outline; this page is what research is feeding.
- [[_index]] — Writing Craft index.
