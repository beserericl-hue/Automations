"""One price table for every paid provider call, and the arithmetic that turns usage into dollars.

The table lives in ``provider_prices.json`` next to this module (each entry carries the official
pricing URL and the date it was checked). The Workbench server keeps a byte-identical copy in
``server/src/lib/provider-prices.ts``; ``tests/test_cost_pricing.py`` fails if the two drift.

Rules this module keeps, because breaking any of them is how recorded cost stops matching the bill:

* **An unknown model is never silently $0 and never silently priced as something else.** It is
  recorded with ``cost_source="unpriced"`` and cost 0, so the cost view can flag it, and a test fails
  when a model the engine is configured to use has no entry.
* **A provider-reported cost wins.** Perplexity returns ``usage.cost.total_cost``; that is recorded
  as ``provider_reported`` and the table is only the fallback (recorded as ``estimated``).
* **Every row carries the prices it was costed at** (``unit_prices``), so a later price change never
  makes an old row unexplainable.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources
from typing import Any

PRICES_FILE = "provider_prices.json"

COST_PROVIDER_REPORTED = "provider_reported"
COST_COMPUTED = "computed"
COST_ESTIMATED = "estimated"
COST_UNPRICED = "unpriced"


@dataclass(frozen=True)
class Cost:
    """The dollars for one call and how they were arrived at."""

    cost_usd: float
    cost_source: str
    unit_prices: dict[str, Any] = field(default_factory=dict)


@lru_cache(maxsize=1)
def load_table() -> dict[str, Any]:
    text = resources.files("writer_engine.telemetry").joinpath(PRICES_FILE).read_text(encoding="utf-8")
    data: dict[str, Any] = json.loads(text)
    return data


@lru_cache(maxsize=1)
def _index() -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in load_table()["entries"]:
        prov = str(entry["provider"])
        for name in [entry["model"], *entry.get("aliases", [])]:
            out[(prov, str(name))] = entry
    return out


def price_entry(provider: str, model: str) -> dict[str, Any] | None:
    """The table entry for ``provider``/``model`` (aliases included), or None."""
    return _index().get((provider or "", model or ""))


def _env_override(entry: dict[str, Any]) -> dict[str, Any]:
    """ScraperAPI's $/credit depends on the account's plan, so it may be overridden by env."""
    if entry.get("provider") == "scraperapi":
        raw = os.environ.get("SCRAPERAPI_USD_PER_CREDIT", "").strip()
        if raw:
            try:
                return {**entry, "per_credit": float(raw), "per_credit_from": "SCRAPERAPI_USD_PER_CREDIT"}
            except ValueError:
                pass
    return entry


def _source_fields(entry: dict[str, Any]) -> dict[str, Any]:
    return {"source": entry.get("source"), "checked": entry.get("checked")}


def token_cost(
    provider: str,
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read: int = 0,
    cache_write_5m: int = 0,
    cache_write_1h: int = 0,
    reported_cost_usd: float | None = None,
    request_fee_tier: str | None = None,
) -> Cost:
    """Dollars for one token-billed call.

    ``input_tokens`` is the UNCACHED input (Anthropic's convention; the Gemini adapter subtracts its
    cached tokens before calling this). ``reported_cost_usd`` is the provider's own figure when it
    returns one — recorded as-is.
    """
    entry = price_entry(provider, model)
    if reported_cost_usd is not None:
        reported = {"reported": True, **(_source_fields(entry) if entry else {})}
        return Cost(round(float(reported_cost_usd), 6), COST_PROVIDER_REPORTED, reported)
    if entry is None or "per_mtok" not in entry:
        return Cost(0.0, COST_UNPRICED, {"missing": f"{provider}/{model}"})
    rates: dict[str, float] = dict(entry["per_mtok"])
    long_ctx = entry.get("long_context")
    prompt_tokens = input_tokens + cache_read + cache_write_5m + cache_write_1h
    if long_ctx and prompt_tokens > int(long_ctx["threshold_tokens"]):
        rates = {**rates, **long_ctx["per_mtok"]}
    cost = (
        input_tokens * rates.get("input", 0.0)
        + output_tokens * rates.get("output", 0.0)
        + cache_read * rates.get("cache_read", rates.get("input", 0.0))
        + cache_write_5m * rates.get("cache_write_5m", rates.get("input", 0.0))
        + cache_write_1h * rates.get("cache_write_1h", rates.get("input", 0.0))
    ) / 1_000_000.0
    prices: dict[str, Any] = {"per_mtok": rates, **_source_fields(entry)}
    per_request = entry.get("per_request")
    if per_request:
        fee = float(per_request.get(request_fee_tier or "low", per_request.get("low", 0.0)))
        cost += fee
        prices["per_request"] = fee
    source = str(entry.get("fallback_cost_source") or COST_COMPUTED)
    return Cost(round(cost, 6), source, prices)


def unit_cost(
    provider: str,
    model: str,
    *,
    units: float,
    credits: float | None = None,
) -> Cost:
    """Dollars for a unit-billed call: words (StealthGPT), credits (ScraperAPI, KIE), images.

    ``credits`` is the provider's own credit count for the call when it reports one (KIE
    ``creditsConsumed``, ScraperAPI ``sa-credit-cost``); without it KIE falls back to the listed
    credits per image and is recorded as ``estimated``.
    """
    entry = price_entry(provider, model)
    if entry is None:
        return Cost(0.0, COST_UNPRICED, {"missing": f"{provider}/{model}"})
    entry = _env_override(entry)
    src = _source_fields(entry)
    if "per_credit" in entry:
        per_credit = float(entry["per_credit"])
        prices = {"per_credit": per_credit, **src}
        if entry.get("per_credit_from"):
            prices["per_credit_from"] = entry["per_credit_from"]
        if credits is not None:
            return Cost(round(credits * per_credit, 6), COST_COMPUTED, prices)
        per_unit = entry.get("credits_per_unit")
        if per_unit is None:
            return Cost(0.0, COST_UNPRICED, {**prices, "missing": "credit count"})
        prices["credits_per_unit"] = per_unit
        return Cost(round(units * float(per_unit) * per_credit, 6), COST_ESTIMATED, prices)
    if "per_unit" in entry:
        per = float(entry["per_unit"])
        source = str(entry.get("fallback_cost_source") or COST_COMPUTED)
        return Cost(
            round(units * per, 6), source, {"per_unit": per, "unit_type": entry.get("unit_type"), **src}
        )
    return Cost(0.0, COST_UNPRICED, {"missing": f"{provider}/{model} has no unit price"})


def priced_models() -> set[tuple[str, str]]:
    return set(_index())
