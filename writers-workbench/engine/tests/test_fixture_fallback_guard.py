"""A1 — a missing provider key must fail loudly, not produce placeholder content.

The fixture fallbacks let the local stack and this suite run key-less. The danger they carried is
that a MISCONFIGURED environment (key absent or mistyped) was indistinguishable from a working one:
the step returned a plausible artifact which was then persisted and emailed to the user as real work.

Fallback is now gated on ALLOW_FIXTURE_FALLBACK. These tests pin both directions.
"""

from __future__ import annotations

import uuid

import pytest

from writer_engine.config import get_settings
from writer_engine.fixtures import (
    FixtureFallbackDisabled,
    fixture_fallback_allowed,
    guard_fixture_fallback,
)
from writer_engine.llm import LLMRouter, ProviderNotConfigured, ProviderNotRegistered
from writer_engine.schemas import StepInput, StepStatus


@pytest.fixture
def fixtures_disabled(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    """Simulate DEV/PROD, where the flag is unset."""
    monkeypatch.setenv("ALLOW_FIXTURE_FALLBACK", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# --- the guard itself -------------------------------------------------------------------------


def test_guard_allows_when_flag_is_on() -> None:
    assert fixture_fallback_allowed() is True  # conftest sets it for the suite
    guard_fixture_fallback(step="demo", reason="no key")  # must not raise


def test_guard_raises_when_flag_is_off(fixtures_disabled: None) -> None:
    assert fixture_fallback_allowed() is False
    with pytest.raises(FixtureFallbackDisabled) as exc:
        guard_fixture_fallback(step="demo", reason="ANTHROPIC_API_KEY unset")
    # The message must name the step and the cause, so the job record is diagnosable.
    assert "demo" in str(exc.value)
    assert "ANTHROPIC_API_KEY unset" in str(exc.value)
    assert "ALLOW_FIXTURE_FALLBACK" in str(exc.value)


def test_default_is_fail_loud() -> None:
    """Regression guard: the flag must never gain a default of True."""
    from writer_engine.config import EngineSettings

    assert EngineSettings.model_fields["allow_fixture_fallback"].default is False


# --- the router choke point -------------------------------------------------------------------


async def test_router_raises_not_registered_when_fixtures_allowed() -> None:
    """With fixtures on, the step services' `except ProviderNotRegistered` paths still work."""
    router = LLMRouter()
    with pytest.raises(ProviderNotRegistered):
        await router.complete(provider="anthropic", model="m", prompt="p")


async def test_router_raises_not_configured_when_fixtures_disabled(fixtures_disabled: None) -> None:
    router = LLMRouter()
    with pytest.raises(ProviderNotConfigured) as exc:
        await router.complete(provider="anthropic", model="m", prompt="p")
    assert "anthropic" in str(exc.value)
    assert "API key" in str(exc.value)


async def test_not_configured_is_not_caught_by_fixture_handlers(fixtures_disabled: None) -> None:
    """The whole mechanism: ProviderNotConfigured must bypass `except ProviderNotRegistered`.

    That is what makes ~23 fallback sites fail loudly without editing any of them — and what stops
    any one site opting itself back into faking success.
    """
    assert not issubclass(ProviderNotConfigured, ProviderNotRegistered)
    assert not issubclass(ProviderNotConfigured, KeyError)

    router = LLMRouter()
    with pytest.raises(ProviderNotConfigured):
        try:
            await router.complete(provider="anthropic", model="m", prompt="p")
        except ProviderNotRegistered:  # the shape every step service uses
            pytest.fail("a fixture handler swallowed ProviderNotConfigured")


# --- end-to-end through a real step service ---------------------------------------------------


def test_subject_step_returns_error_envelope_not_a_fixture(fixtures_disabled: None) -> None:
    """A newsletter subject line is user-visible copy — it must not be silently faked.

    Driven through the step service's ``/run`` route, not the bare handler, because the
    StepOutput(status=ERROR) envelope the orchestrator reads is produced by the route's error
    handling. That envelope is the actual contract.
    """
    from fastapi.testclient import TestClient
    from subject_step.main import app

    client = TestClient(app)
    r = client.post(
        "/run",
        headers={"x-service-secret": "test-secret"},
        json={
            "execution_id": str(uuid.uuid4()),
            "step_name": "subject",
            "payload": {"top_selected_stories": [{"title": "A story"}]},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == StepStatus.ERROR.value
    assert body["error"]["code"] == "ProviderNotConfigured"
    # And crucially: no faked subject line came back.
    assert not (body.get("payload") or {}).get("subject_line")


async def test_subject_step_still_fixtures_when_allowed() -> None:
    """The key-less local/test path is unaffected."""
    from subject_step.main import handler

    out = await handler(
        StepInput(
            execution_id=uuid.uuid4(),
            step_name="subject",
            payload={"top_selected_stories": [{"title": "A story"}]},
        )
    )
    assert out.status is StepStatus.OK
    assert out.payload["subject_line"]


async def test_media_scrape_refuses_without_firecrawl_key(fixtures_disabled: None) -> None:
    """Scraped text grounds newsletter segments and blog copy — a stub body must not pass as source."""
    from media_step.main import _op_scrape_url

    with pytest.raises(FixtureFallbackDisabled):
        await _op_scrape_url({"url": "https://example.com"})


async def test_media_cover_art_refuses_without_an_image_provider(fixtures_disabled: None) -> None:
    from media_step.main import _op_cover_art

    with pytest.raises(FixtureFallbackDisabled):
        await _op_cover_art({"title": "The Last Signal", "user_id": "+10000000000"})


async def test_library_retrieve_refuses_without_supabase(fixtures_disabled: None) -> None:
    """An empty result set would otherwise read as a genuine 'not found'."""
    from library_step.main import _op_retrieve

    with pytest.raises(FixtureFallbackDisabled):
        await _op_retrieve({"search_term": "quantum surfing"})
