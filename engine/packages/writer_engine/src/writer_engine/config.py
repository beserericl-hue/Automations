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

    # Picker model (decision #2)
    picker_model: str = Field(default="gemini-2.5-pro", alias="PICKER_MODEL")

    # Inter-service
    orchestrator_url: str = Field(default="http://localhost:8001", alias="ORCHESTRATOR_URL")

    # Observability
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    metrics_port: int = Field(default=9090, alias="METRICS_PORT")
    service_name: str = Field(default="writer-engine", alias="SERVICE_NAME")


@lru_cache(maxsize=1)
def get_settings() -> EngineSettings:
    """Cached settings accessor."""
    return EngineSettings()
