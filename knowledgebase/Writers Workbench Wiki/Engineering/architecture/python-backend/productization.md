---
name: Productization (B2B platform layer)
description: How the Python backend becomes a sellable B2B product. API keys, tier-based pricing, customer onboarding, SDKs, marketing positioning.
type: concept
tags: [architecture, python-backend, productization, b2b, commercial]
last_reviewed: 2026-05-09
---

# Productization

Author Agent API as a standalone B2B product. Same codebase that powers Writers Workbench (internal) is exposed at `api.authoragent.dev` (or final domain) under the `/v1/*` namespace for paying API customers.

## Positioning

**Tagline:** "Production-grade AI for novel-length writing. Skip the prompt engineering."

**Target customers:**

1. **Indie writing-app developers** — building their own writers app; need chapter generation but don't want to engineer it from scratch.
2. **Educational platforms** — creative writing courses; want students to interact with AI-driven outlines + drafts.
3. **Content agencies** — long-form ghostwriting at scale.
4. **Larger SaaS players** — embed in existing productivity suites (Notion, Reflect, etc.).

**What we're NOT selling:**
- A general-purpose LLM wrapper. (That's commodity.)
- A frontend product. (Customers build their own UI.)
- Hosting for end-users. (No multi-user-per-customer Workbench replacement.)

**What's defensible:**
- Prompt engineering depth (LOCKED CHARACTER ROSTER, deterministic drift scanner, story bible extractor, continuity merge). 18 months of empirical refinement.
- The 8 story arcs + 8 genres + character lock + extract_bible + drift scanner pipeline.
- Cross-chapter continuity check (NEW capability, hard to replicate).
- Multi-LLM strategy + token budget gatekeeper (operational expertise).

## Pricing model

**Two-axis billing:** subscription tier (SLA + feature gating) + usage (per token).

### Subscription tiers

| Tier | Monthly | Annual | Included credits | Features |
|---|---|---|---|---|
| **Free** | $0 | $0 | 10,000 tokens/mo | `/v1/chapters/write`, `/v1/library/*`. Rate limit 5 RPM. No SLA. |
| **Starter** | $99/mo | $999/yr | 1M tokens/mo | + brainstorm + research + media. Rate limit 60 RPM. Email support. |
| **Pro** | $499/mo | $4,990/yr | 8M tokens/mo | + cross-chapter continuity + scan-drift + evaluate-genre. Rate limit 300 RPM. 99.5% SLA. |
| **Scale** | $2,499/mo | $24,990/yr | 50M tokens/mo | + dedicated capacity + custom prompts via `app_config`. Rate limit 1000 RPM. 99.9% SLA. Priority support. |
| **Enterprise** | custom | custom | custom | Self-hosted option, on-prem, custom integrations, dedicated CSM. |

### Per-token overage pricing

When a tenant exceeds their included tokens:

- Sonnet output tokens: $20/MT (Anthropic charges $15/MT — 33% margin)
- Haiku output tokens: $1.50/MT (Anthropic $1/MT)
- Sonnet input tokens: $4/MT (Anthropic $3/MT)
- Haiku input tokens: $0.30/MT (Anthropic $0.25/MT)

Customer dashboard shows live usage + projected month-end. Hard cap configurable (Stripe usage record + auto-suspend).

### Cost-of-goods-sold math (per Pro-tier customer)

Average customer at Pro:
- 8M tokens included; assume 70% utilization = 5.6M tokens used.
- Sonnet share: 60% × 5.6M = 3.36M output tokens.
- Haiku share: 40% × 5.6M = 2.24M output tokens.

COGS per Pro customer:
- Sonnet: 3.36 × $15 = $50.40
- Haiku: 2.24 × $1 = $2.24
- Infrastructure (3 backend instances + Redis + Supabase): ~$50/customer-month at 100 customers
- Total COGS: ~$102/mo
- Revenue: $499/mo
- **Gross margin: ~80%.**

### Free tier policy

- Hard cap at 10K tokens/month.
- Rate limit 5 RPM.
- No webhook callbacks.
- API key requires email verification.
- Used for evaluation. Drives conversion to Starter ($99/mo).

## Multi-tenancy at the data level

Every external customer is a `tenant_v2` row. Every API call resolves API key → tenant_id → data scope. See [[multi-tenancy]] for full details.

### Sample lifecycle

```
1. Customer signs up at api.authoragent.dev/signup
   → POST /signup creates tenants_v2 row + Stripe customer
   → POST /v1/account/api-keys issues first API key

2. Customer calls /v1/chapters/write
   → API key → tenant_v2 → tenant_id
   → Request scoped to tenant_id throughout
   → All DB writes include tenant_id

3. Customer's data is invisible to all other tenants (RLS-equivalent)

4. Billing
   → Token usage tracked in api_usage_v2
   → Aggregated nightly into Stripe usage records
   → Monthly invoice
```

## Customer onboarding

### Self-service flow

1. Sign up at marketing site → email verification.
2. Confirm → land on dashboard `/dashboard`.
3. Generate first API key (free tier auto-active).
4. Documentation walkthrough (interactive).
5. Code sample: copy/paste in their language.
6. First successful API call → "First call success!" notification.

### Free → paid conversion

Trigger upsell modal when:
- Free tenant hits 80% of monthly token cap.
- Free tenant hits rate-limit 3+ times in a week.
- Free tenant has been active 14+ days.

Modal shows: usage summary, value framing ("you've generated 8 chapters worth of content"), upgrade CTA.

### Sales flow (Scale + Enterprise)

- Lead form on marketing site → assigned account exec.
- Discovery call: use case, volume, integrations.
- Custom contract for Enterprise (self-hosted option).
- Onboarding playbook: dedicated Slack channel, technical kickoff, white-glove integration.

## SDKs

Generated from OpenAPI spec via `openapi-generator-cli`. Maintained:

- **Python** (`pip install authoragent`)
- **TypeScript / JavaScript** (`npm install @authoragent/sdk`)

Future:
- Go (`go get github.com/authoragent/sdk-go`)
- Ruby (`gem install authoragent`)

Both maintained SDKs ship:
- Type-safe client.
- Built-in retry with exponential backoff.
- Idempotency-key auto-generation.
- Webhook signature verification helper.
- Streaming response support (when added).

### Quickstart sample (Python)

```python
from authoragent import AuthorAgent

client = AuthorAgent(api_key="aa_live_...")

# Async chapter write
job = client.chapters.write(
    project_id="proj_abc",
    chapter_number=4,
    research_topic="post-apocalyptic transit systems",
    webhook_url="https://yourapp.com/webhooks/aa"
)

# Or wait synchronously (blocks up to job timeout)
result = client.chapters.write(...).wait(timeout=600)
print(result.content_text)
```

### Quickstart sample (TypeScript)

```typescript
import { AuthorAgent } from '@authoragent/sdk';

const client = new AuthorAgent({ apiKey: process.env.AA_API_KEY });

const result = await client.chapters.write({
  projectId: 'proj_abc',
  chapterNumber: 4,
  researchTopic: 'post-apocalyptic transit systems'
}).wait();

console.log(result.contentText);
```

## Documentation

Generated + maintained at `docs.authoragent.dev`. mkdocs-material (or Docusaurus). Sections:

- **Getting started** — sign up, first API call, key concepts.
- **Concepts** — projects, chapters, story bibles, drift scanning, multi-LLM strategy.
- **API reference** — auto-generated from OpenAPI; full schema for every endpoint.
- **SDKs** — Python + TypeScript installation + quickstart + cookbook.
- **Webhooks** — event types, delivery semantics, signature verification.
- **Best practices** — chapter design patterns, prompt engineering tips, cost optimization.
- **Recipes** — common integration patterns: writing app, education platform, agency tool.
- **Changelog** — versioned API changes, deprecation notices.
- **Status** — at `status.authoragent.dev`; uptime + incident history.

## Marketing surface

Out of scope for this wiki — handled by marketing/sales team. Engineering provides:
- OpenAPI spec → marketing site auto-generates feature comparison.
- Usage telemetry → success metrics for case studies.
- Performance benchmarks → blog posts (latency comparison, quality scores from testbed).

## Migration impact: Workbench-as-customer

Internal Workbench becomes one large customer of the Author Agent API. Not literally — internally it uses `/internal/*` endpoints (no API key, no per-token billing) — but conceptually:
- Workbench server's chat-proxy classifies + dispatches.
- For migrated tools, calls `/internal/chapters/write` etc.
- For non-migrated tools, calls n8n hub via existing path.

Workbench user-tier billing (Sprint 8 + Sprint 9 Stripe) remains separate from B2B billing. Workbench users don't have Author Agent API keys; they pay for Writers Workbench access. Internal calls aren't metered against any tenant.

This is the **dogfooding model** — Workbench is the reference implementation. New features prove out internally before shipping to B2B customers.

## Pricing display strategy

Pricing page on marketing site:

```
                Free       Starter     Pro        Scale     Enterprise
Tokens          10K        1M          8M         50M       Custom
$/month         0          99          499        2,499     Custom
RPM             5          60          300        1,000     Custom
SLA             —          —           99.5%      99.9%     99.95%
Cross-chapter   —          —           ✓          ✓         ✓
Custom prompts  —          —           —          ✓         ✓
Self-hosted     —          —           —          —         ✓
Support         Community  Email       Priority   Slack     Dedicated CSM
```

Hide internal cost basis. Show value framing.

## Competitive positioning

| Competitor | Their angle | Our differentiation |
|---|---|---|
| OpenAI Assistants API | General-purpose | Domain-tuned for novel-length writing; built-in story bible + drift scanner |
| Anthropic API directly | Raw LLM | We handle orchestration, idempotency, cost management, multi-LLM strategy |
| Sudowrite (consumer) | Consumer app | We're the API layer — they're the UI; we don't compete |
| NovelAI (consumer) | Consumer app | Same — we're the platform |
| Custom in-house build | Total control | Skip 18 months of prompt engineering |

## Customer support tiers

- **Community** (Free): GitHub Discussions, public Discord. Self-service docs.
- **Email** (Starter): 48h response.
- **Priority** (Pro): 12h response, dedicated email.
- **Slack** (Scale): shared Slack channel, 4h response.
- **Dedicated CSM** (Enterprise): named contact, kickoff onboarding, quarterly reviews.

## Legal + compliance

Out of scope here, but the architecture must enable:
- Per-tenant data deletion (GDPR right-to-erasure).
- Per-tenant data export.
- Audit log of admin actions per tenant.
- Tenant-level secrets isolation.
- SOC 2 evidence collection (tracing, access logs, change management).

[[multi-tenancy]] covers the data isolation guarantees.

## When to launch B2B

**Not before** internal Phase 1-2 of [[python-migration-roadmap]] complete + Writers Workbench has been on the new backend in PROD for ≥30 days without rollback. Reasons:
- B2B customers have higher reliability expectations than internal users.
- Backend bugs surface faster on diverse customer workloads.
- Marketing + sales infrastructure (docs, billing, support) takes time independently.

Realistic B2B GA: ~6-9 months from start of [[python-migration-roadmap|migration roadmap]].

Beta access (paid, capped) can launch earlier (~3 months) for design partners.

## Risk: customer support load

A B2B platform requires customer support hours. Engineering shouldn't carry it long-term. Plan:
- Phase 1 (beta): engineering handles support directly. ~5h/week.
- Phase 2 (GA, <50 customers): one part-time CSM.
- Phase 3 (>50 customers): dedicated support team + tiered routing.

Cost: ~$80k/year per FTE. Factor into pricing model.

## What stays internal-only

Some operations don't make sense to expose externally:

- **`/admin/*`** endpoints — operational only.
- **`/internal/*`** endpoints — same logic but identity-by-payload, not API-key.
- **Hub-callable tools** that depend on Workbench-specific data flow (e.g. Eve callback routing — has no analog for B2B customers without their own voice integration).
- **Cron entry points** — customers shouldn't trigger our crons.

Keep the public surface tight + meaningful. Each `/v1/*` endpoint must have a clear customer use case.

## Decision: when to migrate Workbench server itself to call `/v1/`

Currently Workbench server has its own chat-proxy → BullMQ → n8n flow. As the Python backend matures:

**Option A**: Workbench server calls `/internal/*` endpoints directly. Simple. Keeps existing auth flow.
**Option B**: Workbench server treated as a regular `/v1/*` customer. Eats own dog food on the public API. Better long-term.

**Recommendation: Option A initially** (faster migration, less risk). Migrate to Option B once API stabilizes (~6 months post-launch).
