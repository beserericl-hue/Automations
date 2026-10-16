---
name: Research and Local Color — Follett craft + engine prompts
description: Follett's research methodology distilled into LLM directives. Drives the research_step Perplexity + synthesis pipeline, the chapter_step local-color integration, and the historical fact-check pass in chapter_qa_step. Includes the Sal-and-the-potatoes test for turning historical fact into dramatic scene.
type: concept
tags: [writing-craft, research, historical, local-color, research-step, chapter, follett]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf § 05, § 15
last_reviewed: 2026-05-31
---

# Research and Local Color

> "Research feeds directly into the outline. A setback in your research can be a positive, because in dealing with it you're forced to invent something new — a problem becomes an opportunity." [Follett § 05]

## Principles

1. **Research nails implausibility to plausibility.** Most great stories are somewhat implausible. The job of research is to surround the implausible core with so much accurate, lived-in, period-correct detail that the reader's disbelief is suspended without effort. Goldilocks: bears don't live in houses, but the porridge and the chairs are real.
2. **Start with books, then maps, then museums, then sites.** Follett's order. Books give the framework, maps give geography, museums give objects you couldn't picture from books (the Spinning Mule), sites give sensory ground truth and unexpected story ideas.
3. **Research and outline are not separable.** Each question the research answers generates a new outline beat. The cathedral tracing-floor → a scene with the master builder. The Battle of Waterloo food wagon failure → Sal's potato run, an act of heroism. Follett invented Sal's heroic walk from ONE historical fact.
4. **A setback in research becomes drama, not a problem.** Discovering that Victorian divorces were nearly impossible could have killed *A Dangerous Fortune*'s plot; instead it made the plot more complex and dramatic. Treat "this couldn't have happened that way" as an outline-improving discovery, not a defeat.
5. **Throw research away when it doesn't serve the story.** One of the worst mistakes is cramming research into the prose because you put the hours in. Reading is for pleasure. Background is a bonus, story is the thing. The bomb-making recipe Follett cut from *The Man from St Petersburg* is the canonical example.
6. **Deliver information at the moment the character needs it.** (See [[scene-pace-and-story-turns]] § information_as_drama.) Period-correct gun-loading instructions in the moment a character must load a gun. Period-correct medical practice when the character is wounded. Never as a paragraph of setting the scene.
7. **You don't have to travel — but you must triangulate.** Follett wrote Scottish *Eye of the Needle* scenes from a 30-year-old library tourist guide. He wrote Chadian scenes for *Never* from internet + Google Earth + movies. The principle is multi-source triangulation, not travel for its own sake. Local color comes from cross-referenced detail, not from being there.
8. **Hire experts for the fact-check pass.** Follett pays university professors well. They take it seriously when paid. The expert pass catches things you couldn't possibly know — "town councils" vs "corporations" in 1820s England, "press gang victims couldn't be located" in Naval-era England.
9. **The expert reveals what the reader knows they should care about.** Tim Clayton on the price of porter being three pence a quart — not a pint — is the kind of detail that, once corrected, is invisible to the reader who didn't notice. The opposite (getting it wrong) is what loses the reader who DID notice.
10. **Period language is a balancing act.** You can't use 1820s vocabulary throughout — the reader won't understand. But you must avoid words and concepts that don't exist yet in your period ("redundant" for labor in 1820 — wrong; "Conservative" with capital C before the Conservative Party existed — wrong). Period-correct *concepts*, period-neutral language. Defer to the OED + period sources, not to the modern dictionary's first definition.
11. **The fictional character can quote real historical figures only with documentary basis.** Don't put modern opinions in historical mouths. Follett borrowed Lloyd George's actual memo on Bolshevism for a Lloyd George scene — that's allowed. Inventing a Churchill quote about something he never spoke on is not.
12. **The cleanest historical-novel trick: ground the implausible plot in real historical events.** Tying the story to the Battle of Waterloo, the Methodist movement, the Spinning Mule's introduction, the Bayeux Tapestry's depiction of daily life — all make the implausible feel inevitable.

## The Sal-and-the-potatoes test

Follett's example for converting historical fact into scene: he read that the food wagons for the British Army didn't arrive the day before Waterloo. From this single fact, he invented Sal — a soldier's wife who walks five miles in pouring rain at night and carries 50 pounds of baked potatoes on her back to the battlefield to feed the troops. The scene is an act of heroism. Her husband dies later that day. The dramatic weight of his death lands harder because of Sal's earlier heroism for him.

The test: when research surfaces a single historical fact, ask "what would a character we already care about have done because of this?" That's the scene.

## Prompt fragments for the engine

### `follett_seeds.research.derive_questions`

For `research_step` at the beginning of a research run.

```text
You are deriving research questions for a novel project. The novel's topic is: {topic}. The genre is: {genre}. The setting (period + place) is: {setting}.

Generate 8 to 15 research questions that, if answered, would let the author write convincingly in this setting. Categorize each as:

(a) FRAMEWORK — big-picture context (politics, economy, religion, war, governance of the period).
(b) DAILY LIFE — what people ate, wore, worked at, paid, suffered. The texture of ordinary existence.
(c) OBJECT / TECHNOLOGY — how specific things worked (a gun, a weaving machine, a sailing ship, a printing press).
(d) PROFESSION / ROLE — what a {profession_relevant_to_protagonist}'s day looked like, what they knew, what they didn't.
(e) GEOGRAPHY — what the place looked, smelled, sounded like; what would be unfamiliar to a modern visitor.
(f) LANGUAGE — period-correct names for common things, terms that don't yet exist, terms that exist but mean different things.

For each question, state which category it falls in and why this question matters for the novel. Prefer questions that, when answered, will generate concrete scene ideas (per the Sal-and-the-potatoes test).

Avoid: questions that only yield trivia (date X happened, name of Y person) without scene-generating potential.
```

### `follett_seeds.research.perplexity_query_shape`

For `research_step` when issuing a Perplexity sonar query.

```text
You are issuing a research query to a citation-grounded search system. The novel project requires accurate, period-correct information. Frame the query to elicit:

1. A concise factual summary.
2. Period-typical numbers (prices, distances, weights, durations) when relevant.
3. A 1-3 sentence "what would surprise a modern reader" angle.
4. Any commonly-believed historical "facts" that are actually wrong, with the correction.
5. Citations the author can pursue further.

Tone: research-assistant-formal. Temperature 0.2. Avoid speculation; if sources disagree, surface the disagreement explicitly.

Query template:
"For a novel set in {period} {place}, please research: {specific_question}. Return:
- A factual summary, citing sources.
- Period-typical numbers if relevant.
- One detail likely to surprise a modern reader.
- Common misconceptions about this topic, with correction.
- Suggested further-reading citations."
```

### `follett_seeds.research.synthesis_to_scene_seed`

For `research_step` to convert a research finding into a brainstorm-ready scene seed.

```text
You have research output for the novel project. For each significant finding, apply the Sal-and-the-potatoes test:

> "I read that the day before the Battle of Waterloo the food wagons for the British Army failed to arrive. From the fact that the men had nothing to eat for twenty-four hours before they were due to fight, I invented a story about the wife of one of my soldiers — women were camp followers who carried things and did chores and were very brave — who walks to the village of Waterloo in the pouring rain in the pitch dark of night and carries a fifty-pound sack of baked potatoes on her back all the way back to the battlefield. Sal is probably the main character in The Armour of Light and this is an act of heroism. Later that day her husband is killed." [Follett § 05]

For each finding, ask:
1. What is the concrete fact?
2. What WOULD an existing character in this project (cite by name) have done because of this fact? Make it a SPECIFIC action, not a generalization.
3. What is the dramatic weight of that action? How does it affect their arc?
4. Where in the outline does this scene fit?

Return: research finding → scene seed (POV, action, page placement, emotional consequence).

If a finding doesn't yield a scene seed for any existing character, mark it BACKGROUND-ONLY — it may surface as period texture but does not earn a scene.
```

### `follett_seeds.research.no_dumping`

Append to every `chapter_step` prose generation when research has been gathered.

```text
You have access to research material for this scene. Do NOT dump research into the prose. Apply the following rules:

1. Reading is for pleasure. The story is the thing. Background is a bonus.
2. Information must be delivered at the moment a character LEARNS it or NEEDS it. (See information_as_drama directive.)
3. If you have written a paragraph of pure setting / period-context / explanation, cut it. Either rewrite it as something a character notices, asks about, fears, or acts on — or remove it entirely.
4. Period-correct nouns ("a porter," "a corporation," "a roving") are fine and welcome. Period-correct explanatory paragraphs are not.

When in doubt: would a reader skip this paragraph to get back to the story? If yes, cut.
```

### `follett_seeds.research.period_language_check`

For `chapter_qa_step` as part of the historical-fact-check pass.

```text
This manuscript is set in {period}. Scan the prose for anachronistic language. Flag any of:

1. Words that did not exist in the period (e.g., "redundant" for labor before the 1920s).
2. Words that existed but had a different meaning (e.g., "snob" meant cobbler's apprentice in the 18th century; "town council" implies post-1835 local government).
3. Capitalized proper nouns of organizations that didn't exist yet (e.g., "Conservative Party" before the party formed; brand names of products not invented yet).
4. Concepts the period had no word or framework for (e.g., "stress" as a psychological state, "teenager" as a social category, "weekend").
5. Modern metaphors that depend on technology of a later era (e.g., "snapped like a switch," "tuned out," "on autopilot").

For each flag, suggest a period-appropriate alternative. Cite the OED period of first attestation when relevant. Defer to documented historical usage; when in doubt, prefer the LESS specific word over the anachronistic one.
```

### `follett_seeds.research.expert_check_protocol`

A meta-directive that affects how the engine handles the expert-review step.

```text
The expert-fact-check pass on this manuscript is held to a higher standard than internal QA. When commissioning or applying expert review:

1. Provide the expert with the FULL manuscript, not extracts. Context affects accuracy judgment.
2. Ask for two things: (a) any error or implausibility, (b) suggested fix that preserves the dramatic intent. Bare error-flagging without fix suggestions is less useful.
3. Pay or compensate the expert seriously. Free academic favors get checked-box reviews.
4. Apply expert corrections in full unless the correction would damage the plot. In that case, ENGAGE with the expert to find an alternative path. Follett's example: when historical divorce was nearly impossible in Victorian England, the plot got more complex (better), not abandoned.

Expert comments are not optional polish — they are the dividing line between historical fiction that wins long-term reader trust and historical fiction that loses readers who notice the errors.
```

### `follett_seeds.research.setback_to_opportunity`

For `brainstorm_step` and `chapter_step` when research contradicts a planned plot beat.

```text
Research has surfaced a fact that contradicts what you had planned. Do NOT discard the plot beat as impossible. Instead:

1. State the original plan in one sentence.
2. State the contradicting fact in one sentence.
3. Brainstorm THREE workarounds that respect the historical fact AND advance the plot:
   (a) Change the path to the goal — the character must now go around the obstacle, generating new scenes.
   (b) Change the consequence — the obstacle becomes a recurring complication rather than a single-scene resolution.
   (c) Change who acts — a different character, who would face the obstacle differently, takes over the beat.
4. Pick the strongest of the three. Note that the new path will likely generate 3-5 additional dramatic scenes — this is a feature, not a bug.

Follett: divorces in Victorian England were nearly impossible. A Dangerous Fortune used this to MAKE THE PLOT MORE COMPLEX, which adds drama. The reflex "this kills my plot" is wrong; the correct reflex is "this is more story."
```

### `follett_seeds.research.local_color_density`

For `chapter_step` to ensure scenes feel grounded without being smothered in detail.

```text
This scene must establish or maintain the sensory texture of {period} {place}. Apply the local-color density rule:

- ONE specific, period-correct sensory detail per scene that the modern reader probably doesn't know (the smell of a specific food, the sound of a specific tool, the feel of a specific fabric, the etiquette of a specific greeting, the cost of a specific item).
- ONE specific, period-correct prop that interacts with a character (something they use, hold, drop, struggle with).
- ONE specific, period-correct word or phrase that a character speaks or thinks (subtle — not a parade of dialect, just one anchor).

That's THREE anchors per scene. More than that and the scene becomes a museum tour. Fewer and the period feels generic.

Forbidden: paragraphs of pure period description with no character interacting. Forbidden: dialect-heavy dialogue that condescends to the speaker (see prose-style guidance).
```

## Examples from Follett

- **Pillars of the Earth — tracing floor** — Follett didn't know how medieval cathedral builders laid out ground plans. Research surfaced the tracing floor (a large block of mortar where curves were drawn with compasses). He saw two surviving ones at Wells and York. The detail made it into the book and generated a scene of the master builder at work.
- **Pillars of the Earth — scaffolding death** — Research surfaced Guillaume de Sens, the French architect of Canterbury Cathedral, who died falling from scaffolding. Follett used this to kill a character in his own cathedral build — historically grounded, dramatically necessary.
- **Lie Down With Lions — gun safety catch** — research-driven scene mechanic: heroine needs to threaten a Russian prisoner, hands the gun to the gun-illiterate, and the CIA agent has to teach her the safety catch in real time. Information IS drama.
- **The Armour of Light — Sal's potatoes** — single fact (Waterloo food wagons failed) → an entire character arc.
- **Naval Wives and Mistresses (Margarette Lincoln's book that saved Follett)** — Follett couldn't figure out how a press-ganged sailor's wife would learn what happened to her husband. Answer: she wouldn't. Communication wasn't possible. That made the disappearance more dramatic, not less.

## Engine integration

| Prompt fragment | prompt_store key | Consumed by | When |
|---|---|---|---|
| derive_questions | `follett_seeds.research.derive` | research_step | Beginning of research run |
| perplexity_query_shape | `follett_seeds.research.perplexity_query` | research_step | Each Perplexity sonar call |
| synthesis_to_scene_seed | `follett_seeds.research.scene_seed` | research_step | Synthesis pass after Perplexity returns |
| no_dumping | `follett_seeds.research.no_dumping` | chapter_step | Append to every chapter prose generation when research is in scope |
| period_language_check | `follett_seeds.research.period_language` | chapter_qa_step | Historical fact-check pass |
| expert_check_protocol | `follett_seeds.research.expert_protocol` | meta — chapter_qa_step orchestration | Expert review commissioning |
| setback_to_opportunity | `follett_seeds.research.setback_opportunity` | brainstorm_step + chapter_step | When research contradicts planned beat |
| local_color_density | `follett_seeds.research.local_color` | chapter_step | Every historical-setting scene |

`research_step` output schema additions: each research finding carries (a) the fact, (b) the citation, (c) the proposed scene seed if any, (d) the "surprise a modern reader" angle, (e) BACKGROUND-ONLY flag if no scene seed.

`chapter_qa_step` period-language check should be a deterministic regex pass over a curated anachronism list per period, falling back to LLM check for context-dependent ambiguity. Build the per-period anachronism list incrementally as expert reviews surface new entries.

## See also

- [[plot-and-narrative-structure]] — what the research is feeding into.
- [[character-development]] — characters whose actions emerge from research findings.
- [[scene-pace-and-story-turns]] — information_as_drama directive that this page extends.
- [[prose-style-dialogue-set-pieces]] — period-language treatment in prose.
- [[_index]] — Writing Craft index.
