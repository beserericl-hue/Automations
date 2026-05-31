---
name: Voice and prompts
description: Eve's system prompt sections, voice settings, anti-stage-direction rules, mature-fiction override, listing rules.
type: concept
tags: [elevenlabs, prompts, voice]
last_reviewed: 2026-05-09
---

# Voice + prompts

The full Eve system prompt lives in [`writing-assistant-prompt.md`](../../../../writing-assistant-prompt.md) at the repo root. PROD and DEV agents share base content with tier-specific tweaks. V1 has its own separately-frozen prompt.

## Voice configuration

| Setting | Value |
|---------|-------|
| Voice ID | `aMSt68OGf4xUZAnLpTU8` (custom female voice) |
| Stability | 0.5 |
| Similarity boost | 0.7 |
| Style | 0.0 (neutral) |
| Expressive mode | enabled |
| `turn_eagerness` | `eager` (Sprint 5 latency fix) |
| `optimize_streaming_latency` | 4 (Sprint 5) |
| Suggested audio tags | NONE — removed Sprint 5 (Gemini was outputting `[Patient]`, `[Sigh]`, etc. as spoken text) |

## Prompt structure (in order)

1. **Identity + Role** — "You are Eve, a writing assistant..."
2. **Tool override** — *NEVER fabricate tool results. Always call the tool, even if you think you know the answer.*
3. **Type A vs Type B response** — async ack vs immediate sync data return.
4. **Listing & browsing content** — explicit allowance to list outlines/chapters/etc. Required because Gemini fabricates "I can't list outlines" otherwise. Sprint 8/Multi-User refinement.
5. **Mature fiction override** — unlocks romance / sexual / mature themes Gemini refuses by default. PROD + DEV; not V1.
6. **Available genres** — 8 enumerated.
7. **Available story arcs** — 8 enumerated with descriptions.
8. **Prologue + Epilogue rules** — `chapter_number=0` for prologue, `999` for epilogue. Single-task rules ("write the prologue"). Brainstorm outlines may include them.
9. **Numbered list selection** — "show me 3", "the first one", "#7" map to most recent list in conversation.
10. **CHARACTER LOCK** (3-layer) — LOCKED CHARACTERS section, Requirements copy-first rule, FINAL CHECK verification. Combined with deterministic drift scanner.
11. **Eve mode rules** — brainstorm vs review vs task execution.
12. **Tone & Speech Style** — informal but professional, no preamble.
13. **Rule 4** — Type A async ack vs Type B sync data response.
14. **Rule 7** — anti-stage-direction. Bans `[happy]`, `[slow]`, `[fast]`, `[thoughtful]`, `[whisper]`, `[loud]`, `[soft]`, `[deep]`, `[calm]`, `[dramatic]`, etc. as spoken text. Hard rule.

## Mature fiction override (PROD + DEV)

Gemini 2.5 Flash refuses romance/sexual content by default. The override unlocks:
- Sci-fi romance / dark sci-fi
- Cyberpunk romance
- Space opera romance
- Mature themes / intimate scenes
- Metaphysical romance (soulmates, past lives, intimacy)

The override is in the system prompt, NOT a Google content-filter setting. Without it, Gemini returns "I can't help with that" on romance/intimate-scene requests.

## Tool routing rules

For every user message:

```
if request matches list/browse/retrieve/approve/publish keywords:
   call tool synchronously, await Type B (full data), respond with the data
elif request matches write/brainstorm/generate keywords:
   call tool, immediately respond Type A: "I'm working on that. You'll get an email when it's ready."
elif request is conversational (no DB op):
   respond directly without calling tool
```

This is mirrored on the server side by `lib/jobs/classifier.ts`. They must stay consistent — divergence breaks UX.

## Brainstorm conversation mode

When Eve is in brainstorm mode (user says "let's brainstorm a story"):
1. Eve asks a discovery question from `story_arcs_v2.discovery_question` (per arc).
2. User answers; Eve refines.
3. After 2-3 rounds, Eve calls `brainstorm_story` with the synthesized requirements.
4. Tool returns immediately (Type A). Eve says "Brainstorm sent — check your email."

Common brainstorm flow gotchas:
- Skip the discovery question: Eve forgets the structure she's working in.
- Call brainstorm too early: half-formed requirements produce weak outlines.
- Not call brainstorm at all: Gemini fabricates the answer in conversation.

## Review mode

When user says "let's review chapter 7":
1. Eve calls `retrieve_content` with the chapter id (sync).
2. Gets back the content text.
3. Eve calls `eve_knowledge_callback` to inject the content into her own KB.
4. The callback workflow either:
   - SSE-pushes "eve:loaded" to the web client and Eve continues conversation; OR
   - Triggers an outbound call (V1).
5. User and Eve discuss the chapter; Eve can suggest edits, call `rewrite_chapter_with_research`, etc.

## Listing rules (Sprint 8 / Multi-User refinement)

Gemini fabricates "I can't list X" by default. The prompt explicitly says:

> You CAN list any of these via tool calls:
> - outlines (call retrieve_content with content_type=outline)
> - chapters (call retrieve_content with content_type=chapter, project_id=...)
> - story bibles (retrieve_content with content_type=story_bible_entry)
> - research reports (retrieve_content with content_type=research)
> - scheduled newsletters (retrieve_content with content_type=newsletter, status=scheduled)

Without this section, Eve says "I don't have access to your data" instead of calling the tool.

## Tool override (anti-fabrication)

The hardest rule:

> When a tool returns "no results", say "no results."
> NEVER fabricate a list of items the tool didn't return.
> NEVER say "I updated X" without actually calling the update tool.

This rule was tightened multiple times during Sprints 12-14 because Gemini 2.5 Pro (briefly tested) ignored it for small edits ("can you change Elena's age to 29?") and fabricated "I updated the outline" without calling `edit_outline`. Switching back to Gemini 2.5 Flash + tightening the rule fixed it.

## Mode-switching keyword detection

The hub's `preprocess_message` Code node has aggressive regex pre-routing:
- `revert outline` → retrieve op (NOT brainstorm)
- `revise outline` → brainstorm in revision mode
- `Q/A report` → direct_qa_chapter (skips Agent entirely)
- `list outlines`, `what outlines`, `show outlines` → retrieve op with `list_outlines` operation
- Numbered list selection (`"1"`, `"show me 3"`, `"#7"`) → resolves to item from last list in conversation
- `outline` (bare) + `outlines` (bare) → list_outlines fallback for V2 (when Gemini strips "all" from search params)

## Common voice gotchas

- **Stage directions in voice output** — banned. Rule 7 catches most; if a user reports `[Sigh]` being spoken, audit the prompt for new audio tag suggestions creeping in.
- **Eve repeats herself** — `turn_eagerness=eager` reduces this; without it, Eve waits too long on user pauses and re-prompts.
- **Gemini "I can't" responses** — usually means the listing rule or mature fiction override needs to be tightened.
- **Wrong tool called** — usually means preprocess_message regex is missing the operation type or the agent system prompt is ambiguous. Check `preprocess_message` first.
- **Greeting captures wrong context** — Reset Eve Greeting workflow runs 30s after callback. If it fires too early, the user's outbound call doesn't capture the contextual greeting; too late, the next inbound has stale greeting.
