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


class _Log:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def info(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def warning(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))


def _story() -> dict[str, Any]:
    return {"title": "t", "summary": "s", "identifiers": ["a"], "external_source_links": []}


def test_a_healthy_pick_logs_that_gemini_picked_it(monkeypatch: pytest.MonkeyPatch) -> None:
    log = _Log()

    async def fake(router: Any, *, provider: str, **_k: Any) -> Any:
        return PickedStories.model_validate({"top_selected_stories": [_story(), _story()]}), None

    monkeypatch.setattr(P, "complete_structured", fake)
    monkeypatch.setattr(P, "logger", log)
    asyncio.run(P._pick(object(), [{"id": "a", "title": "t"}], 3, None))  # type: ignore[arg-type]
    done = [kw for e, kw in log.events if e == "pick.done"]
    assert len(done) == 1
    assert done[0]["provider"] == "gemini" and done[0]["fallback"] is False and done[0]["stories"] == 2


def test_a_fallback_pick_logs_that_anthropic_picked_it(monkeypatch: pytest.MonkeyPatch) -> None:
    log = _Log()

    async def fake(router: Any, *, provider: str, **_k: Any) -> Any:
        if provider == "gemini":
            raise RuntimeError("503 unavailable")
        return PickedStories.model_validate({"top_selected_stories": [_story()]}), None

    async def alert(exc: Exception) -> None:
        return None

    monkeypatch.setattr(P, "complete_structured", fake)
    monkeypatch.setattr(P, "_alert_gemini_failed", alert)
    monkeypatch.setattr(P, "logger", log)
    asyncio.run(P._pick(object(), [{"id": "a", "title": "t"}], 3, None))  # type: ignore[arg-type]
    done = [kw for e, kw in log.events if e == "pick.done"]
    assert len(done) == 1
    assert done[0]["provider"] == "anthropic" and done[0]["fallback"] is True


def test_no_provider_registered_still_raises_for_the_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake(router: Any, *, provider: str, **_k: Any) -> Any:
        raise ProviderNotRegistered("gemini")

    monkeypatch.setattr(P, "complete_structured", fake)
    with pytest.raises(ProviderNotRegistered):
        asyncio.run(P._pick(object(), [], 3, None))  # type: ignore[arg-type]
