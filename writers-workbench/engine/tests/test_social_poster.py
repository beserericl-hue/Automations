"""The post calendar's publisher: claim, deliver per channel, retry only what failed, dry run by default."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from conftest import FakeSupabase

from writer_engine import integrations
from writer_engine.social import channels as ch
from writer_engine.social import poster

TEST_KEY = base64.b64encode(bytes(range(32))).decode()

NOW = datetime(2026, 11, 2, 14, 5, tzinfo=UTC)  # 09:05 ET, Monday
USER = "+14105914612"


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _channels(db: FakeSupabase) -> None:
    db.tables["social_channels_v2"] = [
        {
            "user_id": USER,
            "channel": "website",
            "kind": "website",
            "label": "TechAhir website",
            "enabled": True,
            "config": {
                "endpoint": "https://www.techahir.com/api/blog",
                "public_base": "https://www.techahir.com/blog/",
                "auth_header": "x-api-key",
            },
        },
        {
            "user_id": USER,
            "channel": "li_techahir",
            "kind": "linkedin",
            "label": "TechAhir LinkedIn page",
            "enabled": True,
            "config": {"page_id": "104364682"},
        },
        {
            "user_id": USER,
            "channel": "li_personal",
            "kind": "linkedin",
            "label": "personal LinkedIn profile",
            "enabled": True,
            "config": {},
        },
    ]


def _secret_row(user: str, provider: str, channel: str | None, value: str, **config: Any) -> dict[str, Any]:
    key = integrations.load_key(TEST_KEY)
    return {
        "user_id": user,
        "provider": provider,
        "channel": channel,
        "config": config,
        "secret_ciphertext": integrations.encrypt(
            value, user_id=user, provider=provider, channel=channel, key=key
        )
        if value
        else None,
    }


def _credentials(
    db: FakeSupabase, *, blotato: str = "test-blotato-key-0001", website: str = "test-website-key-01"
) -> None:
    db.tables["user_integrations_v2"] = [
        _secret_row(USER, "blotato", None, blotato, account_id="9115"),
        _secret_row(USER, "website", "website", website),
    ]


def _row(db: FakeSupabase, **over: Any) -> dict[str, Any]:
    row = {
        "id": f"s-{len(db.tables.get('social_schedule_v2', [])) + 1}",
        "user_id": USER,
        "display_number": 7,
        "external_id": "batch-2026-11-02-morning-x",
        "title": "Ship it",
        "body_md": "# Ship it\n\nBody text.\n\n## LinkedIn\n\nthe LI draft",
        "linkedin_content": "LI post text",
        "seo_title": "",
        "meta_description": "",
        "category": "ai & data",
        "include_image": False,
        "post_status": "published",
        "channels": ["website", "li_techahir"],
        "scheduled_date": "2026-11-02",
        "slot": "morning",
        "scheduled_at": _iso(NOW - timedelta(minutes=5)),
        "state": "pending",
        "attempts": 0,
        "claimed_at": None,
        "posted_at": None,
        "updated_at": _iso(NOW - timedelta(hours=1)),
        "source": "trend_batch",
    }
    row.update(over)
    db.tables.setdefault("social_schedule_v2", []).append(row)
    return row


class _Net:
    """A mock of the website API and Blotato that records every call."""

    def __init__(
        self, *, website: int = 200, blotato_post: int = 200, blotato_status: str = "published"
    ) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None, dict[str, str]]] = []
        self.website = website
        self.blotato_post = blotato_post
        self.blotato_status = blotato_status

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        self.calls.append((req.method, str(req.url), body, dict(req.headers)))
        if "techahir.com/api/blog" in str(req.url):
            if self.website >= 400:
                return httpx.Response(self.website, json={"error": "boom"})
            return httpx.Response(200, json={"url": "http://localhost:3000/blog/ship-it", "slug": "ship-it"})
        if req.url.path.endswith("/v2/posts") and req.method == "POST":
            if self.blotato_post >= 400:
                return httpx.Response(
                    self.blotato_post, json={"message": "Account connection has expired", "code": 5002}
                )
            return httpx.Response(200, json={"postSubmissionId": f"sub-{len(self.calls)}"})
        if "/v2/posts/" in req.url.path:
            out: dict[str, Any] = {"status": self.blotato_status}
            if self.blotato_status == "published":
                out["publicUrl"] = "https://linkedin.com/feed/update/urn:li:share:1"
            if self.blotato_status == "failed":
                out["errorMessage"] = "Account connection has expired (5002)"
            return httpx.Response(200, json=out)
        return httpx.Response(404, json={})

    def transport(self) -> poster.Transport:
        async def no_sleep(_s: float) -> None:
            return None

        async def public_dns(_host: str, _port: int) -> list[str]:
            return ["93.184.216.34"]

        return poster.Transport(
            http=httpx.AsyncClient(transport=httpx.MockTransport(self.handler)),
            sleep=no_sleep,
            resolve=public_dns,
        )


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    # Company keys in the environment must be IGNORED: there is no shared-key path any more.
    monkeypatch.setenv("TECHAHIR_BLOG_API_KEY", "company-website-key")
    monkeypatch.setenv("BLOTATO_API_KEY", "company-blotato-key")
    monkeypatch.setenv("INTEGRATIONS_ENCRYPTION_KEY", TEST_KEY)
    from writer_engine.config import get_settings

    get_settings.cache_clear()
    d = FakeSupabase()
    _channels(d)
    _credentials(d)
    yield d
    get_settings.cache_clear()


def _deliveries(db: FakeSupabase) -> dict[str, dict[str, Any]]:
    return {d["channel"]: d for d in db.tables.get("social_schedule_deliveries_v2", [])}


@pytest.mark.asyncio
async def test_dry_run_sends_nothing_and_records_the_exact_request(db: FakeSupabase) -> None:
    _row(db)
    net = _Net()
    result = await poster.run_tick(db, net.transport(), now=NOW, mode="dry_run")
    assert net.calls == []
    assert (result.mode, result.claimed, result.posted) == ("dry_run", 1, 1)
    d = _deliveries(db)
    assert {c: x["status"] for c, x in d.items()} == {"website": "dry_run", "li_techahir": "dry_run"}
    web = d["website"]["request"]
    assert web["bodyMarkdown"] == "# Ship it\n\nBody text."  # the LinkedIn draft is not on the blog
    assert web["category"] == "AI & DATA" and web["externalId"] == "batch-2026-11-02-morning-x"
    li = d["li_techahir"]["request"]["post"]
    assert li["accountId"] == "9115" and li["target"] == {"targetType": "linkedin", "pageId": "104364682"}
    assert li["content"]["text"] == "LI post text"
    assert db.tables["social_schedule_v2"][0]["state"] == "posted"


@pytest.mark.asyncio
async def test_live_posts_each_channel_once_and_builds_the_public_url(db: FakeSupabase) -> None:
    _row(db)
    net = _Net()
    result = await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    posts = [c for c in net.calls if c[0] == "POST"]
    assert [c[1] for c in posts] == [
        "https://www.techahir.com/api/blog",
        "https://backend.blotato.com/v2/posts",
    ]
    assert posts[0][3]["x-api-key"] == "test-website-key-01"
    assert posts[1][3]["blotato-api-key"] == "test-blotato-key-0001"
    d = _deliveries(db)
    # Not the API's localhost URL: the public one.
    assert d["website"]["public_url"] == "https://www.techahir.com/blog/ship-it"
    assert d["li_techahir"]["status"] == "submitted" and d["li_techahir"]["provider_ref"]
    assert result.posted == 1
    # A second tick finds nothing due: the row is posted.
    again = await poster.run_tick(db, net.transport(), now=NOW + timedelta(minutes=5), mode="live")
    assert again.claimed == 0


@pytest.mark.asyncio
async def test_a_row_another_tick_claimed_is_not_posted_twice(db: FakeSupabase) -> None:
    seen_by_both_ticks = dict(_row(db))  # both ticks read the row while it was 'pending'
    assert await poster._claim(db, dict(seen_by_both_ticks), NOW) is True
    # The second tick's UPDATE ... WHERE state='pending' now matches nothing.
    assert await poster._claim(db, dict(seen_by_both_ticks), NOW) is False


@pytest.mark.asyncio
async def test_a_failed_channel_is_retried_alone_and_the_working_one_is_not_resent(db: FakeSupabase) -> None:
    _row(db)
    net = _Net(blotato_post=422)
    first = await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    assert first.partial == 1
    d = _deliveries(db)
    assert d["website"]["status"] == "published"
    assert d["li_techahir"]["status"] == "failed" and "5002" in d["li_techahir"]["detail"]
    row = db.tables["social_schedule_v2"][0]
    assert row["state"] == "partial" and "li_techahir" in row["last_error"]

    # Before the retry wait is over, nothing happens.
    net.blotato_post = 200
    row["updated_at"] = _iso(NOW)
    early = await poster.run_tick(db, net.transport(), now=NOW + timedelta(minutes=5), mode="live")
    assert early.claimed == 0

    later = NOW + timedelta(minutes=40)
    before = len(net.calls)
    retry = await poster.run_tick(db, net.transport(), now=later, mode="live")
    assert retry.posted == 1
    new_posts = [c[1] for c in net.calls[before:] if c[0] == "POST"]
    assert new_posts == ["https://backend.blotato.com/v2/posts"]  # the website was not posted again
    assert _deliveries(db)["li_techahir"]["attempts"] == 2


@pytest.mark.asyncio
async def test_retries_stop_after_max_attempts(db: FakeSupabase) -> None:
    _row(db, state="failed", attempts=poster.MAX_ATTEMPTS, updated_at=_iso(NOW - timedelta(days=1)))
    result = await poster.run_tick(db, _Net().transport(), now=NOW, mode="live")
    assert result.claimed == 0


@pytest.mark.asyncio
async def test_reconcile_records_blotatos_failure_reason(db: FakeSupabase) -> None:
    _row(db, channels=["li_techahir"])
    net = _Net()
    await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    d = _deliveries(db)["li_techahir"]
    d["updated_at"] = _iso(datetime.now(UTC) - timedelta(minutes=5))
    net.blotato_status = "failed"
    changed = await poster.reconcile_submitted(db, net.transport())
    assert changed == 1
    d = _deliveries(db)["li_techahir"]
    assert d["status"] == "failed" and "5002" in d["detail"]
    assert db.tables["social_schedule_v2"][0]["state"] == "failed"


@pytest.mark.asyncio
async def test_reconcile_marks_a_published_post_with_its_url(db: FakeSupabase) -> None:
    _row(db, channels=["li_techahir"])
    net = _Net()
    await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    _deliveries(db)["li_techahir"]["updated_at"] = _iso(datetime.now(UTC) - timedelta(minutes=5))
    assert await poster.reconcile_submitted(db, net.transport()) == 1
    assert _deliveries(db)["li_techahir"]["public_url"].startswith("https://linkedin.com/")


@pytest.mark.asyncio
async def test_an_unconfigured_channel_fails_with_a_reason_and_others_still_post(db: FakeSupabase) -> None:
    _row(db, channels=["website", "li_unknown"])
    result = await poster.run_tick(db, _Net().transport(), now=NOW, mode="live")
    assert result.partial == 1
    d = _deliveries(db)
    assert d["li_unknown"]["status"] == "failed" and "not configured" in d["li_unknown"]["detail"]
    assert d["website"]["status"] == "published"


@pytest.mark.asyncio
async def test_a_missing_key_in_live_mode_is_a_failed_delivery_not_a_crash(
    db: FakeSupabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    db.tables["user_integrations_v2"] = [_secret_row(USER, "blotato", None, "", account_id="9115")]
    _row(db, channels=["li_techahir", "website"])
    net = _Net()
    result = await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    # The company BLOTATO_API_KEY / TECHAHIR_BLOG_API_KEY in the environment are not used.
    assert result.failed == 1 and net.calls == []
    d = _deliveries(db)
    assert "no Blotato API key is set for this user" in d["li_techahir"]["detail"]
    assert "no auth token is set for this website" in d["website"]["detail"]


@pytest.mark.asyncio
async def test_future_rows_are_not_due(db: FakeSupabase) -> None:
    _row(db, scheduled_at=_iso(NOW + timedelta(hours=5)))
    assert (await poster.run_tick(db, _Net().transport(), now=NOW, mode="dry_run")).claimed == 0


@pytest.mark.asyncio
async def test_the_after_posted_hook_runs_for_posted_rows(db: FakeSupabase) -> None:
    _row(db)
    seen: list[str] = []

    async def hook(row: dict[str, Any], deliveries: dict[str, dict[str, Any]]) -> None:
        seen.append(row["external_id"])

    await poster.run_tick(db, _Net().transport(), now=NOW, mode="dry_run", after_posted=hook)
    assert seen == ["batch-2026-11-02-morning-x"]


def test_fit_linkedin_keeps_the_call_to_action() -> None:
    body = "x" * 4000
    cta = "[Get your MVP built in 3 days](https://www.techahir.com/3day-minimum-viable-product-mvp) #MVP"
    out = ch.fit_linkedin(f"{body}\n{cta}")
    assert len(out) <= ch.LINKEDIN_MAX_CHARS and out.endswith(cta) and "…" in out


def test_personal_profile_has_no_page_id() -> None:
    c = ch.Channel(
        user_id=USER, channel="li_personal", kind="linkedin", label="me", config={"account_id": "9115"}
    )
    req = ch.linkedin_request({"linkedin_content": "hi"}, c, media_url=None)
    assert req["post"]["target"] == {"targetType": "linkedin"}


def test_summary_email_marks_dry_runs_and_problems() -> None:
    r = poster.TickResult(mode="dry_run", claimed=2, posted=1, partial=1)
    r.rows = [
        {
            "display_number": 1,
            "title": "A",
            "state": "posted",
            "channels": {"website": "dry_run"},
            "detail": {"website": "dry run"},
            "urls": {"website": None},
        },
        {
            "display_number": 2,
            "title": "B",
            "state": "partial",
            "channels": {"li_agile": "failed"},
            "detail": {"li_agile": "expired"},
            "urls": {"li_agile": None},
        },
    ]
    subject, html = poster.summary_email(r, NOW)
    assert subject.startswith("[DRY RUN] Scheduled posts: 1 ok, 1 NEED ATTENTION")
    assert "expired" in html and "#2" in html


@pytest.mark.asyncio
async def test_imported_n8n_failures_are_never_retried(db: FakeSupabase) -> None:
    _row(db, state="failed", attempts=1, source="n8n_import", updated_at=_iso(NOW - timedelta(days=30)))
    _row(db, state="partial", attempts=1, source="n8n_import", updated_at=_iso(NOW - timedelta(days=30)))
    net = _Net()
    result = await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    assert result.claimed == 0 and net.calls == []
    assert {r["state"] for r in db.tables["social_schedule_v2"]} == {"failed", "partial"}


@pytest.mark.asyncio
async def test_each_user_posts_with_their_own_credentials(db: FakeSupabase) -> None:
    other = "+15550001111"
    db.tables["social_channels_v2"].append(
        {
            "user_id": other,
            "channel": "website",
            "kind": "website",
            "label": "Other blog",
            "enabled": True,
            "config": {"endpoint": "https://blog.example.org/api/posts", "auth_header": "Authorization"},
        }
    )
    db.tables["user_integrations_v2"].append(_secret_row(other, "website", "website", "other-users-token-9"))
    _row(db, channels=["website"])
    _row(db, user_id=other, channels=["website"], external_id="other-1")
    net = _Net()
    await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    sent = {c[1]: c[3] for c in net.calls if c[0] == "POST"}
    assert sent["https://www.techahir.com/api/blog"]["x-api-key"] == "test-website-key-01"
    assert sent["https://blog.example.org/api/posts"]["authorization"] == "Bearer other-users-token-9"


@pytest.mark.asyncio
async def test_a_ciphertext_moved_to_another_user_does_not_decrypt(db: FakeSupabase) -> None:
    other = "+15550001111"
    stolen = dict(db.tables["user_integrations_v2"][0])  # USER's Blotato row
    db.tables["user_integrations_v2"].append({**stolen, "user_id": other})
    creds = await integrations.load_user_credentials(db, other)
    assert creds.blotato_api_key == "" and creds.problems
    assert "could not be decrypted" in creds.problems[0]


@pytest.mark.asyncio
async def test_dry_run_resolves_credentials_and_reports_what_is_missing(db: FakeSupabase) -> None:
    _row(db, channels=["website", "li_techahir"])
    await poster.run_tick(db, _Net().transport(), now=NOW, mode="dry_run")
    d = _deliveries(db)
    assert "would send the user's website token in x-api-key" in d["website"]["detail"]
    assert "would send with the user's Blotato key (account 9115)" in d["li_techahir"]["detail"]
    # Nothing secret in what is stored.
    stored = json.dumps(d)
    assert "test-website-key-01" not in stored and "test-blotato-key-0001" not in stored

    db.tables["user_integrations_v2"] = []
    db.tables["social_schedule_deliveries_v2"] = []
    _row(db, channels=["website", "li_techahir"], external_id="second")
    await poster.run_tick(db, _Net().transport(), now=NOW, mode="dry_run")
    d = _deliveries(db)
    assert d["website"]["status"] == "dry_run"
    assert "would fail: channel website: no auth token" in d["website"]["detail"]
    assert "would fail: no Blotato API key" in d["li_techahir"]["detail"]


@pytest.mark.asyncio
async def test_a_private_endpoint_is_refused_at_send_time(db: FakeSupabase) -> None:
    db.tables["social_channels_v2"][0]["config"]["endpoint"] = "https://internal.example.com/api/blog"
    _row(db, channels=["website"])
    net = _Net()

    async def rebinding_dns(_host: str, _port: int) -> list[str]:
        return ["169.254.169.254"]

    transport = net.transport()
    transport.resolve = rebinding_dns
    result = await poster.run_tick(db, transport, now=NOW, mode="live")
    assert result.failed == 1 and net.calls == []
    assert "endpoint refused" in _deliveries(db)["website"]["detail"]


@pytest.mark.asyncio
async def test_reconcile_uses_the_posts_owner_key(db: FakeSupabase) -> None:
    _row(db, channels=["li_techahir"])
    net = _Net()
    await poster.run_tick(db, net.transport(), now=NOW, mode="live")
    _deliveries(db)["li_techahir"]["updated_at"] = _iso(datetime.now(UTC) - timedelta(minutes=5))
    before = len(net.calls)
    assert await poster.reconcile_submitted(db, net.transport()) == 1
    status_calls = [c for c in net.calls[before:] if c[0] == "GET"]
    assert status_calls and status_calls[0][3]["blotato-api-key"] == "test-blotato-key-0001"
