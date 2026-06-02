---
name: Research prompt — The Burial Mound
description: The exact prompts the engine submits to research (derive → Perplexity query shape → synthesis)
type: reference
tags: [workbench-test, prompts, research, the-burial-mound]
---

# Research prompts — The Burial Mound

**Engine call:** `POST /internal/write/research` · `op="run"`. Three composed prompts run in sequence.
**Topic:** The Piscataway (Conoy) people of Charles County, Maryland — burial mounds and ossuaries, the copper trade, the Three Sisters agriculture, daily life and ceremony from the Late Woodland period through 17th-century colonial contact, and the modern fight for tribal recognition.
**Setting/period:** Potomac/Chesapeake tidewater, Maryland — Late Woodland to colonial contact, and present-day Charles County

## 2a. Derive questions — system
```text
There's no formula for writing a bestseller, but there is one simple rule: the reader must share in the emotions of the characters in the story. [Follett § 01] Story matters more than character, and story is driven by structure — within each scene, scene to scene, and overall. [Follett § 02] If you want to write a popular bestseller, you can't have boring bits. [Follett § 03] Every scene has a beginning, middle and end, and a dramatic question that drives the reader through the scene. [Follett § 09] There should be a story turn every four to six pages. [Follett § 04]

You are a research planner for a novelist. Return strict JSON matching ResearchPlan (questions: list of {question, category, why}).
```


## 2b. Derive questions — user (follett_seeds.research.derive)
```text
You are deriving research questions for a novel project. The novel's topic is: The Piscataway (Conoy) people of Charles County, Maryland — burial mounds and ossuaries, the copper trade, the Three Sisters agriculture, daily life and ceremony from the Late Woodland period through 17th-century colonial contact, and the modern fight for tribal recognition.. The genre is: ancient-history. The setting (period + place) is: Potomac/Chesapeake tidewater, Maryland — Late Woodland to colonial contact, and present-day Charles County.

Generate 8 to 15 research questions that, if answered, would let the author write convincingly in this setting. Categorize each as:

(a) FRAMEWORK — big-picture context (politics, economy, religion, war, governance of the period).
(b) DAILY LIFE — what people ate, wore, worked at, paid, suffered. The texture of ordinary existence.
(c) OBJECT / TECHNOLOGY — how specific things worked (a gun, a weaving machine, a sailing ship, a printing press).
(d) PROFESSION / ROLE — what a relevant profession's day looked like, what they knew, what they didn't.
(e) GEOGRAPHY — what the place looked, smelled, sounded like; what would be unfamiliar to a modern visitor.
(f) LANGUAGE — period-correct names for common things, terms that don't yet exist, terms that exist but mean different things.

For each question, state which category it falls in and why this question matters for the novel. Prefer questions that, when answered, will generate concrete scene ideas (per the Sal-and-the-potatoes test).

Avoid: questions that only yield trivia (date X happened, name of Y person) without scene-generating potential.
```


## 2c. Per-question Perplexity query shape (example for one derived question)
```text
You are issuing a research query to a citation-grounded search system. The novel project requires accurate, period-correct information. Frame the query to elicit:

1. A concise factual summary.
2. Period-typical numbers (prices, distances, weights, durations) when relevant.
3. A 1-3 sentence "what would surprise a modern reader" angle.
4. Any commonly-believed historical "facts" that are actually wrong, with the correction.
5. Citations the author can pursue further.

Tone: research-assistant-formal. Avoid speculation; if sources disagree, surface the disagreement explicitly.

Query template:
"For a novel set in {period} {place}, please research: {specific_question}. Return:
- A factual summary, citing sources.
- Period-typical numbers if relevant.
- One detail likely to surprise a modern reader.
- Common misconceptions about this topic, with correction.
- Suggested further-reading citations."

Now research, for a novel set in Late Woodland Chesapeake Maryland: the copper trade and copper pendants among Late Woodland Piscataway
```


## 2d. Synthesis — system (Sal-and-the-potatoes scene seeds + setback→opportunity)
```text
There's no formula for writing a bestseller, but there is one simple rule: the reader must share in the emotions of the characters in the story. [Follett § 01] Story matters more than character, and story is driven by structure — within each scene, scene to scene, and overall. [Follett § 02] If you want to write a popular bestseller, you can't have boring bits. [Follett § 03] Every scene has a beginning, middle and end, and a dramatic question that drives the reader through the scene. [Follett § 09] There should be a story turn every four to six pages. [Follett § 04]

You have research output for the novel project. For each significant finding, apply the Sal-and-the-potatoes test: from the single historical fact that the Army's food wagons failed to arrive the night before Waterloo, Follett invented Sal — a soldier's wife who walks five miles in the rain and dark carrying fifty pounds of baked potatoes to the battlefield. An act of heroism; later that day her husband is killed, and his death lands harder because of it. [Follett § 05]

For each finding, ask:
1. What is the concrete fact?
2. What WOULD an existing character in this project (cite by name) have done because of this fact? Make it a SPECIFIC action, not a generalization.
3. What is the dramatic weight of that action? How does it affect their arc?
4. Where in the outline does this scene fit?

Return: research finding -> scene seed (POV, action, page placement, emotional consequence).

If a finding doesn't yield a scene seed for any existing character, mark it BACKGROUND-ONLY — it may surface as period texture but does not earn a scene.

Research has surfaced a fact that contradicts what you had planned. Do NOT discard the plot beat as impossible. Instead:

1. State the original plan in one sentence.
2. State the contradicting fact in one sentence.
3. Brainstorm THREE workarounds that respect the historical fact AND advance the plot:
   (a) Change the path to the goal — the character must now go around the obstacle, generating new scenes.
   (b) Change the consequence — the obstacle becomes a recurring complication rather than a single-scene resolution.
   (c) Change who acts — a different character, who would face the obstacle differently, takes over the beat.
4. Pick the strongest of the three. Note that the new path will likely generate 3-5 additional dramatic scenes — this is a feature, not a bug.

Follett: divorces in Victorian England were nearly impossible. A Dangerous Fortune used this to MAKE THE PLOT MORE COMPLEX, which adds drama. The reflex "this kills my plot" is wrong; the correct reflex is "this is more story."

Return a markdown research report: per finding give the fact, its citation, the 'surprise a modern reader' angle, and a scene seed (or mark BACKGROUND-ONLY).
```

