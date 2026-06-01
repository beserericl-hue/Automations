"""Engine → WW newsletter-stage callback (F2-8 SSE bridge)."""

from __future__ import annotations

from uuid import uuid4

import httpx
import pytest

from writer_engine.config import get_settings
from writer_engine.state_machine import workbench_callback as wc


@pytest.fixture(autouse=True)
def _reset_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_stage_mapping_to_ww_enum() -> None:
    assert wc._ww_stage("picking") == "selecting_stories"
    assert wc._ww_stage("awaiting_subject_approval") == "awaiting_subject_approval"
    assert wc._ww_stage("rendering") == "segments_done"
    assert wc._ww_stage("saved") == "saved"
    assert wc._ww_stage("error") == "error"
    assert wc._ww_stage("init") is None  # no UI representation


@pytest.mark.asyncio
async def test_noop_when_unconfigured(monkeypatch) -> None:
    monkeypatch.delenv("WORKBENCH_API_URL", raising=False)
    monkeypatch.delenv("NEWSLETTER_CALLBACK_SECRET", raising=False)
    get_settings.cache_clear()
    assert await wc.notify_workbench_stage(uuid4(), "picking", cfg={"user_id": "+1", "edition_id": "ai-news"}) is False


@pytest.mark.asyncio
async def test_noop_when_cfg_missing_ids(monkeypatch) -> None:
    monkeypatch.setenv("WORKBENCH_API_URL", "https://ww.example")
    monkeypatch.setenv("NEWSLETTER_CALLBACK_SECRET", "s3cr3t")
    get_settings.cache_clear()
    assert await wc.notify_workbench_stage(uuid4(), "picking", cfg={}) is False


@pytest.mark.asyncio
async def test_posts_callback_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("WORKBENCH_API_URL", "https://ww.example")
    monkeypatch.setenv("NEWSLETTER_CALLBACK_SECRET", "s3cr3t")
    get_settings.cache_clear()

    captured: dict = {}

    class _Resp:
        status_code = 200

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    ok = await wc.notify_workbench_stage(
        uuid4(), "awaiting_stories_approval", cfg={"user_id": "+14105914612", "edition_id": "ai-news"}, message="m"
    )
    assert ok is True
    assert captured["url"].endswith("/api/callback/newsletter-stage")
    assert captured["headers"]["X-Callback-Secret"] == "s3cr3t"
    assert captured["json"]["stage"] == "awaiting_stories_approval"
    assert captured["json"]["userId"] == "+14105914612"
    assert captured["json"]["editionId"] == "ai-news"
    assert "ts" in captured["json"]


@pytest.mark.asyncio
async def test_post_failure_returns_false(monkeypatch) -> None:
    monkeypatch.setenv("WORKBENCH_API_URL", "https://ww.example")
    monkeypatch.setenv("NEWSLETTER_CALLBACK_SECRET", "s3cr3t")
    get_settings.cache_clear()

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    assert await wc.notify_workbench_stage(
        uuid4(), "picking", cfg={"user_id": "+1", "edition_id": "ai-news"}
    ) is False
