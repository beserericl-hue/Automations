"""studio-svc — the Content Studio's ops (``writer_engine.studio``), for the Workbench and the hub.

Every op needs ``user_id`` and ``edition_id``, and first resolves the edition as one of the caller's
own studio editions (owner + radar subscription); anything else is ``NOT_FOUND``. Ops:

``slate``     {week_of?}                                    the week's ranked topics + what each became
``queue``     {status: drafts|approved|queue|all|one, posts?} posts of the edition
``generate``  {numbers "1-5, 8" | topic_ids [...], week_of?, redo?}   draft topics (task: LLM)
``revise``    {posts|post_id, mode: revise|regenerate|undo, instruction?}  (task: LLM)
``update``    {action, posts|post_ids, changes?}           approve / unapprove / discard / cancel /
                                                            requeue / unschedule / image_on / image_off / edit
``schedule``  {posts|post_ids, mode: next|slot|at|now, day?, slot?, time?, at?, channels?}
``issue``     {action: show|set|add|remove|new, ranks?, posts?, items?}
``email``     {posts|post_id} | {target: digest, week_of?}
``help``      the command list

Each answers ``{op, result}`` with ``result.message`` a sentence the assistant shows. A refusal is a
StepStatus.ERROR with ``{code, message}``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.social import schedule as S
from writer_engine.step_service import build_step_app
from writer_engine.studio import commands, core, drafting, emailing, issue
from writer_engine.studio.core import StudioEdition, StudioError
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "studio"
logger = get_logger(STEP_NAME)


async def _client() -> Any:
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _posts(
    client: Any, ed: StudioEdition, p: dict[str, Any], *, default_all: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """The posts a request names: ``post_ids``/``post_id``, or ``posts`` = "3, 5-7" | "all" | "approved" | "drafts"."""
    ids = p.get("post_ids") or ([p["post_id"]] if p.get("post_id") else None)
    if ids:
        return await core.own_posts(client, ed, ids=[str(i) for i in ids])
    spec = p.get("posts")
    if isinstance(spec, str) and spec.strip().lower() in ("all", "approved", "drafts"):
        word = spec.strip().lower()
        states = ("approved",) if word == "approved" else ("draft",) if word == "drafts" else default_all
        if not states:
            raise StudioError("VALIDATION", "Name the posts (#N) for that")
        return list(reversed(await core.posts_for(client, ed, states)))
    numbers = core.parse_post_numbers(spec)
    if not numbers:
        raise StudioError("VALIDATION", "Which post? Give its number, like #3")
    found = await core.own_posts(client, ed, numbers=numbers)
    missing = sorted(set(numbers) - {int(r.get("display_number") or 0) for r in found})
    if missing and not found:
        raise StudioError("NOT_FOUND", f"No post {', '.join('#' + str(n) for n in missing)} in this edition")
    return found


def _view(p: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "id",
        "display_number",
        "title",
        "state",
        "scheduled_date",
        "slot",
        "post_at",
        "channels",
        "item_type",
        "source_url",
        "include_image",
        "image_url",
        "radar_topic_id",
    )
    return {k: p.get(k) for k in keep}


async def op_help(_c: Any, _ed: StudioEdition, _p: dict[str, Any]) -> dict[str, Any]:
    return {"message": commands.HELP}


async def op_slate(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    view = await core.slate(client, ed, p.get("week_of"))
    lines = []
    for t in view["topics"]:
        kind = "[VIDEO] " if t.get("item_type") == "video" else ("[ARTICLE] " if ed.radar == "dev" else "")
        made = t.get("post")
        tail = f" → #{made['display_number']} ({made['state']})" if made else ""
        lines.append(f"{t['rank']}. {kind}{t.get('title')} — {t.get('angle') or t.get('source') or ''}{tail}")
    msg = (
        f"Week of {view['week_of']} ({len(view['topics'])} topics):\n" + "\n".join(lines)
        if view["topics"]
        else "No slate yet. Run the radar to build this week's."
    )
    return {**view, "message": msg + "\nReply “generate 1-5, 8” to draft some."}


async def op_queue(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    status = str(p.get("status") or "queue")
    if status == "one":
        posts = await _posts(client, ed, p)
        if not posts:
            raise StudioError("NOT_FOUND", "No such post")
        post = posts[0]
        text = f"#{post['display_number']} — {post['title']} ({post['state']})"
        if post.get("body_md"):
            text += f"\n=== BLOG ===\n{post['body_md'][:1500]}"
        if post.get("linkedin_content"):
            text += f"\n=== LINKEDIN ({len(post['linkedin_content'])} chars) ===\n{post['linkedin_content']}"
        return {"posts": [_view(post)], "message": text}
    states = {
        "drafts": ("draft",),
        "approved": ("approved",),
        "queue": core.QUEUE,
        "all": None,
    }.get(status, core.QUEUE)
    posts = await core.posts_for(client, ed, states)
    if status == "queue":
        posts.sort(key=lambda r: str(r.get("scheduled_at") or ""))
    return {"posts": [_view(x) for x in posts], "message": core.queue_message(posts)}


async def op_generate(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    if p.get("topic_ids"):
        topics = await core.topics_by_id(client, ed, [str(i) for i in p["topic_ids"]])
    else:
        _week, topics = await core.topics_by_rank(client, ed, p.get("numbers"), p.get("week_of"))
    if not topics:
        raise StudioError("NOT_FOUND", "None of those are on the slate")
    return await drafting.generate(client, ed, topics, redo=bool(p.get("redo")))


async def op_revise(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    posts = await _posts(client, ed, p)
    if not posts:
        raise StudioError("NOT_FOUND", "No such post")
    mode = str(p.get("mode") or "revise")
    out: list[dict[str, Any]] = []
    messages: list[str] = []
    for post in posts[:10]:
        if mode == "regenerate":
            r = await drafting.regenerate(client, ed, post)
        elif mode == "undo":
            r = await drafting.restore_previous(client, ed, post)
        else:
            r = await drafting.revise(client, ed, post, str(p.get("instruction") or ""))
        out.append(r["post"])
        messages.append(r["message"])
    return {"posts": out, "message": " ".join(messages)}


async def op_update(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    action = str(p.get("action") or "")
    if action == "edit":
        posts = await _posts(client, ed, p)
        if len(posts) != 1:
            raise StudioError("VALIDATION", "Edit one post at a time")
        row = await core.edit_post(client, ed, posts[0], dict(p.get("changes") or {}))
        return {"post": _view(row), "message": f"Saved #{row.get('display_number')}."}
    default_all = {"approve": ("draft",), "discard": ("draft",), "unapprove": ("approved",)}.get(action, ())
    posts = await _posts(client, ed, p, default_all=default_all)
    return await core.apply_action(client, ed, posts, action)


def _at(day_text: str | None, time_text: str | None, iso: str | None, now: datetime) -> datetime | None:
    if iso:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    day = core.parse_day(day_text, now)
    if day is None or not time_text:
        return None
    import re

    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", str(time_text).strip().lower())
    if not m:
        return None
    hour = int(m.group(1)) % 12 if m.group(3) else int(m.group(1))
    if m.group(3) == "pm":
        hour += 12
    return datetime(day.year, day.month, day.day, hour, int(m.group(2) or 0), tzinfo=S.ET)


async def op_schedule(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(UTC)
    posts = await _posts(client, ed, p, default_all=("approved",))
    mode = str(p.get("mode") or "next")
    channels = p.get("channels")
    chans = S.normalise_channels(channels) if isinstance(channels, str) else channels
    at = _at(p.get("day"), p.get("time"), p.get("at"), now) if mode == "at" else None
    if mode == "at" and at is None:
        raise StudioError("VALIDATION", "I could not read that time; try “schedule #3 tuesday at 11:30 am”")
    return await core.schedule_posts(
        client,
        ed,
        posts,
        mode=mode,
        at=at,
        day=core.parse_day(p.get("day"), now) if mode == "slot" else None,
        slot=p.get("slot"),
        channels=chans,
        now=now,
    )


async def op_issue(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    action = str(p.get("action") or "show")
    if action == "show":
        v = await issue.view(client, ed)
        lines = [
            f"{i['position']}. {i['title']}"
            + (f" (#{i['display_number']})" if i.get("display_number") else "")
            for i in v["items"]
        ]
        v["message"] = (
            ("The next issue: \n" + "\n".join(lines)) if lines else "Nothing chosen for the next issue yet."
        )
        return v
    if action == "new":
        return await issue.new_selection(client, ed)
    if isinstance(p.get("items"), list):
        items = [
            {"kind": str(i.get("kind")), "id": str(i.get("id"))} for i in p["items"] if isinstance(i, dict)
        ]
    else:
        from writer_engine.radar.drafts import expand_selection

        ranks_spec = str(p.get("ranks") or "").strip()
        ranks = expand_selection(ranks_spec, list(range(1, 51))) if ranks_spec else []
        numbers = core.parse_post_numbers(p.get("posts") or "")
        items = await issue.items_for_spec(client, ed, ranks=ranks, numbers=numbers, week_of=p.get("week_of"))
        if (ranks or numbers) and not items:
            raise StudioError("NOT_FOUND", "None of those are on the slate or in this edition")
    if action == "set":
        return await issue.set_items(client, ed, items)
    if action == "add":
        return await issue.add_items(client, ed, items)
    if action == "remove":
        return await issue.remove_items(client, ed, items)
    raise StudioError("VALIDATION", f"Unknown newsletter action {action!r}")


async def op_email(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    if p.get("target") == "digest":
        return await emailing.email_digest(client, ed, p.get("week_of"))
    posts = await _posts(client, ed, p)
    if not posts:
        raise StudioError("NOT_FOUND", "No such post")
    return await emailing.email_post(client, ed, posts[0])


async def op_batch(client: Any, ed: StudioEdition, p: dict[str, Any]) -> dict[str, Any]:
    """Several studio ops from one assistant message, in order ("make #3 punchier and schedule it
    thursday afternoon"). Stops at the first refusal: a later step usually depends on an earlier one
    (no point scheduling a draft whose revision failed), and the message says what was not done."""
    from writer_engine.hub.router import studio_batch_steps

    steps = studio_batch_steps({"steps": p.get("steps")})
    if not steps:
        raise StudioError("VALIDATION", "Nothing to do")
    done: list[dict[str, Any]] = []
    messages: list[str] = []
    for i, step in enumerate(steps):
        op = str(step.pop("op"))
        try:
            result = await OPS[op](client, ed, {**step, "op": op})
        except StudioError as exc:
            rest = ", ".join(str(s.get("op")) for s in steps[i + 1 :])
            msg = " ".join([*messages, f"{op} failed: {exc.message}"])
            if rest:
                msg += f" Not done: {rest}."
            if not done:
                raise StudioError(exc.code, msg) from exc
            return {"steps": done, "failed": {"op": op, "code": exc.code}, "message": msg}
        done.append({"op": op, "result": result})
        messages.append(str(result.get("message") or f"{op} done."))
    return {"steps": done, "message": " ".join(messages)}


OPS = {
    "batch": op_batch,
    "help": op_help,
    "slate": op_slate,
    "queue": op_queue,
    "generate": op_generate,
    "revise": op_revise,
    "update": op_update,
    "schedule": op_schedule,
    "issue": op_issue,
    "email": op_email,
}


def _error(inp: StepInput, code: str, message: str) -> StepOutput:
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.ERROR,
        error={"code": code, "message": message},  # type: ignore[arg-type]
    )


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "").strip().lower()
    if op not in OPS:
        return _error(inp, "UNKNOWN_OP", op or "(none)")
    user_id = str(inp.payload.get("user_id") or "").strip()
    edition_id = str(inp.payload.get("edition_id") or "").strip()
    try:
        client = await _client()
        # Choosing an issue's stories works for any edition the caller owns; the rest needs a radar.
        resolve = core.resolve_owned_edition if op == "issue" else core.resolve_edition
        ed = await resolve(client, user_id, edition_id)
        result = await OPS[op](client, ed, dict(inp.payload))
    except StudioError as exc:
        logger.info("studio.refused", op=op, code=exc.code, message=exc.message[:200])
        return _error(inp, exc.code, exc.message)
    except ValueError as exc:
        return _error(inp, "VALIDATION", str(exc)[:300])
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
