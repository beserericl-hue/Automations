---
name: Classifier + priority
description: Regex-rule message classifier that routes messages to sync/medium/heavy/background queues. Mirrors n8n hub preprocess_message.
type: concept
tags: [backend, classifier, sprint-10b]
last_reviewed: 2026-05-09
---

# Classifier + priority

[`server/src/lib/jobs/classifier.ts`](../../../../writers-workbench/server/src/lib/jobs/classifier.ts).

Decides which BullMQ queue a chat message goes into, AND whether it should bypass the queue entirely (sync ops). Mirrors the n8n hub `preprocess_message` Code node logic so server-side routing is consistent with what the agent would have done.

## Output shape

```ts
type Classification = {
  tier: QueueName;            // 'sync-ops' | 'medium-ops' | 'heavy-ops' | 'background-ops'
  jobName: string;             // 'write_chapter', 'list_outlines', 'chat_generic', etc.
  isHeavy: boolean;            // for concurrency slot accounting
  isAsync: boolean;            // false → bypass queue, fetch directly
};
```

## Rule book (first-match-wins)

Approximate rules — consult the file for exact regex.

### Sync ops (bypass queue)

| Pattern (case-insensitive) | jobName |
|---------------------------|---------|
| `/^list (my )?(outlines?|chapters?|projects?|story bibles?|research( reports?)?|newsletters?)/` | `list_<type>` |
| `/^show (my )?(...)/` | same as list |
| `/retrieve (?:content )?(.+)/` | `retrieve_content` |
| `/^(approve|publish|reject) (.+)/` | `approve_content` etc. |
| `/^revert outline/` | `revert_outline` (NOT brainstorm — narrowed to avoid matching "revise") |
| `/^outline versions? for/` | `list_outline_versions` |
| `/^content versions? for/` | `list_content_versions` |
| `/^edit outline.*\b(age|name|description)\b/` | `edit_outline` (small targeted edits, medium-ops actually) |

Sync ops set `isAsync: false`. The chat-proxy fetches n8n directly, skips queue.

### Heavy ops

| Pattern | jobName |
|---------|---------|
| `/write (a |the |my )?(next )?chapter/` | `write_chapter` |
| `/^write the prologue/` | `write_chapter` (chapter_number=0) |
| `/^write the epilogue/` | `write_chapter` (chapter_number=999) |
| `/rewrite.*chapter.*research/` | `rewrite_chapter_with_research` |
| `/brainstorm.*chapter/` | `brainstorm_chapter` |

### Medium ops

| Pattern | jobName |
|---------|---------|
| `/brainstorm (a |the |my )?(story|book|outline)/` | `brainstorm_story` |
| `/(revise|revising) outline/` | `brainstorm_story` (revision mode) |
| `/cover (art|image)/` | `cover_art` |
| `/social ?(media )?posts?/` | `repurpose_to_social` |
| `/research (about|on)/` | `research` |
| `/blog post/` | `write_blog_post` |
| `/short story/` | `write_short_story` |
| `/newsletter/` | `write_newsletter` |
| `/q\/?a (report|chapter)/` | `qa_chapter` |
| `/evaluate genre/` | `evaluate_genre_compliance` |
| `/scan (character |for )?drift/` | `scan_character_drift` |
| `/edit outline/` | `edit_outline` |

### Background ops

| Pattern | jobName |
|---------|---------|
| (no current rules — reserved for nightly cron tasks) | |

### Default fallback

Anything not matched goes to `medium-ops` with `jobName: 'chat_generic'`.

## isHeavy accounting

`isHeavy = (tier === 'heavy-ops')`. Used by `tryAcquireUserSlot` to count against the heavy quota (1 per user). A user with 1 heavy and 2 mediums is at 3/3 total + 1/1 heavy.

## Why mirror the hub's regex

The n8n hub has its own `preprocess_message` Code node with similar regex rules. Running the same logic on the server saves a hub round-trip for sync ops AND ensures sync ops don't accidentally hit the queue.

If hub regex changes (Sprint X), server classifier must change in lockstep. Tests in `server/src/test/s10b3-chat-queue.test.ts` validate alignment.

## Common gotchas

- **First-match-wins.** Order matters. The list-style rules run before the write-style rules so "list my chapters" doesn't accidentally fall into "chapter" matches.
- **`/revis(e|ing)/`** instead of `/revise/.{0,20}outline/` — narrow regex to avoid matching "revert" (a real bug).
- **Stop words** — bare keywords like "outline", "outlines", "list", "show" should be considered as candidates for retrieve_content even without "all/list/show" prefix (Gemini strips qualifiers from search params).
- **Mature fiction trigger** — no special regex; the system prompt is what unlocks Gemini. Classifier just routes to the right queue.
- **"Revert outline X to version N"** — must match retrieve op, NOT brainstorm. Old regex caught "revert" in `/revise.{0,20}outline/`. Real bug fixed by narrowing.
- **`chat_generic`** is the catch-all → medium-ops. If a user's message doesn't match anything specific, n8n's Agent will route it.
- **Evaluate / scan / annotate triggers** all go to medium-ops, not heavy. They're computed-before validators (Sprint 12 S12-11) — fast in practice (<60s).
