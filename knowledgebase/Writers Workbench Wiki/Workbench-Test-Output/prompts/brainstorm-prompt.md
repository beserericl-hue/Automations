---
name: Brainstorm prompt — The Burial Mound
description: The exact system + user prompt the engine submits to brainstorm.story (outline generation)
type: reference
tags: [workbench-test, prompts, brainstorm, the-burial-mound]
---

# Brainstorm (outline) prompt — The Burial Mound

**Engine call:** `POST /internal/write/brainstorm` · `op="story"` · model `claude-sonnet-4-6` · max_tokens 16384
**Genre:** `ancient-history` · **Story arc:** `(none set — engine infers from outline)`

Composed as: Follett prime directive → genre block → arc block → plot seeds (dramatic_question,
weaving, anti_sog, heightened_ending, wow_factor, scene_density) → character seeds
(broad_strokes_then_twist, moral_complication, no_milk_and_water) → outline_gate self-validation.

## System prompt
```text
There's no formula for writing a bestseller, but there is one simple rule: the reader must share in the emotions of the characters in the story. [Follett § 01] Story matters more than character, and story is driven by structure — within each scene, scene to scene, and overall. [Follett § 02] If you want to write a popular bestseller, you can't have boring bits. [Follett § 03] Every scene has a beginning, middle and end, and a dramatic question that drives the reader through the scene. [Follett § 09] There should be a story turn every four to six pages. [Follett § 04]

GENRE: ancient-history. Honour this genre's conventions and reader expectations.

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

When this outline switches between groups of characters or POVs, the storyline thread MUST remain unbroken. Apply this rule:

- The scene that immediately follows a POV switch must use INFORMATION or CONSEQUENCES from the prior scene. Example pattern: scene 1 = CIA agent Tamara receives intel from contact Abdul; scene 2 = Abdul (new POV) acts on the intel he just gave; scene 3 = US President (new POV) reacts to the intel that traveled from Tamara via Abdul.
- Never switch to a new POV at the start of a chapter and have them in a completely disconnected situation with no link to what just happened. This reads as "starting a new book."
- The thread can be: information, character travel, a phone call, a consequence, a deadline. Not: "meanwhile, in a different city, completely different characters were doing different things."

For each POV switch in this outline, name the thread that bridges it. If you cannot name a thread, restructure.

You are writing the middle of this novel. Soggy middles are the #1 failure mode of long-form fiction. To avoid one:

For each middle chapter, invent at least ONE of the following that did NOT exist in the setup:
- A new dramatic problem for the EXISTING cast (do not introduce new POV characters to manufacture middle drama — that's a creative failure).
- A serious setback to the protagonist's plan that requires real adaptation, not just inconvenience.
- A reveal about an existing character's past that changes how other characters relate to them.
- A consequence of an earlier choice that the reader didn't see coming but, in retrospect, was inevitable.
- A new piece of information that recasts the dramatic question.

Forbidden in the middle: chapters that only restate the dramatic question, chapters that only advance one logistical step, chapters whose only function is to move characters geographically.

Pillars of the Earth example for reference: in the middle, Alfred takes over from Tom Builder and the ceiling collapses; Aliena marries the wrong person; the builders go on strike; the monks run out of money. Four BIG new dramas, none requiring new cast.

The ending must be heightened — its impact spread across multiple characters with different emotional stakes, not concentrated on the protagonist alone.

To heighten the climax of this novel:
1. State the central resolution that answers the dramatic question.
2. Identify THREE characters whose lives are materially changed by this resolution. They must have different emotional investments — the obsessed hero, the wronged secondary character (a relative, a friend), and ideally an antagonist or rival whose own fate hinges on the outcome.
3. For each of the three, write one sentence on what the resolution costs them or grants them. The costs/grants must differ in kind, not just degree.
4. The climactic scene should show the resolution from the POV of the character with the highest emotional stake (per the POV selector rule), but its consequences must reach the other two within the same or adjacent scenes.

Avoid the ponderous ending: any subplot that needs tidying up should be RESOLVED BEFORE the climactic scene, not after. After the central question is answered, the drama is over; readers won't tolerate a long denouement.

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

Aim for 3 to 8 distinct dramatic scenes per chapter. A scene change is a shift of time, place, or POV. A scene contains: (a) a dramatic question, (b) hopes and fears for the POV character, (c) a beginning-middle-end, (d) a partial resolution that introduces the next question.

A chapter with 1-2 scenes is a vignette; only use this for opening/closing chapters or moments of high focus. A chapter with 10+ scenes feels scattered.

Generate a character for this story who would plausibly do what the plot requires of them. Follow these rules:

1. Pick the obvious archetype that the plot needs (the soldier, the spy, the priest, the heiress, the rebel). State it in one sentence.
2. Immediately add ONE off-axis attribute that complicates the cliche. The smart one is dumb about people. The strong one is neurotic about something small. The kind one has a casual cruelty when crossed. Make this twist specific and surprising, not generic.
3. They MUST be a person who gets into trouble. Cautious, agreeable, life-flows-by personalities are forbidden as POV characters — they cannot drive a bestseller. Even quiet characters must have a strong inner pressure that will explode under stress.
4. Give them a life outside the plot: a job that may not appear in the story, a hobby, a friend they like for no plot reason, a private worry. Three to five lines.
5. State the dramatic question that follows them through the book — the one their entire arc resolves. ONE sentence.
6. State what would humiliate them, terrify them, and make them happy. ONE sentence each.

Forbidden: "blonde hair and brown eyes" descriptions, "kind but firm" character summaries, anyone who is good at everything, anyone whose only role is to suffer.

At least ONE principal character must face a moral complication the reader cannot easily resolve. Construct it like this:

1. Identify a goal the character desperately wants to achieve (rescue someone, win the battle, marry the love interest, get justice).
2. Find a path to it that requires them to do something the reader will recognize as unkind, dishonest, cowardly, or morally compromised.
3. Make the path the OBVIOUSLY EFFECTIVE choice. The reader, in the character's shoes, would be tempted to take it.
4. Whatever they choose — to take the shortcut or refuse it — they will have regrets. The choice should not be costless. The reader should understand they would have regrets either way.

Do NOT resolve the moral question in their favor by adding new information that makes the choice easy. The dilemma must remain a dilemma until the character acts.

Forbidden character types for POV roles in this story:
- The cautious person who lets life happen to them and rarely protests.
- The wise mentor who has all the answers.
- The pure victim whose only function is to suffer beautifully.
- The plot-vehicle character with no inner life of their own.
- The character whose internal contradictions are never expressed in action.

If your draft contains such a character in a POV role, either upgrade them (give them a strong agenda + a willingness to act on it, even badly) or demote them to a secondary character seen through someone else's eyes.

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

Produce the novel outline as strict JSON matching StoryOutline (title, premise, themes, story_arc_name, dramatic_question, wow_factor, characters, chapters). Run the OUTLINE QUALITY GATE on yourself before returning; if it fails, revise and only then return.
```


## User prompt
```text
PROJECT REQUIREMENTS:
Dr. Tayak Moyaone, a Piscataway archaeologist fighting for tribal recognition, excavates a burial mound in Charles County, Maryland. As she uncovers artifacts spanning over two millennia—from copper pendants to colonial documents—each discovery triggers visions of her ancestors' lives, revealing the unbroken chain of heritage that connects her to the very people whose stories she seeks to preserve. Only when she reaches the deepest layer does she realize she has been excavating her own family's sacred ground.

Generate the full outline.
```

