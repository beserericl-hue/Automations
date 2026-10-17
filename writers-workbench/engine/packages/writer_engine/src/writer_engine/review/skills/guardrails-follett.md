# Follett-style guardrails (fiction / Writers Workbench)

The style layer for reviewing **fiction** — novel chapters written to the Ken Follett craft rules. Where
`working-overtime-guardrails.md` names what to catch in Every's non-fiction columns, this file names what
to catch in prose fiction, using the same rules the Workbench engine *writes* to (the Follett craft seeds,
`writer_engine/prompt_store/follett_seeds.py`). Citations `[Follett § N]` match that layer.

**Use this when the draft is a Workbench chapter / novel prose** (not an essay). It replaces the Every
column categories (5–6). Flag with diagnosis + fix; do not rewrite the whole draft.

---

## 1. Prose transparency `[Follett § prose.transparent]`

The reader should see THROUGH the sentence to the story, not look AT it.

- **Vague intensifiers that hide imprecise observation.** "It was as if…", "she felt a strange…", "a kind of…".
  *Fix:* replace with the concrete thing observed. If you can't name it, the sentence has no content — cut it.
- **Adverb-laden verbs.** "said quietly", "walked slowly", "smiled warmly."
  *Fix:* let the verb do the work ("whispered") or show it in action. Adjectives sparingly, adverbs almost never.
- **Latinate over Anglo-Saxon** `[§ prose.diction]`. commence/purchase/inquire/edifice/residence/proceed.
  *Fix:* begin/buy/ask/building/home/go — unless the register (educated period speech, formal context) demands otherwise.
- **Literary mannerisms at unearned moments.** Extended metaphor on a low-stakes beat; fancy synonyms for common words.
  *Fix:* transparent prose by default; flamboyance only at a genuine peak of lyrical or comedic emotion.
- **Long sentences without emotional justification.** Long only when the emotional content earns the length.
  *Fix:* break into short-to-medium, subject-verb-object.

## 2. Dialogue `[Follett § prose.dialogue]`

Snappy, not realistic — a duel, not a transcript.

- **Phonetic dialect** ("'cos I were wonderin'"), *especially* only for poor/marginalized characters.
  *Fix:* distinguish speakers by DICTION (sentence length, concrete vs abstract, questions vs statements), never by spelled-out accent. Phonetic dialect for some characters but not the posh ones is condescension — always flag.
- **Fancy speech tags.** "exclaimed", "ejaculated", "retorted", "expostulated."
  *Fix:* use "said" almost exclusively; if you're reaching for a fancy tag the line isn't doing the work.
- **Adverb dialogue tags.** "she said angrily."
  *Fix:* action beat instead — "She slammed the cup down."
- **Monologue where a volley belongs.** Long speeches outside interrogation/confession/public-speech beats.
  *Fix:* tennis-match rhythm — short lines, quick alternation, each line advances or shifts position.

## 3. Scene construction `[Follett § 09 / scene.bme_check / scene.turn_density]`

Every scene = a unit of drama, not a container of information.

- **No dramatic question.** A scene the reader could skip with nothing lost.
  *Fix:* give the POV character a want and a threat to it; open a question the scene (partly) answers.
- **Missing beginning-middle-end.** Scene starts mid-air or stops without a partial resolution.
  *Fix:* establish hopes/fears → escalate → land a partial resolution that raises the NEXT question.
- **Story-turn drought** `[§ 04]`. Long stretch with no reversal.
  *Fix:* a turn (up→down or down→up) every four to six pages; 3–8 distinct dramatic scenes per chapter `[§ scene.turn_density]`.
- **Information as lecture** `[§ scene.info_as_drama]`. Backstory/world facts delivered flat.
  *Fix:* dramatize it — a character *learns* it under pressure, with the listener's reaction as friction. If it can't be dramatized, cut it.
- **POV chosen by importance, not stake** `[§ character.pov_selector]`.
  *Fix:* the POV is whoever cares MOST about this scene's outcome — highest emotional stake, not most information.

## 4. Character `[Follett § character.*]`

- **Milk-and-water POV** `[§ character.no_milk_and_water]`. Cautious, agreeable, life-flows-by protagonists.
  *Fix:* POV characters must get into trouble; even quiet ones need an inner pressure that explodes under stress.
- **The too-perfect good guy** `[§ character.good_guy_humanizer]`. Intelligent, kind, brave — and boring.
  *Fix:* one humanizing flaw/quirk/vice, shown in their first scene, not just narrated.
- **No moral complication** `[§ character.moral_complication]`. Every choice is easy.
  *Fix:* at least one principal faces a dilemma the reader can't easily resolve — the tempting path is the wrong one, and it stays a dilemma until they act.
- **Roster drift** `[§ character.locked_roster]`. A name spelling / role / trait changes between chapters, or a new character appears in a revision.
  *Fix:* preserve the locked cast exactly. (The Workbench drift scanner catches name variants — treat any it surfaces as a hard flag.)

## 5. No boring bits / pacing `[Follett § 03 / plot.anti_sog / scene.ups_and_downs]`

- **Flat, eventless passage.** "If you want to write a popular bestseller, you can't have boring bits."
  *Fix:* cut it or give it a turn. Every retained paragraph earns its place with tension, motion, or revelation.
- **Soggy middle** `[§ plot.anti_sog]`. The chapter sags between set-pieces.
  *Fix:* introduce a new complication, a subplot cross, or raise the stakes on the standing question.
- **Monotone emotional line** `[§ scene.ups_and_downs]`. All tension or all calm.
  *Fix:* alternate — a win before a loss lands harder; a breath before a blow.

## 6. Research & period `[Follett § research.*]`

- **Research dump** `[§ research.no_dumping]`. The author showing their homework.
  *Fix:* only the facts a character would notice, delivered as scene texture, never as a paragraph of exposition.
- **Anachronistic language** `[§ research.period_language]`. Modern idiom in period dialogue/narration.
  *Fix:* diction consistent with the era; flag any word that would not exist in the period.
- **No local color** `[§ research.local_color]`. Setting is generic.
  *Fix:* one or two specific, sensory, period-true details that only this place/time would have.

## 7. First line / opening `[Follett § prose.first_line]`

- **Dead openings.** Weather alone; "The sun rose over…"; protagonist waking up; anything over ~25 words.
  *Fix:* a first line that does the most jobs in the fewest words — intriguing / mysterious / shocking / declarative-and-loaded ("The small boys came early to the hanging.").

---

## Severity note for fiction

Flag hardest on: milk-and-water POV, a scene with no dramatic question, a story-turn drought, phonetic
dialect, and research dumps — these are structural, not cosmetic. Ration prose-transparency nits (one pass,
note the pattern, don't flag every adverb). A single flamboyant sentence at a real emotional peak is the
allowed exception, not a violation — note it and let the author decide.
