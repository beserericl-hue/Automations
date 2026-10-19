"""C3 / G4 — credentials must not reach the logs.

Nothing redacted anything. `logger.warning(..., error=str(exc)[:200])` appears in the Anthropic
client, the embeddings match, every step's fixture fallback and the ingestion pipeline, and a
provider error is one of the likeliest places for a credential to surface: an SDK that quotes the
failing request brings the authorization header with it, and a PostgREST error can quote a URL
carrying `apikey=`. These logs go to Railway, readable by anyone with project access, and retained.

The strings below are the real shapes — the engine's own providers — with the bodies replaced by
filler.
"""

from __future__ import annotations

import pytest

from writer_engine.config import get_settings
from writer_engine.telemetry import redaction
from writer_engine.telemetry.redaction import MASK, redact, redact_processor


@pytest.fixture(autouse=True)
def _fresh_cache() -> None:
    redaction.reset_cache()
    yield
    redaction.reset_cache()


class TestKeyShapes:
    @pytest.mark.parametrize(
        "secret",
        [
            "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
            "sk-ant-usr-AAAABBBBCCCCDDDDEEEEFFFFGGGG",
            "sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGG",
            "sbp_AAAABBBBCCCCDDDDEEEEFFFFGGGG1234",
            "sb_secret_AAAABBBBCCCCDDDD",
            "fc-AAAABBBBCCCCDDDDEEEEFFFF",
            "AIzaAAAABBBBCCCCDDDDEEEEFFFFGGGGHHH",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.AAAABBBBCCCCDDDD",
        ],
    )
    def test_a_key_in_an_error_string_is_masked(self, secret: str) -> None:
        line = f"AuthenticationError: invalid key {secret} for workspace wrk_1"
        out = redact(line)
        assert secret not in out
        assert MASK in out
        # The surrounding diagnostic must survive — a redactor that eats the message is useless.
        assert "AuthenticationError" in out and "wrk_1" in out

    def test_a_credential_in_a_url_is_masked(self) -> None:
        line = (
            "APIError: GET https://gvbvwcnmjkdpclcisqrr.supabase.co/rest/v1/users_v2"
            "?select=*&apikey=sb_secret_AAAABBBBCCCCDDDD returned 401"
        )
        out = redact(line)
        assert "sb_secret_AAAABBBBCCCCDDDD" not in out
        assert "users_v2" in out, "the failing table is the useful part of this line"

    def test_a_bearer_header_is_masked(self) -> None:
        out = redact("401 {'authorization': 'Bearer abcdefghijklmnopqrstuvwxyz'}")
        assert "abcdefghijklmnopqrstuvwxyz" not in out

    def test_a_named_header_is_masked(self) -> None:
        out = redact("rejected: X-Admin-Token: 47c75d890241c40b29cb1f9884a03c2c")
        assert "47c75d890241c40b29cb1f9884a03c2c" not in out

    def test_ordinary_text_is_untouched(self) -> None:
        """Over-redaction makes logs useless, which is its own outage."""
        line = "chapter.write finished chapter=12 words=6314 model=claude-sonnet-4-6 duration_s=184.2"
        assert redact(line) == line

    def test_a_model_name_is_not_mistaken_for_a_key(self) -> None:
        assert redact("model=claude-haiku-4-5-20251001") == "model=claude-haiku-4-5-20251001"


class TestConfiguredSecrets:
    def test_a_configured_secret_is_masked_even_without_a_recognisable_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """SERVICE_SHARED_SECRET is 64 hex characters and looks like nothing in particular, so shape
        matching alone would miss it."""
        secret = "3a69afb270eaf56c51e176d861d44a59a3eb8de7aa623fbf6725faedf1ff015b"
        monkeypatch.setenv("SERVICE_SHARED_SECRET", secret)
        get_settings.cache_clear()
        redaction.reset_cache()
        try:
            out = redact(f"step call rejected with secret={secret}")
            assert secret not in out
            assert MASK in out
        finally:
            get_settings.cache_clear()

    def test_a_short_configured_value_is_not_masked(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A six-character "secret" would match inside ordinary words and turn every line into
        redaction soup."""
        monkeypatch.setenv("ADMIN_TOKEN", "abc123")
        get_settings.cache_clear()
        redaction.reset_cache()
        try:
            assert redact("the abc123 chapter") == "the abc123 chapter"
        finally:
            get_settings.cache_clear()


class TestProcessor:
    def test_every_string_value_in_the_event_is_redacted(self) -> None:
        event = {
            "event": "anthropic.error",
            "error": "AuthenticationError: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF",
            "model": "claude-sonnet-4-6",
            "attempt": 2,
        }
        out = redact_processor(None, "warning", event)
        assert "sk-ant-api03" not in str(out["error"])
        assert out["model"] == "claude-sonnet-4-6"
        assert out["attempt"] == 2, "non-strings pass through untouched"

    def test_the_event_message_itself_is_redacted(self) -> None:
        out = redact_processor(None, "info", {"event": "using key sk-ant-api03-AAAABBBBCCCCDDDDEEEE"})
        assert "sk-ant-api03" not in str(out["event"])

    def test_it_runs_before_the_renderer_in_the_real_configuration(self) -> None:
        """A processor installed after JSONRenderer would see a string, not the event dict, and do
        nothing — so the ORDER is the feature."""
        import inspect

        from writer_engine.telemetry import logging as log_mod

        src = inspect.getsource(log_mod.configure_logging)
        assert src.index("redact_processor") < src.index("JSONRenderer")

    def test_a_redactor_failure_cannot_break_logging(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(redaction, "_exact_secrets", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        redaction.reset_cache()
        assert redact("some line") == "some line"
