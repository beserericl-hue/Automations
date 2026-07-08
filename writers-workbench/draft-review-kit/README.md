# Draft Review Kit

Reusable review skills for stress-testing drafts.

This kit is a small editorial board you can run from an agentic writing environment. Each reviewer has a distinct job: one attacks the argument, one checks whether a general reader can follow, one looks for suspense, one cuts bloat, one convenes the whole room.

These skills are intentionally feedback-focused. They are not for generating ideas, hooks, outlines, or first drafts. Use them once you have prose on the page and want sharper judgment around what is working, what is weak, and what needs to change.

## Included Reviewers

### Big-Picture Review

- `dev-edit` - reviews argument, structure, stakes, and payoff.
- `guardrails` - scans for evidence gaps, argument failures, AI-shaped rhetoric, mechanics problems, and recurring voice tics.
- `panel` - convenes multiple reviewers and synthesizes their feedback.
- `debate` - has reviewers argue with each other until tensions resolve or become clear.

### Pressure And Reader Response

- `asshole` - gives the least charitable read and attacks weak claims.
- `mom` - reads as a loving but non-expert general reader.
- `eli5` - flags jargon, hand-waving, and skipped steps.

### Craft Lenses

- `hitchcock` - checks suspense, tension, and the visible "bomb under the table."
- `sorkin` - checks pacing, momentum, and forward motion.
- `vonnegut` - applies Vonnegut's story rules to fiction or nonfiction.
- `sedaris` - finds humor, specificity, absurdity, and self-deprecation.
- `hemingway` - cuts adjectives, adverbs, qualifiers, and unnecessary words.

### Final Editing

- `line-edit` - performs a rigorous sentence-level edit and summarizes changes.

## Suggested Workflow

1. Run `dev-edit` when the draft exists but the structure can still move.
2. Run `asshole`, `mom`, or `eli5` depending on the reader risk you want to expose.
3. Run one or two craft reviewers: `hitchcock` for tension, `sorkin` for pace, `vonnegut` for story logic, `sedaris` for humor, `hemingway` for bloat.
4. Run `guardrails` before publication to catch evidence, argument, mechanics, and patterned AI-writing failures.
5. Run `panel` or `debate` for high-stakes drafts where multiple perspectives should be reconciled.
6. Run `line-edit` after the big decisions are resolved.

The point is not to run every reviewer every time. The point is to have the right kind of pressure available when the draft needs it.

## Install

### Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add EveryInc/draft-review-kit
/plugin install draft-review-kit@draft-review-kit-local
```

Restart Claude Code after installation.

### Codex

Register the marketplace:

```bash
codex plugin marketplace add EveryInc/draft-review-kit
```

Then launch Codex, run `/plugins`, open the **Draft Review Kit** marketplace, and install `draft-review-kit`. Restart Codex after installation.

### Use The Skills

Ask for a review in plain language, or invoke a specific skill:

- Claude Code: `/dev-edit`, `/guardrails`, `/hitchcock`, `/line-edit`
- Codex: `$dev-edit`, `$guardrails`, `$hitchcock`, `$line-edit`

For other agents, copy the relevant skill folders into that agent's skills directory. Each skill is plain Markdown and can be adapted to any system that supports reusable instructions.

## Customize This

Fork the reviewers. Rename them. Make them kinder, meaner, narrower, stranger, or more specific to your work.

The best reviewer is not the most universal one. It is the one that remembers the standard you keep forgetting at exactly the moment you are tempted to call the draft done.
