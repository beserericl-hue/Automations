---
name: Character Development — Follett craft + engine prompts
description: Follett's character-building rules distilled into LLM directives. Drives the brainstorm_step character generator and the chapter_step in-scene character behaviour, including the 3-layer character lock that prevents revisions from drifting into new cast members.
type: concept
tags: [writing-craft, characters, prompts, brainstorm, chapter, follett]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf § 10, § 03, § 04
last_reviewed: 2026-05-31
---

# Character Development

> "Memorable characters need to be just a little larger than life. Not too much — just enough." [Follett § 10]

## Principles

1. **Story first, then character.** Decide what kind of person would do the thing the plot requires, then build them backwards. Don't start with character and hunt for a plot.
2. **Broad strokes, then twist.** Start with handsome / smart / kind / brave / cruel and immediately add one off-axis attribute that complicates the cliché. A smart person who is dumb about people. A beautiful woman who isn't conventionally beautiful but has terrific allure. A tough-guy hero who's afraid of snakes (Indiana Jones).
3. **No milk-and-water characters.** Principal characters must be the kind of person who gets into trouble. Cautious people who let life flow by are not bestseller material. Even victims must struggle and resist — the reader needs something to admire.
4. **Every important character has a life outside the plot.** They do things that have nothing to do with the cathedral / war / heist. They have people they hang out with just because they like them. They have a job, even if their job is not the story. This makes them feel real instead of plot-functional.
5. **Get the reader to care.** The single test for whether character work is succeeding: does the reader emotionally side with this person? A character is "loved" when someone else in the story loves them — let other characters do the work the author would otherwise have to do directly.
6. **POV discipline.** 2–6 point-of-view characters per novel, max. When two POV candidates are present in the same scene, pick the one who **cares most** about what's happening. POV characters are the eyes the reader sees through; secondary characters can be described from outside.
7. **Slow reveal of POV cast.** Never dump a roster in chapter one. Introduce POV characters one at a time, and only after the reader has fully met each one. Use a continuous storyline thread to bridge the introduction of each new POV (Follett's *Never* introduces Tamara, then Abdul, then the President this way — the *information* connects them across the chapter switch).
8. **Bad guys are easy, good guys are hard.** Bad guys just need more mean things to do in line with their character. Good guys need an eccentricity, hobby, contrast, or failing that humanises them — otherwise "intelligent, kind, brave" reads as dull. (Poirot's vanity. Adam Dalgleish's poetry.)
9. **Moral complications are gold.** A heroic character tempted to do something shabby is more interesting than one who never wavers. Whether they succumb or resist, *how they feel afterwards* adds depth. The best moral dilemmas have the reader unsure what the character *should* do.
10. **Characters can change over the course of the novel.** A stiff-necked person can become a campaigner. A sweet boy can become a selfish rotter. Consistency means tracking the arc, not freezing the person at page 1.

## The 3-layer character lock (revision mode only)

Follett doesn't name this — but it's the engine's existing protection (from MEMORY.md) against revision drift, and it maps cleanly to his "consistency" principle. When `brainstorm_step` or `chapter_step` runs in **revision mode** (rewrite of an existing outline / chapter), the locked-character roster is the load-bearing input. Three layers:

1. **LOCKED CHARACTERS section** — list every existing character with name + role + key traits at the top of the prompt.
2. **Copy-first rule** — instruct the LLM to copy the existing roster verbatim into its output before doing any additions or changes.
3. **FINAL CHECK** — the prompt's last line asks the LLM to verify it has not invented new characters or altered existing ones; if it has, restart.

This survived multiple Gemini and Sonnet model upgrades. Do not remove any layer.

## Prompt fragments for the engine

### `follett_seeds.character.broad_strokes_then_twist`

For `brainstorm_step` when generating a new POV character.

```text
Generate a character for this story who would plausibly do what the plot requires of them. Follow these rules:

1. Pick the obvious archetype that the plot needs (the soldier, the spy, the priest, the heiress, the rebel). State it in one sentence.
2. Immediately add ONE off-axis attribute that complicates the cliché. The smart one is dumb about people. The strong one is neurotic about something small. The kind one has a casual cruelty when crossed. Make this twist specific and surprising, not generic.
3. They MUST be a person who gets into trouble. Cautious, agreeable, life-flows-by personalities are forbidden as POV characters — they cannot drive a bestseller. Even quiet characters must have a strong inner pressure that will explode under stress.
4. Give them a life outside the plot: a job that may not appear in the story, a hobby, a friend they like for no plot reason, a private worry. Three to five lines.
5. State the dramatic question that follows them through the book — the one their entire arc resolves. ONE sentence.
6. State what would humiliate them, terrify them, and make them happy. ONE sentence each.

Forbidden: "blonde hair and brown eyes" descriptions, "kind but firm" character summaries, anyone who is good at everything, anyone whose only role is to suffer.
```

### `follett_seeds.character.life_outside_plot`

A short directive appended to every character generator output to enforce rule 4.

```text
Before finalizing this character, list three things they do in their life that have NOTHING to do with the events of this plot. These are activities, relationships, or preoccupations the reader will never see in scene but that exist in the character's life. Cite them once each in passing during the manuscript — never in detail, just as the texture of a real life lived alongside the events of the story.
```

### `follett_seeds.character.pov_selector`

For `chapter_step` when a scene has multiple candidate POV characters present.

```text
Two or more point-of-view characters are present in this scene. Choose the POV character by ONE rule: pick the character who cares MOST about the outcome — who has the highest emotional stake in what is about to happen. Not the most important character overall. Not the one with the most information. The one for whom the result of this scene most changes their inner life.

State the chosen POV character's name and ONE sentence on why their emotional stake is highest. If two candidates are genuinely tied, pick the one whose worldview is less familiar to the reader so far.
```

### `follett_seeds.character.locked_roster` (3-layer lock — revision mode)

For `brainstorm_step` and `chapter_step` when revising existing content. This is the load-bearing prompt that prevents drift.

```text
LOCKED CHARACTERS — this story has the following established cast. You MUST preserve every name, role, and key trait exactly. You MAY NOT invent new characters in this revision. You MAY NOT change the role, gender, age, name spelling, or relationships of any existing character.

{locked_character_roster}

COPY-FIRST RULE: Before writing anything new, copy the LOCKED CHARACTERS roster above into your output verbatim, as a section labeled "Confirmed cast." This is not optional. If your output does not begin with this confirmation, the revision will be rejected.

FINAL CHECK (last step before returning): Re-read your output. Have you introduced any character not in the LOCKED CHARACTERS list? Have you changed any existing character's name, role, gender, or core trait? If YES to either, restart this revision from scratch. The locked roster is the contract.
```

### `follett_seeds.character.good_guy_humanizer`

To avoid bland-hero syndrome on protagonists.

```text
This character is one of the story's good people — intelligent, kind, and brave. That alone is BORING and will lose the reader. Give them ONE of the following to humanise them:

(a) An eccentricity (Poirot's vanity, Adam Dalgleish's poetry).
(b) A hobby that contrasts sharply with their work or duty.
(c) A failing they're aware of and struggle against — vanity, jealousy, an old grudge, a vice.
(d) A regret they carry from a decision the reader will only learn about late.

Pick ONE. Make it specific. Show it in their first scene, not just their internal monologue.
```

### `follett_seeds.character.moral_complication`

For `brainstorm_step` when setting up a major character arc.

```text
At least ONE principal character must face a moral complication the reader cannot easily resolve. Construct it like this:

1. Identify a goal the character desperately wants to achieve (rescue someone, win the battle, marry the love interest, get justice).
2. Find a path to it that requires them to do something the reader will recognize as unkind, dishonest, cowardly, or morally compromised.
3. Make the path the OBVIOUSLY EFFECTIVE choice. The reader, in the character's shoes, would be tempted to take it.
4. Whatever they choose — to take the shortcut or refuse it — they will have regrets. The choice should not be costless. The reader should understand they would have regrets either way.

Do NOT resolve the moral question in their favor by adding new information that makes the choice easy. The dilemma must remain a dilemma until the character acts.
```

### `follett_seeds.character.no_milk_and_water`

Negative-constraint fragment appended to every character generation.

```text
Forbidden character types for POV roles in this story:
- The cautious person who lets life happen to them and rarely protests.
- The wise mentor who has all the answers.
- The pure victim whose only function is to suffer beautifully.
- The plot-vehicle character with no inner life of their own.
- The character whose internal contradictions are never expressed in action.

If your draft contains such a character in a POV role, either upgrade them (give them a strong agenda + a willingness to act on it, even badly) or demote them to a secondary character seen through someone else's eyes.
```

## Examples from Follett

- **Hannibal Lecter (Thomas Harris)** — pure villain, no redeeming qualities. Follett used the same approach for William Hamleigh in *The Pillars of the Earth*: "the one people talk to me about most." Sometimes a totally unredeemed villain is the right choice; the redemption-arc-for-everyone rule is overstated.
- **James Bond (Ian Fleming)** — sixty cigarettes a day, heavy drinker, dubious behavior with women — yet we identify with him. The reader can side with a character doing things they don't approve of, as long as the character is *actively pursuing* something they care about.
- **Lisbeth Salander / Stieg Larsson type characters** — Follett's own *Eye of the Needle* heroine was an early example of "strong female lead in an outdoor adventure thriller." The genre's expectation of passive women was the cliché; the twist was the lead.
- **William Hamleigh's mother (Pillars of the Earth)** — never spelled out, but in the novel the domineering mother is the implicit cause of his hatred of women. Follett left it to inference; the TV adaptation made it incestuous because TV doesn't have time for subtle exposition. Lesson: prose can imply backstory that the audience constructs.

## Engine integration

| Prompt fragment | prompt_store key | Consumed by | When |
|---|---|---|---|
| broad_strokes_then_twist | `follett_seeds.character.broad_strokes_then_twist` | brainstorm_step | New POV character generation |
| life_outside_plot | `follett_seeds.character.life_outside_plot` | brainstorm_step | Append to every character generator output |
| pov_selector | `follett_seeds.character.pov_selector` | chapter_step | Multi-POV scene resolution |
| locked_roster | `follett_seeds.character.locked_roster` | brainstorm_step + chapter_step | Revision mode only — required when prior content exists |
| good_guy_humanizer | `follett_seeds.character.good_guy_humanizer` | brainstorm_step | Protagonist generation |
| moral_complication | `follett_seeds.character.moral_complication` | brainstorm_step | Major character arc setup |
| no_milk_and_water | `follett_seeds.character.no_milk_and_water` | brainstorm_step | Append to every POV character generation as negative constraint |

L5 parity check for `brainstorm_step` character module: every generated POV character must score ≥0.9 on a rubric that asks (a) does the twist surprise? (b) is the life-outside-plot present? (c) is a dramatic question explicit? (d) is the character active rather than passive?

## See also

- [[plot-and-narrative-structure]] — the plot the characters serve.
- [[scene-pace-and-story-turns]] — how characters reveal themselves in scene.
- [[prose-style-dialogue-set-pieces]] — how character speaks through dialogue.
- [[_index]] — Writing Craft index.
