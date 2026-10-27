"""The newsletter's story pick survives a dead Gemini key (DEV, 2026-10-27: "API key not valid")."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pick_step import main as P

from writer_engine.llm import ProviderNotRegistered
from writer_engine.schemas.newsletter import PickedStories


def test_a_gemini_failure_falls_back_to_anthropic_and_alerts(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    alerts: list[Any] = []

    async def fake(router: Any, *, provider: str, **_k: Any) -> Any:
        calls.append(provider)
        if provider == "gemini":
            raise RuntimeError("400 API key not valid. Please pass a valid API key.")
        return PickedStories.model_validate({"top_selected_stories": []}), None

    async def alert(exc: Exception) -> None:
        alerts.append(str(exc))

    monkeypatch.setattr(P, "complete_structured", fake)
    monkeypatch.setattr(P, "_alert_gemini_failed", alert)
    out = asyncio.run(P._pick(object(), [{"id": "a", "title": "t"}], 3, None))  # type: ignore[arg-type]
    assert isinstance(out, PickedStories)
    assert calls == ["gemini", "anthropic"]
    assert alerts and "API key not valid" in alerts[0]


def test_no_provider_registered_still_raises_for_the_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake(router: Any, *, provider: str, **_k: Any) -> Any:
        raise ProviderNotRegistered("gemini")

    monkeypatch.setattr(P, "complete_structured", fake)
    with pytest.raises(ProviderNotRegistered):
        asyncio.run(P._pick(object(), [], 3, None))  # type: ignore[arg-type]
