"""notify uses an authorised From; media social-posts is craft-composed with fixture fallback."""

from __future__ import annotations

import pytest
from media_step.main import _op_social_posts, _social_system


def test_social_system_has_craft_voice() -> None:
    sys = _social_system()
    assert "see THROUGH your sentences" in sys  # prose.transparent
    assert "strict JSON" in sys


@pytest.mark.asyncio
async def test_social_posts_fixture_path() -> None:
    out = await _op_social_posts({"summary": "A novel about cathedrals", "platforms": ["twitter", "linkedin"]})
    assert set(out) == {"twitter", "linkedin"}
    assert all(isinstance(v, str) and v for v in out.values())


@pytest.mark.asyncio
async def test_notify_email_defaults_to_authorised_from(monkeypatch: pytest.MonkeyPatch) -> None:
    import notify_step.main as nm

    captured: dict = {}

    async def _fake_send(**kwargs):
        captured.update(kwargs)

        class _R:
            message_id = "mid"

        return _R()

    monkeypatch.setattr(nm, "send_email", _fake_send)
    await nm._op_email({"to": ["a@b.com"], "subject": "s", "html": "<p>x</p>"})
    # default From must be the configured authorised sender, not a .local placeholder
    assert ".local" not in captured["from_addr"]
    assert "@" in captured["from_addr"]
