"""Follett craft prompt seeds — the engine's writing-craft layer.

Operational distillation of Ken Follett's BBC Maestro course "Writing Bestselling Fiction"
(permission granted by the author 2026-05-31), authored in the Obsidian vault under
``knowledgebase/Writers Workbench Wiki/Writing Craft/`` and ported here verbatim as composable LLM
directives. The source PDF is gitignored and NOT redistributed — these are the operational layer.

Keys are dotted ``follett_seeds.<area>.<fragment>`` exactly as the vault pages specify, so the
write-workshop step services can compose them (see :func:`compose_craft_system`). They register as
prompt-store defaults and are DB-overridable under ``app_config.prompts`` like every other prompt.

Layering the craft sits inside:
    genre (genre_config_v2)  -> the basic outline / themes / market register
    story arc (story_arcs_v2) -> the structural beats / points
    follett_seeds (here)      -> the detail craft of characters, scenes, dialogue, prose, research

Citations to the course are inline as ``[Follett § N]``.
"""

from __future__ import annotations

from writer_engine.prompt_store.store import get_prompt_store

# The Prime Directive, distilled (the five load-bearing sentences from the Writing Craft index).
PRIME_DIRECTIVE = (
    "There's no formula for writing a bestseller, but there is one simple rule: the reader must "
    "share in the emotions of the characters in the story. [Follett § 01] "
    "Story matters more than character, and story is driven by structure — within each scene, scene "
    "to scene, and overall. [Follett § 02] "
    "If you want to write a popular bestseller, you can't have boring bits. [Follett § 03] "
    "Every scene has a beginning, middle and end, and a dramatic question that drives the reader "
    "through the scene. [Follett § 09] "
    "There should be a story turn every four to six pages. [Follett § 04]"
)

# ---------------------------------------------------------------------------------------------------
# Character (character-development.md, Follett § 10/03/04)
# ---------------------------------------------------------------------------------------------------

_CHARACTER: dict[str, str] = {
    "follett_seeds.character.broad_strokes_then_twist": """\
Generate a character for this story who would plausibly do what the plot requires of them. Follow these rules:

1. Pick the obvious archetype that the plot needs (the soldier, the spy, the priest, the heiress, the rebel). State it in one sentence.
2. Immediately add ONE off-axis attribute that complicates the cliche. The smart one is dumb about people. The strong one is neurotic about something small. The kind one has a casual cruelty when crossed. Make this twist specific and surprising, not generic.
3. They MUST be a person who gets into trouble. Cautious, agreeable, life-flows-by personalities are forbidden as POV characters — they cannot drive a bestseller. Even quiet characters must have a strong inner pressure that will explode under stress.
4. Give them a life outside the plot: a job that may not appear in the story, a hobby, a friend they like for no plot reason, a private worry. Three to five lines.
5. State the dramatic question that follows them through the book — the one their entire arc resolves. ONE sentence.
6. State what would humiliate them, terrify them, and make them happy. ONE sentence each.

Forbidden: "blonde hair and brown eyes" descriptions, "kind but firm" character summaries, anyone who is good at everything, anyone whose only role is to suffer.""",
    "follett_seeds.character.life_outside_plot": """\
Before finalizing this character, list three things they do in their life that have NOTHING to do with the events of this plot. These are activities, relationships, or preoccupations the reader will never see in scene but that exist in the character's life. Cite them once each in passing during the manuscript — never in detail, just as the texture of a real life lived alongside the events of the story.""",
    "follett_seeds.character.pov_selector": """\
Two or more point-of-view characters are present in this scene. Choose the POV character by ONE rule: pick the character who cares MOST about the outcome — who has the highest emotional stake in what is about to happen. Not the most important character overall. Not the one with the most information. The one for whom the result of this scene most changes their inner life.

State the chosen POV character's name and ONE sentence on why their emotional stake is highest. If two candidates are genuinely tied, pick the one whose worldview is less familiar to the reader so far.""",
    "follett_seeds.character.locked_roster": """\
LOCKED CHARACTERS — this story has the following established cast. You MUST preserve every name, role, and key trait exactly. You MAY NOT invent new characters in this revision. You MAY NOT change the role, gender, age, name spelling, or relationships of any existing character.

{locked_character_roster}

COPY-FIRST RULE: Before writing anything new, copy the LOCKED CHARACTERS roster above into your output verbatim, as a section labeled "Confirmed cast." This is not optional. If your output does not begin with this confirmation, the revision will be rejected.

FINAL CHECK (last step before returning): Re-read your output. Have you introduced any character not in the LOCKED CHARACTERS list? Have you changed any existing character's name, role, gender, or core trait? If YES to either, restart this revision from scratch. The locked roster is the contract.""",
    "follett_seeds.character.good_guy_humanizer": """\
This character is one of the story's good people — intelligent, kind, and brave. That alone is BORING and will lose the reader. Give them ONE of the following to humanise them:

(a) An eccentricity (Poirot's vanity, Adam Dalgleish's poetry).
(b) A hobby that contrasts sharply with their work or duty.
(c) A failing they're aware of and struggle against — vanity, jealousy, an old grudge, a vice.
(d) A regret they carry from a decision the reader will only learn about late.

Pick ONE. Make it specific. Show it in their first scene, not just their internal monologue.""",
    "follett_seeds.character.moral_complication": """\
At least ONE principal character must face a moral complication the reader cannot easily resolve. Construct it like this:

1. Identify a goal the character desperately wants to achieve (rescue someone, win the battle, marry the love interest, get justice).
2. Find a path to it that requires them to do something the reader will recognize as unkind, dishonest, cowardly, or morally compromised.
3. Make the path the OBVIOUSLY EFFECTIVE choice. The reader, in the character's shoes, would be tempted to take it.
4. Whatever they choose — to take the shortcut or refuse it — they will have regrets. The choice should not be costless. The reader should understand they would have regrets either way.

Do NOT resolve the moral question in their favor by adding new information that makes the choice easy. The dilemma must remain a dilemma until the character acts.""",
    "follett_seeds.character.no_milk_and_water": """\
Forbidden character types for POV roles in this story:
- The cautious person who lets life happen to them and rarely protests.
- The wise mentor who has all the answers.
- The pure victim whose only function is to suffer beautifully.
- The plot-vehicle character with no inner life of their own.
- The character whose internal contradictions are never expressed in action.

If your draft contains such a character in a POV role, either upgrade them (give them a strong agenda + a willingness to act on it, even badly) or demote them to a secondary character seen through someone else's eyes.""",
}

# ---------------------------------------------------------------------------------------------------
# Plot / narrative structure (plot-and-narrative-structure.md, Follett § 02/03/04/06/11)
# ---------------------------------------------------------------------------------------------------

_PLOT: dict[str, str] = {
    "follett_seeds.plot.dramatic_question": """\
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

Reject any candidate that fails any of the 5 criteria. If all three candidates fail, regenerate.""",
    "follett_seeds.plot.outline_gate": """\
You have produced an outline for this novel. Before returning it, score it against these criteria. If it fails any, regenerate and try again. Do NOT return a failing outline.

1. SCENE COUNT: Count the distinct dramatic scenes (not chapters — scenes within chapters). The total must be between 50 and 100 for a novel-length work. If under 50, the idea is short fiction; add more cast and complications. If over 100, the book will sprawl; consolidate.
2. DRAMATIC QUESTION: Can the central question be stated in one sentence? Is it referenced (directly or via consequence) in every chapter? If not, the outline is unfocused.
3. CHAPTER 1 GRIP: Does chapter 1 end with the reader fully committed to reading the next chapter? If not, the opening is too gentle.
4. STORY TURN DENSITY: For chapters 1-3 and the final 2 chapters, list the story turns. There should be at least one per 4-6 pages of intended draft length.
5. SOGGY MIDDLE CHECK: Look at the middle third of chapters. For each, what NEW dramatic situation arises in this chapter that wasn't set up before? "Nothing new, but moves toward the resolution" is a fail. Each middle chapter must add a fresh dramatic complication for the existing cast.
6. WOW FACTOR: State the unique selling point in one sentence. If you cannot, the book is generic — invent one.
7. POV DISCIPLINE: Count POV characters. 2-6 is acceptable. 1 is fine but limits scope. 7+ confuses readers.
8. ENDING HEIGHTENED: Does the ending impact 3+ major characters with different emotional stakes? Or only the protagonist? Single-character resolutions are flatter than multi-character resolutions.

If all 8 pass, return the outline. Otherwise, list which failed and revise.""",
    "follett_seeds.plot.scene_density": """\
Aim for 3 to 8 distinct dramatic scenes per chapter. A scene change is a shift of time, place, or POV. A scene contains: (a) a dramatic question, (b) hopes and fears for the POV character, (c) a beginning-middle-end, (d) a partial resolution that introduces the next question.

A chapter with 1-2 scenes is a vignette; only use this for opening/closing chapters or moments of high focus. A chapter with 10+ scenes feels scattered.""",
    "follett_seeds.plot.weaving": """\
When this outline switches between groups of characters or POVs, the storyline thread MUST remain unbroken. Apply this rule:

- The scene that immediately follows a POV switch must use INFORMATION or CONSEQUENCES from the prior scene. Example pattern: scene 1 = CIA agent Tamara receives intel from contact Abdul; scene 2 = Abdul (new POV) acts on the intel he just gave; scene 3 = US President (new POV) reacts to the intel that traveled from Tamara via Abdul.
- Never switch to a new POV at the start of a chapter and have them in a completely disconnected situation with no link to what just happened. This reads as "starting a new book."
- The thread can be: information, character travel, a phone call, a consequence, a deadline. Not: "meanwhile, in a different city, completely different characters were doing different things."

For each POV switch in this outline, name the thread that bridges it. If you cannot name a thread, restructure.""",
    "follett_seeds.plot.anti_sog": """\
You are writing the middle of this novel. Soggy middles are the #1 failure mode of long-form fiction. To avoid one:

For each middle chapter, invent at least ONE of the following that did NOT exist in the setup:
- A new dramatic problem for the EXISTING cast (do not introduce new POV characters to manufacture middle drama — that's a creative failure).
- A serious setback to the protagonist's plan that requires real adaptation, not just inconvenience.
- A reveal about an existing character's past that changes how other characters relate to them.
- A consequence of an earlier choice that the reader didn't see coming but, in retrospect, was inevitable.
- A new piece of information that recasts the dramatic question.

Forbidden in the middle: chapters that only restate the dramatic question, chapters that only advance one logistical step, chapters whose only function is to move characters geographically.

Pillars of the Earth example for reference: in the middle, Alfred takes over from Tom Builder and the ceiling collapses; Aliena marries the wrong person; the builders go on strike; the monks run out of money. Four BIG new dramas, none requiring new cast.""",
    "follett_seeds.plot.heightened_ending": """\
The ending must be heightened — its impact spread across multiple characters with different emotional stakes, not concentrated on the protagonist alone.

To heighten the climax of this novel:
1. State the central resolution that answers the dramatic question.
2. Identify THREE characters whose lives are materially changed by this resolution. They must have different emotional investments — the obsessed hero, the wronged secondary character (a relative, a friend), and ideally an antagonist or rival whose own fate hinges on the outcome.
3. For each of the three, write one sentence on what the resolution costs them or grants them. The costs/grants must differ in kind, not just degree.
4. The climactic scene should show the resolution from the POV of the character with the highest emotional stake (per the POV selector rule), but its consequences must reach the other two within the same or adjacent scenes.

Avoid the ponderous ending: any subplot that needs tidying up should be RESOLVED BEFORE the climactic scene, not after. After the central question is answered, the drama is over; readers won't tolerate a long denouement.""",
    "follett_seeds.plot.wow_factor": """\
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

If you cannot produce one, generate three candidate wow factors and select the strongest. If none of the three are strong, the project's premise needs reworking — say so explicitly.""",
}

# ---------------------------------------------------------------------------------------------------
# Scene / pace / story turns (scene-pace-and-story-turns.md, Follett § 04/09/11)
# ---------------------------------------------------------------------------------------------------

_SCENE: dict[str, str] = {
    "follett_seeds.scene.event_list": """\
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

DO NOT WRITE PROSE in this step. Prose comes after the list is approved.""",
    "follett_seeds.scene.ups_and_downs": """\
This scene has 8 or more events and runs the risk of monotony. After listing the events, mark each with an arrow showing the POV character's mood-shift:

up — a win, a hope, a positive surprise
down — a setback, a fear realized, a humiliation
flat — neutral or transitional

Now examine the sequence. Two ups or two downs in a row without break flatten the wave and lose reader interest. Reshuffle the events (within plausibility) so the pattern alternates rather than clustering all ups then all downs.

The Pauline Green diplomats' ball scene in Follett's Never is the model: arriving optimistic (up), can't find the Saudi ambassador (down), runs into the French ambassador who supports her (up), the fired official she didn't want to see appears (down), the Saudi ambassador finally arrives and refuses her ask (down, down), she gives her speech well and leaves (up). Wave intact, scene satisfying despite the bad news at its core.

Now return the re-sequenced event list with arrows.""",
    "follett_seeds.scene.bme_check": """\
Before returning this scene, validate it against the three required components:

1. BEGINNING — establishes the POV character's hopes AND fears entering the scene. The reader knows what could go well and what could go badly. If the beginning is just "Sarah walked into the room," it's failed — restart.
2. MIDDLE — dramatizes the hopes and fears through action, dialogue, or decision. Not exposition. Not internal monologue alone (a small amount is fine; the middle cannot be entirely interior). Things must HAPPEN.
3. END — a partial resolution. Some hopes are fulfilled, some fears realized, some questions remain. The end MUST raise a new question that propels the reader into the next scene. If the end concludes everything, this scene is the climax — confirm that's intentional or revise.

If any of the three fails, restart. Do not return a scene without all three.""",
    "follett_seeds.scene.turn_density": """\
Count the story turns in this chapter. A story turn is anything that changes the situation for the characters — a death, a lie told, a discovery, a reversal, a confession, a new threat, a relationship shift, a power change. Internal realizations count only if they lead to action.

Target: ONE story turn per 4-6 pages of draft. Below that = drags. Above = frenetic.

If this chapter is 18 pages, you want 3-5 story turns. If you have only 1, the chapter is too soft — invent more story (existing cast, not new characters). If you have 8, the chapter is overcaffeinated — promote the most resonant 4-5 turns and demote or remove the others.

List each story turn in this chapter with the page it occurs on. State whether the density is within target. If not, revise.""",
    "follett_seeds.scene.escalating_turn": """\
The best story turn is one that escalates — starts small and gets worse with each subsequent scene. A character tells a small lie in chapter 3 to avoid embarrassment. In chapter 5, they must maintain the lie. In chapter 8, the lie causes someone to make a wrong decision. In chapter 12, the lie is discovered with consequences far worse than the original embarrassment would have been.

When you introduce a small story turn that COULD escalate (a lie, a hidden weakness, a secret debt, a misplaced trust, a borrowed item not returned), explicitly note in the outline:
- Where it starts (small)
- Where it must reappear with greater pressure
- Where it explodes (the chapter where the escalation pays off)

This is the highest-ROI story-turn architecture. Use it for at least one major thread per novel.""",
    "follett_seeds.scene.info_as_drama": """\
This scene must convey a piece of information the reader needs to understand the plot (technical detail, historical fact, character backstory, world rule). Do NOT deliver this information as exposition — even one paragraph of pure exposition risks losing the reader.

Instead, embed the information into a moment of DRAMA where a character LEARNS or NEEDS the information at the exact moment the reader does. The model is Follett's Lie Down With Lions: the gun's safety catch is explained when the heroine is told to shoot a prisoner with a gun she's never held — the CIA agent's instruction ("the safety catch is here") IS the exposition.

Patterns:
- A character must teach another character because of the immediate situation.
- A character realizes a thing about their own past in the moment that thing becomes relevant.
- A character reads a document that contains the fact, but reads it while something dangerous is happening.
- A character argues with another about the fact, and the argument is itself the drama.

If you cannot find a way to embed the information dramatically, you may not have a real scene — you may have an exposition dump masquerading as one. Revise the scene's design.""",
    "follett_seeds.scene.description": """\
Every description in this scene must do TWO jobs at once:

1. Paint a picture the reader can see in their mind. Specific, sensory, vivid. Avoid generic adjectives ("nice," "old," "interesting").
2. Tell the reader something about character, mood, power, or consequence. The HOW of the description carries meaning beyond the WHAT.

Examples:
- "She had beautiful blonde hair" — does one job.
- "Her beautiful blonde hair was very carefully arranged" — does two: paints the picture AND tells you she's fussy / vain / under pressure to look perfect.
- "There was a Ming vase on the desk" — does one job.
- "The foreign minister had only one object on his desk — a priceless Ming vase. The Russian general sat down, lit a cigarette, and tapped ash into it" — does two: paints the picture AND tells you everything about the power dynamic and the general's contempt.

If a description does only one job, rewrite or cut. Two jobs per description is the standard. Avoid "brown eyes and brown hair" character descriptions. Avoid cataloguing what people are wearing unless the clothes are doing dramatic work.""",
    "follett_seeds.scene.pov_bridge": """\
The next scene shifts to a different POV character. To prevent the reader from feeling they've started a new book:

1. The LAST LINE of the current scene must create urgency, a question, or a consequence that the NEW POV scene will engage with.
2. The OPENING of the new POV scene must explicitly carry forward the thread — through information, consequence, character travel, or a shared deadline.
3. The new POV character must have been mentioned (even briefly) in earlier text, or must be in a situation directly caused by the prior scene.

Forbidden bridge: "Meanwhile, in [different city], [completely new character] was doing [completely unrelated thing]."

Acceptable bridges:
- "Meanwhile, [character mentioned 30 pages ago] received the message [that the prior scene sent]."
- "[New POV character] was the only person who could verify [the discovery from the prior scene]."
- "The phone call [the prior POV character made at the end of the scene] reached [new POV character] in [setting]."

Name the bridge before writing the new scene. If you cannot, the structural design has gone wrong — restart.""",
    "follett_seeds.scene.fix_now": """\
When you notice something that needs fixing in this scene — a continuity break, a tone mismatch, a character acting out-of-character, a factual slip — FIX IT NOW in this draft, not in a list of corrections to apply later.

Lists of pending fixes grow. Detail is forgotten. Downstream scenes get written on top of unfixed problems. The cumulative cost of deferred fixes is always higher than the immediate cost of fixing as you find.

Exception: if a fix requires restructuring an earlier chapter that's already in the manuscript, queue it as a structural change for the next revision pass — but flag it explicitly with a TODO at the change point, never silently.""",
}

# ---------------------------------------------------------------------------------------------------
# Research / local color (research-and-local-color.md, Follett § 05/15)
# ---------------------------------------------------------------------------------------------------

_RESEARCH: dict[str, str] = {
    "follett_seeds.research.derive": """\
You are deriving research questions for a novel project. The novel's topic is: {topic}. The genre is: {genre}. The setting (period + place) is: {setting}.

Generate 8 to 15 research questions that, if answered, would let the author write convincingly in this setting. Categorize each as:

(a) FRAMEWORK — big-picture context (politics, economy, religion, war, governance of the period).
(b) DAILY LIFE — what people ate, wore, worked at, paid, suffered. The texture of ordinary existence.
(c) OBJECT / TECHNOLOGY — how specific things worked (a gun, a weaving machine, a sailing ship, a printing press).
(d) PROFESSION / ROLE — what a relevant profession's day looked like, what they knew, what they didn't.
(e) GEOGRAPHY — what the place looked, smelled, sounded like; what would be unfamiliar to a modern visitor.
(f) LANGUAGE — period-correct names for common things, terms that don't yet exist, terms that exist but mean different things.

For each question, state which category it falls in and why this question matters for the novel. Prefer questions that, when answered, will generate concrete scene ideas (per the Sal-and-the-potatoes test).

Avoid: questions that only yield trivia (date X happened, name of Y person) without scene-generating potential.""",
    "follett_seeds.research.perplexity_query": """\
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
- Suggested further-reading citations.\"""",
    "follett_seeds.research.scene_seed": """\
You have research output for the novel project. For each significant finding, apply the Sal-and-the-potatoes test: from the single historical fact that the Army's food wagons failed to arrive the night before Waterloo, Follett invented Sal — a soldier's wife who walks five miles in the rain and dark carrying fifty pounds of baked potatoes to the battlefield. An act of heroism; later that day her husband is killed, and his death lands harder because of it. [Follett § 05]

For each finding, ask:
1. What is the concrete fact?
2. What WOULD an existing character in this project (cite by name) have done because of this fact? Make it a SPECIFIC action, not a generalization.
3. What is the dramatic weight of that action? How does it affect their arc?
4. Where in the outline does this scene fit?

Return: research finding -> scene seed (POV, action, page placement, emotional consequence).

If a finding doesn't yield a scene seed for any existing character, mark it BACKGROUND-ONLY — it may surface as period texture but does not earn a scene.""",
    "follett_seeds.research.no_dumping": """\
You have access to research material for this scene. Do NOT dump research into the prose. Apply the following rules:

1. Reading is for pleasure. The story is the thing. Background is a bonus.
2. Information must be delivered at the moment a character LEARNS it or NEEDS it. (See information_as_drama directive.)
3. If you have written a paragraph of pure setting / period-context / explanation, cut it. Either rewrite it as something a character notices, asks about, fears, or acts on — or remove it entirely.
4. Period-correct nouns ("a porter," "a corporation," "a roving") are fine and welcome. Period-correct explanatory paragraphs are not.

When in doubt: would a reader skip this paragraph to get back to the story? If yes, cut.""",
    "follett_seeds.research.period_language": """\
This manuscript is set in {period}. Scan the prose for anachronistic language. Flag any of:

1. Words that did not exist in the period (e.g., "redundant" for labor before the 1920s).
2. Words that existed but had a different meaning (e.g., "snob" meant cobbler's apprentice in the 18th century; "town council" implies post-1835 local government).
3. Capitalized proper nouns of organizations that didn't exist yet (e.g., "Conservative Party" before the party formed; brand names of products not invented yet).
4. Concepts the period had no word or framework for (e.g., "stress" as a psychological state, "teenager" as a social category, "weekend").
5. Modern metaphors that depend on technology of a later era (e.g., "snapped like a switch," "tuned out," "on autopilot").

For each flag, suggest a period-appropriate alternative. Cite the OED period of first attestation when relevant. Defer to documented historical usage; when in doubt, prefer the LESS specific word over the anachronistic one.""",
    "follett_seeds.research.expert_protocol": """\
The expert-fact-check pass on this manuscript is held to a higher standard than internal QA. When commissioning or applying expert review:

1. Provide the expert with the FULL manuscript, not extracts. Context affects accuracy judgment.
2. Ask for two things: (a) any error or implausibility, (b) suggested fix that preserves the dramatic intent. Bare error-flagging without fix suggestions is less useful.
3. Pay or compensate the expert seriously. Free academic favors get checked-box reviews.
4. Apply expert corrections in full unless the correction would damage the plot. In that case, ENGAGE with the expert to find an alternative path. Follett's example: when historical divorce was nearly impossible in Victorian England, the plot got more complex (better), not abandoned.

Expert comments are not optional polish — they are the dividing line between historical fiction that wins long-term reader trust and historical fiction that loses readers who notice the errors.""",
    "follett_seeds.research.setback_opportunity": """\
Research has surfaced a fact that contradicts what you had planned. Do NOT discard the plot beat as impossible. Instead:

1. State the original plan in one sentence.
2. State the contradicting fact in one sentence.
3. Brainstorm THREE workarounds that respect the historical fact AND advance the plot:
   (a) Change the path to the goal — the character must now go around the obstacle, generating new scenes.
   (b) Change the consequence — the obstacle becomes a recurring complication rather than a single-scene resolution.
   (c) Change who acts — a different character, who would face the obstacle differently, takes over the beat.
4. Pick the strongest of the three. Note that the new path will likely generate 3-5 additional dramatic scenes — this is a feature, not a bug.

Follett: divorces in Victorian England were nearly impossible. A Dangerous Fortune used this to MAKE THE PLOT MORE COMPLEX, which adds drama. The reflex "this kills my plot" is wrong; the correct reflex is "this is more story.\"""",
    "follett_seeds.research.local_color": """\
This scene must establish or maintain the sensory texture of {period} {place}. Apply the local-color density rule:

- ONE specific, period-correct sensory detail per scene that the modern reader probably doesn't know (the smell of a specific food, the sound of a specific tool, the feel of a specific fabric, the etiquette of a specific greeting, the cost of a specific item).
- ONE specific, period-correct prop that interacts with a character (something they use, hold, drop, struggle with).
- ONE specific, period-correct word or phrase that a character speaks or thinks (subtle — not a parade of dialect, just one anchor).

That's THREE anchors per scene. More than that and the scene becomes a museum tour. Fewer and the period feels generic.

Forbidden: paragraphs of pure period description with no character interacting. Forbidden: dialect-heavy dialogue that condescends to the speaker.""",
}

# ---------------------------------------------------------------------------------------------------
# Prose / dialogue / set pieces (prose-style-dialogue-set-pieces.md, Follett § 08/12/14)
# ---------------------------------------------------------------------------------------------------

_PROSE: dict[str, str] = {
    "follett_seeds.prose.transparent": """\
Default to transparent prose. The reader should see THROUGH your sentences to the story, not look AT them. Rules:

- Short to medium sentences. Long sentences only when the emotional content justifies the length.
- Direct word order. Subject-verb-object dominates. Inversions only for deliberate effect.
- Concrete nouns and active verbs. Adjectives sparingly. Adverbs almost never.
- Avoid: "It was as if...," "she felt a strange..," "a kind of..." (vague intensifiers that hide imprecise observation).
- Avoid: "literary" mannerisms — extended metaphors at unsupported emotional moments, fancy alternates for common words (commenced for began, departed for left).

The model is Follett's own prose: clear, direct, light on imagery, lets the story breathe. Flamboyant prose is permitted only when the genre and moment justify it (a moment of high lyrical emotion, a comedic narrator's voice). When in doubt, transparent.""",
    "follett_seeds.prose.diction": """\
When English offers two words for the same concept, prefer the Anglo-Saxon (earthier, shorter, more direct) over the Latinate (formal, longer, distancing). Some pairs:

malediction -> curse; maternal -> motherly; residence -> home; ignominy -> shame; commence -> begin/start; purchase -> buy; inquire -> ask; edifice -> building; fatigue -> tiredness; discussion -> talk; companion -> friend; proceed -> go; verify -> check; endeavor -> try; sufficient -> enough.

This is not absolute. Latinate words are correct in formal registers, academic contexts, period speech of the educated upper classes, and when the Anglo-Saxon would be tonally wrong. But the default leans Anglo-Saxon for popular fiction prose.""",
    "follett_seeds.prose.first_line": """\
You are writing the first line of {project_title}. The first line is the most important sentence in the book. It is: a sales tool (browsers read it before buying), a contract (sets expectations), a hook (catches attention immediately), and a tone-setter.

Generate 8 candidate first lines. Each must satisfy AT LEAST TWO of these patterns (Follett's taxonomy):
1. INTRIGUING — raises a question the reader must answer.
2. MYSTERIOUS — opens with the surreal or impossible.
3. SHOCKING — a "gotcha" that demands explanation.
4. FUNNY — a joke that also tells you about the world.
5. TONE-SETTING — establishes the world and the register.
6. ATMOSPHERIC — sets a mood with vivid sensory detail.
7. DECLARATIVE-AND-LOADED — short, simple, implies more than it states ("The small boys came early to the hanging." "The last camel collapsed at noon.").
8. CHARACTER-DEFINING — opens with a person whose voice tells you everything.

For each candidate, label which patterns it uses and why it works for THIS novel. Then rank them — the strongest first line does the MOST jobs in the FEWEST words; bias toward short declarative sentences with implication.

Forbidden: "It was a dark and stormy night."; "The sun rose over the [location]."; anything that begins with weather alone; anything longer than 25 words; anything that begins with the protagonist waking up.""",
    "follett_seeds.prose.dialogue": """\
Write dialogue that is SNAPPY, not realistic. Real conversation is incomprehensible on the page. Apply:

1. Tennis-match rhythm — short lines, quick alternation, each line advances or shifts position. Long monologues only in clear character beats (interrogations, confessions, public speeches).
2. Distinguish characters by DICTION (word choice, sentence rhythm, vocabulary range, tendency toward direct or indirect statement) — NOT by phonetic spelling of accent.
3. Don't write dialect like 'cos I were wonderin'. Do: have one character use shorter sentences than another; one more abstract, another more concrete; one ask questions, another make statements; one interrupt, another wait.
4. Forbidden: phonetic dialect for marginalized or poor characters when you would never do the same for posh ones. This is condescension.
5. Use "said" almost exclusively. Avoid "exclaimed," "ejaculated," "retorted," "expostulated." If you reach for a fancy tag, the dialogue itself probably isn't doing the work.
6. Use action beats between dialogue lines instead of adverb-laden tags. "She said angrily" -> "She slammed the cup down."
7. Conversation can carry story — a character who arrived after the action can be told what happened, with friction (the listener's reactions matter).

When in doubt, read your dialogue aloud. If it sounds like a transcript of two people talking, it's too realistic. If it sounds like a duel, it's right.""",
    "follett_seeds.prose.intimacy": """\
Sex scenes follow scene-construction rules. They are NOT decoration and NOT gratuitous. They are scenes with:

1. BEGINNING — preparation. The two characters have been moving toward this for many pages. Establish what each hopes for, what each fears (rejection, awkwardness, regret), and any external pressure.
2. MIDDLE — the encounter itself, written honestly but not gratuitously. Physical detail is calibrated to genre and the characters' familiarity. First encounters tolerate more uncertainty and discovery; later ones more economy.
3. END — one partner happy and the other unhappy, OR both happy, OR both unhappy. State which. The end answers (provisionally) whether they want to do it again.

Rules:
- Sex scenes are never the FIRST scene of the novel. Reader must care first.
- Match the characters' register. Worldly characters use frank words; shy characters use words they would actually think.
- Avoid crashing waves, erupting volcanoes, fountains, fireworks. Cliche orgasm imagery is comic.
- COERCION REBRANDED AS PASSION IS FORBIDDEN. Both parties want the encounter, even if uncertainly.
- Characters of all bodies and orientations: write with honesty and respect.
- Emotional weight matters more than physical detail. Euphemism for body parts ("his manhood," "her secret garden") is comic in serious prose.""",
    "follett_seeds.prose.action": """\
Action scenes follow scene-construction rules. They are not choreography — they are the PHYSICAL EXPRESSION of emotional history accumulated across the whole novel.

1. PREPARE THE GROUND — A fight between strangers is uninteresting; a fight between two characters with chapters of accumulated grudge is electrifying. Reference the grudge IN the action — what they say, remember, target.
2. BEGINNING — Hopes and fears of the POV character entering the action. The reader must know what would be won and lost.
3. MIDDLE — Sustained, with thinking time as well as moves. The character considers, fears, decides. Real-time duration roughly tripled in prose length.
4. END — Big external resolution that manifests the inner pressure (death, escape, victory, surrender), changing the characters beyond physical wounds.
5. RAISE THE STAKES INSIDE THE ACTION — Mid-scene, something else goes wrong (terrain turns hostile, a third party arrives, a weapon fails).

Forbidden: action as the first scene; action that doesn't move a major character arc; brief casual violence used only for pacing; heroic outcomes the characters' demonstrated competence wouldn't earn.

The action is symbolic AND literal (Anna Karenina under the train; Manderley burning; Quilp drowning). Both layers must work.""",
    "follett_seeds.prose.daily_rewrite": """\
Before generating new prose for this chapter, read the prose generated in the most recent prior session. Always change at least one thing. Improvements typically:
- Tighten dialogue (cut redundancies).
- Replace Latinate words with Anglo-Saxon equivalents.
- Cut adverbs.
- Replace passive constructions with active ones.
- Catch continuity slips (a character's eye color, a setting detail, a date).
- Strengthen the dramatic question of the prior scene's ending.

This is not optional. It keeps the prose tight and surfaces problems while they're still cheap to fix. Yesterday's draft is a draft, not a finished product.""",
    "follett_seeds.prose.no_boring": """\
After generating prose, scan it for boring paragraphs. A paragraph is BORING if:
- It contains no dramatic content (no story turn, no character action, no rising tension, no new information delivered as drama).
- It restates information the reader already has.
- It describes setting without a character interacting with it.
- It explains the historical period without any character noticing.
- It is pure transition ("they traveled for two days, arriving at...") without consequence.

When you find a boring paragraph, you MUST do one of: (a) cut it; (b) rewrite it as something a character notices, fears, or acts on; (c) replace it with a story turn — give the POV character a problem or goal that this paragraph dramatizes.

Follett: "Do not be tempted to think that some of the other scenes are so great that they will make up for the boring bits. You can't do that, because they won't. You have to be a perfectionist."

If you cannot kill the boring paragraph in (a), (b), or (c), the scene's design is wrong. Restructure the scene.""",
}


FOLLETT_SEEDS: dict[str, str] = {
    "follett_seeds.prime_directive": PRIME_DIRECTIVE,
    **_CHARACTER,
    **_PLOT,
    **_SCENE,
    **_RESEARCH,
    **_PROSE,
}


def load_follett_seeds() -> int:
    """Register every Follett craft seed as a prompt-store default. Idempotent. Returns the count."""
    store = get_prompt_store()
    for key, value in FOLLETT_SEEDS.items():
        store.register_default(key, value)
    return len(FOLLETT_SEEDS)


def compose_craft_system(
    *,
    seed_keys: list[str],
    genre_block: str = "",
    arc_block: str = "",
    include_prime_directive: bool = True,
) -> str:
    """Assemble a system prompt from the craft layers: prime directive + genre + arc + chosen seeds.

    This is the canonical composition order the write-workshop steps use (see the Writing Craft
    index): the Follett prime directive grounds everything, the genre sets the basic register, the
    story arc sets the structural beats, and the selected ``follett_seeds.*`` fragments guide the
    detail. Unknown seed keys raise ``KeyError`` so a typo fails loudly at call time.
    """
    store = get_prompt_store()
    parts: list[str] = []
    if include_prime_directive:
        parts.append(store.get("follett_seeds.prime_directive"))
    if genre_block.strip():
        parts.append(genre_block.strip())
    if arc_block.strip():
        parts.append(arc_block.strip())
    for key in seed_keys:
        parts.append(store.get(key))
    return "\n\n".join(p for p in parts if p.strip())
