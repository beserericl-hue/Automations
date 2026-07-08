"""CR-001 — engine DB persistence parity with the n8n write workflows.

These helpers write generated artifacts into the SAME base tables n8n writes (``writing_projects_v2``,
``published_content_v2`` + ``content_versions_v2``, ``story_bible_v2``, ``research_reports_v2`` +
``outline_versions_v2``). They are best-effort and idempotent: a chapter is keyed on
(project_id, chapter_number) so a re-run replaces the row and snapshots a version rather than
duplicating. Every write carries ``user_id`` (V2 multi-tenant partitioning) so the row shows under the
right account in the UI. No base-table schema changes — only inserts/updates.
"""

from __future__ import annotations

import contextlib
from typing import Any
from uuid import uuid4


async def _rows(resp: Any) -> list[dict]:
    return list(getattr(resp, "data", None) or [])


async def create_project(
    client: Any, *, user_id: str, title: str, genre_slug: str = "", project_type: str = "story"
) -> str:
    """Insert a new writing_projects_v2 row and return its id (W1)."""
    resp = await (
        client.table("writing_projects_v2")
        .insert({"user_id": user_id, "title": title, "genre_slug": genre_slug,
                 "project_type": project_type, "status": "draft"})
        .execute()
    )
    rows = await _rows(resp)
    return str(rows[0]["id"]) if rows else ""


async def resolve_project_id(
    client: Any, *, user_id: str | None, title: str | None
) -> tuple[str | None, dict | None]:
    """Find the user's project whose title matches ``title`` (fuzzy — the n8n ilike behaviour).

    Returns ``(project_id, row)`` for the best match, or ``(None, None)`` when nothing matches.
    Used by the hub write paths (chapter.write / chapter.plan / brainstorm) to turn a spoken/typed
    project TITLE into the ``project_id`` the step + persist layer require — the chat/voice surfaces
    never carry a UUID (CR-004), so without this every 'write chapter N of <title>' fails validation.
    """
    from writer_engine.library_helpers.title_resolver import normalize_title, titles_match

    if not title:
        return None, None
    q = client.table("writing_projects_v2").select("id,title,genre_slug,outline,user_id")
    if user_id:
        q = q.eq("user_id", user_id)
    rows = await _rows(await q.limit(500).execute())
    if not rows:
        return None, None
    # Exact normalized match wins; then the fuzzy (article-insensitive / substring) match.
    want = normalize_title(title)
    for row in rows:
        if normalize_title(row.get("title")) == want:
            return str(row["id"]), row
    for row in rows:
        if titles_match(row.get("title"), title):
            return str(row["id"]), row
    return None, None


async def resolve_or_create_project(
    client: Any, *, user_id: str, title: str | None, project_id: str | None = None,
    genre_slug: str = "", project_type: str = "story", create: bool = True,
) -> tuple[str | None, dict | None]:
    """Resolve a project by id or title; create it (when ``create``) if the title matches nothing.

    Central to G9/G12: 'write chapter 2 of "The Seed Vault"' resolves the existing project; 'write a
    chapter of a new book called X' creates it. Returns ``(project_id, row_or_None)`` — the row is the
    matched/created project so callers can reuse its outline/genre without a second query. When the
    title matches nothing and ``create`` is False, returns ``(None, None)`` (the caller decides)."""
    if project_id:
        return str(project_id), None
    pid, row = await resolve_project_id(client, user_id=user_id, title=title)
    if pid:
        return pid, row
    if not (create and user_id and title):
        return None, None
    new_id = await create_project(
        client, user_id=user_id, title=title, genre_slug=genre_slug, project_type=project_type
    )
    return (new_id or None), None


async def persist_outline(
    client: Any, *, project_id: str, user_id: str, outline: dict, note: str = "engine brainstorm"
) -> None:
    """Snapshot the prior outline to outline_versions_v2, then update writing_projects_v2.outline (W2)."""
    cur = await (
        client.table("writing_projects_v2").select("outline").eq("id", project_id).limit(1).execute()
    )
    prior = (await _rows(cur) or [{}])[0].get("outline")
    if prior:
        vresp = await (
            client.table("outline_versions_v2").select("version_number")
            .eq("project_id", project_id).order("version_number", desc=True).limit(1).execute()
        )
        n = ((await _rows(vresp) or [{}])[0].get("version_number") or 0) + 1
        await (
            client.table("outline_versions_v2")
            .insert({"user_id": user_id, "project_id": project_id, "version_number": n,
                     "outline": prior, "revision_note": "pre-revision snapshot"})
            .execute()
        )
    chapter_count = len(outline.get("chapters") or [])
    await (
        client.table("writing_projects_v2")
        .update({"outline": outline, "chapter_count": chapter_count, "status": "outlined"})
        .eq("id", project_id)
        .execute()
    )
    await persist_canon(client, project_id=project_id, user_id=user_id, outline=outline)


async def persist_canon(client: Any, *, project_id: str, user_id: str, outline: dict) -> None:
    """CR-002: write/update the project's 'Series Bible' canon entry in story_bible_v2 — the synopsis,
    target chapter count, and arc, alongside the character entries. Best-effort; a failure here never
    blocks the outline persist."""
    chapter_count = len(outline.get("chapters") or [])
    desc = (
        f"SYNOPSIS: {outline.get('premise') or ''}\n"
        f"STORY ARC: {outline.get('story_arc_name') or ''}\n"
        f"TARGET CHAPTER COUNT: {chapter_count}\n"
        f"DRAMATIC QUESTION: {outline.get('dramatic_question') or ''}"
    )
    row = {"user_id": user_id, "project_id": project_id, "entry_type": "concept",
           "name": "Series Bible", "description": desc}
    try:
        existing = await (
            client.table("story_bible_v2").select("id")
            .eq("project_id", project_id).eq("entry_type", "concept").eq("name", "Series Bible")
            .limit(1).execute()
        )
        rows = await _rows(existing)
        if rows:
            await client.table("story_bible_v2").update(row).eq("id", rows[0]["id"]).execute()
        else:
            await client.table("story_bible_v2").insert(row).execute()
    except Exception:
        pass


async def persist_chapter(
    client: Any, *, project_id: str, user_id: str, chapter_number: int, title: str,
    content_text: str, genre_slug: str = "", metadata: dict | None = None,
) -> str:
    """Idempotent (project_id, chapter_number) upsert into published_content_v2 + a content_versions_v2
    snapshot (W3). Returns the content id."""
    existing = await (
        client.table("published_content_v2").select("id, metadata")
        .eq("project_id", project_id).eq("content_type", "chapter").eq("chapter_number", chapter_number)
        .limit(1).execute()
    )
    rows = await _rows(existing)
    row = {
        "user_id": user_id, "title": title, "content_type": "chapter", "genre_slug": genre_slug,
        "content_text": content_text, "status": "draft", "project_id": project_id,
        "chapter_number": chapter_number, "metadata": metadata or {},
    }
    if rows:
        content_id = str(rows[0]["id"])
        # MERGE metadata on a re-write (repair/rewrite): the caller passes only the write-time keys
        # (chapter_run_id, word_count, sub_chapter_count, craft_qa, drift_report). Overwriting the whole
        # metadata column here WIPED fields the rewrite doesn't own — most visibly ``qa_report`` (the Q/A
        # Consistency Report the user ran, which then vanished from the UI), plus ``dismissed_annotations``
        # and ``last_qa_report``. Preserve the prior keys; only refresh the ones we produced this run.
        prior_meta = rows[0].get("metadata") if isinstance(rows[0].get("metadata"), dict) else {}
        row["metadata"] = {**(prior_meta or {}), **(metadata or {})}
        # Stamp updated_at on re-writes (repair/rewrite) — there is no DB trigger, so without this the
        # row's updated_at stays frozen at first-write time and the UI sorts/refreshes stale.
        from datetime import UTC, datetime

        row["updated_at"] = datetime.now(UTC).isoformat()
        await client.table("published_content_v2").update(row).eq("id", content_id).execute()
    else:
        ins = await client.table("published_content_v2").insert(row).execute()
        content_id = str((await _rows(ins) or [{"id": str(uuid4())}])[0]["id"])
    # version snapshot
    vresp = await (
        client.table("content_versions_v2").select("version_number")
        .eq("content_id", content_id).order("version_number", desc=True).limit(1).execute()
    )
    n = ((await _rows(vresp) or [{}])[0].get("version_number") or 0) + 1
    await (
        client.table("content_versions_v2")
        .insert({"user_id": user_id, "content_id": content_id, "version_number": n,
                 "content_text": content_text, "changed_by": "engine",
                 "change_note": f"chapter {chapter_number} (engine write)"})
        .execute()
    )
    return content_id


def _is_junk_bible_name(name: str, entry_type: str) -> bool:
    """Reject the entries that polluted the bible to ~1000 rows (CR-005/006 finding): possessives
    ('Tayak's grandmother', "Kimi's boyfriend"), 'The ...' fragments, bare generic roles, and
    one-word descriptors — for CHARACTER entries especially. These created dozens of fake/variant
    'characters' that contradicted the canonical cast and broke the writer's roster."""
    n = (name or "").strip()
    if len(n) < 2:
        return True
    low = n.lower()
    if "'s " in low or low.endswith("'s"):  # possessive -> a relation, not a character
        return True
    if entry_type == "character":
        if low.startswith(("the ", "a ", "an ")):  # "The clerk", "A delegate"
            return True
        # generic role with no proper name (all lowercase, e.g. "commission chair", "constable")
        if n == low and not any(ch.isupper() for ch in n):
            return True
    return False


async def persist_bible(
    client: Any, *, project_id: str, user_id: str, entries: list[dict], chapter_number: int | None = None
) -> int:
    """Persist story-bible entries (W4), de-duped on (project_id, entry_type, name).

    Done as select-then-update/insert rather than a DB upsert: DEV's ``story_bible_v2`` has no UNIQUE
    constraint on (project_id, entry_type, name), so ``on_conflict`` raises 42P10. Each entry is
    independently best-effort so one bad row can't abort the rest (or mask the chapter persist).

    Junk/variant names are filtered (see _is_junk_bible_name) so the bible stays a clean canonical
    cast rather than accreting possessives/fragments that poison the writer's roster.
    """
    count = 0
    for e in entries:
        name = e.get("name")
        if not name:
            continue
        entry_type = e.get("entry_type") or "concept"
        if _is_junk_bible_name(str(name), entry_type):
            continue
        row = {
            "user_id": user_id, "project_id": project_id, "entry_type": entry_type, "name": name,
            "description": e.get("description") or "", "last_chapter_seen": chapter_number,
        }
        try:
            existing = await (
                client.table("story_bible_v2").select("id")
                .eq("project_id", project_id).eq("entry_type", entry_type).eq("name", name)
                .limit(1).execute()
            )
            rows = await _rows(existing)
            if rows:
                await client.table("story_bible_v2").update(row).eq("id", rows[0]["id"]).execute()
            else:
                await client.table("story_bible_v2").insert(row).execute()
            count += 1
        except Exception:
            continue
    return count


async def persist_research(
    client: Any, *, project_id: str | None, user_id: str, topic: str, content: str, genre_slug: str = ""
) -> str:
    """Insert a research report (W5) and, when a project is given, link it to that project via the
    research_report_projects_v2 meta table (CR-006) so the UI research tab can filter by project.
    research_reports_v2 itself is a base table with no project_id column, so the link lives in the
    meta table (the topic prefix is kept too, for human-readable traceability)."""
    resp = await (
        client.table("research_reports_v2")
        .insert({"user_id": user_id, "topic": topic, "genre_slug": genre_slug,
                 "content": content, "status": "draft"})
        .execute()
    )
    rows = await _rows(resp)
    report_id = str(rows[0]["id"]) if rows else ""
    if report_id and project_id:
        # Best-effort link — a missing meta table (pre-migration-026) must not fail the report write.
        with contextlib.suppress(Exception):
            await (
                client.table("research_report_projects_v2")
                .insert({"report_id": report_id, "project_id": str(project_id), "user_id": user_id})
                .execute()
            )
    return report_id


async def persist_content(
    client: Any, *, user_id: str, title: str, content_type: str, content_text: str,
    genre_slug: str = "", project_id: str | None = None, metadata: dict | None = None,
) -> str:
    """Insert a standalone piece (blog_post / short_story / etc.) into published_content_v2 + a
    content_versions_v2 snapshot. For non-chapter content (no chapter_number)."""
    ins = await (
        client.table("published_content_v2")
        .insert({
            "user_id": user_id, "title": title, "content_type": content_type,
            "genre_slug": genre_slug, "content_text": content_text, "status": "draft",
            "project_id": project_id, "metadata": metadata or {},
        })
        .execute()
    )
    content_id = str((await _rows(ins) or [{"id": str(uuid4())}])[0]["id"])
    await (
        client.table("content_versions_v2")
        .insert({"user_id": user_id, "content_id": content_id, "version_number": 1,
                 "content_text": content_text, "changed_by": "engine",
                 "change_note": f"{content_type} (engine write)"})
        .execute()
    )
    return content_id


async def persist_token_usage(
    client: Any, *, user_id: str, workflow: str, calls: list[dict], metadata: dict | None = None
) -> int:
    """CR-007 — write one ``token_usage_v2`` row per LLM call (billing parity with the n8n workflows).
    Each row: model, input/output/total tokens, cost_usd, and metadata (project_id/chapter_number +
    cache tokens). Best-effort bulk insert; returns the number of rows written."""
    rows = []
    for c in calls:
        inp = int(c.get("input_tokens") or 0)
        out = int(c.get("output_tokens") or 0)
        cr = int(c.get("cache_read_tokens") or 0)
        cw = int(c.get("cache_write_tokens") or 0)
        rows.append({
            "user_id": user_id,
            "workflow_name": workflow,
            "model": c.get("model"),
            "input_tokens": inp,
            "output_tokens": out,
            # total includes cache tokens so cost analytics reflect the full billable footprint
            "total_tokens": inp + out + cr + cw,
            "cost_usd": c.get("cost_usd") or 0,
            "metadata": {**(metadata or {}), "provider": c.get("provider"),
                         "cache_read_tokens": cr, "cache_write_tokens": cw},
        })
    if not rows:
        return 0
    await client.table("token_usage_v2").insert(rows).execute()
    return len(rows)


async def persist_chapter_qa(
    client: Any, *, project_id: str, user_id: str, chapter_number: int, telemetry: dict
) -> str:
    """CR-005 — insert one per-run telemetry row into ``chapter_qa_v2`` (drift report, craft QA,
    research used, bible entries loaded, generation stats). History model: one row per run, newest
    by created_at wins in the project view. Best-effort; the caller logs failures."""
    row = {
        "user_id": user_id,
        "project_id": project_id,
        "chapter_number": chapter_number,
        "chapter_run_id": telemetry.get("chapter_run_id"),
        "aligned": telemetry.get("aligned"),
        "drift_report": telemetry.get("drift_report"),
        "craft_qa": telemetry.get("craft_qa"),
        "research_used": telemetry.get("research_used"),
        "bible_entries_loaded": telemetry.get("bible_entries_loaded"),
        "word_count": telemetry.get("word_count"),
        "sub_chapter_count": telemetry.get("sub_chapter_count"),
        "craft_passes": telemetry.get("craft_passes"),
        "cache_read_tokens": telemetry.get("cache_read_tokens"),
        "cache_write_tokens": telemetry.get("cache_write_tokens"),
        "model": telemetry.get("model"),
        "status": telemetry.get("status") or "ok",
        "error": telemetry.get("error"),
    }
    resp = await client.table("chapter_qa_v2").insert(row).execute()
    rows = await _rows(resp)
    return str(rows[0]["id"]) if rows else ""
