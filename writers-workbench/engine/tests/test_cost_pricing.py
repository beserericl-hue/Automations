"""The price table: every model in use is priced, prices match the providers' pages, and the server's
copy is identical. An unknown model must never silently cost $0 or a guessed price."""

from __future__ import annotations

import json
import re
from importlib import resources
from pathlib import Path

import pytest

from writer_engine.config import get_settings
from writer_engine.telemetry import pricing

ENGINE = Path(__file__).resolve().parents[1]
SERVER_COPY = ENGINE.parent / "server" / "src" / "lib" / "provider-prices.ts"


def _json_text() -> str:
    return (
        resources.files("writer_engine.telemetry").joinpath(pricing.PRICES_FILE).read_text(encoding="utf-8")
    )


def test_every_entry_names_its_source_and_check_date() -> None:
    for e in pricing.load_table()["entries"]:
        assert str(e["source"]).startswith("https://"), e["model"]
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", e["checked"]), e["model"]


def test_every_configured_model_has_a_price() -> None:
    """Any model the engine is configured to call must be in the table — this is the test that fails
    when someone switches MODEL_DEFAULT to a new model and forgets the price."""
    s = get_settings()
    used = [
        ("anthropic", s.model_default),
        ("anthropic", s.model_cheap),
        ("anthropic", s.model_premium),
        ("gemini", s.picker_model),
        ("gemini", s.hub_router_model),
        ("openai", s.embedding_model),
        ("stealthgpt", s.stealthgpt_model),
        ("kieai", "google/nano-banana"),
        ("openai", "dall-e-3"),
        ("scraperapi", "api"),
    ]
    missing = [f"{p}/{m}" for p, m in used if pricing.price_entry(p, m) is None]
    assert not missing, f"unpriced models in use: {missing}"


_LITERAL = re.compile(r"[\"'](claude-[a-z0-9.-]+|gemini-[0-9][a-z0-9.-]*|sonar(?:-pro|-reasoning-pro)?)[\"']")


def test_every_model_literal_in_the_engine_source_has_a_price() -> None:
    """Catches a model named directly in a step (not via settings) with no price entry."""
    found: set[tuple[str, str]] = set()
    for path in [*(ENGINE / "packages").rglob("*.py"), *(ENGINE / "services").rglob("*.py")]:
        if "/tests/" in str(path):
            continue
        for m in _LITERAL.findall(path.read_text(encoding="utf-8")):
            prov = (
                "anthropic"
                if m.startswith("claude")
                else "gemini"
                if m.startswith("gemini")
                else "perplexity"
            )
            found.add((prov, m))
    assert found, "the scan found no model names at all — the regex is broken"
    missing = sorted(f"{p}/{m}" for p, m in found if pricing.price_entry(p, m) is None)
    assert not missing, f"model names in engine code with no price: {missing}"


@pytest.mark.parametrize(
    ("model", "inp", "out", "read", "w5", "w1h"),
    [
        # https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-02
        ("claude-sonnet-4-6", 3.0, 15.0, 0.30, 3.75, 6.0),
        ("claude-haiku-4-5-20251001", 1.0, 5.0, 0.10, 1.25, 2.0),  # was $0.80/$4 — wrong
        ("claude-opus-4-8", 5.0, 25.0, 0.50, 6.25, 10.0),  # was $15/$75 — wrong
        ("claude-opus-5-5", 4.0, 20.0, 0.20, 5.0, 8.0),  # cache read is 0.05x on Opus 5.5
        # Sonnet 4 (retired): kept so n8n-era rows can be re-priced (migration 047)
        ("claude-sonnet-4-20250514", 3.0, 15.0, 0.30, 3.75, 6.0),
        ("claude-sonnet-4-0", 3.0, 15.0, 0.30, 3.75, 6.0),
    ],
)
def test_anthropic_prices(model: str, inp: float, out: float, read: float, w5: float, w1h: float) -> None:
    m = 1_000_000

    def c(**kw: int) -> float:
        return pricing.token_cost("anthropic", model, **kw).cost_usd

    assert c(input_tokens=m) == inp
    assert c(output_tokens=m) == out
    assert c(cache_read=m) == read
    assert c(cache_write_5m=m) == w5
    assert c(cache_write_1h=m) == w1h
    assert pricing.token_cost("anthropic", model, input_tokens=1).cost_source == pricing.COST_COMPUTED


def test_gemini_pro_long_context_tier() -> None:
    short = pricing.token_cost("gemini", "gemini-2.5-pro", input_tokens=100_000, output_tokens=1_000)
    long = pricing.token_cost("gemini", "gemini-2.5-pro", input_tokens=300_000, output_tokens=1_000)
    assert short.cost_usd == pytest.approx(100_000 * 1.25e-6 + 1_000 * 10e-6)
    assert long.cost_usd == pytest.approx(300_000 * 2.5e-6 + 1_000 * 15e-6)


@pytest.mark.parametrize("alias", ["google", "Google", " google ", "google-genai", "googleai"])
def test_google_is_an_alias_for_gemini(alias: str) -> None:
    assert pricing.normalize_provider(alias) == "gemini"
    assert pricing.price_entry(alias, "gemini-2.5-pro") is pricing.price_entry("gemini", "gemini-2.5-pro")
    cost = pricing.token_cost(alias, "gemini-2.5-pro", input_tokens=18285, output_tokens=85)
    # The n8n Hub V2 row this came from carried estimated_cost 0.023706 and cost_usd 0.
    assert (cost.cost_usd, cost.cost_source) == (0.023706, pricing.COST_COMPUTED)


def test_normalize_provider_leaves_canonical_names_alone() -> None:
    for name in ("anthropic", "gemini", "perplexity", "openai", "kieai", "stealthgpt", "scraperapi"):
        assert pricing.normalize_provider(name) == name
    assert pricing.normalize_provider(None) == ""
    assert pricing.normalize_provider("claude") == "anthropic"


def test_provider_reported_cost_wins() -> None:
    cost = pricing.token_cost(
        "perplexity", "sonar-pro", input_tokens=12, output_tokens=16, reported_cost_usd=0.00373
    )
    assert (cost.cost_usd, cost.cost_source) == (0.00373, pricing.COST_PROVIDER_REPORTED)


def test_perplexity_fallback_includes_the_request_fee_and_is_marked_estimated() -> None:
    cost = pricing.token_cost(
        "perplexity", "sonar-pro", input_tokens=0, output_tokens=0, request_fee_tier="low"
    )
    assert cost.cost_source == pricing.COST_ESTIMATED
    assert cost.cost_usd == 0.0025 and cost.unit_prices["per_request"] == 0.0025


def test_unknown_model_is_unpriced_and_zero() -> None:
    cost = pricing.token_cost("anthropic", "claude-something-new", input_tokens=1_000_000)
    assert (cost.cost_usd, cost.cost_source) == (0.0, pricing.COST_UNPRICED)
    assert "claude-something-new" in cost.unit_prices["missing"]


def test_unit_prices() -> None:
    assert pricing.unit_cost("stealthgpt", "standard", units=1000).cost_usd == 0.2
    assert pricing.unit_cost("stealthgpt", "super", units=1000).cost_usd == 0.5
    reported = pricing.unit_cost("kieai", "google/nano-banana", units=1, credits=4)
    assert (reported.cost_usd, reported.cost_source) == (0.02, pricing.COST_COMPUTED)
    listed = pricing.unit_cost("kieai", "google/nano-banana", units=1)
    assert (listed.cost_usd, listed.cost_source) == (0.02, pricing.COST_ESTIMATED)
    assert pricing.unit_cost("scraperapi", "api", units=10, credits=10).cost_usd == 0.0049
    assert pricing.unit_cost("nobody", "x", units=3).cost_source == pricing.COST_UNPRICED


def test_scraperapi_plan_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCRAPERAPI_USD_PER_CREDIT", "0.000149")  # Startup plan
    cost = pricing.unit_cost("scraperapi", "api", units=10, credits=10)
    assert cost.cost_usd == 0.00149
    assert cost.unit_prices["per_credit_from"] == "SCRAPERAPI_USD_PER_CREDIT"


def test_server_copy_is_identical() -> None:
    """server/src/lib/provider-prices.ts carries the same JSON between its markers."""
    if not SERVER_COPY.exists():
        pytest.skip("server tree not present (engine-only checkout)")
    lines = SERVER_COPY.read_text(encoding="utf-8").splitlines(keepends=True)
    start = next(i for i, ln in enumerate(lines) if ln.startswith("// BEGIN PROVIDER_PRICES"))
    end = next(i for i, ln in enumerate(lines) if ln.startswith("// END PROVIDER_PRICES"))
    copy = "".join(lines[start + 1 : end])
    assert json.loads(copy) == json.loads(_json_text())
    assert copy.strip() == _json_text().strip(), "server copy differs textually; re-paste the JSON"
