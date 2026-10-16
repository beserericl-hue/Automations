---
name: Scene Construction, Pace, and Story Turns — Follett craft + engine prompts
description: Follett's scene-level rules — beginning/middle/end per scene, story turn every 4-6 pages, ups-and-downs diagramming, A/B/C story braiding — distilled into LLM directives for the chapter_step scene generator and the chapter_qa_step pace-drift checks.
type: concept
tags: [writing-craft, scenes, pace, story-turns, chapter, chapter-qa, follett]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf § 04, § 09, § 11
last_reviewed: 2026-05-31
---

# Scene Construction, Pace, and Story Turns

> "A story turn is anything — small or big — that changes the situation for the characters. There should be a story turn every four to six pages." [Follett § 04]

## Principles

1. **Every scene has a beginning, middle, end, and dramatic question.** This is non-negotiable. The beginning establishes hopes and fears for the POV character. The middle dramatizes them. The end is a partial resolution that introduces the next question. A scene without this shape is a passage of exposition pretending to be a scene.
2. **Story turn every 4-6 pages.** A story turn is anything that changes the situation: a death, a lie told, a discovery, a reversal, a confession, a new threat. Sub-4 pages = frenetic. Over-6 pages = drag. This applies to long-form genre fiction; Austen, Tolstoy, Trollope all hit roughly this cadence in their popular work.
3. **The best story turn escalates.** A small turn that grows worse as scenes pass is more powerful than a single big turn. A lie told in chapter 3 that becomes harder to maintain through chapter 7 and explodes in chapter 12 is gold.
4. **Pre-list the scene's events before writing prose.** Follett lists 7-10 atomic events per scene in his notes BEFORE drafting. Example: (1) Amos talks to his mother, (2) goes to Methodist Hall, (3) Jane is there and looks fabulous, (4) crowd of beaus around her, (5) Amos resolves to act, (6) Jane rejects him, (7) Amos walks away. The prose comes from this list, not the other way around.
5. **Ups-and-downs diagramming.** For long scenes (Pauline Green at the diplomats' ball in *Never*), mark each event with an up-arrow or down-arrow for the POV character's mood. Reshuffle to create a wave — never two ups in a row or two downs in a row without break. The wave is what keeps reader interest alive over 10+ pages.
6. **No "lists of changes to make later."** When something needs fixing, fix it immediately. Lists grow, detail is forgotten, and downstream consequences pile up. (Follett's practice — and the inverse of what most pantsers do.)
7. **Read yesterday's pages every morning.** Always improve them. This gets you back in the zone AND catches problems while they're cheap to fix.
8. **Description does two jobs.** It paints a picture AND tells you something about character / mood / consequence. "Brown eyes and brown hair" is the worst possible description. "Her beautiful blonde hair was very carefully arranged" tells you she's fussy. The Russian general tapping ash into the Ming vase tells you everything about him and the foreign minister at once.
9. **Information delivered as drama, never as exposition.** The gun-and-safety-catch scene in *Lie Down With Lions* is the model: the heroine learns about the gun in the moment she needs to use it. Five dull pages of weapons exposition become a tense character scene with the same information.
10. **Switching POV mid-novel.** A/B/C story structure (TV writing): A is the main thread, B is a subplot of a different emotional register, C is light relief or counterpoint. Use B to give the reader respite from A's intensity. Switch when the storyline demands it — never whimsically.
11. **End every scene with a hook for the next, especially across POV switches.** If the next scene shifts to a new POV, the LAST LINE of this scene must create urgency that propels the reader through the switch.
12. **A grim scene is fine. A grim book is not.** Even Cormac McCarthy's *The Road* has tender moments. The wave of ups and downs scales up from scene to chapter to novel.

## Prompt fragments for the engine

### `follett_seeds.scene.event_list_first`

For `chapter_step` BEFORE generating scene prose. Mandatory pre-step.

```text
Before writing any prose for this scene, generate a numbered list of 5 to 10 atomic events that will happen in it. Each event is a discrete action or moment, not a paragraph of writing. Example for a romantic confession scene:

1. Amos asks his mother about when she started walking out with his father (sets up the custom + his state of mind).
2. Amos arrives at the Methodist Hall.
3. Jane is there, beautifully dressed.
4. A small crowd of other young beaus already surrounds her.
5. Amos hates his friend Rupert, who has Jane's attention.
6. Amos makes up his mind to ask.
7. He asks "Would you walk out with me?"
8. Jane rejects him, explaining she wants a life of parties and dresses.
9. Amos walks away, miserable.

Each event must be specific and concrete. Avoid: "Amos feels conflicted" (abstract) or "Amos and Jane talk" (vague). Use: "Amos asks the question, Jane gives a specific answer."

Now generate the list for THIS scene. Number each event. State the POV character at the top. State the scene's dramatic question (the one that hooks the reader from beginning to end) below the POV line.

DO NOT WRITE PROSE in this step. Prose comes after the list is approved.
```

### `follett_seeds.scene.ups_and_downs_diagram`

For `chapter_step` on long scenes (8+ events).

```text
This scene has 8 or more events and runs the risk of monotony. After listing the events, mark each with an arrow showing the POV character's mood-shift:

↑ — up (a win, a hope, a positive surprise)
↓ — down (a setback, a fear realized, a humiliation)
→ — neutral or transitional

Now examine the sequence. Two ups or two downs in a row without break flatten the wave and lose reader interest. Reshuffle the events (within plausibility) so the pattern alternates: e.g. ↑↓↑↓↑↑↓ rather than ↑↑↑↓↓↓.

The Pauline Green diplomats' ball scene in Follett's Never is the model: arriving optimistic ↑, can't find the Saudi ambassador ↓, runs into the French ambassador who supports her ↑, the fired official she didn't want to see appears ↓, the Saudi ambassador finally arrives and refuses her ask (big) ↓↓, she gives her speech well and leaves ↑. Wave intact, scene satisfying despite the bad news at its core.

Now return the re-sequenced event list with arrows.
```

### `follett_seeds.scene.beginning_middle_end_check`

Self-validation for `chapter_step` BEFORE returning a generated scene.

```text
Before returning this scene, validate it against the three required components:

1. BEGINNING — establishes the POV character's hopes AND fears entering the scene. The reader knows what could go well and what could go badly. If the beginning is just "Sarah walked into the room," it's failed — restart.

2. MIDDLE — dramatizes the hopes and fears through action, dialogue, or decision. Not exposition. Not internal monologue alone (a small amount is fine; the middle cannot be entirely interior). Things must HAPPEN.

3. END — a partial resolution. Some hopes are fulfilled, some fears realized, some questions remain. The end MUST raise a new question that propels the reader into the next scene. If the end concludes everything, this scene is the climax — confirm that's intentional or revise.

If any of the three fails, restart. Do not return a scene without all three.
```

### `follett_seeds.scene.story_turn_density_check`

Self-validation for `chapter_step` at the chapter level.

```text
Count the story turns in this chapter. A story turn is anything that changes the situation for the characters — a death, a lie told, a discovery, a reversal, a confession, a new threat, a relationship shift, a power change. Internal realizations count only if they lead to action.

Target: ONE story turn per 4-6 pages of draft. Below that = drags. Above = frenetic.

If this chapter is 18 pages, you want 3-5 story turns. If you have only 1, the chapter is too soft — invent more story (existing cast, not new characters). If you have 8, the chapter is overcaffeinated — promote the most resonant 4-5 turns and demote or remove the others.

List each story turn in this chapter with the page it occurs on. State whether the density is within target. If not, revise.
```

### `follett_seeds.scene.escalating_turn_recommendation`

For `brainstorm_step` and `chapter_step` when planting future story turns.

```text
The best story turn is one that escalates — starts small and gets worse with each subsequent scene. A character tells a small lie in chapter 3 to avoid embarrassment. In chapter 5, they must maintain the lie. In chapter 8, the lie causes someone to make a wrong decision. In chapter 12, the lie is discovered with consequences far worse than the original embarrassment would have been.

When you introduce a small story turn that COULD escalate (a lie, a hidden weakness, a secret debt, a misplaced trust, a borrowed item not returned), explicitly note in the outline:
- Where it starts (small)
- Where it must reappear with greater pressure
- Where it explodes (the chapter where the escalation pays off)

This is the highest-ROI story-turn architecture. Use it for at least one major thread per novel.
```

### `follett_seeds.scene.information_as_drama`

Append to `chapter_step` prose generator whenever exposition is needed.

```text
This scene must convey a piece of information the reader needs to understand the plot (technical detail, historical fact, character backstory, world rule). Do NOT deliver this information as exposition — even one paragraph of pure exposition risks losing the reader.

Instead, embed the information into a moment of DRAMA where a character LEARNS or NEEDS the information at the exact moment the reader does. The model is Follett's Lie Down With Lions: the gun's safety catch is explained when the heroine is told to shoot a prisoner with a gun she's never held — the CIA agent's instruction ("the safety catch is here") IS the exposition.

Patterns:
- A character must teach another character because of the immediate situation.
- A character realizes a thing about their own past in the moment that thing becomes relevant.
- A character reads a document that contains the fact, but reads it while something dangerous is happening.
- A character argues with another about the fact, and the argument is itself the drama.

If you cannot find a way to embed the information dramatically, you may not have a real scene — you may have an exposition dump masquerading as one. Revise the scene's design.
```

### `follett_seeds.scene.description_does_two_jobs`

Append to every description-heavy block in `chapter_step` prose.

```text
Every description in this scene must do TWO jobs at once:

1. Paint a picture the reader can see in their mind. Specific, sensory, vivid. Avoid generic adjectives ("nice," "old," "interesting").
2. Tell the reader something about character, mood, power, or consequence. The HOW of the description carries meaning beyond the WHAT.

Examples:
- "She had beautiful blonde hair" — does one job.
- "Her beautiful blonde hair was very carefully arranged" — does two: paints the picture AND tells you she's fussy / vain / under pressure to look perfect.
- "There was a Ming vase on the desk" — does one job.
- "The foreign minister had only one object on his desk — a priceless Ming vase. The Russian general sat down, lit a cigarette, and tapped ash into it" — does two: paints the picture AND tells you everything about the power dynamic and the general's contempt.

If a description does only one job, rewrite or cut. Two jobs per description is the standard.

Avoid: "brown eyes and brown hair" character descriptions. Avoid: cataloguing what people are wearing unless the clothes are doing dramatic work.
```

### `follett_seeds.scene.pov_switch_bridge`

For `chapter_step` when transitioning between POV characters mid-chapter or chapter-to-chapter.

```text
The next scene shifts to a different POV character. To prevent the reader from feeling they've started a new book:

1. The LAST LINE of the current scene must create urgency, a question, or a consequence that the NEW POV scene will engage with.
2. The OPENING of the new POV scene must explicitly carry forward the thread — through information, consequence, character travel, or a shared deadline.
3. The new POV character must have been mentioned (even briefly) in earlier text, or must be in a situation directly caused by the prior scene.

Forbidden bridge:
"Meanwhile, in [different city], [completely new character] was doing [completely unrelated thing]."

Acceptable bridges:
- "Meanwhile, [character mentioned 30 pages ago] received the message [that the prior scene sent]."
- "[New POV character] was the only person who could verify [the discovery from the prior scene]."
- "The phone call [the prior POV character made at the end of the scene] reached [new POV character] in [setting]."

Name the bridge before writing the new scene. If you cannot, the structural design has gone wrong — restart.
```

### `follett_seeds.scene.no_pending_fix_list`

A meta-directive that affects HOW the engine processes corrections.

```text
When you notice something that needs fixing in this scene — a continuity break, a tone mismatch, a character acting out-of-character, a factual slip — FIX IT NOW in this draft, not in a list of corrections to apply later.

Lists of pending fixes grow. Detail is forgotten. Downstream scenes get written on top of unfixed problems. The cumulative cost of deferred fixes is always higher than the immediate cost of fixing as you find.

Exception: if a fix requires restructuring an earlier chapter that's already in the manuscript, queue it as a structural change for the next revision pass — but flag it explicitly with a TODO at the change point, never silently.
```

## Examples from Follett

- **Amos asks Jane (The Armour of Light)** — 7-event scene list, simple structure (beginning: hopes + fears, middle: the dramatic ask, end: rejection + new question = how will Amos respond). Model for compact dramatic scenes.
- **Pauline Green at the diplomats' ball (Never)** — 10+ events in a single scene, ups-and-downs diagrammed: starts optimistic, multiple political conversations, fired-official sighting, Saudi rejection, recovery via speech. Model for sustained long scenes.
- **Lie Down With Lions gun scene** — the canonical "information as drama" example. Heroine learns about the safety catch in the moment she needs to use it.
- **The Pillars of the Earth middle** — Alfred takes over from Tom Builder, ceiling collapses, Aliena marries the wrong person, builders strike, monks run out of money. Four BIG fresh story turns, all with existing cast.
- **The Da Vinci Code opening** — the gorgeous assistant hands the American her phone and says "This call is for you" — at which point the call is from her, warning him to leave. The reader's assumptions are blown up by page 5. Story turn density at maximum from line 1.

## Engine integration

| Prompt fragment | prompt_store key | Consumed by | When |
|---|---|---|---|
| event_list_first | `follett_seeds.scene.event_list` | chapter_step | Mandatory pre-step before scene prose |
| ups_and_downs_diagram | `follett_seeds.scene.ups_and_downs` | chapter_step | Long scenes (8+ events) |
| beginning_middle_end_check | `follett_seeds.scene.bme_check` | chapter_step | Self-validation before return |
| story_turn_density_check | `follett_seeds.scene.turn_density` | chapter_step + chapter_qa_step | Chapter-level pace validation |
| escalating_turn_recommendation | `follett_seeds.scene.escalating_turn` | brainstorm_step | Outline planning of major threads |
| information_as_drama | `follett_seeds.scene.info_as_drama` | chapter_step | Whenever exposition is needed |
| description_does_two_jobs | `follett_seeds.scene.description` | chapter_step | Description-heavy passages |
| pov_switch_bridge | `follett_seeds.scene.pov_bridge` | chapter_step | POV transitions |
| no_pending_fix_list | `follett_seeds.scene.fix_now` | chapter_step | Meta-directive on revision behavior |

`chapter_qa_step` should run the story_turn_density_check on every generated chapter. Threshold for flagging: <1 turn per 8 pages OR >1 turn per 3 pages. Either fails parity.

Drift-scan parity test: the byte-equal drift-scan algorithm (per F1-A research) should also be augmented with a "pace-drift" check that fires when scene event counts deviate from outline expectations by >40%.

## See also

- [[character-development]] — who's in the scene and whose POV we follow.
- [[plot-and-narrative-structure]] — chapter-level structure under which scenes nest.
- [[prose-style-dialogue-set-pieces]] — how scenes are written sentence-by-sentence.
- [[_index]] — Writing Craft index.
