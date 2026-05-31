"""Async Supabase service-role client, lazily constructed and cached for the process lifetime."""

from __future__ import annotations

from supabase._async.client import AsyncClient, create_client

from writer_engine.config import get_settings

_client: AsyncClient | None = None


async def get_supabase_admin() -> AsyncClient:
    """Return the process-wide Supabase admin (service-role) client."""
    global _client
    if _client is None:
        settings = get_settings()
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise RuntimeError(
                "Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
            )
        _client = await create_client(settings.supabase_url, settings.supabase_service_role_key)
    return _client


async def close_supabase() -> None:
    """Drop the cached client. The underlying httpx client closes on GC."""
    global _client
    _client = None
