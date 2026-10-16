---
name: Prose Style, Dialogue, and Set Pieces — Follett craft + engine prompts
description: Follett's sentence-level rules — transparent prose, Anglo-Saxon over Latin, dialogue without parodied accent, the first-line hook, sex and violence as physical expression of emotional history — distilled into LLM directives for the chapter_step prose generator and the first-chapter / climax generators.
type: concept
tags: [writing-craft, prose, dialogue, first-line, sex, violence, chapter, follett]
source: KenFollett_WritingBestsellingFiction_BBCMaestro_CourseNotes.pdf § 08, § 12, § 14
last_reviewed: 2026-05-31
---

# Prose Style, Dialogue, and Set Pieces

> "A sentence should be like a glass window: you don't look at it, but through it." [Follett § 14]

## Principles

1. **Transparent prose is the default.** Follett's windowpane style: clear, direct, light on imagery. The reader should not notice the prose; they should see through it to the story. Most popular bestsellers use this register.
2. **Flamboyant prose is a choice, not an accident.** Dickens, Wodehouse, Roth, Knausgård all write differently. Their voices work because they chose them and committed. If you can't sustain a stylistic effect across a whole novel, default to transparent.
3. **Anglo-Saxon over Latin.** When English offers two words for the same thing — one Latinate, one Anglo-Saxon — pick the Anglo-Saxon. "Curse" not "malediction." "Motherly" not "maternal." "Home" not "residence." "Shame" not "ignominy." The Anglo-Saxon word is shorter, earthier, more emotionally direct, and lands harder.
4. **Imitation is a phase, not a destination.** It's fine to start by writing like Chandler or Hammett or your favorite. You won't sound like them; you'll sound like you in a particular mode. Use imitation as apprenticeship; it teaches you what you like and don't like.
5. **Dialogue: don't parody accents.** Writing dialect ("'cos I were wonderin'") usually condescends to the speaker — especially if you only do it for poor or marginalized characters and not for posh ones. Most writers' characters speak in the author's natural register; that's fine. Distinguish characters through diction choices, vocabulary range, and reaction patterns, not phonetic spelling.
6. **Dialogue is snappy, not realistic.** Real conversation is incomprehensible on the page. Good dialogue is short, quick-fire, with each line advancing position — Ed McBain's detective interrogations are the model. Tennis match, not transcript.
7. **First line does a lot of work.** The first line of a novel is a sales tool, a hook, a tone-setter, a contract with the reader. "The small boys came early to the hanging" (Pillars). "The last camel collapsed at noon" (Key to Rebecca). "Once upon a time, a long time ago, in a land far far away." Simple, declarative, surprising, weighted with implication.
8. **Sex scenes have beginning, middle, end.** Like every other scene. They are the physical expression of long-built emotional tension. Two characters jumping into bed without preparation isn't a love scene; it's a stunt.
9. **Action scenes have beginning, middle, end.** A fight between strangers is uninteresting. A fight between two characters with hundreds of pages of accumulated grudge is electrifying. The action is the EXPRESSION of the emotional history — that's why Anna Karenina throws herself under a train, why Manderley burns down, why Quilp drowns. Big external action manifests inner pressure.
10. **Sex/violence is never the first scene.** Readers must care about the characters first. Without emotional investment, the action is choreography. Save the set pieces for after the reader is committed.
11. **Action and sex scenes should LAST.** A 1-page fight is a missed opportunity. A 5-page fight that pays off chapters of buildup is satisfying. Multiply real-time duration by ~3 for prose length.
12. **No coercion-rebranded-as-passion.** The classic "strong-willed man overcomes woman's resistance, she ends up loving it" trope is wrong for today's literature. Forbidden. (Follett, on his own evolution.)
13. **Don't shy from physical detail, but don't gratuitize.** Sex/violence should be honest about what happens but should not luxuriate. The point is emotional truth, not titillation or shock.
14. **Read what you wrote yesterday. Improve it.** Every morning. Always change something. This is how prose tightens.

## Prompt fragments for the engine

### `follett_seeds.prose.transparent_default`

System-level directive for `chapter_step` prose generation.

```text
Default to transparent prose. The reader should see THROUGH your sentences to the story, not look AT them. Rules:

- Short to medium sentences. Long sentences only when the emotional content justifies the length.
- Direct word order. Subject-verb-object dominates. Inversions only for deliberate effect.
- Concrete nouns and active verbs. Adjectives sparingly. Adverbs almost never.
- Avoid: "It was as if...," "she felt a strange..," "a kind of..." (vague intensifiers that hide imprecise observation).
- Avoid: "literary" mannerisms — extended metaphors at unsupported emotional moments, fancy alternates for common words (commenced for began, departed for left).

The model is Follett's own prose: clear, direct, light on imagery, lets the story breathe. Flamboyant prose is permitted only when the genre and moment justify it (a moment of high lyrical emotion, a comedic narrator's voice). When in doubt, transparent.
```

### `follett_seeds.prose.anglo_saxon_over_latin`

Append to every prose-generation pass.

```text
When English offers two words for the same concept, prefer the Anglo-Saxon (earthier, shorter, more direct) over the Latinate (formal, longer, distancing). Some pairs:

malediction → curse
maternal → motherly
residence → home
ignominy → shame
commence → begin / start
purchase → buy
inquire → ask
edifice → building
fatigue → tiredness
discussion → talk
companion → friend
proceed → go
verify → check
endeavor → try
sufficient → enough

This is not absolute. Latinate words are correct in formal registers, academic contexts, period speech of the educated upper classes, and when the Anglo-Saxon would be tonally wrong. But the default leans Anglo-Saxon for popular fiction prose.
```

### `follett_seeds.prose.first_line_generator`

For `chapter_step` when writing the FIRST line of a novel or major part. Special prompt — first lines warrant individual attention.

```text
You are writing the first line of {project_title}. The first line is the most important sentence in the book. It is:

(a) A sales tool — bookshop browsers read it before buying.
(b) A contract — sets expectations the rest of the book will meet.
(c) A hook — catches the reader's attention immediately.
(d) A tone-setter — tells the reader what kind of story they're in for.

Generate 8 candidate first lines. Each must satisfy AT LEAST TWO of these patterns (Follett's taxonomy):

1. INTRIGUING — raises a question the reader must answer. "Until he was four years old, James Henry Trotter had a happy life." (What happened when he was four?)
2. MYSTERIOUS — opens with the surreal or impossible. "As Gregor Samsa awoke one morning from uneasy dreams, he found himself transformed in his bed into a giant insect."
3. SHOCKING — a "gotcha" that demands explanation. "There were only three of us left now; the others had been hung over the ramparts, one every morning."
4. FUNNY — a joke that also tells you about the world. "There were one hundred and seventeen psychoanalysts on the Pan Am flight to Vienna and I'd been treated by at least six of them."
5. TONE-SETTING — establishes the world and the register. "It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife."
6. ATMOSPHERIC — sets a mood with vivid sensory detail. "The scent and smoke and sweat of a casino are nauseating at three in the morning."
7. DECLARATIVE-AND-LOADED — short, simple, implies more than it states. "The small boys came early to the hanging." "The last camel collapsed at noon."
8. CHARACTER-DEFINING — opens with a person whose voice tells you everything. "Mr and Mrs Dursley of number four, Privet Drive, were proud to say that they were perfectly normal, thank you very much."

For each candidate, label which patterns it uses and why this first line works for this particular novel.

After generating 8, rank them. The strongest first line is usually the one that does the MOST jobs in the FEWEST words. Bias toward short declarative sentences with implication.

Forbidden:
- "It was a dark and stormy night."
- "The sun rose over the [location]."
- Anything that begins with weather alone.
- Anything longer than 25 words for the first line specifically (later sentences can be longer).
- Anything that begins with the protagonist waking up (overused).
```

### `follett_seeds.prose.dialogue_register`

For `chapter_step` dialogue passages.

```text
Write dialogue that is SNAPPY, not realistic. Real conversation is incomprehensible on the page. Apply:

1. Tennis-match rhythm — short lines, quick alternation, each line advances or shifts position. Long monologues only in clear character beats (interrogations, confessions, public speeches).
2. Distinguish characters by DICTION (word choice, sentence rhythm, vocabulary range, tendency toward direct or indirect statement) — NOT by phonetic spelling of accent.
3. Don't write dialect like 'cos I were wonderin'. Do write: have one character use shorter sentences than another. Have one use more abstract words, another more concrete. Have one ask questions, another make statements. Have one interrupt, another wait.
4. Forbidden: phonetic dialect for marginalized or poor characters when you would never do the same for posh ones. This is condescension. (Follett's rule.)
5. Use "said" almost exclusively. Avoid "exclaimed," "ejaculated," "retorted," "expostulated." If you find yourself reaching for a fancy dialogue tag, the dialogue itself probably isn't doing the work.
6. Use action beats (a character does something) between dialogue lines instead of adverb-laden tags. "She said angrily" → "She slammed the cup down." The action conveys the emotion.
7. Conversation can carry story. A character who arrived after the action can be told what happened, with friction (the listener's reactions matter). This is acceptable exposition.

When in doubt, read your dialogue aloud. If it sounds like a transcript of two people talking, it's too realistic. If it sounds like a duel, it's right.
```

### `follett_seeds.prose.sex_scene_construction`

For `chapter_step` when writing intimate scenes.

```text
Sex scenes follow scene-construction rules. They are NOT decoration, NOT icing, NOT gratuitous. They are scenes with:

1. BEGINNING — preparation. The two characters have been moving toward this moment for many pages. Establish what each hopes for in the encounter, what each fears (rejection, awkwardness, regret), and any external pressure (a deadline, a lie maintained, a partner not present).
2. MIDDLE — the encounter itself, written honestly but not gratuitously. The level of physical detail is calibrated to the genre and the characters' familiarity with each other. First encounters tolerate more uncertainty and discovery; later encounters tolerate more economy.
3. END — one partner is happy and the other unhappy, OR both happy, OR both unhappy. State which, by implication or directly. The end answers (provisionally) whether they want to do it again.

Rules:
- Sex scenes are never the FIRST scene of the novel. Reader must care first.
- Sex scenes match the characters' register. Worldly characters use frank words; shy characters use words they would actually think. Don't import a register that doesn't fit them.
- Avoid crashing waves, erupting volcanoes, fountains, fireworks. Cliché imagery for orgasm is comic. Subtle, unexpected imagery if any.
- COERCION REBRANDED AS PASSION IS FORBIDDEN. The classic trope of the resistant woman who comes to enjoy it is wrong for today's literature. Both parties want the encounter, even if uncertainly.
- Same-sex, hetero-sex, characters of all bodies: write with honesty and respect. Don't shy from intimacy if the story calls for it. Conservative readers who object should buy different books.
- The scene's emotional weight matters more than its physical detail. A subtle moment can be more erotic than an explicit one.
- Don't be afraid to say what happens. Euphemism for body parts ("his manhood," "her secret garden") is comic in serious prose.
```

### `follett_seeds.prose.action_scene_construction`

For `chapter_step` when writing fight / chase / battle / climactic action scenes.

```text
Action scenes follow scene-construction rules. They are not choreography — they are the PHYSICAL EXPRESSION of emotional history that has accumulated across the entire novel.

Apply:

1. PREPARE THE GROUND — A fight between strangers is uninteresting. A fight between two characters with chapters of accumulated grudge is electrifying. Reference the grudge IN the action — through what they say, what they remember, what they target. The fight is about the history.
2. BEGINNING — Hopes and fears of the POV character entering the action. The reader must know what would be won and what would be lost. Without stakes, the action is sport.
3. MIDDLE — Sustained, with thinking time as well as moves. The character considers, fears, decides. Not pure choreography. Real-time duration ≈ 1 page of prose for every 15 seconds of action (Follett's heuristic: multiply real time by ~3).
4. END — Big external resolution that manifests the inner pressure. Death, escape, victory, surrender. The action's outcome should change the characters in ways that go beyond physical wounds.
5. RAISE THE STAKES INSIDE THE ACTION — Mid-fight, something else goes wrong. The terrain becomes hostile. A third party arrives. A weapon fails. The stakes keep escalating until the resolution.

Forbidden:
- Action scenes as the first scene of a novel. Reader must care first.
- Action scenes that don't move at least one major character arc forward.
- Brief, casual violence used for pacing rather than payoff.
- Heroic outcomes that the characters' demonstrated competence wouldn't earn.

Examples for reference:
- Anna Karenina throws herself under a train — physical expression of intolerable emotional torment.
- Rebecca: Manderley burns — physical expression of the new wife's torment by the ghost of the predecessor.
- The Old Curiosity Shop: Quilp drowns — physical expression that the unstoppable evil is stoppable by the ordinary world.

The action is symbolic AND literal. Both layers must work.
```

### `follett_seeds.prose.daily_rewrite_directive`

Meta-directive that affects how the engine handles incremental writing.

```text
Before generating new prose for this chapter, read the prose generated yesterday (or the most recent prior session). Always change at least one thing. Improvements typically:

- Tighten dialogue (cut redundancies).
- Replace Latinate words with Anglo-Saxon equivalents.
- Cut adverbs.
- Replace passive constructions with active ones.
- Catch continuity slips (a character's eye color, a setting detail, a date).
- Strengthen the dramatic question of the prior scene's ending.

This is not optional. It both keeps the prose tight and surfaces problems while they're still cheap to fix. Yesterday's draft is a draft, not a finished product.
```

### `follett_seeds.prose.boring_paragraph_kill`

Self-validation for `chapter_step` prose.

```text
After generating prose, scan it for boring paragraphs. A paragraph is BORING if:

- It contains no dramatic content (no story turn, no character action, no rising tension, no new information delivered as drama).
- It restates information the reader already has.
- It describes setting without a character interacting with it.
- It explains the historical period without any character noticing.
- It is pure transition ("they traveled for two days, arriving at...") without consequence.

When you find a boring paragraph, you MUST do one of:
(a) Cut it.
(b) Rewrite it as something a character notices, fears, or acts on.
(c) Replace it with a story turn — give the POV character a problem or a goal that this paragraph dramatizes.

Follett: "Do not be tempted to think that some of the other scenes are so great that they will make up for the boring bits. You can't do that, because they won't. You have to be a perfectionist."

If you cannot kill the boring paragraph in (a), (b), or (c), the scene's design is wrong. Restructure the scene.
```

## Examples from Follett

- **Transparent prose** — Follett's own paragraphs throughout, e.g., the opening of *Eye of the Needle*: "It was the coldest winter for forty-five years. Villages in the English countryside were cut off by the snow, and the Thames froze over."
- **Flamboyant prose (counter-example)** — Dickens on Wackford Squeers: "...he appeared ill at ease in his clothes, as if he were in a perpetual state of astonishment at finding himself so respectable." Works for Dickens. Don't try unless you can sustain it.
- **First lines studied in detail** — Follett devotes Lesson 08 to first lines and provides the canonical taxonomy. The engine's first_line_generator implements that taxonomy directly.
- **Dialogue as tennis match** — Ed McBain's 87th Precinct interrogations, which Follett cites as the model.
- **Sex scenes done well** — Follett notes the modern reader expects honesty in physical detail after long buildup; the Pillars of the Earth scenes are his examples of post-buildup payoff that respects the reader.
- **Action as emotional climax** — *Eye of the Needle's* cliff-edge fight, which Follett cites as bringing emotional + physical layers together.

## Engine integration

| Prompt fragment | prompt_store key | Consumed by | When |
|---|---|---|---|
| transparent_default | `follett_seeds.prose.transparent` | chapter_step | System block for all prose generation |
| anglo_saxon_over_latin | `follett_seeds.prose.diction` | chapter_step | Append to every prose pass |
| first_line_generator | `follett_seeds.prose.first_line` | chapter_step | Special — chapter 1 opening |
| dialogue_register | `follett_seeds.prose.dialogue` | chapter_step | Dialogue-heavy scenes |
| sex_scene_construction | `follett_seeds.prose.intimacy` | chapter_step | Intimate scenes |
| action_scene_construction | `follett_seeds.prose.action` | chapter_step | Fight / chase / battle / climactic scenes |
| daily_rewrite_directive | `follett_seeds.prose.daily_rewrite` | chapter_step | Meta — applied between sessions |
| boring_paragraph_kill | `follett_seeds.prose.no_boring` | chapter_step | Self-validation pass on every chapter |

The chapter_qa_step "boring paragraph" check could be implemented as a deterministic regex pre-filter (looking for paragraphs with no dialogue + no action verbs + length > 100 words) plus an LLM judgment call for borderline cases.

The dialogue register check could measure: average line length, ratio of "said" to fancy tags, presence of phonetic dialect (regex for apostrophe-heavy strings), and character-distinguishing diction (using a per-character word-frequency baseline).

## See also

- [[character-development]] — character voices that drive dialogue.
- [[scene-pace-and-story-turns]] — scene structure that prose serves.
- [[plot-and-narrative-structure]] — plot-level questions about pacing.
- [[research-and-local-color]] — period language constraints on prose.
- [[_index]] — Writing Craft index.
