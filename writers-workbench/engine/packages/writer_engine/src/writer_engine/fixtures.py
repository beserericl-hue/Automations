"""Gate for the step services' fixture fallbacks (A1).

Every step service falls back to locally-generated placeholder content when its provider adapter is
not registered — which is how the local ``docker compose`` stack and the test suite run without any
API keys. The F1-A prereq narrowed those ``except`` clauses to :class:`ProviderNotRegistered` so real
LLM errors (429, network, validation) surface unmasked, and that part works.

What remained (A1) is the dangerous half: a **misconfigured** environment — a key absent or
mistyped — still produced a plausible-looking artifact that was then **persisted and emailed to the
user as real work**. A missing key is indistinguishable from a working one at the call site, so the
failure is silent by construction.

So the fallback is now opt-in. ``ALLOW_FIXTURE_FALLBACK`` must be explicitly true for a step to
substitute a fixture; otherwise the step raises and the step-service template converts it into a
``StepOutput(status=ERROR)``, which the orchestrator surfaces rather than persisting.

* tests + local compose: ``ALLOW_FIXTURE_FALLBACK=true`` (``conftest.py`` / ``.env.example``)
* DEV + PROD: unset, therefore false — a missing key fails loudly on the first call

The guard is NOT a substitute for the provider-error narrowing; both apply. This one covers
"configured wrong", the other covers "provider misbehaved".
"""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("fixtures")


class FixtureFallbackDisabled(RuntimeError):
    """A step needed a fixture fallback but fixtures are not enabled in this environment.

    Surfaces through the step template as ``StepOutput(status=ERROR, code="FixtureFallbackDisabled")``
    so the cause is attributable in the job record instead of looking like a successful generation.
    """


def fixture_fallback_allowed() -> bool:
    """True only when ``ALLOW_FIXTURE_FALLBACK`` is explicitly enabled."""
    return bool(get_settings().allow_fixture_fallback)


def guard_fixture_fallback(*, step: str, reason: str) -> None:
    """Permit a fixture fallback, or raise so the step fails loudly.

    Call immediately before substituting placeholder content::

        except ProviderNotRegistered as exc:
            guard_fixture_fallback(step=STEP_NAME, reason=str(exc))
            result = _fixture(...)

    Even when permitted, the substitution is logged at WARNING — a fixture in a run that was supposed
    to be real should be visible in the logs, not just in the output.
    """
    if not fixture_fallback_allowed():
        raise FixtureFallbackDisabled(
            f"{step}: {reason}. Fixture fallback is disabled "
            "(ALLOW_FIXTURE_FALLBACK is not set), so this step will not return placeholder "
            "content as a real result. Configure the provider's API key for this environment."
        )
    logger.warning("step.fixture_fallback", step=step, reason=reason)


__all__ = ["FixtureFallbackDisabled", "fixture_fallback_allowed", "guard_fixture_fallback"]
