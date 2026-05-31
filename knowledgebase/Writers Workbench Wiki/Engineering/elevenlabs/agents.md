---
name: Agents
description: V1 / DEV / PROD Eve agents — IDs, phone numbers, LLM, voice, configuration.
type: concept
tags: [elevenlabs, eve, agents]
last_reviewed: 2026-05-09
---

# Eve agents

Three Eve agents in the ElevenLabs platform. Each is an `agent` resource with its own LLM, voice, system prompt, and tool list.

## V1 — Baseline

- **Agent ID:** `agent_6401kjwqy66nfhabj82dvy8pnh2b`
- **Display name:** `Writing Assistant` (V1 baseline)
- **Phone number:** `+17622495331` (`phnum_1201kks4nfxpetpvc0n3xdkj2rx5`) — moved here at v1.0.0 release 2026-03-16
- **Original phone:** `+14435012219` (`phnum_8201kectdg3ze30shnq7wsm8bm84`) — historical
- **LLM:** `gemini-2.5-flash`
- **Voice:** `aMSt68OGf4xUZAnLpTU8` (custom voice)
- **Hub it talks to:** V1 hub `RcHfwiB7uM2vFfJ3` via webhook `/webhook/author_request`
- **FROZEN.** DO NOT modify (per CLAUDE.md baseline protection).

## DEV — Writing Assistant Dev

- **Agent ID:** `agent_0001kpr667v6ffctex0a8dt4fk71`
- **Display name:** `Writing Assistant Dev`
- **Phone number:** none (web widget only)
- **LLM:** `gemini-2.5-flash`
- **Voice:** same as V1 / PROD (custom)
- **Forwarding tool:** `tool_0801kprf5a14ee9b5ts7b8d2tetf` (`forward_writing_request_dev`) → DEV hub webhook `/webhook/author_request_dev`
- **Used by:** DEV Workbench at `writersworkbench-develop.up.railway.app`
- **Mature fiction override:** ENABLED (matches PROD)

## PROD — Writing Assistant PROD

- **Agent ID:** `agent_2801kks580vnf5q80j3bd0n0x45v`
- **Display name:** `Writing Assistant PROD`
- **Phone number:** none on web; provisioned per-customer for outbound calls
- **LLM:** `gemini-2.5-flash`
- **Voice:** same as V1 / DEV
- **Forwarding tool:** `tool_2301kksb78ygewvv3q3cm82wcfjs` (`forward_writing_request_v2`) → PROD hub webhook `/webhook/author_request_v2`
- **Used by:** PROD Workbench at `writersworkbench-production.up.railway.app`
- **Mature fiction override:** ENABLED

## Tier isolation rule

Every agent must have its own forwarding tool with the right webhook path. **Sharing tools between DEV and PROD is the bug** that Sprint 10.a fixed: previously, the DEV agent shared the PROD tool, so DEV calls hit PROD n8n. Now each agent owns its own tool id.

## Web widget configuration

The web widget is the same `<elevenlabs-convai>` embed across DEV and PROD; only the `agent-id` attribute differs:

```html
<!-- DEV Workbench -->
<elevenlabs-convai agent-id="agent_0001kpr667v6ffctex0a8dt4fk71"></elevenlabs-convai>

<!-- PROD Workbench -->
<elevenlabs-convai agent-id="agent_2801kks580vnf5q80j3bd0n0x45v"></elevenlabs-convai>
```

CDN: `https://unpkg.com/@elevenlabs/convai-widget-embed`. Loaded in `index.html` of the client bundle.

`@elevenlabs/react` (the programmatic SDK) was tried and abandoned — WebRTC/LiveKit 404 errors. Switched to the embed, which handles connection, microphone, UI, and status internally.

## Per-customer agent provisioning (V1 customers)

Each V1 customer has:
- An ElevenLabs phone number assigned to the baseline agent.
- Their phone-as-`user_id` mapped to `users_v2.user_id`.
- Their `system__caller_id` is the same E.164 number.

For PROD customers, the model is web-first; phone is only used for outbound callbacks (when n8n's `eve_knowledge_callback` decides to dial).

## Tools wired into each agent

The agent's `prompt.tools` and `prompt.tool_ids` arrays (NOT `agent.tools` — common mistake when querying ElevenLabs API).

| Agent | Tools |
|-------|-------|
| V1 Baseline | `forward_writing_request` (V1 webhook) |
| DEV | `forward_writing_request_dev` only |
| PROD | `forward_writing_request_v2` only |

Adding a new tool requires editing `prompt.tools` and `prompt.tool_ids` via the ElevenLabs admin UI or REST API.

## Knowledge Base

ElevenLabs supports per-agent knowledge documents. Used by:
- `eve_knowledge_callback` (web mode) — INJECTS content into the agent's KB so Eve can discuss it during the call.
- API: `POST /v1/convai/knowledge-base/documents` (multipart/form-data).

When n8n calls `Sub - Eve Knowledge Callback`, it:
1. Uploads the content text + title to the agent KB.
2. Sets `agent.first_message` to a context-aware greeting ("I've loaded chapter 7 — let's review").
3. Triggers an outbound call via `POST /v1/convai/twilio/outbound-call` to the user's phone (V1) or pushes SSE callback to web (PROD/DEV).
4. After 30s delay, `Reset Eve Greeting` workflow resets `agent.first_message` so the next inbound call has the default greeting.

## Outbound calls

Triggered by `Sub - Eve Knowledge Callback` when no web session is active.

```
POST /v1/convai/twilio/outbound-call
{
  "agent_id": "<agent>",
  "to_number": "<user_phone>",
  "first_message": "I've prepared chapter 7. Let me know when you're ready to review."
}
```

Routed through ElevenLabs's Twilio integration. User receives a call from the agent's number; conversation begins immediately with the dynamic first_message.

## Cost considerations

- Voice generation: ~$0.18 per 1000 characters (default tier).
- Knowledge Base storage: free.
- Outbound minutes: bundled with ElevenLabs Twilio number plan.

## Common gotchas

- **Agent tools are under `prompt.tools` and `prompt.tool_ids`, NOT `agent.tools`.** Querying the wrong path shows empty arrays.
- **Duplicating an agent in the dashboard clones `tool_ids` but NOT the tools themselves.** Create a new tool for the duplicated agent and update its `tool_ids` to point at the new tool.
- **Suggested audio tags cause Gemini to output `[sigh]`, `[whisper]`, etc. as spoken text.** Removed at Sprint 5. Use `expressive_mode` only.
- **Anti-stage-direction prompt rule (rule 7)** is a hard constraint — bans `[happy]`, `[slow]`, `[fast]`, `[thoughtful]`, `[whisper]`, `[loud]`, `[soft]`, `[deep]`, `[calm]`, `[dramatic]` from voice output.
- **Setting `agent.first_message` globally** propagates to ALL future calls until reset. The `Reset Eve Greeting` workflow runs 30s after a callback to undo this — without the delay, the user's outbound call doesn't capture the contextual greeting.
- **`turn_eagerness=eager` + `optimize_streaming_latency=4`** were the Sprint 5 latency fix. Keep these.
- **Mature fiction prompt override** unlocks Gemini's default refusal on romance / sexual content. PROD + DEV agents have it; V1 doesn't.
