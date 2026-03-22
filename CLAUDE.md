# Project Rules

## BASELINE PROTECTION — MANDATORY, NO EXCEPTIONS

**NEVER modify baseline/production resources without explicit user permission.** This includes:

- **ElevenLabs baseline agent** (`Writing Assistant`, agent ID: `agent_6401kjwqy66nfhabj82dvy8pnh2b`) — DO NOT change its tools, webhook URL, prompt, or any configuration
- **n8n V1 workflows** (original workflow IDs listed in MEMORY.md) — DO NOT update, deactivate, or delete any original workflow
- **n8n V1 webhook** (`/webhook/author_request`) — DO NOT modify or redirect
- **Supabase production tables** — DO NOT drop, alter, or delete data without permission

All development work goes on **V2/Beta resources only**:
- Beta Writing Assistant: `agent_2801kks580vnf5q80j3bd0n0x45v`
- V2 workflows on n8n (names ending in "V2")
- V2 webhook: `/webhook/author_request_v2`

**If a subagent or automated process needs to touch ANY baseline resource, STOP and ask the user first.**

## Git Branching

- `main` = stable release baseline. Only updated via PR after testing.
- `develop` = all active development. Commit here by default.
