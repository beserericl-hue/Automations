# Hotfix 2026-04-29 — Story-bible extraction restored

**Severity:** silent regression — chapters wrote successfully but `story_bible_v2`
remained empty for every project written under the new sub-chapter architecture.

**Affected window:** ~2 weeks (since the sub-chapter parallel-write migration in
mid-Sprint 12).

**Affected systems:** `Worker - Write Chapter` (PROD + DEV). Cascading impact on
the drift scanner, which kept flagging the same characters as "unknown" because
they never landed in the bible.

## Symptom

Visible to users on the project Story Bible tab. Projects written under the new
architecture (e.g. *The Invisible Wall*) showed:

> No story bible entries yet. They are created automatically when you write
> chapters.

Projects written under the V1 single-LLM era (e.g. *The Familiar*) still had
populated bibles because the old writer emitted entries inline with the chapter
prose.

## Root cause

In the sub-chapter architecture, each sub-chapter agent emits prose only — not
the JSON envelope (`{chapter_text, new_story_bible_entries}`) that the V1 writer
returned. The `concatenate_chapter` Code node, which joins sub-chapter outputs
into a single chapter envelope, hardcodes:

```js
new_story_bible_entries: []
```

The downstream `update_story_bible` node correctly reads
`output.new_story_bible_entries` and inserts each entry into `story_bible_v2`,
but it has been receiving an empty array on every chapter write since the
migration.

## Fix

Insert a deterministic extraction stage **between** `continuity_finalize` and
`update_story_bible`:

```
continuity_finalize
   ↓
extract_bible_prepare    (Code: build do-not-emit list + prompt)
   ↓
extract_bible_llm        (chainLlm)
   ↑ (ai_languageModel)
extract_bible_claude     (Sonnet 4.5, 4096 tokens, temp 0.2)
   ↓
extract_bible_finalize   (Code: defensive JSON parse, merge onto envelope)
   ↓
update_story_bible       (unchanged — now sees populated array)
```

**Prompt design highlights:**

- Reads the project's existing `story_bible_v2` rows + outline characters and
  passes them as a "do NOT re-emit" list. Prevents duplicates on every chapter
  write.
- Strict JSON output (`{"new_story_bible_entries": [...]}`). The finalize node
  tolerates code fences and partial JSON via the same defensive parser pattern
  used elsewhere (see drift scanner / genre eval).
- Conservative — explicit instructions to skip generic mentions ("the agent",
  "a guard") and only emit plot-load-bearing entries.

**Failure isolation:** `update_story_bible` already wraps its inserts in a
try/catch that swallows errors, so even if Claude returns malformed output the
chapter write itself is unaffected.

## Deploy

```bash
# DEV (idempotent — re-run safely)
N8N_API_KEY=... \
python3 scripts/hotfix-add-story-bible-extractor.py --target dev

# PROD
N8N_API_KEY=... CONFIRM_PROD=yes \
python3 scripts/hotfix-add-story-bible-extractor.py --target prod
```

Both targets were patched on 2026-04-29.

## Backfill

Existing projects written during the broken window have empty bibles. The
companion script deploys a one-shot `Sub - Backfill Story Bible` workflow and
drives it per-chapter:

```bash
N8N_API_KEY=... \
python3 scripts/hotfix-backfill-story-bible.py \
  --project-id <uuid> \
  --user-id <user_id>
```

**Verified backfill:** *The Invisible Wall* (DEV, project
`366ca0a0-18e8-45a5-83da-a6b3d23d760b`) — 37 entries inserted across 7 chapters
(11 characters / 11 events / 11 items / 4 locations). Drift scanner re-run
afterwards no longer flags the new canonical characters as unknowns.

PROD backfill is **not** included in this hotfix — it is a per-customer cost
decision (Anthropic tokens). Decide on a per-project basis after release-day
promotion.

## Lessons / process notes

- This regression was silent for ~2 weeks because story-bible population is a
  side-effect with no visible failure mode (chapters still wrote successfully).
- Adding a quality-comparison harness (Sprint 16) would have caught this — the
  baseline corpus would have shown bible counts dropping to zero on the new
  architecture vs the V1 reference.
- The drift scanner kept flagging the same characters every scan because they
  never made it into canon. The two systems now feed each other once this fix
  is in place.
- n8n's PUT validator on this version rejects almost every key inside
  `settings`. Send only `{executionOrder: "v1"}` and let n8n preserve the rest.
- The CI workflow has a `paths` filter on `writers-workbench/**` — scripts-only
  hotfixes don't trigger CI and therefore don't satisfy required-check gates on
  PRs to `main`. This is why the hotfix PR also includes this runbook.
