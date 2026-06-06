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

    # Auth
    service_shared_secret: str = Field(default="dev-service-secret-change-me", alias="SERVICE_SHARED_SECRET")
    admin_token: str = Field(default="dev-admin-token-change-me", alias="ADMIN_TOKEN")

    # Supabase
    supabase_url: str = Field(default="", alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(default="", alias="SUPABASE_SERVICE_ROLE_KEY")

    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")

    # LLM providers
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    perplexity_api_key: str = Field(default="", alias="PERPLEXITY_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")

    # Image / scrape
    kieai_api_key: str = Field(default="", alias="KIEAI_API_KEY")
    firecrawl_api_key: str = Field(default="", alias="FIRECRAWL_API_KEY")

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

    # Anthropic rate-limit budget (F1-A prereq #4). Empty string = use the baked-in Tier-4
    # DEFAULT_LIMITS in writer_engine.rate_limit.anthropic_budget. Set to override per env/tier.
    anthropic_tier: str = Field(default="", alias="ANTHROPIC_TIER")
    anthropic_budget_overrides: str = Field(default="", alias="ANTHROPIC_BUDGET_OVERRIDES")
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
    newsletter_from_address: str = Field(
        default="eve@courseworx.media", alias="NEWSLETTER_FROM_ADDRESS"
    )
    postal_reply_to: str = Field(default="", alias="REPLY_TO_EMAIL")
    postal_default_bcc: str = Field(default="", alias="POSTAL_DEFAULT_BCC")

    # Feature flags (F1-A). Embeddings default OFF → falls through to the n8n shim.
    enable_python_embeddings: bool = Field(default=False, alias="ENABLE_PYTHON_EMBEDDINGS")

    # Embeddings (F1-A prereq #5). OpenAI text-embedding model + the pgvector match RPC name.
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")
    embedding_match_rpc: str = Field(
        default="match_writing_documents", alias="EMBEDDING_MATCH_RPC"
    )

    # Inter-service
    orchestrator_url: str = Field(default="http://localhost:8001", alias="ORCHESTRATOR_URL")

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
    library_retrieve_step_url: str = Field(
        default="http://localhost:8002", alias="LIBRARY_RETRIEVE_STEP_URL"
    )
    # Write-workshop step services (F1-B) — same in-container localhost convention.
    chapter_step_url: str = Field(default="http://localhost:8020", alias="CHAPTER_STEP_URL")
    research_step_url: str = Field(default="http://localhost:8021", alias="RESEARCH_STEP_URL")
    brainstorm_step_url: str = Field(default="http://localhost:8022", alias="BRAINSTORM_STEP_URL")
    media_step_url: str = Field(default="http://localhost:8023", alias="MEDIA_STEP_URL")
    library_step_url: str = Field(default="http://localhost:8024", alias="LIBRARY_STEP_URL")
    story_bible_step_url: str = Field(default="http://localhost:8025", alias="STORY_BIBLE_STEP_URL")
    approval_step_url: str = Field(default="http://localhost:8026", alias="APPROVAL_STEP_URL")
    notify_step_url: str = Field(default="http://localhost:8027", alias="NOTIFY_STEP_URL")

    # Observability
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    metrics_port: int = Field(default=9090, alias="METRICS_PORT")
    service_name: str = Field(default="writer-engine", alias="SERVICE_NAME")


@lru_cache(maxsize=1)
def get_settings() -> EngineSettings:
    """Cached settings accessor."""
    return EngineSettings()
