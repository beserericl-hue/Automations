"""Item 8 — global (all-user) settings resolve user -> global -> default.

``app_config_v2`` is per-user with a NOT NULL FK on user_id, so before migration 045 a shared value
had to be copied onto every account (DEV had two ``recipient_email`` rows, one per user, and no way
to say "everyone"). ``app_config_global_v2`` is that scope; these pin the precedence.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from postgrest.exceptions import APIError

from writer_engine.library_helpers.email_recipients import (
    GLOBAL_TABLE,
    USER_TABLE,
    load_app_config,
    load_config_layers,
    load_recipient_config,
)


@pytest.fixture
def db(fake_supabase: Any) -> Any:
    fake_supabase.tables[USER_TABLE] = [
        {"user_id": "u1", "key": "bcc_email", "value": "u1-bcc@x.com"},
        {"user_id": "u1", "key": "recipient_email", "value": "u1@x.com"},
        {"user_id": "u2", "key": "recipient_email", "value": "u2@x.com"},
        {"user_id": "u1", "key": "tone", "value": "  "},  # blank = unset
    ]
    fake_supabase.tables[GLOBAL_TABLE] = [
        {"key": "bcc_email", "value": "ops@x.com"},
        {"key": "tone", "value": "warm"},
        {"key": "recipient_email", "value": "fallback@x.com"},
    ]
    fake_supabase.tables["users_v2"] = [
        {"user_id": "u3", "email": "u3-account@x.com"},
        {"user_id": "u4", "email": None},
    ]
    return fake_supabase


@pytest.mark.asyncio
async def test_user_beats_global_beats_default(db: Any) -> None:
    cfg = await load_app_config(
        db, ["bcc_email", "tone", "missing"], "u1", defaults={"missing": "d", "tone": "x"}
    )
    assert cfg == {"bcc_email": "u1-bcc@x.com", "tone": "warm", "missing": "d"}


@pytest.mark.asyncio
async def test_a_user_never_sees_another_users_value(db: Any) -> None:
    user, glob = await load_config_layers(db, ["recipient_email"], "u1")
    assert user == {"recipient_email": "u1@x.com"}
    assert glob == {"recipient_email": "fallback@x.com"}


@pytest.mark.asyncio
async def test_no_user_means_global_only(db: Any) -> None:
    assert await load_app_config(db, ["tone"]) == {"tone": "warm"}


@pytest.mark.asyncio
async def test_global_bcc_applies_to_users_without_their_own(db: Any) -> None:
    assert (await load_recipient_config(db, "u2"))["bcc_email"] == "ops@x.com"
    assert (await load_recipient_config(db, "u1"))["bcc_email"] == "u1-bcc@x.com"


@pytest.mark.asyncio
async def test_a_users_own_address_outranks_a_global_recipient(db: Any) -> None:
    """A global recipient must not redirect everyone's mail: the account email is still the user's."""
    assert (await load_recipient_config(db, "u2"))["recipient_email"] == "u2@x.com"
    assert (await load_recipient_config(db, "u3"))["recipient_email"] == "u3-account@x.com"
    assert (await load_recipient_config(db, "u4"))["recipient_email"] == "fallback@x.com"


class _Failing:
    """A query on one table that fails at execute(), the way postgrest-py does."""

    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def __getattr__(self, _name: str) -> Any:
        return lambda *a, **k: self

    async def execute(self) -> Any:
        raise self.exc


class _OneTableDown:
    def __init__(self, fake: Any, table: str, exc: Exception) -> None:
        self.fake, self.down, self.exc = fake, table, exc

    def table(self, name: str) -> Any:
        return _Failing(self.exc) if name == self.down else self.fake.table(name)


@pytest.mark.asyncio
async def test_a_missing_global_table_is_no_values_not_an_error(fake_supabase: Any) -> None:
    """Code ships before the migration is applied; the reader must keep working."""
    missing = APIError({"code": "42P01", "message": 'relation "app_config_global_v2" does not exist'})
    fake_supabase.tables[USER_TABLE] = [{"user_id": "u1", "key": "tone", "value": "dry"}]
    client = _OneTableDown(fake_supabase, GLOBAL_TABLE, missing)
    assert await load_app_config(client, ["tone"], "u1") == {"tone": "dry"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outage",
    [
        APIError({"code": "57014", "message": "canceling statement due to statement timeout"}),
        httpx.ReadTimeout("t"),
    ],
)
async def test_an_unreadable_user_setting_never_falls_back_to_the_global_recipient(
    db: Any, outage: Exception
) -> None:
    """Item 9 defect: a failed read of u1's settings used to look like "u1 has no address", so u1's
    content was mailed to the global (operator) recipient. Now it raises and nothing is sent."""
    with pytest.raises(type(outage)):
        await load_recipient_config(_OneTableDown(db, USER_TABLE, outage), "u1")
    with pytest.raises(type(outage)):
        await load_recipient_config(_OneTableDown(db, "users_v2", outage), "u3")
