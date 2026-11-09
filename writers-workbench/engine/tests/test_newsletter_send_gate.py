"""The final "Send to subscribers" gate, the owner's test copy, the slate email record and the
humanizer default (Eric's decisions, 2026-11-03).

Every test here fails on the code before this change: approving the image gate used to render AND
deliver in one go, there was no test copy, the slate email left no record, and newsletter sections
were humanized by default.
"""

from __future__ import annotations

from typing import Any

import pytest

import orchestrator.newsletter_saga as saga_mod
from orchestrator.newsletter_saga import NewsletterSagaDriver, SagaResult
from writer_engine.config import get_settings
from writer_engine.newsletter_send import OwnerCopyError
from writer_engine.schemas import Stage, StepInput, StepOutput, StepStatus
from writer_engine.state_machine.durable import InMemorySagaRepo
from writer_engine.state_machine.hitl import ApprovalDecision, _in_memory

OWNER = "+1"
SUBSCRIBER = "reader@example.invalid"


@pytest.fixture(autouse=True)
def _clear_hitl_state() -> Any:
    _in_memory.clear()
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _Steps:
    """Canned step outputs; records every step call (name + payload) in order."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def names(self) -> list[str]:
        return [n for n, _ in self.calls]

    def deliveries(self) -> list[dict[str, Any]]:
        """Real deliveries only (a test copy carries ``test_recipient``)."""
        return [p for n, p in self.calls if n == "deliver" and not p.get("test_recipient")]

    async def __call__(self, st: Any, step: Any, *, execution_id: Any, payload: Any, **_k: Any) -> StepOutput:
        name = str(getattr(step, "name", step))
        self.calls.append((name, dict(payload)))
        out: dict[str, Any] = {}
        if name == "subject":
            out = {"subject_line": "Hello {{first_name | friend}}", "pre_header_text": "P"}
        elif name == "scrape":
            out = {"scraped": []}
        elif name == "image":
            out = {"story_title": payload["story"]["title"], "options": [], "auto_pick": None}
        elif name == "segment":
            out = {"story_title": payload["story"]["title"], "newsletter_section_content": "x"}
        elif name == "assemble":
            out = {"intro": "i", "segments": [], "markdown_body": "# Body"}
        elif name == "render":
            out = {"html_body": "<html><body><p>Hi {{first_name | there}}</p></body></html>"}
        elif name == "persist":
            out = {"send_row": {"id": "send-1", "issue_number": 7, "status": "draft"}}
        elif name == "deliver":
            if payload.get("test_recipient"):
                out = {
                    "test_copy": True,
                    "to": payload["test_recipient"],
                    "subject": "[TEST] " + payload["subject"],
                    "message_id": "postal-test-1",
                }
            else:
                out = {"recipients_emailed": 0, "permalink_url": "https://p", "message_ids": []}
        return StepOutput(execution_id=execution_id, step_name=name, status=StepStatus.OK, payload=out)


async def _to_send_gate(monkeypatch: pytest.MonkeyPatch, *, subscribers: int | None = 0) -> Any:
    """Drive a Content Studio issue (no gather / pick) through stories, subject and images."""

    async def selection(cfg: dict[str, Any], execution_id: Any) -> list[dict[str, Any]]:
        return [{"id": "ci1", "key": "k1", "title": "Story one", "_summary": "a"}]

    async def count(_edition: str) -> int | None:
        return subscribers

    cancelled: list[str] = []

    async def cancel(send_id: str) -> None:
        cancelled.append(send_id)

    steps = _Steps()
    monkeypatch.setattr(saga_mod, "_studio_selection", selection)
    monkeypatch.setattr(saga_mod, "count_active_subscribers", count)
    monkeypatch.setattr(saga_mod, "mark_send_cancelled", cancel)
    monkeypatch.setattr(NewsletterSagaDriver, "_run_step", steps)
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(cfg={"edition_id": "throwaway", "send_date": "2026-11-03", "user_id": OWNER})
    await driver.advance(eid)
    for gate in ("awaiting_stories_approval", "awaiting_subject_approval", "awaiting_image_approval"):
        await driver.apply_decision(eid, gate_stage=gate, decision=ApprovalDecision.APPROVE, feedback=None)
        await driver.advance(eid)
    return driver, repo, eid, steps, cancelled


# --- 1a. approving the images does not send ------------------------------------------------------


@pytest.mark.asyncio
async def test_approving_the_image_gate_renders_and_saves_but_does_not_send(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    driver, repo, eid, steps, _ = await _to_send_gate(monkeypatch, subscribers=3)
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_SEND_APPROVAL
    assert "render" in steps.names() and "persist" in steps.names()
    assert steps.deliveries() == []
    assert await driver.advance(eid) is SagaResult.PAUSED  # stays paused; nothing goes out

    gate = _in_memory[state.state["send_gate_token"]]
    assert gate.stage == "awaiting_send_approval"
    assert gate.payload["send_id"] == "send-1"
    assert gate.payload["subscriber_count"] == 3
    assert gate.payload["issue_number"] == 7
    assert gate.payload["subject"] == "Hello {{first_name | friend}}"
    assert gate.payload["test_copy_available"] is True


@pytest.mark.asyncio
async def test_approving_the_send_gate_delivers_once(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    driver, repo, eid, steps, cancelled = await _to_send_gate(monkeypatch)
    await driver.apply_decision(
        eid, gate_stage="awaiting_send_approval", decision=ApprovalDecision.APPROVE, feedback=None
    )
    assert await driver.advance(eid) is SagaResult.DONE
    state = await repo.load(eid)
    assert state.stage is Stage.SENT
    assert len(steps.deliveries()) == 1
    assert steps.deliveries()[0]["send_id"] == "send-1"
    assert cancelled == []

    # A replayed approval of a gate the saga has left must not deliver a second time.
    await driver.apply_decision(
        eid, gate_stage="awaiting_send_approval", decision=ApprovalDecision.APPROVE, feedback=None
    )
    await driver.advance(eid)
    assert len(steps.deliveries()) == 1
    assert (await repo.load(eid)).stage is Stage.SENT


@pytest.mark.parametrize("decision", [ApprovalDecision.REJECT, ApprovalDecision.REVISE])
@pytest.mark.asyncio
async def test_declining_the_send_gate_never_sends(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any, decision: ApprovalDecision
) -> None:
    driver, repo, eid, steps, cancelled = await _to_send_gate(monkeypatch)
    await driver.apply_decision(eid, gate_stage="awaiting_send_approval", decision=decision, feedback="no")
    assert await driver.advance(eid) is SagaResult.DONE
    state = await repo.load(eid)
    assert state.stage is Stage.CANCELLED
    assert steps.deliveries() == []
    assert cancelled == ["send-1"]


def test_the_send_gate_has_a_mirror_stage_and_a_workbench_stage() -> None:
    from writer_engine.state_machine import hitl
    from writer_engine.state_machine import workbench_callback as wc

    assert hitl._table_stage("awaiting_send_approval") == "send"
    assert hitl._ENGINE_STAGE["send"] == "awaiting_send_approval"
    assert wc._ww_stage("awaiting_send_approval") == "awaiting_send_approval"
    assert wc._ww_stage("sent") == "sent"
    assert wc._ww_stage("cancelled") == "cancelled"


# --- 1b. the test copy ---------------------------------------------------------------------------


def _owner_db(fake_supabase: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    fake_supabase.tables["users_v2"] = [{"user_id": OWNER, "email": "owner@example.com"}]
    fake_supabase.tables["newsletter_subscribers_v2"] = [
        {"id": "s1", "edition_id": "throwaway", "email": SUBSCRIBER, "status": "active"}
    ]
    monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    get_settings.cache_clear()

    async def admin() -> Any:
        return fake_supabase

    import writer_engine.supabase.client as sb

    monkeypatch.setattr(sb, "get_supabase_admin", admin)
    return fake_supabase


@pytest.mark.asyncio
async def test_a_test_copy_goes_to_the_owner_only_and_is_recorded(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any, fake_supabase: Any
) -> None:
    driver, repo, eid, steps, _ = await _to_send_gate(monkeypatch)
    db = _owner_db(fake_supabase, monkeypatch)

    out = await driver.send_test_copy(eid, user_id=OWNER)

    copies = [p for n, p in steps.calls if n == "deliver" and p.get("test_recipient")]
    assert [c["test_recipient"] for c in copies] == ["owner@example.com"]
    assert steps.deliveries() == []  # no real delivery
    assert out["to"] == "owner@example.com" and out["message_id"] == "postal-test-1"
    assert out["subject"].startswith("[TEST] ")
    rows = db.tables["newsletter_owner_emails_v2"]
    assert len(rows) == 1
    assert rows[0]["kind"] == "test_copy"
    assert rows[0]["user_id"] == OWNER and rows[0]["to_email"] == "owner@example.com"
    assert rows[0]["postal_message_id"] == "postal-test-1"
    assert rows[0]["execution_id"] == str(eid) and rows[0]["send_id"] == "send-1"
    assert rows[0]["sent_at"]
    # Still waiting at the final gate afterwards.
    assert (await repo.load(eid)).stage is Stage.AWAITING_SEND_APPROVAL


@pytest.mark.asyncio
async def test_a_test_copy_is_refused_for_another_user_and_before_the_final_gate(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any, fake_supabase: Any
) -> None:
    driver, _repo, eid, steps, _ = await _to_send_gate(monkeypatch)
    _owner_db(fake_supabase, monkeypatch)
    with pytest.raises(OwnerCopyError) as forbidden:
        await driver.send_test_copy(eid, user_id="+someone-else")
    assert forbidden.value.code == "FORBIDDEN"

    await driver.apply_decision(
        eid, gate_stage="awaiting_send_approval", decision=ApprovalDecision.APPROVE, feedback=None
    )
    await driver.advance(eid)
    with pytest.raises(OwnerCopyError) as late:
        await driver.send_test_copy(eid, user_id=OWNER)
    assert late.value.code == "NOT_READY"
    assert not any(p.get("test_recipient") for n, p in steps.calls if n == "deliver")


@pytest.mark.asyncio
async def test_the_deliver_step_test_mode_reads_no_subscribers_and_marks_nothing_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deliver_step import main as deliver

    monkeypatch.setenv("POSTAL_API_KEY", "k")
    monkeypatch.setenv("POSTAL_API_URL", "https://postal.example")
    get_settings.cache_clear()
    sent: list[dict[str, Any]] = []

    class _Postal:
        async def send(self, **kw: Any) -> Any:
            sent.append(kw)
            return type("R", (), {"message_id": "m-1", "status": "ok"})()

        async def aclose(self) -> None:
            return None

    async def no_subscribers(*_a: Any) -> Any:
        raise AssertionError("a test copy must never read the subscriber list")

    async def no_mark(*_a: Any) -> Any:
        raise AssertionError("a test copy must never mark the issue sent")

    async def no_permalink(*_a: Any) -> Any:
        raise AssertionError("a test copy must not publish the permalink")

    monkeypatch.setattr(deliver, "PostalClient", _Postal)
    monkeypatch.setattr(deliver, "_fetch_subscribers", no_subscribers)
    monkeypatch.setattr(deliver, "_mark_sent", no_mark)
    monkeypatch.setattr(deliver, "_publish_permalink", no_permalink)
    from uuid import uuid4

    out = await deliver.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="deliver",
            payload={
                "test_recipient": "owner@example.com",
                "edition_id": "throwaway",
                "html_body": "<html><body>Hi {{first_name | there}}</body></html>",
                "subject": "Issue {{first_name | friend}}",
                "permalink_url": "https://ww/view",
            },
        )
    )
    assert [s["to"] for s in sent] == [["owner@example.com"]]
    assert sent[0]["subject"] == "[TEST] Issue friend"
    assert "{{" not in sent[0]["html"] and "Read on web" in sent[0]["html"]
    assert out.payload == {
        "test_copy": True,
        "to": "owner@example.com",
        "subject": "[TEST] Issue friend",
        "message_id": "m-1",
    }


# --- 3. the slate email record ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_emailing_the_slate_records_it(monkeypatch: pytest.MonkeyPatch, fake_supabase: Any) -> None:
    from writer_engine.postal import client as postal_client
    from writer_engine.studio import emailing
    from writer_engine.studio.core import StudioEdition

    ed = StudioEdition(user_id=OWNER, edition_id="ai-mvp", radar="trend", name="AI MVP")

    async def view(_client: Any, _ed: Any, _week: Any) -> dict[str, Any]:
        return {
            "week_of": "2026-11-02",
            "topics": [{"rank": 1, "title": "T", "url": "https://t", "item_type": "article"}],
        }

    async def recipient(_client: Any, _user: str) -> tuple[str, str | None]:
        return "owner@example.com", None

    async def send_email(**kw: Any) -> Any:
        return type("R", (), {"message_id": "slate-msg-1"})()

    monkeypatch.setattr(emailing, "slate", view)
    monkeypatch.setattr(emailing, "_recipient", recipient)
    monkeypatch.setattr(postal_client, "send_email", send_email)

    out = await emailing.email_digest(fake_supabase, ed)

    rows = fake_supabase.tables["newsletter_owner_emails_v2"]
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "slate" and row["user_id"] == OWNER and row["edition_id"] == "ai-mvp"
    assert row["to_email"] == "owner@example.com"
    assert row["subject"] == out["subject"]
    assert row["postal_message_id"] == "slate-msg-1"
    assert row["week_of"] == "2026-11-02"
    assert row["sent_at"]
    assert out["recorded"] is True and out["sent_at"] == row["sent_at"]


# --- 2. the humanizer default -------------------------------------------------------------------


def test_newsletter_sections_are_not_humanized_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HUMANIZE_NEWSLETTER_SEGMENTS", raising=False)
    get_settings.cache_clear()
    assert get_settings().humanize_newsletter_segments is False
    monkeypatch.setenv("HUMANIZE_NEWSLETTER_SEGMENTS", "true")
    get_settings.cache_clear()
    assert get_settings().humanize_newsletter_segments is True


@pytest.mark.asyncio
async def test_slate_email_has_the_studio_button_and_dated_subject(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: Any
) -> None:
    """The email Eric got from n8n (2026-11-08): a dated header, a button into the studio chat for THIS
    edition, then the stories with their links in full. Now sent by the Workbench."""
    from writer_engine.postal import client as postal_client
    from writer_engine.studio import emailing
    from writer_engine.studio.core import StudioEdition

    monkeypatch.setenv("WORKBENCH_API_URL", "https://wb.example.com/")
    get_settings.cache_clear()
    ed = StudioEdition(user_id=OWNER, edition_id="ai-dev-roundup", radar="dev", name="AI Dev Roundup")
    topics = [
        {
            "rank": 1,
            "title": "A",
            "url": "https://a.example/x",
            "item_type": "article",
            "source": "HN",
            "angle": "ang",
        },
        {
            "rank": 2,
            "title": "V",
            "url": "https://v.example/y",
            "item_type": "video",
            "source": "YT",
            "angle": "",
        },
    ]
    sent: dict[str, Any] = {}

    async def view(_c: Any, _e: Any, _w: Any) -> dict[str, Any]:
        return {"week_of": "2026-11-09", "topics": topics}

    async def recipient(_c: Any, _u: str) -> tuple[str, str | None]:
        return "owner@example.com", None

    async def send_email(**kw: Any) -> Any:
        sent.update(kw)
        return type("R", (), {"message_id": "m"})()

    monkeypatch.setattr(emailing, "slate", view)
    monkeypatch.setattr(emailing, "_recipient", recipient)
    monkeypatch.setattr(postal_client, "send_email", send_email)
    await emailing.email_digest(fake_supabase, ed)
    get_settings.cache_clear()

    html = sent["html"]
    assert 'href="https://wb.example.com/newsletter/studio/ai-dev-roundup"' in html
    assert "Open the AI Dev Roundup studio" in html
    assert "1 articles + 1 videos" in html
    assert "Read → https://a.example/x" in html and "Watch → https://v.example/y" in html
    assert sent["subject"].startswith("AI Dev Roundup — ") and sent["subject"].endswith("(1+1)")
    assert "week of" not in sent["subject"]


@pytest.mark.asyncio
async def test_trend_slate_email_is_the_scored_ranked_table_n8n_sent(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: Any
) -> None:
    """The second radar (Eric, 2026-11-09): the email n8n's Trend Radar sent — "AI & Software Engineering
    Radar — Nov 9, 2026 — 14 topics", a "Want a draft?" box into the studio, then # / score / title with
    the driver and category under each — now sent by the Workbench."""
    from writer_engine.postal import client as postal_client
    from writer_engine.studio import emailing
    from writer_engine.studio.core import StudioEdition

    monkeypatch.setenv("WORKBENCH_API_URL", "https://wb.example.com/")
    get_settings.cache_clear()
    ed = StudioEdition(user_id=OWNER, edition_id="ai-mvp", radar="trend", name="The MVP Brief")
    topics = [
        {
            "rank": 1,
            "title": "Base44 <big>",
            "url": "https://a.example/1",
            "item_type": "article",
            "score": 95,
            "driver_type": "demand trigger",
            "category": "demand trigger",
            "client_relevance": "MVP & startups",
            "also_covered_by": ["HN"],
            "angle": "Ship it first",
            "summary": "What happened.\n\nWhy it matters.",
            "source": "SaaStr",
            "published_at": "2026-11-07T10:00:00+00:00",
        },
        {
            "rank": 2,
            "title": "Vercel",
            "url": "https://a.example/2",
            "item_type": "article",
            "score": 72,
            "driver_type": "AI dev tool/agent",
            "category": "AI advances",
            "also_covered_by": [],
        },
    ]
    sent: dict[str, Any] = {}

    async def view(_c: Any, _e: Any, _w: Any) -> dict[str, Any]:
        return {"week_of": "2026-11-09", "topics": topics}

    async def recipient(_c: Any, _u: str) -> tuple[str, str | None]:
        return "owner@example.com", None

    async def send_email(**kw: Any) -> Any:
        sent.update(kw)
        return type("R", (), {"message_id": "m"})()

    monkeypatch.setattr(emailing, "slate", view)
    monkeypatch.setattr(emailing, "_recipient", recipient)
    monkeypatch.setattr(postal_client, "send_email", send_email)
    await emailing.email_digest(fake_supabase, ed)
    get_settings.cache_clear()

    html = sent["html"]
    assert sent["subject"].startswith("AI & Software Engineering Radar — ") and sent["subject"].endswith(
        "— 2 topics"
    )
    assert "Weekly AI &amp; Software Engineering Slate" in html and "2 ranked topics" in html
    assert 'href="https://wb.example.com/newsletter/studio/ai-mvp"' in html and "Want a draft?" in html
    assert "RANKED TOPICS" in html and ">95<" in html and "demand trigger · MVP &amp; startups" in html
    assert "also covered by HN" in html and "Base44 &lt;big&gt;" in html
    assert (
        "Blog angle:</b> Ship it first" in html and '<p style="margin:0 0 10px">Why it matters.</p>' in html
    )
    assert "Read the full article" in html and "SaaStr · 2026-11-07" in html
