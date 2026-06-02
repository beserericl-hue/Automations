"""F1-B write-tool dispatch map — the hub-callable write-workshop tools resolve to step URLs.

Every tool name must equal a step service STEP_NAME (so StepInput.step_name validates) and resolve
to a configured *_step_url. This locks the gateway->orchestrator->step contract.
"""

from __future__ import annotations

from orchestrator.main import _WRITE_TOOL_URLS
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
    assert set(_WRITE_TOOL_URLS) == EXPECTED_TOOLS


def test_each_tool_resolves_to_a_localhost_step_url() -> None:
    s = get_settings()
    seen_ports = set()
    for tool, getter in _WRITE_TOOL_URLS.items():
        url = getter(s)
        assert url.startswith("http://"), f"{tool} url not http: {url}"
        port = url.rsplit(":", 1)[-1]
        assert port.isdigit(), f"{tool} url has no port: {url}"
        assert port not in seen_ports, f"{tool} reuses port {port}"
        seen_ports.add(port)
