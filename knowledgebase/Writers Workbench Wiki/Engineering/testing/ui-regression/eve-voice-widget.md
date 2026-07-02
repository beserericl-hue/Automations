---
name: Eve voice widget (Workbench UI) regression + demo agent config
description: The ElevenLabs ConvAI voice widget embedded in the Workbench, the DEV demo agent wiring to the engine, and how to test/revert it.
type: reference
last_reviewed: 2026-07-02
---

# Eve voice widget (Workbench UI)

Spec: `writers-workbench/e2e/regression/eve-voice-widget.spec.ts`. Components:
`components/eve/EveOrb.tsx` (sidebar "Talk to Eve" button) → lazy-mounts `components/eve/EveWidget.tsx`,
which injects `<elevenlabs-convai agent-id={VITE_ELEVENLABS_AGENT_ID}>` and passes the signed-in user via
a `dynamic-variables` JSON attribute (`{user_id, user_name, source:"web_widget"}`).

## What the test asserts (UI wiring)

| Element | Expected | Selector |
|---|---|---|
| Sidebar "Talk to Eve" | opens the widget dialog | `button[title="Talk to Eve"]` |
| Widget dialog | `role="dialog" aria-label="Eve voice assistant"` visible | `getByRole('dialog',{name:/Eve voice assistant/})` |
| `<elevenlabs-convai>` | mounts once with an `agent-id` starting `agent_` | `locator('elevenlabs-convai')` |
| `dynamic-variables` | carries `user_id` + `source:"web_widget"` | attribute JSON |
| Close | `aria-label="Close Eve voice widget"` hides the dialog | dialog Close button |

The live spoken (WebRTC) turn can't be driven headlessly; the agent→engine round-trip is proven
separately against `/internal/hub/voice` (see the engine suite).

## DEV demo Eve → engine wiring (2026-07-02)

The DEV Workbench (`VITE_ELEVENLABS_AGENT_ID` on Railway `WritersWorkbench` develop) points the widget at
the **demo agent** `Writing Assistant Dev` (`agent_0001kpr667v6ffctex0a8dt4fk71`, phone +14435012219).
That agent was repointed from the old n8n DEV webhook to the **DEV engine (Path B)**:

- New webhook tool `forward_writing_request_engine_dev` (`tool_5901kwhj38xyefgvqtc7nxw4788d`) →
  `POST https://writer-engine-gateway-develop.up.railway.app/internal/hub/voice`, header
  `x-service-secret: <DEV SERVICE_SHARED_SECRET>`.
- Body: `user_message_request` (LLM-filled) + **`user_id` = constant `+14105914612`**. The demo is pinned
  to the demo account on purpose — every web-widget/phone interaction acts as `+14105914612` and **never
  touches any other user's data** (the widget's own `user_id` dynamic-variable is ignored).
- The agent's prompt + LLM (gemini-2.5-flash) are unchanged.

**Protected (NOT modified):** `Writing Assistant PROD` (`agent_2801…`, +17622495331 / +14104986741) and
`Writing Assistant` V1 (`agent_6401…`). The original n8n dev tool (`tool_0801…`) is preserved.

**Revert:** point the Dev agent's `prompt.tool_ids` back to `['tool_0801kprf5a14ee9b5ts7b8d2tetf']`
(the n8n dev tool), via `PATCH /v1/convai/agents/agent_0001…`.

**Test it for real:** open the DEV Workbench → "Talk to Eve" (web widget), or call **+14435012219**, and
say "list my outlines" / "write a blog post about X". Everything resolves to the `+14105914612` account.
