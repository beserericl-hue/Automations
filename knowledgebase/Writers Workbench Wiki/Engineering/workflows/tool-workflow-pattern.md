---
name: Tool workflow pattern
description: Common shape of every n8n tool sub-workflow + recurring conventions ($fromAI, terminal nodes, deactivate→PUT→activate).
type: concept
tags: [workflows, n8n, patterns]
last_reviewed: 2026-05-09
---

# Tool workflow pattern

A "tool workflow" is a sub-workflow callable from `PROD - The Author Agent` (or DEV equivalent) as either an `executeWorkflow` reference or an `ai_tool` LangChain integration. Most of the 23 PROD tool sub-workflows follow a consistent shape.

## Shape

```
[Workflow Trigger node]
   │ payload: $fromAI('field1', '...', 'string'),
   │           $fromAI('field2', '...', 'number'),
   │           $fromAI('user_id', '...', 'string'),
   │           $fromAI('originalUserPrompt', '...', 'string', '')
   ▼
[Set: app_config]
   │ Pulls recipient_email, bcc_email, sender_email from app_config_v2
   │ (don't trust the trigger to provide these)
   ▼
[Set: validate input + load related data]
   │ supabase_url, supabase_service_role_key
   │ SELECT writing_projects_v2 etc.
   ▼
[Conditional branch: input valid?]
   ├── invalid → [Set error response] → [terminal node]
   └── valid   →
       │
       ▼
   [LLM call (chainLlm) or HTTP node]
       │
       ▼
   [DB write (Supabase HTTP node)]
       │
       ▼
   [send_email]   (HTTP POST /api/email/send via Postal)
       │
       ▼
   [insert_draft] (Supabase INSERT published_content_v2)
       │
       ▼
   [Set: result envelope]
       │
       ▼
   [terminal node — explicit]
```

## Why explicit terminal nodes

n8n sub-workflows return `0 items` if the terminal branch has **no connected node**. If both legs of an IF must produce a result, both must explicitly connect to a final node. This is the "always add an explicit terminal output node" rule from MEMORY.md.

## `$fromAI()` rules

`$fromAI(name, description, type, default?)` is how the LangChain Agent passes parameters into a tool sub-workflow.

| Form | Behavior |
|------|----------|
| `$fromAI('project_id', '...', 'string')` | **Required** — agent must supply this or the tool call fails |
| `$fromAI('story_arc', '...', 'string', '')` | **Optional** — empty default makes it optional in the Zod schema |

**4-argument form** is the difference between required and optional. The 3-argument form is required.

**Single quotes inside `$fromAI` description** is broken in n8n — they become unescaped and break JSON parsing. Use double quotes inside or rephrase.

## `$('node_name')` is null inside ai_tool sub-workflows

The Sprint 5 lesson: tool sub-workflows called as `ai_tool` from the hub CANNOT access the parent flow's nodes via `$('parent_node').item.json`. The expression returns null. Tool workflows must independently fetch any config they need.

That's why every tool workflow has a `Set: app_config` node that reads from `app_config_v2` directly, rather than relying on the hub passing `recipient_email`.

## Activation cycle (deactivate → PUT → activate)

After updating workflow JSON via REST API:

```bash
curl -X POST "$N8N/api/v1/workflows/$ID/deactivate"  # may 403 on n8n 2.x — that's OK
curl -X PUT "$N8N/api/v1/workflows/$ID" -d '{name, nodes, connections, settings: {executionOrder:"v1"}}'
curl -X POST "$N8N/api/v1/workflows/$ID/activate"
```

**Why:** `activeVersion` is a snapshot at activation time. PUT alone updates the saved JSON but doesn't rebuild `activeVersion`. The runtime keeps using the old version until activation rebuilds it.

n8n 2.x adds a UI workaround: refresh the workflow tab in the browser, then click **Publish** (⌘P). This is the visible signal that the runtime activeVersion has been updated. See `feedback_n8n_2x_publish_flow.md` in user memory.

## PUT API allowlist

n8n's `PUT /api/v1/workflows/{id}` only accepts:
- `name` (string)
- `nodes` (array)
- `connections` (object)
- `settings` (object — itself only `executionOrder` accepted in current version)

It **rejects** with `400 must NOT have additional properties`:
- `active`
- `staticData`
- `pinData`
- `activeVersionId`, `versionCounter`, `triggerCount`
- `shared`, `tags`, `meta`, `description`, `isArchived`
- Most `settings` keys: `binaryMode`, `errorWorkflow`, `executionTimeout`, `callerPolicy`, `availableInMCP`

`scripts/clone-prod-to-dev.py` strips incoming source workflows to the allowlist before re-posting.

## Shared `Set: app_config` pattern

Most tool workflows have:

```
=Set node (app_config)=
  app_config = SELECT * FROM app_config_v2 WHERE user_id = '{{ $json.user_id }}'
  recipient_email = $json.recipient_email
  bcc_email = $json.bcc_email
```

Centralized config means swapping recipient email for testing requires one row update, not editing 14 workflows.

## Common HTTP Request patterns

### Supabase REST

```
url:    https://gvbvwcnmjkdpclcisqrr.supabase.co/rest/v1/<table>?select=*&user_id=eq.<user_id>
method: GET / POST / PATCH
headers:
  apikey:        <SERVICE_ROLE_KEY>
  authorization: Bearer <SERVICE_ROLE_KEY>
  content-type:  application/json
  prefer:        return=representation
```

### Workbench API (n8n → Workbench)

```
url:    https://writersworkbench-develop.up.railway.app/api/email/send
method: POST
auth:   httpHeaderAuth credential (X-Email-Secret = <secret>)
body:   {to, subject, html, text}
```

### Anthropic chainLlm

```
node type: @n8n/n8n-nodes-langchain.chainLlm
parameters:
  promptType:    'define'
  text:          '<full system + user prompt concatenated>'
  hasOutputParser: false
  modelLanguage: 'claude-sonnet-4-5-20250929'
  temperature:   0.2 — 0.8
  maxTokens:     4096
```

The `messages.messageValues` shape DOES NOT WORK on chainLlm — fails with "No prompt specified. Expected to find the prompt in an input field called 'chatInput'". Real bug from Sprint 12.

## Node naming conventions

| Prefix | Purpose |
|--------|---------|
| `get_` | Read from DB |
| `build_` | Synthesize a prompt or context |
| `<tool>_llm` | LLM call (chainLlm) |
| `<tool>_claude` | Claude language-model sub-node feeding chainLlm |
| `<tool>_finalize` | Code node that parses LLM output + builds result envelope |
| `insert_*` | DB INSERT |
| `update_*` | DB UPDATE |
| `send_email` / `send_email_with_image` | Email dispatch |
| `set_result` | Terminal Set node — what the agent receives back |

## Preserving Firecrawl/Anthropic credentials on clone

When cloning a workflow PROD → DEV (or vice versa), credential **IDs** are preserved by default. That's correct for shared API creds (Anthropic, Perplexity, Firecrawl) but wrong for tier-specific shared-secret credentials (Email, Ingestion, Approval). `scripts/clone-prod-to-dev.py` rewrites the latter set per-tier; the rest stay.

## Writing a new tool workflow checklist

1. Start from a copy of the closest existing tool (e.g. `Tool - Edit Outline` for an outline-editing tool).
2. Webhook trigger? No — use Workflow Trigger and accept `$fromAI` parameters from the hub Agent.
3. Add a `Set: app_config` node at top.
4. Validate input: load related rows from Supabase by user_id + entity_id; if mismatch, return error envelope.
5. Make the LLM call. Use chainLlm with `promptType: 'define'`.
6. Save state — INSERT or UPDATE the appropriate `_v2` table.
7. Send email if user-facing notification.
8. Track tokens via INSERT `token_usage_v2`.
9. `set_result` Set node returning `{success, summary, ...}`.
10. **Both branches of every IF must connect to an explicit terminal node.**
11. Test via direct webhook POST: `POST /webhook/<your-test-webhook>` with synthetic payload.
12. Wire into hub:
    - Hub system prompt: add tool description + signature.
    - Hub Agent: add `ai_tool` reference to your new workflow id.
    - Promote DEV → PROD at next release; update the hub on PROD too.
