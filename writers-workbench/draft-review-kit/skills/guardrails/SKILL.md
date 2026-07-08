---
name: guardrails
description: "Scan any Every draft for recurring editorial-review failures: clarity and evidence gaps, argument problems, mechanics red flags, second-order AI tells, and, for Working Overtime only, column-specific voice tics and structural throat-clearing. Use when reviewing or polishing Every writing before submission. Reports findings with line-level diagnoses and suggested fixes. Pairs with ai-check and every-style."
user_invocable: true
---

# Guardrails

## Overview

This skill scans drafts against patterns that recur in Every pre-publication review. The first four categories apply to any Every draft. Categories 5 and 6 are Working Overtime-specific; do not apply them to other columns or ghostwritten work.

This skill produces a findings report. It does **not** rewrite the whole draft. Katie wants to see flags with diagnoses and suggested fixes, then make the editorial calls herself.

## When this skill auto-triggers

- Reviewing any Every draft for pre-publication
- Polishing a draft when AI tells have been flagged
- Invoked explicitly via `/guardrails`
- Any Every draft review request that mentions "scan," "check," "review," "tighten," or "flag"

For generic AI-tell detection, use `ai-check`. For Every house mechanics, use `every-style`. For residual process narration, use `tracks`. All four can run in sequence; this skill is the substantive editorial guardrail layer.

## Detection categories

### Universal: apply to every Every draft

1. **Editorial clarity and evidence** — missing "why" or "so what," missing specifics, unidentified people/companies/terms, source and attribution gaps, TKs in review copy, jargon without translation, naming a tool when the category is the point, and muddy connective logic.
2. **Argument-level guardrails** — straw men, false binaries, AI determinism, technical intimidation, suffering Olympics, false universality.
3. **Mechanics-level guardrails** — hedges, correlative constructions, rhetorical questions as filler, meandering intros, sentimental conclusions, metaphors without payoff, unexplained technical terms.
4. **AI tells beyond the standard lexicon** — aphoristic balance closes, "I don't mean X. I mean Y" redirects, pseudo-Q&A bridges, and reader-projection "Maybe" anaphora.

### Working Overtime only: skip for other formats

5. **Voice tics at risk of overuse** — "messy middle" fingerprint phrase, italicized closing mantra, Then/Now temporal opener.
6. **Structural throat-clearing** — structural self-naming announcements, "(and what it isn't)" subheads, standardized build-your-own appendix.

## Editorial Clarity And Evidence Checks

Run these first on every draft:

- Translate AI-flavored or branded-sounding phrasing into plain English.
- Add the reason when a recommendation or claim leaves the reader asking why it is important.
- Give abstract concepts a concrete example and numbers a meaningful comparison.
- Identify people, companies, acronyms, and specialist terms on first mention.
- Attribute factual claims, statistics, trend statements, and quotes. If no source exists, narrow or cut the claim.
- Resolve body-copy `TK`s before editorial review; surface any unresolved gap separately.
- Define necessary jargon on first use or replace it with plain language.
- Name the tool category when the point is general; name the specific tool only when its identity matters.
- State the connection between grouped examples explicitly or cut the grouping.

For any Every scan, read `references/editorial-clarity-evidence.md` for the universal criteria. For expanded Working Overtime examples and earlier pattern history, read `references/working-overtime-guardrails.md` only when reviewing Working Overtime.

## Scan workflow

### Step 1: Identify the content type

Determine whether the draft is Working Overtime or another Every format. This sets whether Categories 5 and 6 apply.

### Step 2: Scan in priority order

1. Editorial clarity and evidence pass
2. Argument-level pass
3. Correlatives pass
4. Hedge pass
5. Rhetorical-question pass
6. Closing pass
7. Tic pass, for Working Overtime only
8. Structure pass, for Working Overtime only

For each pass, scan the full draft before moving to the next. Don't try to catch everything in one read.

### Step 3: Log each finding

For every flag, record:

- **Pattern name** (from the guardrails catalog)
- **Location** (paragraph number, section header, or distinctive opening words of the paragraph)
- **Offending line** (verbatim quote)
- **Diagnosis** (one sentence on why it trips the rule)
- **Suggested fix** (either a specific rewrite or a directional cut)

### Step 4: Note watch-items

If a pattern not yet in the guardrails catalog appears in the draft, log it as a watch-item at the bottom of the report. Format: pattern description + one-line example. If it shows up in a future draft, it gets promoted to the catalog.

### Step 5: Output the findings report

Use the format below.

## Output format

**Lead with the findings.** No preamble, no scan summary at the top. The report opens with the flags, organized by priority.

```
# Guardrails scan: [essay title or filename]

## Tier 1 — High priority

These hit the highest-severity rules: editorial clarity and evidence, argument-level issues, correlatives, and AI tells beyond the standard lexicon.

### [Pattern name] — [paragraph location]

> "[Offending line, verbatim]"

[One-sentence diagnosis.]

**Fix:** [Specific rewrite or directional cut.]

---

[Repeat for each Tier 1 finding.]

## Tier 2 — Voice tics and mechanics

These need rationing or revision but aren't violations in the strict sense.

[Same format.]

## Tier 3 — Structural throat-clearing

[Same format.]

## Watch-items

Patterns observed in this draft that don't yet have a named rule. If they show up again, promote to the catalog.

- [Description + example]

## Summary

- Total flags: [N]
- Tier 1: [N] | Tier 2: [N] | Tier 3: [N]
- Top three patterns to address: [list]
```

## Calibration

### What to flag aggressively on every Every draft

- Every unsupported factual claim, unidentified person/company/term, unresolved body-copy `TK`, and missing explanation of a load-bearing recommendation
- All correlative constructions and their cousins: "not X, but Y," "I don't mean X. I mean Y," and "X is (and what it isn't)" subheads
- Every rhetorical question that isn't reframing the thesis

### What to flag aggressively for Working Overtime only

- Every italicized closing mantra (cap is one per quarter)
- Structural self-naming announcements (always cut)

### What to flag once, then ration

- "Messy middle," "lived moment of friction," "permission to experiment"—flag if present, note frequency. Don't flag every instance; flag the recurrence pattern.
- Then/Now temporal openers—flag only if the temporal pivot isn't itself the essay's friction.
- Standardized build-your-own appendix—flag only if the recipe isn't the deliverable.

### What NOT to flag

- Single uses of words that overlap with AI vocabulary but serve the piece ("significant" used precisely, "crucial" in context)
- Intentional cascades (three or more parallel sentences accreting specifics)—this is the signature move, not a tic
- Parenthetical asides that carry argumentative weight—signature move
- Vernacular gut-checks ("OH MY GOD, MARGOT," "it's fine, it's fine, it's probably fine")—signature move
- Wry humor with self-deprecation that closes a loop—signature move

When in doubt, ask: does this passage sound like Katie thinking out loud, or like a model that found a satisfying rhythm? The first stays. The second flags.

### Severity calibration by format

- **Working Overtime:** apply all six categories.
- **Source Code, Vibe Check, Context Window, daily-read modules, and ghostwritten pieces:** apply Categories 1 through 4 only.
- **Short social copy, captions, and decks:** apply Category 1 unless a wider scan is requested.

## Edge cases

**Q: A flagged passage is genuinely strong. Should I still flag it?**
Yes. Flag it with a note that it's strong but pattern-detectable. Let the writer decide whether it earns its place. Example: an aphoristic balance close that defines the essay's thesis may be the one allowed exception per piece.

**Q: The draft has zero flags.**
Output a one-line confirmation: "No guardrail violations found. Watch-items: none." Skip the section headers.

**Q: The draft is heavily flagged (10+ Tier 1 issues).**
Don't write the full report. Output a summary: "Heavy flag count—N Tier 1, M Tier 2, K Tier 3. Suggest a structural revision before line-level pass. Top three patterns: [list]." This signals the draft needs a bigger intervention than line edits.

**Q: A pattern fires but the writer has clearly used it intentionally for voice (e.g., a deliberate "messy middle" callback to a prior essay).**
Flag with the note: "Intentional callback to [prior essay]. Allowed if deliberate; recommend swap if not." The writer makes the call.

**Q: A new pattern appears that doesn't fit any existing rule.**
Log it as a watch-item. Don't try to force it into an existing category. Two appearances = promote to the catalog.

## Pairing with other skills

- **Before guardrails:** run `dev-edit` when the opening, thesis, promise, stakes, or evidence still need validation. No point scanning line-level guardrails on a piece with a buried lede or unstable argument.
- **Alongside guardrails:** run `ai-check` for the standard AI-tell lexicon (delve, leverage, "in today's fast-paced world"). The two scans are complementary: `ai-check` catches generic lexical patterns; `guardrails` catches substantive editorial failures.
- **After guardrails:** run `every-style` for house mechanics, then `tracks` for residual process narration.

## References

- `references/editorial-clarity-evidence.md` — universal Every editorial clarity and evidence rules. Load for every scan.
- `references/working-overtime-guardrails.md` — supplemental pattern history and examples for Working Overtime-only scans. It is not the universal source of truth for this skill.

## Updating the catalog

When a draft surfaces a pattern not yet in the catalog:

1. Log it as a watch-item in the scan report.
2. After two appearances across separate drafts, add a universal pattern to this skill or a Working Overtime-only pattern to `references/working-overtime-guardrails.md`, using the real example.
3. After three appearances, promote it to a numbered position in the relevant category.
4. When this skill catches the pattern unprompted in subsequent drafts, the rule has stuck.

The catalog is a living system. Universal Every rules belong here; column-specific patterns belong in their project-specific references.
