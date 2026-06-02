# F1-B — hub routing + DEV→PROD cutover

Routes the n8n hub's write-workshop `ai_tool`s to the Python engine instead of `executeWorkflow`,
behind a per-tool `app_config` flag. **The PROD flip happens only after a formal acceptance test of
the DEV system passes** (and explicit user sign-off) — never straight off the shadow.

## Sequence (gates in order)

```
1. Engine machinery (DONE)        — steps deployed + /internal/write/{tool} verified end-to-end on DEV
2. F1-A.6b remaining engine work  — media cover-art (KIE.AI) + scrape-url (Firecrawl) clients
3. Hub rewiring on DEV + shadow   — n8n ai_tools call the engine; shadow-diff vs n8n
        │
        ▼
4. ►► ACCEPTANCE TEST (DEV) ◄◄    — the gate. Full suite green on the DEV system + UAT sign-off.
        │   (must PASS before step 5)
        ▼
5. PROD flip (per tool)           — Tier-2/3; only after step 4 passes AND the user says go.
```

Steps 1–3 are non-PROD. **Step 5 must not start until step 4 is signed off.**

## 1. Engine machinery (done)

The 8 write-workshop step services run inside `writer-engine-runtime` (Dockerfile + entrypoint,
ports 8020–8027, `*_STEP_URL` config), callable through one uniform route:

- **gateway** `POST /internal/write/{tool}` (`X-Service-Secret`) → forwards to
- **orchestrator** `POST /pipelines/write/{tool}/run` → dispatches to the step's `/run`.

Tools: `chapter`, `research`, `brainstorm`, `media`, `library`, `story_bible`, `approval`, `notify`
(name == step `STEP_NAME`). Body is the step payload (`{op, ...}`); response is the `StepOutput`.
Verified end-to-end on DEV (a full craft-composed outline returned through the gateway).

```
POST https://writer-engine-gateway-develop.up.railway.app/internal/write/chapter
X-Service-Secret: <secret>
{ "op": "write", "project_id": "...", "chapter_number": 1, "chapter_run_id": "...", "llm_strategy": "sonnet" }
```

## 2. Remaining engine work (before the shadow)
- `media.cover-art` (KIE.AI submit/poll + DALL·E fallback) and `media.scrape-url` (Firecrawl) HTTP
  clients (F1-A.6b) — keys present; currently stubs.
- L5 parity harness wired per tool (extends `scripts/f1a-chapter-regression.py`).

## 3. Hub rewiring on DEV + shadow (F1-7)

Per write-workshop `ai_tool` in the **DEV** hub (`DEV - The Author Agent` + the `DEV - Tool - *`
workflows), replace `executeWorkflow` with an HTTP Request node to
`{ENGINE_GATEWAY}/internal/write/{tool}` (header-auth `X-Service-Secret`), gated by
`app_config.python_backend_routing.{tool}`.

**Shadow:** in "shadow" mode run BOTH the n8n tool and the engine call, log both artifacts, and diff
(the L5 parity harness). Accumulate ≥7 days of data at ≥95% agreement on structure + craft dims.

## 4. Acceptance test of the DEV system — THE GATE before PROD

A single named gate (`docs/f1-test-plan.md` defines the suites). PROD flip does NOT begin until ALL
of these pass on the **develop** system and the user signs off:

- **A1 — Unit:** engine CI green on `develop` (the full pytest suite).
- **A2 — System (S-suite):** S-CH-*, S-RE, S-BR, S-OUT, S-MED, S-LIB/S-SB, S-APP, S-NOT green
  against the deployed **DEV** engine (real DB + LLM).
- **A3 — Regression (R-CHAPTER-DB):** `scripts/f1a-chapter-regression.py` over real DEV outlines —
  every chapter generates and clears the craft-QA bar (≥0.8 every dimension) after the revision loop.
- **A4 — Parity (L5):** each write tool ≥0.95 vs its n8n baseline, sustained over the ≥7-day DEV
  shadow (step 3).
- **A5 — UAT:** a human runs each tool through the **DEV Writer's Workbench UI** end-to-end
  (brainstorm → research → chapter → QA → library) and signs off on quality + behaviour.

**Exit:** A1–A5 all pass on DEV → recorded as the acceptance sign-off → only then schedule step 5.

## 5. PROD flip (F1-8 — Tier-2/3, GATED on the acceptance sign-off + user go)

Only after step 4 passes. Per tool:
0. Set the PROD engine env (`WORKBENCH_API_URL`, `INGESTION_SECRET`, `ANTHROPIC_API_KEY`,
   `PERPLEXITY_API_KEY`, `KIEAI_API_KEY`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, step URLs) and
   confirm the PROD runtime booted healthy with all write steps.
1. Flip `app_config.python_backend_routing.{tool}=engine` on PROD.
2. Smoke the tool on PROD.
3. After 7 clean days on PROD, archive the replaced n8n tool workflow (90-day rollback).

**Do not flip PROD without (a) the DEV acceptance test passed and (b) the user's explicit go** — this
changes the PROD hub (Tier-2) + PROD behaviour.
