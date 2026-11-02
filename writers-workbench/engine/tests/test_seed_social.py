"""scripts/seed_social.py — the tier-aware social seed (item 17).

Guard rails first: PROD is never contacted without ``--confirm``, the URL must match the target, and
the default is a dry run. Then idempotency against an in-memory PostgREST stand-in: the first apply
writes, a second writes nothing, and an edition owned by someone else is never taken over.
"""

from __future__ import annotations

import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import seed_social as S

DEV_URL = "https://gvbvwcnmjkdpclcisqrr.supabase.co"
PROD_URL = "https://faklxfakgzkpkbxfihzh.supabase.co"
USER = "+14105914612"


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("the network was touched")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)


class FakeDb:
    """Rows per table; select understands the eq filters seed_social uses."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {"users_v2": [{"user_id": USER}]}
        self.writes: list[tuple[str, dict[str, Any]]] = []

    def select(self, _self: Any, table: str, query: str) -> list[dict[str, Any]]:
        params = urllib.parse.parse_qs(query)
        rows = self.tables.get(table, [])
        for k, v in params.items():
            if k == "select":
                continue
            want = v[0].removeprefix("eq.")
            rows = [r for r in rows if str(r.get(k)) == want]
        return [dict(r) for r in rows]

    def upsert(self, _self: Any, table: str, row: dict[str, Any], on_conflict: str) -> None:
        _self.writes += 1
        self.writes.append((table, row))
        keys = on_conflict.split(",")
        rows = self.tables.setdefault(table, [])
        for r in rows:
            if all(r.get(k) == row.get(k) for k in keys):
                r.update(row)
                return
        rows.append(dict(row))

    def insert(self, _self: Any, table: str, row: dict[str, Any]) -> None:
        _self.writes += 1
        self.writes.append((table, row))
        self.tables.setdefault(table, []).append(dict(row))


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    fake = FakeDb()
    monkeypatch.setattr(S.Supabase, "select", lambda self, t, q: fake.select(self, t, q))
    monkeypatch.setattr(S.Supabase, "upsert", lambda self, t, r, c: fake.upsert(self, t, r, c))
    monkeypatch.setattr(S.Supabase, "insert", lambda self, t, r: fake.insert(self, t, r))
    return fake


def _env(url: str) -> dict[str, str]:
    return {"SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_test"}


# --- guard rails ----------------------------------------------------------------------------------


def test_prod_without_confirm_is_refused_before_any_network() -> None:
    with pytest.raises(SystemExit) as exc:
        S.main(["--target", "prod"], _env(PROD_URL))
    assert exc.value.code == 2
    with pytest.raises(SystemExit):
        S.main(["--target", "prod", "--apply"], _env(PROD_URL))


def test_the_url_must_match_the_target() -> None:
    with pytest.raises(SystemExit) as exc:
        S.main(["--target", "prod", "--confirm"], _env(DEV_URL))
    assert exc.value.code == 2
    with pytest.raises(SystemExit):
        S.main(["--target", "dev"], _env(PROD_URL))
    with pytest.raises(SystemExit):
        S.main([], {})


def test_offline_prints_the_prod_plan_disabled_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    assert S.main(["--target", "prod", "--offline"], {}) == 0
    out = capsys.readouterr().out
    assert "target=prod" in out and "enabled=False" in out and "offline dry run" in out
    assert "social_channels_v2" in out and "radar_subscriptions_v2" in out
    assert "newsletter_editions_v2" in out and "newsletter_feed_sources_v2" in out
    assert "sb_secret" not in out
    with pytest.raises(SystemExit):
        S.main(["--offline", "--apply"], {})


def test_plan_defaults_and_enable_flag() -> None:
    dev = S.build_plan(target="dev", user_id=USER, enabled=True)
    assert all(s.row.get("enabled", True) for s in dev.steps)
    tables = [s.table for s in dev.steps]
    assert tables.count("social_channels_v2") == 4
    assert tables.count("radar_subscriptions_v2") == 2
    assert tables.count("newsletter_editions_v2") == 2
    assert tables.count("newsletter_feed_sources_v2") == 4
    # editions precede their feed sources
    assert tables.index("newsletter_editions_v2") < tables.index("newsletter_feed_sources_v2")


# --- dry run and idempotency ----------------------------------------------------------------------


def test_dry_run_reads_and_writes_nothing(db: FakeDb, capsys: pytest.CaptureFixture[str]) -> None:
    assert S.main([], _env(DEV_URL)) == 0
    assert db.writes == []
    out = capsys.readouterr().out
    assert "dry run" in out and "insert" in out and "totals: insert=12" in out


def test_prod_dry_run_with_confirm_still_writes_nothing(db: FakeDb) -> None:
    assert S.main(["--target", "prod", "--confirm"], _env(PROD_URL)) == 0
    assert db.writes == []


def test_apply_then_apply_again_writes_nothing_the_second_time(
    db: FakeDb, capsys: pytest.CaptureFixture[str]
) -> None:
    assert S.main(["--apply"], _env(DEV_URL)) == 0
    assert len(db.writes) == 12
    capsys.readouterr()
    assert S.main(["--apply"], _env(DEV_URL)) == 0
    assert len(db.writes) == 12  # unchanged
    assert "totals: same=12" in capsys.readouterr().out


def test_an_update_names_its_fields(db: FakeDb, capsys: pytest.CaptureFixture[str]) -> None:
    S.main(["--apply"], _env(DEV_URL))
    db.tables["social_channels_v2"][0]["label"] = "renamed by hand"
    capsys.readouterr()
    S.main([], _env(DEV_URL))
    assert "changes: label" in capsys.readouterr().out


def test_someone_elses_edition_is_not_taken_over(db: FakeDb, capsys: pytest.CaptureFixture[str]) -> None:
    db.tables["newsletter_editions_v2"] = [{"id": "ai-mvp", "user_id": "+19999999999"}]
    S.main(["--apply"], _env(DEV_URL))
    written = [(t, r) for t, r in db.writes if t in ("newsletter_editions_v2", "newsletter_feed_sources_v2")]
    assert all(r.get("id") != "ai-mvp" and r.get("edition_id") != "ai-mvp" for _, r in written)
    assert db.tables["newsletter_editions_v2"][0]["user_id"] == "+19999999999"
    assert "belongs to another user" in capsys.readouterr().out


def test_a_missing_user_is_refused(db: FakeDb) -> None:
    db.tables["users_v2"] = []
    with pytest.raises(SystemExit) as exc:
        S.main(["--apply"], _env(DEV_URL))
    assert exc.value.code == 2
    assert db.writes == []
