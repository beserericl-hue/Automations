"""Mail to the regression-test inbox is held while a run is going, and only then (Eric, 2026-11-08)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from writer_engine.postal import client as postal_client
from writer_engine.postal import test_hold as hold


def _value(delta: timedelta, addresses: list[str]) -> str:
    import json

    return json.dumps({"until": (datetime.now(UTC) + delta).isoformat(), "addresses": addresses})


def test_parse_hold_current_expired_and_malformed() -> None:
    assert hold.parse_hold(_value(timedelta(hours=1), ["Eric@X.com"])) == frozenset({"eric@x.com"})
    assert hold.parse_hold(_value(timedelta(hours=-1), ["eric@x.com"])) == frozenset()
    assert hold.parse_hold("nope") == frozenset()
    assert hold.parse_hold(None) == frozenset()


@pytest.mark.asyncio
async def test_is_held_needs_every_recipient_on_the_list(monkeypatch: pytest.MonkeyPatch) -> None:
    async def held() -> frozenset[str]:
        return frozenset({"eric@x.com"})

    monkeypatch.setattr(hold, "held_addresses", held)
    assert await hold.is_held(["eric@x.com"]) is True
    assert await hold.is_held(["eric@x.com", "reader@y.com"]) is False
    assert await hold.is_held([]) is False


@pytest.mark.asyncio
async def test_postal_send_is_skipped_for_a_held_address_and_goes_out_for_others(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def held() -> frozenset[str]:
        return frozenset({"eric@x.com"})

    monkeypatch.setattr(hold, "held_addresses", held)
    posted: list[Any] = []

    class FakeHttp:
        async def post(self, url: str, **kw: Any) -> Any:
            posted.append(kw["json"]["to"])

            class R:
                def raise_for_status(self) -> None: ...
                def json(self) -> dict[str, Any]:
                    return {"status": "success", "data": {"message_id": "real-1"}}

            return R()

        async def aclose(self) -> None: ...

    c = postal_client.PostalClient(api_url="https://postal.test/api", api_key="k")
    c._client = FakeHttp()  # type: ignore[assignment]
    r1 = await c.send(to=["eric@x.com"], from_addr="a@b.c", subject="s", html="h")
    assert (r1.message_id, r1.status) == ("e2e-held", "held") and posted == []
    r2 = await c.send(to=["reader@y.com"], from_addr="a@b.c", subject="s", html="h")
    assert r2.message_id == "real-1" and posted == [["reader@y.com"]]
