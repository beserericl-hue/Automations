"""Keep secrets out of the logs (C3 / G4).

Nothing redacted anything. The engine logs provider errors verbatim —
``logger.warning(..., error=str(exc)[:200])`` appears in the Anthropic client, the embeddings match,
every step's fixture fallback and the ingestion pipeline — and a provider error is one of the most
likely places for a credential to surface:

* an SDK that includes the failing request in its exception text brings the ``authorization`` header
  with it;
* a Supabase/PostgREST error can quote the URL it called, and a service-role key travels in
  ``apikey=``;
* a 401 body often echoes the key prefix back at you, which is enough to identify the key.

The logs go to Railway, where they are readable by anyone with project access and retained. So this
is a structlog processor that rewrites every event before it is rendered, rather than a rule that
every call site has to remember — the call sites are the thing that cannot be relied upon.

**What is matched.** The provider key SHAPES we actually use (`sk-ant-`, `sk-`, `sbp_`, `sb_secret_`,
`fc-`, Google's `AIza`, a JWT, a bearer/apikey parameter), plus any configured secret read from
settings at startup. Shape matching catches a key that arrives from somewhere we did not configure —
a user-pasted BYOK key, a key in a URL from a third-party SDK — and exact matching catches our own
keys even when they do not look like anything in particular, as `SERVICE_SHARED_SECRET` does.

**What is deliberately NOT done.** No attempt to parse structures or scrub recursively through
arbitrary objects: the processor walks the event dict's own values and stringifies nothing it is not
already going to render. A redactor that is slow or clever enough to break is worse than none, since
it sits in front of every log line in the system.
"""

from __future__ import annotations

import re
from collections.abc import MutableMapping
from typing import Any

MASK = "[redacted]"

# Ordered longest-prefix-first so `sk-ant-...` is not partly consumed by the `sk-` rule.
_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Anthropic (both workspace and account keys), OpenAI, Supabase (PAT + the new secret format),
    # Firecrawl, Google.
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bsbp_[A-Za-z0-9]{16,}"),
    re.compile(r"\bsb_secret_[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bfc-[A-Za-z0-9]{16,}"),
    re.compile(r"\bAIza[A-Za-z0-9_\-]{20,}"),
    # A JWT — Supabase anon/service keys and every user access token are JWTs.
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    # Credentials carried in a URL or a header that an SDK echoed back.
    re.compile(r"(?i)\b(apikey|api[-_]?key|access[-_]?token|token)=([^\s&\"']{8,})"),
    re.compile(r"(?i)\b(authorization|x-api-key|x-admin-token|x-service-secret)\s*[:=]\s*\S{8,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}"),
)

_MIN_EXACT_LEN = 12
"""Shorter configured values are not masked. A 6-character "secret" would match inside ordinary
words and turn the logs into redaction soup; anything that short is not a credential worth having."""


def _exact_secrets() -> list[str]:
    """The configured secrets, longest first so one is not partly masked by another."""
    try:
        from writer_engine.config import get_settings

        settings = get_settings()
    except Exception:  # pragma: no cover - logging must work before settings do
        return []
    candidates = [
        getattr(settings, name, "")
        for name in (
            "anthropic_api_key",
            "openai_api_key",
            "gemini_api_key",
            "perplexity_api_key",
            "firecrawl_api_key",
            "kieai_api_key",
            "stealthgpt_api_key",
            "postal_api_key",
            "supabase_service_role_key",
            "service_shared_secret",
            "admin_token",
            "ingestion_secret",
            "newsletter_callback_secret",
            "workbench_cron_secret",
        )
    ]
    out = {str(v).strip() for v in candidates if isinstance(v, str) and len(str(v).strip()) >= _MIN_EXACT_LEN}
    return sorted(out, key=len, reverse=True)


_cached_exact: list[str] | None = None


def reset_cache() -> None:
    """Forget the configured-secret list. For tests, and for a settings reload."""
    global _cached_exact
    _cached_exact = None


def redact(text: str) -> str:
    """Mask anything credential-shaped in ``text``. Never raises."""
    if not text:
        return text
    global _cached_exact
    try:
        if _cached_exact is None:
            _cached_exact = _exact_secrets()
        out = text
        for secret in _cached_exact:
            if secret and secret in out:
                out = out.replace(secret, MASK)
        for pattern in _PATTERNS:
            if pattern.groups:
                out = pattern.sub(lambda m: f"{m.group(1)}={MASK}", out)
            else:
                out = pattern.sub(MASK, out)
        return out
    except Exception:  # pragma: no cover - a redactor must not break logging
        return text


def redact_processor(
    _logger: Any, _name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: redact the event message and every string value.

    Installed for every service, so a call site that logs an exception verbatim — which is most of
    them — cannot leak a key by forgetting to think about it.
    """
    for key, value in list(event_dict.items()):
        if isinstance(value, str):
            event_dict[key] = redact(value)
    return event_dict


__all__ = ["MASK", "redact", "redact_processor", "reset_cache"]
