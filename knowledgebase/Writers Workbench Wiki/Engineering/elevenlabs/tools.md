---
name: Eve forwarding tools
description: ElevenLabs tools that bridge Eve to the n8n hub — one per tier.
type: concept
tags: [elevenlabs, eve, tools]
last_reviewed: 2026-05-09
---

# Eve forwarding tools

Each Eve agent has exactly one forwarding tool: a webhook tool that POSTs the user's request to the n8n hub.

## DEV — `forward_writing_request_dev`

- **Tool ID:** `tool_0801kprf5a14ee9b5ts7b8d2tetf`
- **URL:** `https://n8n.agileadautomation.com/webhook/author_request_dev`
- **Method:** POST
- **Authentication:** none (n8n webhook is open; the agent + user_id pairing is the implicit auth)
- **Wired to:** `agent_0001kpr667v6ffctex0a8dt4fk71` (DEV Eve)

## PROD — `forward_writing_request_v2`

- **Tool ID:** `tool_2301kksb78ygewvv3q3cm82wcfjs`
- **URL:** `https://n8n.agileadautomation.com/webhook/author_request_v2`
- **Method:** POST
- **Authentication:** none
- **Wired to:** `agent_2801kks580vnf5q80j3bd0n0x45v` (PROD Eve)

## V1 — `forward_writing_request` (legacy)

- **URL:** `https://n8n.agileadautomation.com/webhook/author_request`
- **Wired to:** `agent_6401kjwqy66nfhabj82dvy8pnh2b` (V1 Baseline Eve)
- **Frozen.**

## Tool body schema

The agent prompt tells Gemini what payload to construct:

```json
{
  "user_message_request": "<the user's verbalized request, transcribed and synthesized>",
  "user_id": "<system__caller_id>",
  "originalUserPrompt": "<the user's exact words>"
}
```

`system__caller_id` is the ElevenLabs name for the calling phone number — same as the user's `user_id` in the database. ElevenLabs injects it as a variable; the prompt template references it as `{{system__caller_id}}`.

## Why one tool per tier

Sprint 10.a fixed a real bug: previously, the DEV agent shared the PROD tool, so DEV calls hit the PROD webhook. Cross-tier writes ensued. The fix:
1. Created a new `forward_writing_request_dev` tool pointing at the DEV webhook.
2. Updated the DEV agent's `prompt.tool_ids` to reference the new tool only.
3. Verified by triggering a DEV call and watching `verify-env-isolation.py` confirm the DEV n8n hub got the call.

Per-tier tools are a hard isolation boundary. NEVER share tools across tiers.

## Tool definition shape (ElevenLabs side)

```json
{
  "id": "tool_…",
  "name": "forward_writing_request_v2",
  "description": "Forward the user's writing request to the n8n hub for processing",
  "type": "webhook",
  "config": {
    "url": "https://n8n.agileadautomation.com/webhook/author_request_v2",
    "method": "POST",
    "headers": {
      "content-type": "application/json"
    },
    "body": {
      "user_message_request": "{{user_message_request}}",
      "user_id": "{{system__caller_id}}",
      "originalUserPrompt": "{{originalUserPrompt}}"
    }
  }
}
```

Fields are template-substituted at call time. Gemini fills `{{user_message_request}}` and `{{originalUserPrompt}}` based on the conversation; ElevenLabs fills `{{system__caller_id}}` from session metadata.

## Editing tools

Via ElevenLabs dashboard or REST API:

```
PATCH https://api.elevenlabs.io/v1/convai/tools/{tool_id}
Authorization: xi-api-key <ELEVENLABS_API_KEY>

{ "config": { "url": "..." } }
```

Editing the URL is the most common change (e.g. switching tiers). Don't share tools between tiers — instead, create a new tool, update the agent's `prompt.tool_ids` to swap.

## Knowledge Base API (used by callbacks)

```
POST https://api.elevenlabs.io/v1/convai/knowledge-base/documents
Authorization: xi-api-key <ELEVENLABS_API_KEY>
Content-Type: multipart/form-data

agent_id=<agent>
title=<doc title>
content=<text>
```

Returns `{document_id}`. Used by `Sub - Eve Knowledge Callback` to inject content for the agent to discuss.

## Outbound call API

```
POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
{
  "agent_id": "<agent>",
  "to_number": "<E.164>",
  "first_message": "<context-aware greeting>"
}
```

Used by `Sub - Eve Knowledge Callback` (phone branch).

## Common gotchas

- **Empty `prompt.tool_ids`** — querying the wrong API path (`agent.tools` vs `agent.prompt.tools`). Always read from `prompt.tools` and `prompt.tool_ids`.
- **Sharing a tool across tiers** breaks isolation silently. Always one tool per tier.
- **`first_message` is a global agent property** — reset it after callback (Reset Eve Greeting workflow).
- **Webhook auth** — the n8n webhook is currently un-authenticated. Anyone with the URL can trigger it. Future Sprint 9-Stripe sprint may add HMAC validation.
