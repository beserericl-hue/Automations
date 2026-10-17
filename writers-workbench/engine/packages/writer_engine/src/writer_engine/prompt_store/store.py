"""In-process prompt store. Falls back to a code-default dict when DB is unavailable.

When ``reload()`` is called (via ``/admin/reload-prompts``), the store pulls the latest from
``app_config_v2.prompts`` (Supabase). Keys are dotted: ``newsletter.pick_top_stories``, etc.
"""

from __future__ import annotations

from collections.abc import Mapping
from threading import RLock

from writer_engine.telemetry.logging import get_logger

logger = get_logger("prompt_store")


class PromptStore:
    def __init__(self, defaults: Mapping[str, str] | None = None) -> None:
        self._lock = RLock()
        self._defaults: dict[str, str] = dict(defaults or {})
        self._overrides: dict[str, str] = {}

    def get(self, key: str, default: str | None = None) -> str:
        with self._lock:
            if key in self._overrides:
                return self._overrides[key]
            if key in self._defaults:
                return self._defaults[key]
        if default is not None:
            return default
        raise KeyError(f"unknown prompt key: {key}")

    def register_default(self, key: str, value: str) -> None:
        with self._lock:
            self._defaults[key] = value

    def override(self, key: str, value: str) -> None:
        with self._lock:
            self._overrides[key] = value

    def clear_overrides(self) -> None:
        with self._lock:
            self._overrides.clear()

    async def reload_from_supabase(self) -> int:
        """Pull overrides from Supabase ``app_config`` keyed ``prompts.*`` and return the count loaded."""
        try:
            from writer_engine.supabase.client import get_supabase_admin
        except Exception as exc:  # pragma: no cover - import failure is environmental
            logger.warning("prompt_store.reload_unavailable", error=f"{type(exc).__name__}: {exc}"[:160])
            return 0
        try:
            client = await get_supabase_admin()
            resp = await client.table("app_config_v2").select("key,value").like("key", "prompts.%").execute()
        except Exception as exc:
            # C4: this used to return 0 silently, so `/admin/reload-prompts` answered "loaded: 0"
            # with no reason and the engine went on serving the previous prompts. A reload that
            # cannot reach Supabase is indistinguishable from one that found no overrides unless
            # it says so.
            logger.warning("prompt_store.reload_failed", error=f"{type(exc).__name__}: {str(exc)[:160]}")
            return 0
        rows = getattr(resp, "data", None) or []
        with self._lock:
            self._overrides.clear()
            for row in rows:
                key = row.get("key", "").removeprefix("prompts.")
                value = row.get("value")
                if key and isinstance(value, str):
                    self._overrides[key] = value
        return len(rows)


_store: PromptStore | None = None


def get_prompt_store() -> PromptStore:
    global _store
    if _store is None:
        _store = PromptStore()
    return _store
