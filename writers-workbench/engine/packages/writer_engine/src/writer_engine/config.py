"""Engine-wide settings loaded from env. All services share this shape via ``EngineSettings``."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineSettings(BaseSettings):
    """Single source of truth for environment configuration across the engine.

    Every service instantiates this once at startup. Values come from env vars (and ``.env`` in dev).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Auth. Default EMPTY, never a placeholder value (G3): a well-known default like
    # "dev-service-secret-change-me" means an environment that forgets to set these is wide open to
    # anyone who has read this file. Empty is treated as "not configured" and fails closed — see
    # writer_engine.auth.service_secret.
    service_shared_secret: str = Field(default="", alias="SERVICE_SHARED_SECRET")
    admin_token: str = Field(default="", alias="ADMIN_TOKEN")

    # Supabase
    supabase_url: str = Field(default="", alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(default="", alias="SUPABASE_SERVICE_ROLE_KEY")

    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    # arq's RedisSettings defaults to a ONE SECOND socket connect timeout, which the B11 load test
    # at 20 users blew through: the heavy worker took `redis.exceptions.TimeoutError: Timeout
    # connecting to server` and exited, taking the container with it. Redis was not down — it was
    # busy.
    #
    # 15s, not 10, since DEV moved to HA Redis (2026-10-17): that deployment is HAProxy in front of
    # five nodes with HAPROXY_TIMEOUT_CONNECT=10s, so during a failover HAProxy may itself spend up
    # to 10 seconds reaching a backend. A client timeout at or below that would give up while the
    # failover it is waiting for is still completing — turning a survivable 3s blip into an error.
    # Still short enough that a genuinely dead Redis is caught inside one readiness cycle.
    redis_connect_timeout_s: int = Field(default=15, alias="REDIS_CONNECT_TIMEOUT_S")
    # Pool ceiling per process. The interactive worker alone may hold 24 jobs, each of which touches
    # Redis for budget, progress and the ledger, and the orchestrator shares the container.
    redis_max_connections: int = Field(default=64, alias="REDIS_MAX_CONNECTIONS")

    # LLM providers
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    perplexity_api_key: str = Field(default="", alias="PERPLEXITY_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")

    # Image / scrape
    kieai_api_key: str = Field(default="", alias="KIEAI_API_KEY")
    firecrawl_api_key: str = Field(default="", alias="FIRECRAWL_API_KEY")

    # Humanizer (E6). StealthGPT REST: POST https://www.stealthgpt.ai/api/stealthify with an
    # `api-token` header, max 3000 words per request. Empty = the humanize pass is OFF, which is the
    # default everywhere: it is a paid per-word service, and on fiction a strong setting can flatten
    # literary voice, so it must never run unless someone asked for it.
    stealthgpt_api_key: str = Field(default="", alias="STEALTHGPT_API_KEY")
    # super | standard | lite. `standard` measured best per credit: `super` bills ~6x the input
    # words and invents events that were not in the source.
    stealthgpt_model: str = Field(default="standard", alias="STEALTHGPT_MODEL")
    # High | Medium | Low. Default Low on measured evidence, not on the name: on a real 1479-word
    # blog post Low scored 93 against High's 83, kept all 7 markdown headings against High's 6, and
    # lost no dates where High dropped the two the article was about. Same cost either way.
    stealthgpt_mode: str = Field(default="Low", alias="STEALTHGPT_MODE")
    # text | markdown. markdown is not cosmetic: the same mode in `text` dropped 2 of 7 headings
    # and scored 7 points lower for the same money.
    stealthgpt_output_format: str = Field(default="markdown", alias="STEALTHGPT_OUTPUT_FORMAT")
    # Run the pass automatically on non-fiction (blog / newsletter / social). Fiction is NOT
    # humanized: measured on a real scene, both modes destroyed the researched period vocabulary
    # (maize -> corn, packed earth -> flat stone) that a chapter's research pass exists to get
    # right. A caller may still opt a single request out with `humanize: false`.
    humanize_non_fiction: bool = Field(default=True, alias="HUMANIZE_NON_FICTION")
    # Hard ceiling on BILLED words for a single humanize pass. Measured against the live API on
    # 2026-10-17: a 29-word passage billed 60 words on `standard` and 195 on `super`, i.e. roughly
    # 2x and 6x the input. The account is `billingMode: payg` with no prepaid credit buffer, so
    # nothing upstream would stop a mistaken "humanize all": 96 chapters x 7k words x 2 is about
    # 1.3M billed words. 20000 covers two or three chapters and makes a runaway pass impossible.
    humanize_max_words_per_run: int = Field(default=20_000, alias="HUMANIZE_MAX_WORDS_PER_RUN")

    # Delivery
    postal_api_key: str = Field(default="", alias="POSTAL_API_KEY")
    postal_api_url: str = Field(default="", alias="POSTAL_API_URL")
    archive_base_url: str = Field(default="https://archive.example.com", alias="ARCHIVE_BASE_URL")

    # Workbench
    workbench_api_url: str = Field(default="", alias="WORKBENCH_API_URL")
    ingestion_secret: str = Field(default="", alias="INGESTION_SECRET")
    # Shared with the WW server's /api/callback/newsletter-stage (X-Callback-Secret) so engine-backed
    # runs can drive the in-app SSE progress strip (F2-8). Empty = callback skipped.
    newsletter_callback_secret: str = Field(default="", alias="NEWSLETTER_CALLBACK_SECRET")

    # Picker model (decision #2)
    picker_model: str = Field(default="gemini-2.5-pro", alias="PICKER_MODEL")

    # Hub router model (CR-004) — fast/cheap Gemini for intent + tool selection, mirroring the n8n
    # hub's gemini-2.5-flash. Routing is a short structured call, so flash is the right tier.
    hub_router_model: str = Field(default="gemini-2.5-flash", alias="HUB_ROUTER_MODEL")

    # Anthropic model pins (F1-A — see [[f1a-decisions]] § model lineup). Strategy slots resolve to
    # these concrete ids; overridable per-env without code change.
    model_default: str = Field(default="claude-sonnet-4-6", alias="MODEL_DEFAULT")
    model_cheap: str = Field(default="claude-haiku-4-5-20251001", alias="MODEL_CHEAP")
    model_premium: str = Field(default="claude-opus-4-8", alias="MODEL_PREMIUM")

    # Required when ANTHROPIC_API_KEY is an ACCOUNT-level key (prefix sk-ant-usr-) rather than a
    # workspace-scoped one (sk-ant-api03-). Anthropic rejects every Messages call made with an
    # account key unless the request names a workspace:
    #
    #   400 invalid_request_error — "This API key is not scoped to a workspace, so this request
    #   must include the anthropic-workspace-id header"
    #
    # Empty for a workspace-scoped key, where the workspace is implicit and the header must NOT be
    # sent. See writer_engine.llm.anthropic_client.
    anthropic_workspace_id: str = Field(default="", alias="ANTHROPIC_WORKSPACE_ID")

    # Anthropic rate-limit budget (F1-A prereq #4). Empty string = use the baked-in Tier-4
    # DEFAULT_LIMITS in writer_engine.rate_limit.anthropic_budget. Set to override per env/tier.
    anthropic_tier: str = Field(default="", alias="ANTHROPIC_TIER")
    anthropic_budget_overrides: str = Field(default="", alias="ANTHROPIC_BUDGET_OVERRIDES")
    # B8: per-provider request caps for everything that is NOT Anthropic (which has its own
    # per-model token budget). Format "gemini=600,perplexity=30,openai=500/2000000" — rpm, or
    # rpm/tpm. Empty = the conservative defaults in writer_engine.rate_limit.provider_budget.
    # These are caps we chose, not limits the providers told us, so they belong in env.
    provider_rate_limits: str = Field(default="", alias="PROVIDER_RATE_LIMITS")

    # Scaling (CR-003): per-INSTANCE cap on simultaneous in-flight LLM calls (sized so one engine
    # instance handles ~10 concurrent users without oversubscribing). Horizontal scale = add
    # instances; the Redis-shared AnthropicBudget keeps all instances under the account-wide limit.
    max_concurrent_llm: int = Field(default=12, alias="MAX_CONCURRENT_LLM")
    llm_budget_max_wait_s: float = Field(default=300.0, alias="LLM_BUDGET_MAX_WAIT_S")
    # 429 backstop: how many times the Anthropic SDK retries with exponential backoff + retry-after.
    anthropic_max_retries: int = Field(default=5, alias="ANTHROPIC_MAX_RETRIES")

    # Postal delivery defaults (F1-A prereq #1 — PostalClient cc/bcc/sender/reply_to/headers).
    postal_sender: str = Field(default="", alias="POSTAL_SENDER")
    postal_sender_name: str = Field(default="", alias="SENDER_NAME")
    # Newsletter From header. MUST be an address Postal is authorised to send from (the
    # courseworx.media server authenticates the From domain) — an unauthorised From returns a
    # status=error "UnauthenticatedFromAddress" and the mail is dropped.
    newsletter_from_address: str = Field(default="eve@courseworx.media", alias="NEWSLETTER_FROM_ADDRESS")
    postal_reply_to: str = Field(default="", alias="REPLY_TO_EMAIL")
    postal_default_bcc: str = Field(default="", alias="POSTAL_DEFAULT_BCC")

    # Feature flags (F1-A). Embeddings default OFF → falls through to the n8n shim.
    enable_python_embeddings: bool = Field(default=False, alias="ENABLE_PYTHON_EMBEDDINGS")

    # A1: allow step services to substitute placeholder content when a provider key is missing.
    # Default FALSE so a misconfigured DEV/PROD environment fails loudly instead of persisting and
    # emailing a fixture as real work. Set true only for the key-less local stack + tests.
    allow_fixture_fallback: bool = Field(default=False, alias="ALLOW_FIXTURE_FALLBACK")

    # Embeddings (F1-A prereq #5). OpenAI text-embedding model + the pgvector match RPC name.
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")
    # A3: must match the function migration 027 creates. The old default
    # ("match_writing_documents") named a function that exists nowhere.
    embedding_match_rpc: str = Field(default="match_writing_embeddings_v2", alias="EMBEDDING_MATCH_RPC")

    # Inter-service
    orchestrator_url: str = Field(default="http://localhost:8001", alias="ORCHESTRATOR_URL")
    # Base URL of the steps process, for admin fan-out (A5 prompt reload). Prompts are consumed
    # there, so a reload that does not reach it changes nothing that generates text.
    #
    # Read by the ORCHESTRATOR, which shares the runtime container with the steps process and so can
    # reach it on localhost. The gateway is a separate service and cannot — it fans out to the
    # orchestrator (via `orchestrator_url`), which then does this hop. Empty = skip.
    steps_admin_url: str = Field(default="http://localhost:8030", alias="STEPS_ADMIN_URL")

    # Per-step service URLs (F1-A — runtime container binds these on localhost; orchestrator dials
    # them). Defaults match services/runtime/entrypoint.sh.
    gather_step_url: str = Field(default="http://localhost:8010", alias="GATHER_STEP_URL")
    pick_step_url: str = Field(default="http://localhost:8011", alias="PICK_STEP_URL")
    subject_step_url: str = Field(default="http://localhost:8012", alias="SUBJECT_STEP_URL")
    scrape_step_url: str = Field(default="http://localhost:8013", alias="SCRAPE_STEP_URL")
    segment_step_url: str = Field(default="http://localhost:8014", alias="SEGMENT_STEP_URL")
    image_step_url: str = Field(default="http://localhost:8015", alias="IMAGE_STEP_URL")
    assemble_step_url: str = Field(default="http://localhost:8016", alias="ASSEMBLE_STEP_URL")
    render_step_url: str = Field(default="http://localhost:8017", alias="RENDER_STEP_URL")
    persist_step_url: str = Field(default="http://localhost:8018", alias="PERSIST_STEP_URL")
    deliver_step_url: str = Field(default="http://localhost:8019", alias="DELIVER_STEP_URL")
    library_retrieve_step_url: str = Field(default="http://localhost:8002", alias="LIBRARY_RETRIEVE_STEP_URL")
    # Write-workshop step services (F1-B) — same in-container localhost convention.
    chapter_step_url: str = Field(default="http://localhost:8020", alias="CHAPTER_STEP_URL")
    research_step_url: str = Field(default="http://localhost:8021", alias="RESEARCH_STEP_URL")
    brainstorm_step_url: str = Field(default="http://localhost:8022", alias="BRAINSTORM_STEP_URL")
    media_step_url: str = Field(default="http://localhost:8023", alias="MEDIA_STEP_URL")
    library_step_url: str = Field(default="http://localhost:8024", alias="LIBRARY_STEP_URL")
    story_bible_step_url: str = Field(default="http://localhost:8025", alias="STORY_BIBLE_STEP_URL")
    approval_step_url: str = Field(default="http://localhost:8026", alias="APPROVAL_STEP_URL")
    notify_step_url: str = Field(default="http://localhost:8027", alias="NOTIFY_STEP_URL")

    # Alerting (C2). Empty recipient = log only, which is what the engine did for its whole life:
    # the 2026-05-19 Redis outage ran nine days because nothing ever told anyone.
    alert_email: str = Field(default="", alias="ALERT_EMAIL")
    # How long a condition stays quiet after it has been reported once. A monitor that mails every
    # 30 seconds during an outage is a monitor that gets filtered into a folder.
    alert_repeat_minutes: int = Field(default=30, alias="ALERT_REPEAT_MINUTES")

    # How often the in-process watchdog re-runs the readiness probes. 0 disables it. 60s means an
    # outage is reported within about a minute rather than when someone next uses the product.
    watchdog_interval_seconds: float = Field(default=60.0, alias="WATCHDOG_INTERVAL_SECONDS")

    # A11: the zone `newsletter_editions_v2.cadence_send_time` is interpreted in. The table has no
    # per-edition timezone column, so this is one global interpretation — set it to the operator's
    # own zone or a stored "09:00" means 09:00 UTC, which is 05:00 in New York.
    newsletter_timezone: str = Field(default="UTC", alias="NEWSLETTER_TIMEZONE")

    # Observability
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    metrics_port: int = Field(default=9090, alias="METRICS_PORT")
    service_name: str = Field(default="writer-engine", alias="SERVICE_NAME")


@lru_cache(maxsize=1)
def get_settings() -> EngineSettings:
    """Cached settings accessor."""
    return EngineSettings()
