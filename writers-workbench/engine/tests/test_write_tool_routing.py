"""F1-B write-tool dispatch map + async classification.

Every tool name must equal a step service STEP_NAME (so StepInput.step_name validates) and resolve
to a configured *_step_url. Heavy tools default to async (enqueue + poll) to beat the ~300s edge limit.
"""

from __future__ import annotations

from orchestrator.write_tools import (
    ASYNC_DEFAULT_TOOLS,
    WRITE_TOOL_URLS,
    is_async,
    resolve_step_url,
)
from writer_engine.config import get_settings

EXPECTED_TOOLS = {
    "chapter",
    "research",
    "brainstorm",
    "media",
    "library",
    "story_bible",
    "approval",
    "notify",
}


def test_all_write_tools_present() -> None:
    assert set(WRITE_TOOL_URLS) == EXPECTED_TOOLS


def test_each_tool_resolves_to_a_unique_localhost_step_url() -> None:
    s = get_settings()
    seen = set()
    for tool in WRITE_TOOL_URLS:
        url = resolve_step_url(tool, s)
        assert url and url.startswith("http://")
        port = url.rsplit(":", 1)[-1]
        assert port.isdigit() and port not in seen
        seen.add(port)


def test_unknown_tool_resolves_none() -> None:
    assert resolve_step_url("nope", get_settings()) is None


def test_heavy_tools_default_async() -> None:
    assert {"chapter", "brainstorm", "research"} <= ASYNC_DEFAULT_TOOLS
    assert is_async("chapter", {}) is True
    assert is_async("brainstorm", {}) is True
    # lightweight tools stay sync by default
    assert is_async("library", {}) is False


def test_async_flag_overrides_default() -> None:
    assert is_async("chapter", {"async": False}) is False  # force sync
    assert is_async("library", {"async": True}) is True  # force async
