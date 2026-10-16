"""An account-level Anthropic key must name its workspace on every request.

Measured against the live API on 2026-10-16 while recovering DEV from a 401:

    sk-ant-usr-...  + no header                 -> 400 invalid_request_error
                                                   "This API key is not scoped to a workspace..."
    sk-ant-usr-...  + anthropic-workspace-id    -> 200
    sk-ant-api03-...                            -> 200 (workspace is implicit)

So the header is required for one key shape and must be ABSENT for the other. Both halves are
tested, because sending an empty workspace id is its own 400 and would be a confusing one.
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine.config import get_settings


@pytest.fixture(autouse=True)
def _fresh_settings() -> Any:
    """Settings are lru_cached process-wide; each test here needs its own view."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _adapter(monkeypatch: pytest.MonkeyPatch, *, workspace: str | None) -> Any:
    from writer_engine.llm.anthropic_client import AnthropicAdapter

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")
    if workspace is None:
        monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)
    else:
        monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", workspace)
    get_settings.cache_clear()
    return AnthropicAdapter(service="test")


def _sent_headers(adapter: Any) -> dict[str, str]:
    """The headers the SDK will attach to every request from this client."""
    client = adapter._client
    raw = dict(getattr(client, "default_headers", {}) or {})
    return {str(k).lower(): str(v) for k, v in raw.items()}


def test_the_workspace_header_is_sent_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _adapter(monkeypatch, workspace="wrkspc_011FbjsL6KUyChB43cF5QCLJ")
    assert _sent_headers(adapter)["anthropic-workspace-id"] == "wrkspc_011FbjsL6KUyChB43cF5QCLJ"


def test_no_header_is_sent_when_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    """A workspace-scoped key carries its workspace implicitly; the header would be noise."""
    adapter = _adapter(monkeypatch, workspace=None)
    assert "anthropic-workspace-id" not in _sent_headers(adapter)


def test_an_empty_or_blank_setting_sends_no_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ANTHROPIC_WORKSPACE_ID=""` (or a stray space) must not become an empty header value.

    Anthropic rejects an empty workspace id, and it would do so with a different, more confusing
    error than the missing-header one.
    """
    for value in ("", "   "):
        adapter = _adapter(monkeypatch, workspace=value)
        assert "anthropic-workspace-id" not in _sent_headers(adapter), repr(value)


def test_the_setting_is_trimmed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A pasted env var often carries whitespace; the header value must not."""
    adapter = _adapter(monkeypatch, workspace="  wrkspc_abc  ")
    assert _sent_headers(adapter)["anthropic-workspace-id"] == "wrkspc_abc"


def test_the_header_applies_to_streaming_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set once on the client, not per call, so stream and create cannot diverge.

    A chapter write streams (>16k output tokens) and a Q/A does not. If the header were added at one
    call site only, exactly one of those two would work — the worst possible version of this bug.
    """
    adapter = _adapter(monkeypatch, workspace="wrkspc_abc")
    # Both call paths use the same client instance, so one assertion covers both by construction.
    assert adapter._client is adapter._client
    assert _sent_headers(adapter)["anthropic-workspace-id"] == "wrkspc_abc"
