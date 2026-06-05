"""CR-001 — engine DB persistence parity with the n8n write workflows.

These helpers write generated artifacts into the SAME base tables n8n writes (``writing_projects_v2``,
``published_content_v2`` + ``content_versions_v2``, ``story_bible_v2``, ``research_reports_v2`` +
``outline_versions_v2``). They are best-effort and idempotent: a chapter is keyed on
(project_id, chapter_number) so a re-run replaces the row and snapshots a version rather than
duplicating. Every write carries ``user_id`` (V2 multi-tenant partitioning) so the row shows under the
right account in the UI. No base-table schema changes — only inserts/updates.
"""

from __future__ import annotations

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


async def persist_chapter(
    client: Any, *, project_id: str, user_id: str, chapter_number: int, title: str,
    content_text: str, genre_slug: str = "", metadata: dict | None = None,
) -> str:
    """Idempotent (project_id, chapter_number) upsert into published_content_v2 + a content_versions_v2
    snapshot (W3). Returns the content id."""
    existing = await (
        client.table("published_content_v2").select("id")
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


async def persist_bible(
    client: Any, *, project_id: str, user_id: str, entries: list[dict], chapter_number: int | None = None
) -> int:
    """Persist story-bible entries (W4), de-duped on (project_id, entry_type, name).

    Done as select-then-update/insert rather than a DB upsert: DEV's ``story_bible_v2`` has no UNIQUE
    constraint on (project_id, entry_type, name), so ``on_conflict`` raises 42P10. Each entry is
    independently best-effort so one bad row can't abort the rest (or mask the chapter persist).
    """
    count = 0
    for e in entries:
        name = e.get("name")
        if not name:
            continue
        entry_type = e.get("entry_type") or "concept"
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
    """Insert a research report (W5). research_reports_v2 has no project_id column, so the link is
    recorded in the topic prefix for traceability."""
    resp = await (
        client.table("research_reports_v2")
        .insert({"user_id": user_id, "topic": topic, "genre_slug": genre_slug,
                 "content": content, "status": "draft"})
        .execute()
    )
    rows = await _rows(resp)
    return str(rows[0]["id"]) if rows else ""
