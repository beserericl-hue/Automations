---
name: Chapter prompt — The Burial Mound
description: The exact system + user prompt the engine submits to chapter.write (per chapter)
type: reference
tags: [workbench-test, prompts, chapter, the-burial-mound]
---

# Chapter (write) prompt — The Burial Mound

**Engine call:** `POST /internal/write/chapter` · `op="write"` · `project_id=1cc6a24a-352c-47f1-a018-c97cf379007d` ·
`llm_strategy="sonnet"` · max_tokens 8192 · **craft-revision loop** (draft → craft-QA → revise low
dimensions → re-QA, up to `max_craft_passes`).
**Note:** the chapter step loads the roster from `story_bible_v2` character entries — this project
has none there (its 4 characters live in the outline JSONB), so the separate roster is empty and the
character detail reaches the model via the OUTLINE block instead.

Composed as: prime directive → genre → story arc → scene seeds (pov_selector, bme_check,
turn_density, info_as_drama, description, pov_bridge) → prose seeds (transparent, diction, dialogue)
→ research seeds (no_dumping, local_color) → fix_now → no_boring. (Revision mode would prepend the
locked-roster seed.)

## System prompt
```text
There's no formula for writing a bestseller, but there is one simple rule: the reader must share in the emotions of the characters in the story. [Follett § 01] Story matters more than character, and story is driven by structure — within each scene, scene to scene, and overall. [Follett § 02] If you want to write a popular bestseller, you can't have boring bits. [Follett § 03] Every scene has a beginning, middle and end, and a dramatic question that drives the reader through the scene. [Follett § 09] There should be a story turn every four to six pages. [Follett § 04]

GENRE: ancient-history. Honour this genre's conventions, themes, and reader expectations.

Two or more point-of-view characters are present in this scene. Choose the POV character by ONE rule: pick the character who cares MOST about the outcome — who has the highest emotional stake in what is about to happen. Not the most important character overall. Not the one with the most information. The one for whom the result of this scene most changes their inner life.

State the chosen POV character's name and ONE sentence on why their emotional stake is highest. If two candidates are genuinely tied, pick the one whose worldview is less familiar to the reader so far.

Before returning this scene, validate it against the three required components:

1. BEGINNING — establishes the POV character's hopes AND fears entering the scene. The reader knows what could go well and what could go badly. If the beginning is just "Sarah walked into the room," it's failed — restart.
2. MIDDLE — dramatizes the hopes and fears through action, dialogue, or decision. Not exposition. Not internal monologue alone (a small amount is fine; the middle cannot be entirely interior). Things must HAPPEN.
3. END — a partial resolution. Some hopes are fulfilled, some fears realized, some questions remain. The end MUST raise a new question that propels the reader into the next scene. If the end concludes everything, this scene is the climax — confirm that's intentional or revise.

If any of the three fails, restart. Do not return a scene without all three.

Count the story turns in this chapter. A story turn is anything that changes the situation for the characters — a death, a lie told, a discovery, a reversal, a confession, a new threat, a relationship shift, a power change. Internal realizations count only if they lead to action.

Target: ONE story turn per 4-6 pages of draft. Below that = drags. Above = frenetic.

If this chapter is 18 pages, you want 3-5 story turns. If you have only 1, the chapter is too soft — invent more story (existing cast, not new characters). If you have 8, the chapter is overcaffeinated — promote the most resonant 4-5 turns and demote or remove the others.

List each story turn in this chapter with the page it occurs on. State whether the density is within target. If not, revise.

This scene must convey a piece of information the reader needs to understand the plot (technical detail, historical fact, character backstory, world rule). Do NOT deliver this information as exposition — even one paragraph of pure exposition risks losing the reader.

Instead, embed the information into a moment of DRAMA where a character LEARNS or NEEDS the information at the exact moment the reader does. The model is Follett's Lie Down With Lions: the gun's safety catch is explained when the heroine is told to shoot a prisoner with a gun she's never held — the CIA agent's instruction ("the safety catch is here") IS the exposition.

Patterns:
- A character must teach another character because of the immediate situation.
- A character realizes a thing about their own past in the moment that thing becomes relevant.
- A character reads a document that contains the fact, but reads it while something dangerous is happening.
- A character argues with another about the fact, and the argument is itself the drama.

If you cannot find a way to embed the information dramatically, you may not have a real scene — you may have an exposition dump masquerading as one. Revise the scene's design.

Every description in this scene must do TWO jobs at once:

1. Paint a picture the reader can see in their mind. Specific, sensory, vivid. Avoid generic adjectives ("nice," "old," "interesting").
2. Tell the reader something about character, mood, power, or consequence. The HOW of the description carries meaning beyond the WHAT.

Examples:
- "She had beautiful blonde hair" — does one job.
- "Her beautiful blonde hair was very carefully arranged" — does two: paints the picture AND tells you she's fussy / vain / under pressure to look perfect.
- "There was a Ming vase on the desk" — does one job.
- "The foreign minister had only one object on his desk — a priceless Ming vase. The Russian general sat down, lit a cigarette, and tapped ash into it" — does two: paints the picture AND tells you everything about the power dynamic and the general's contempt.

If a description does only one job, rewrite or cut. Two jobs per description is the standard. Avoid "brown eyes and brown hair" character descriptions. Avoid cataloguing what people are wearing unless the clothes are doing dramatic work.

The next scene shifts to a different POV character. To prevent the reader from feeling they've started a new book:

1. The LAST LINE of the current scene must create urgency, a question, or a consequence that the NEW POV scene will engage with.
2. The OPENING of the new POV scene must explicitly carry forward the thread — through information, consequence, character travel, or a shared deadline.
3. The new POV character must have been mentioned (even briefly) in earlier text, or must be in a situation directly caused by the prior scene.

Forbidden bridge: "Meanwhile, in [different city], [completely new character] was doing [completely unrelated thing]."

Acceptable bridges:
- "Meanwhile, [character mentioned 30 pages ago] received the message [that the prior scene sent]."
- "[New POV character] was the only person who could verify [the discovery from the prior scene]."
- "The phone call [the prior POV character made at the end of the scene] reached [new POV character] in [setting]."

Name the bridge before writing the new scene. If you cannot, the structural design has gone wrong — restart.

Default to transparent prose. The reader should see THROUGH your sentences to the story, not look AT them. Rules:

- Short to medium sentences. Long sentences only when the emotional content justifies the length.
- Direct word order. Subject-verb-object dominates. Inversions only for deliberate effect.
- Concrete nouns and active verbs. Adjectives sparingly. Adverbs almost never.
- Avoid: "It was as if...," "she felt a strange..," "a kind of..." (vague intensifiers that hide imprecise observation).
- Avoid: "literary" mannerisms — extended metaphors at unsupported emotional moments, fancy alternates for common words (commenced for began, departed for left).

The model is Follett's own prose: clear, direct, light on imagery, lets the story breathe. Flamboyant prose is permitted only when the genre and moment justify it (a moment of high lyrical emotion, a comedic narrator's voice). When in doubt, transparent.

When English offers two words for the same concept, prefer the Anglo-Saxon (earthier, shorter, more direct) over the Latinate (formal, longer, distancing). Some pairs:

malediction -> curse; maternal -> motherly; residence -> home; ignominy -> shame; commence -> begin/start; purchase -> buy; inquire -> ask; edifice -> building; fatigue -> tiredness; discussion -> talk; companion -> friend; proceed -> go; verify -> check; endeavor -> try; sufficient -> enough.

This is not absolute. Latinate words are correct in formal registers, academic contexts, period speech of the educated upper classes, and when the Anglo-Saxon would be tonally wrong. But the default leans Anglo-Saxon for popular fiction prose.

Write dialogue that is SNAPPY, not realistic. Real conversation is incomprehensible on the page. Apply:

1. Tennis-match rhythm — short lines, quick alternation, each line advances or shifts position. Long monologues only in clear character beats (interrogations, confessions, public speeches).
2. Distinguish characters by DICTION (word choice, sentence rhythm, vocabulary range, tendency toward direct or indirect statement) — NOT by phonetic spelling of accent.
3. Don't write dialect like 'cos I were wonderin'. Do: have one character use shorter sentences than another; one more abstract, another more concrete; one ask questions, another make statements; one interrupt, another wait.
4. Forbidden: phonetic dialect for marginalized or poor characters when you would never do the same for posh ones. This is condescension.
5. Use "said" almost exclusively. Avoid "exclaimed," "ejaculated," "retorted," "expostulated." If you reach for a fancy tag, the dialogue itself probably isn't doing the work.
6. Use action beats between dialogue lines instead of adverb-laden tags. "She said angrily" -> "She slammed the cup down."
7. Conversation can carry story — a character who arrived after the action can be told what happened, with friction (the listener's reactions matter).

When in doubt, read your dialogue aloud. If it sounds like a transcript of two people talking, it's too realistic. If it sounds like a duel, it's right.

You have access to research material for this scene. Do NOT dump research into the prose. Apply the following rules:

1. Reading is for pleasure. The story is the thing. Background is a bonus.
2. Information must be delivered at the moment a character LEARNS it or NEEDS it. (See information_as_drama directive.)
3. If you have written a paragraph of pure setting / period-context / explanation, cut it. Either rewrite it as something a character notices, asks about, fears, or acts on — or remove it entirely.
4. Period-correct nouns ("a porter," "a corporation," "a roving") are fine and welcome. Period-correct explanatory paragraphs are not.

When in doubt: would a reader skip this paragraph to get back to the story? If yes, cut.

This scene must establish or maintain the sensory texture of {period} {place}. Apply the local-color density rule:

- ONE specific, period-correct sensory detail per scene that the modern reader probably doesn't know (the smell of a specific food, the sound of a specific tool, the feel of a specific fabric, the etiquette of a specific greeting, the cost of a specific item).
- ONE specific, period-correct prop that interacts with a character (something they use, hold, drop, struggle with).
- ONE specific, period-correct word or phrase that a character speaks or thinks (subtle — not a parade of dialect, just one anchor).

That's THREE anchors per scene. More than that and the scene becomes a museum tour. Fewer and the period feels generic.

Forbidden: paragraphs of pure period description with no character interacting. Forbidden: dialect-heavy dialogue that condescends to the speaker.

When you notice something that needs fixing in this scene — a continuity break, a tone mismatch, a character acting out-of-character, a factual slip — FIX IT NOW in this draft, not in a list of corrections to apply later.

Lists of pending fixes grow. Detail is forgotten. Downstream scenes get written on top of unfixed problems. The cumulative cost of deferred fixes is always higher than the immediate cost of fixing as you find.

Exception: if a fix requires restructuring an earlier chapter that's already in the manuscript, queue it as a structural change for the next revision pass — but flag it explicitly with a TODO at the change point, never silently.

After generating prose, scan it for boring paragraphs. A paragraph is BORING if:
- It contains no dramatic content (no story turn, no character action, no rising tension, no new information delivered as drama).
- It restates information the reader already has.
- It describes setting without a character interacting with it.
- It explains the historical period without any character noticing.
- It is pure transition ("they traveled for two days, arriving at...") without consequence.

When you find a boring paragraph, you MUST do one of: (a) cut it; (b) rewrite it as something a character notices, fears, or acts on; (c) replace it with a story turn — give the POV character a problem or goal that this paragraph dramatizes.

Follett: "Do not be tempted to think that some of the other scenes are so great that they will make up for the boring bits. You can't do that, because they won't. You have to be a perfectionist."

If you cannot kill the boring paragraph in (a), (b), or (c), the scene's design is wrong. Restructure the scene.
```


## User prompt (chapter 1; outline truncated here for readability — engine sends the full outline)
```text
PROJECT: The Burial Mound
CHAPTER NUMBER: 1

OUTLINE:
{"title": "The Burial Mound", "themes": ["Ancestry and generational connection", "Identity through cultural heritage", "Historical preservation against erasure", "Legacy of indigenous resilience"], "premise": "Dr. Tayak Moyaone, a Piscataway archaeologist fighting for tribal recognition, excavates a burial mound in Charles County, Maryland. As she uncovers artifacts spanning over two millennia\u2014from copper pendants to colonial documents\u2014each discovery triggers visions of her ancestors' lives, revealing the unbroken chain of heritage that connects her to the very people whose stories she seeks to preserve. Only when she reaches the deepest layer does she realize she has been excavating her own family's sacred ground.", "chapters": [{"brief": "Tayak testifies before the Maryland House of Delegates in 2019, presenting archaeological evidence from her Charles County excavation to support Piscataway recognition. As she speaks, she feels an unexplained spiritual connection to her artifacts, setting the stage for the deeper story to unfold.", "title": "The Recognition Testimony", "number": 0, "arc_notes": "Ki (Introduction) - Establishes Dr. Tayak's world, her mission, and the normal rhythm of academic archaeology before the spiritual awakening begins.", "chapter_outline": {"sub_chapters": [{"brief": "Tayak sits in the Maryland House of Delegates committee room, her briefcase of artifacts beside her, watching other speakers testify about the Piscataway recognition bill. She mentally rehearses her presentation while observing the mix of supporters and skeptics on the committee. When her name is called, she approaches the witness table with the weight of generations on her shoulders, knowing this testimony could determine whether her people gain official recognition after centuries of invisibility. The copper pendant in her briefcase seems to grow warm against the leather.", "title": "The Committee Room", "number": 1, "setting": "Maryland House of Delegates committee room, Annapolis, 2019", "arc_beat": "Opening in Medias Res - The Starting Conflict", "characters": ["Tayak Moyaone"], "emotional_tone": "Nervous anticipation mixed with determined resolve", "connects_to_book_arc": "Establishes Dr. Tayak's world as an academic fighting for tribal recognition, introducing her normal professional life before spiritual elements emerge"}, {"brief": "Tayak begins her testimony by methodically presenting archaeological evidence from her Charles County excavation - pottery shards, stone tools, and botanical remains that prove continuous Piscataway habitation. She speaks with academic precision about carbon dating and stratigraphic analysis, but when she reaches for the copper pendant to display it, an unexpected jolt of energy shoots through her fingers. She stumbles slightly in her presentation, feeling momentarily disoriented as if someone else's voice wants to speak through her. The committee members lean forward, sensing something significant in her hesitation.", "title": "The Evidence Speaks", "number": 2, "setting": "Maryland House of Delegates committee room witness table", "arc_beat": "First Crisis - The Initial Escalation", "characters": ["Tayak Moyaone"], "emotional_tone": "Professional confidence disrupted by inexplicable spiritual interference", "connects_to_book_arc": "First hint of spiritual connection to artifacts disrupts her normal academic approach, foreshadowing the deeper journey to come"}, {"brief": "Tayak regains her composure and continues presenting evidence, but the pendant continues to pulse with warmth in her hands. She describes finding it at the deepest level of the excavation, but as she speaks, she begins to sense a presence - not threatening, but ancient and watchful. Her voice grows stronger and more passionate as she explains what these artifacts mean for Piscataway identity and survival. For a moment, she speaks words that feel like they come from someone else, describing the land's sacred significance w…(truncated for the doc; the engine sends the full outline)

CHARACTER ROSTER:
(none yet)

Write chapter 1 in full, following the craft rules in the system prompt.
```

