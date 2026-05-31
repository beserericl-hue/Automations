"""writer_engine.embeddings — flag-gating + graceful degradation (F1-A prereq #5).

The default-off path must never touch OpenAI/Supabase, so these tests run without either configured.
"""

from __future__ import annotations

import pytest

from writer_engine import embeddings
from writer_engine.config import get_settings


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_embeddings_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_PYTHON_EMBEDDINGS", raising=False)
    get_settings.cache_clear()
    assert embeddings.embeddings_enabled() is False


def test_embeddings_enabled_when_flag_set(monkeypatch) -> None:
    monkeypatch.setenv("ENABLE_PYTHON_EMBEDDINGS", "true")
    get_settings.cache_clear()
    assert embeddings.embeddings_enabled() is True


@pytest.mark.asyncio
async def test_match_returns_empty_when_disabled(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_PYTHON_EMBEDDINGS", raising=False)
    get_settings.cache_clear()
    out = await embeddings.match_writing_documents(query="q", user_id="+1")
    assert out == []


@pytest.mark.asyncio
async def test_re_embed_noop_when_disabled(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_PYTHON_EMBEDDINGS", raising=False)
    get_settings.cache_clear()
    assert await embeddings.re_embed_project(user_id="+1", project_title="p") == 0


@pytest.mark.asyncio
async def test_embed_texts_raises_when_disabled(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_PYTHON_EMBEDDINGS", raising=False)
    get_settings.cache_clear()
    with pytest.raises(RuntimeError):
        await embeddings.embed_texts(["hello"])


@pytest.mark.asyncio
async def test_embed_texts_empty_input_returns_empty_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("ENABLE_PYTHON_EMBEDDINGS", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()
    # Empty input short-circuits before any OpenAI call.
    assert await embeddings.embed_texts([]) == []
