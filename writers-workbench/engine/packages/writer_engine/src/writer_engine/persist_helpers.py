"""CR-001 — engine DB persistence parity with the n8n write workflows.

These helpers write generated artifacts into the SAME base tables n8n writes (``writing_projects_v2``,
``published_content_v2`` + ``content_versions_v2``, ``story_bible_v2``, ``research_reports_v2`` +
``outline_versions_v2``). They are best-effort and idempotent: a chapter is keyed on
(project_id, chapter_number) so a re-run replaces the row and snapshots a version rather than
duplicating. Every write carries ``user_id`` (V2 multi-tenant partitioning) so the row shows under the
right account in the UI. No base-table schema changes — only inserts/updates.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from writer_engine.errors import SUPABASE_ERRORS
from writer_engine.telemetry import token_accounting
from writer_engine.telemetry.logging import get_logger

logger = get_logger("persist_helpers")


async def _rows(resp: Any) -> list[dict]:
    return list(getattr(resp, "data", None) or [])


def touch() -> dict[str, str]:
    """``{"updated_at": <now>}``, to merge into any writing_projects_v2 update.

    Nothing bumps ``writing_projects_v2.updated_at`` — no trigger, and none of the writers set it.
    On The Ossuary it still equalled ``created_at`` after eight outline versions, which made the
    canon freshness probe report "fresh" against an index that was missing every research chunk.
    Measured 2026-10-18. The probe no longer trusts this column alone, but a row that changed should
    say so.
    """
    return {"updated_at": datetime.now(UTC).isoformat()}


async def create_project(
    client: Any, *, user_id: str, title: str, genre_slug: str = "", project_type: str = "story"
) -> str:
    """Insert a new writing_projects_v2 row and return its id (W1)."""
    resp = await (
        client.table("writing_projects_v2")
        .insert(
            {
                "user_id": user_id,
                "title": title,
                "genre_slug": genre_slug,
                "project_type": project_type,
                "status": "draft",
            }
        )
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
    client: Any,
    *,
    user_id: str,
    title: str | None,
    project_id: str | None = None,
    genre_slug: str = "",
    project_type: str = "story",
    create: bool = True,
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
    """Snapshot the prior outline to outline_versions_v2, then update writing_projects_v2.outline (W2).

    Item 7: the outline is validated and normalised to the canonical shape FIRST — an outline the
    schema rejects raises :class:`OutlineValidationError` before anything (snapshot included) is
    written."""
    from writer_engine.outline_schema import normalize_outline

    outline = normalize_outline(outline)
    cur = await client.table("writing_projects_v2").select("outline").eq("id", project_id).limit(1).execute()
    prior = (await _rows(cur) or [{}])[0].get("outline")
    if prior:
        vresp = await (
            client.table("outline_versions_v2")
            .select("version_number")
            .eq("project_id", project_id)
            .order("version_number", desc=True)
            .limit(1)
            .execute()
        )
        n = ((await _rows(vresp) or [{}])[0].get("version_number") or 0) + 1
        await (
            client.table("outline_versions_v2")
            .insert(
                {
                    "user_id": user_id,
                    "project_id": project_id,
                    "version_number": n,
                    "outline": prior,
                    "revision_note": "pre-revision snapshot",
                }
            )
            .execute()
        )
    chapter_count = len(outline.get("chapters") or [])
    await (
        client.table("writing_projects_v2")
        .update({"outline": outline, "chapter_count": chapter_count, "status": "outlined", **touch()})
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
    row = {
        "user_id": user_id,
        "project_id": project_id,
        "entry_type": "concept",
        "name": "Series Bible",
        "description": desc,
    }
    try:
        existing = await (
            client.table("story_bible_v2")
            .select("id")
            .eq("project_id", project_id)
            .eq("entry_type", "concept")
            .eq("name", "Series Bible")
            .limit(1)
            .execute()
        )
        rows = await _rows(existing)
        if rows:
            await client.table("story_bible_v2").update(row).eq("id", rows[0]["id"]).execute()
        else:
            await client.table("story_bible_v2").insert(row).execute()
    except SUPABASE_ERRORS as exc:
        # C4: was `pass`. The Series Bible entry is the project's synopsis + target chapter count,
        # so losing it silently means a later chapter is written without the canon it should have.
        logger.warning(
            "persist.canon_failed",
            project_id=str(project_id),
            error=f"{type(exc).__name__}: {str(exc)[:160]}",
        )


async def _latest_version(client: Any, content_id: str) -> tuple[int, str | None]:
    resp = await (
        client.table("content_versions_v2")
        .select("version_number, content_text")
        .eq("content_id", content_id)
        .order("version_number", desc=True)
        .limit(1)
        .execute()
    )
    top = (await _rows(resp) or [{}])[0]
    return int(top.get("version_number") or 0), top.get("content_text")


async def _snapshot_current_text(
    client: Any, *, content_id: str, user_id: str, current: str, chapter_number: int
) -> None:
    """Save the chapter's current text as a version unless the newest version already holds it."""
    if not current.strip():
        return
    n, latest_text = await _latest_version(client, content_id)
    if latest_text == current:
        return
    await (
        client.table("content_versions_v2")
        .insert(
            {
                "user_id": user_id,
                "content_id": content_id,
                "version_number": n + 1,
                "content_text": current,
                "changed_by": "engine",
                "change_note": f"chapter {chapter_number}: text before the engine rewrote it",
            }
        )
        .execute()
    )


async def persist_chapter(
    client: Any,
    *,
    project_id: str,
    user_id: str,
    chapter_number: int,
    title: str,
    content_text: str,
    genre_slug: str = "",
    metadata: dict | None = None,
) -> str:
    """Idempotent (project_id, chapter_number) upsert into published_content_v2 + a content_versions_v2
    snapshot (W3). Returns the content id.

    Two things a rewrite must not do (CR-001 audit, 2026-10-26):

    * **lose the text it replaces.** Versions held only engine writes, so a chapter last changed by
      hand (or by n8n) had no version of its current text, and the rewrite overwrote it for good.
      The current text is now saved as a version first whenever the newest version differs from it.
    * **write into a trashed row.** The lookup did not skip soft-deleted chapters, so rewriting a
      chapter the author had deleted put the new text in the trash where the UI never shows it.
    """
    existing = await (
        client.table("published_content_v2")
        .select("id, metadata, content_text")
        .eq("project_id", project_id)
        .eq("content_type", "chapter")
        .eq("chapter_number", chapter_number)
        .is_("deleted_at", None)
        .limit(1)
        .execute()
    )
    rows = await _rows(existing)
    row = {
        "user_id": user_id,
        "title": title,
        "content_type": "chapter",
        "genre_slug": genre_slug,
        "content_text": content_text,
        "status": "draft",
        "project_id": project_id,
        "chapter_number": chapter_number,
        "metadata": metadata or {},
    }
    if rows:
        content_id = str(rows[0]["id"])
        await _snapshot_current_text(
            client,
            content_id=content_id,
            user_id=user_id,
            current=str(rows[0].get("content_text") or ""),
            chapter_number=chapter_number,
        )
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
    n = (await _latest_version(client, content_id))[0] + 1
    await (
        client.table("content_versions_v2")
        .insert(
            {
                "user_id": user_id,
                "content_id": content_id,
                "version_number": n,
                "content_text": content_text,
                "changed_by": "engine",
                "change_note": f"chapter {chapter_number} (engine write)",
            }
        )
        .execute()
    )
    # The cost rows of this run were recorded before the chapter existed: tie them to it.
    token_accounting.annotate(project_id=project_id, content_id=content_id, chapter_number=chapter_number)
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
    if entry_type == "character":
        # A possessive CHARACTER is a relation, not a person ("Tayak's grandmother"). A possessive
        # place, object or event is an ordinary name ("Heater's Island", "Thomas Franklin's Pocket
        # Watch", "Turkey Tayac's burial"), and rejecting those dropped real canon on every write.
        if "'s " in low or low.endswith("'s"):
            return True
        if low.startswith(("the ", "a ", "an ")):  # "The clerk", "A delegate"
            return True
        # generic role with no proper name (all lowercase, e.g. "commission chair", "constable")
        if n == low and not any(ch.isupper() for ch in n):
            return True
    return False


# The canonical story-bible vocabulary (A6): what ``schemas.chapter.BibleEntry`` emits and what the
# client groups by first. ``story_bible_v2.entry_type`` has no CHECK, so anything typed by a person
# (chat, voice) is mapped onto these words here rather than accreting a sixth type per phrasing.
CANONICAL_ENTRY_TYPES: tuple[str, ...] = ("character", "place", "object", "concept", "event")
_ENTRY_TYPE_SYNONYMS: dict[str, str] = {
    "person": "character",
    "people": "character",
    "characters": "character",
    "cast": "character",
    "protagonist": "character",
    "antagonist": "character",
    "villain": "character",
    "location": "place",
    "locations": "place",
    "setting": "place",
    "places": "place",
    "city": "place",
    "planet": "place",
    "item": "object",
    "items": "object",
    "artifact": "object",
    "artefact": "object",
    "weapon": "object",
    "ship": "object",
    "objects": "object",
    "faction": "concept",
    "organization": "concept",
    "organisation": "concept",
    "group": "concept",
    "technology": "concept",
    "world_rule": "concept",
    "rule": "concept",
    "lore": "concept",
    "concepts": "concept",
    "timeline": "event",
    "battle": "event",
    "events": "event",
}


def normalize_entry_type(raw: Any) -> str | None:
    """Map a typed entry type onto the canonical vocabulary; None when it is not recognisable."""
    t = re.sub(r"[\s-]+", "_", str(raw or "").strip().lower())
    if not t:
        return None
    if t in CANONICAL_ENTRY_TYPES:
        return t
    return _ENTRY_TYPE_SYNONYMS.get(t)


_TRAILING_PAREN = re.compile(r"\s*\(([^)]*)\)\s*$")


def _clean(name: str) -> str:
    return " ".join(re.sub(r"[\s\u2014\u2013-]+$", "", name or "").split()).lower()


def character_keys(name: str) -> tuple[str, str]:
    """``(key, alias_key)`` for a character name.

    The key is the name without a trailing ALIAS in brackets, lower-cased: "Adaeze Okonkwo (A. Okonkwo)"
    and "Adaeze Okonkwo" share it. Only an alias is stripped, meaning a bracket that is itself a name
    (it starts with a capital). A descriptive bracket keeps people apart: "Taya (child)" and
    "Taya (the first, deceased)" are two people, and each keeps its full name as its key.
    """
    raw = " ".join(str(name or "").split())
    m = _TRAILING_PAREN.search(raw)
    if m and m.group(1)[:1].isupper():
        return _clean(raw[: m.start()]), _clean(m.group(1))
    return _clean(raw), ""


_SIGNIFICANT = re.compile(r"[A-Za-z][A-Za-z'-]{4,}")
_STOP = frozenset(
    {
        "about",
        "after",
        "again",
        "against",
        "appears",
        "before",
        "being",
        "between",
        "chapter",
        "character",
        "could",
        "described",
        "during",
        "every",
        "first",
        "known",
        "member",
        "members",
        "mentioned",
        "named",
        "other",
        "people",
        "person",
        "served",
        "serves",
        "staff",
        "their",
        "there",
        "these",
        "those",
        "through",
        "under",
        "until",
        "where",
        "which",
        "while",
        "worked",
        "working",
        "works",
        "would",
        "years",
    }
)


def _significant_words(text: str) -> set[str]:
    return {w.lower() for w in _SIGNIFICANT.findall(text or "")} - _STOP


def _is_person_target(name: str) -> bool:
    """A full name another entry may be merged into: one person, with no descriptive bracket."""
    key = character_keys(name)[0]
    return "(" not in key and " and " not in f" {key} " and "&" not in key


def resolve_character_variant(
    name: str, existing: list[str], *, descriptions: dict[str, str] | None = None
) -> str | None:
    """The existing character entry ``name`` is another spelling of, or None (CR-002).

    Only the unambiguous cases:

    * the same person under a bracketed alias: "Adaeze Okonkwo (A. Okonkwo)" is "Adaeze Okonkwo",
      and the fullest plain spelling wins ("Kaya-Tayac (Kaya)" goes to "Kaya-Tayac", not "Kaya");
    * a first name alone when the bible holds exactly ONE full name starting with it: "Osei" is
      "Osei Asante".

    What stays apart, each found in the DEV dry run of 2026-10-26:

    * a full name with a descriptive bracket: "Kittamaquund (ancestor)" is a different bearer of the
      name than "Kittamaquund", and "Maka and Maka-Small" is two people;
    * a bare word that is someone's SURNAME in this bible: "Voss" next to Dorothy, Renata and Elliot
      Voss is nobody in particular;
    * when ``descriptions`` are given, a first name whose description shares no distinctive word
      with the full name's: "Stewart", Ferguson's 1940 co-author, is not Stewart Udall.
    """
    key, alias = character_keys(name)
    if not key:
        return None
    others = [e for e in existing if e != name]
    same = [e for e in others if character_keys(e)[0] in {key, alias} - {""}]
    if same:
        plain = [e for e in same if not _TRAILING_PAREN.search(e)] or same
        return max(plain, key=lambda e: (len(character_keys(e)[0]), e))
    if " " in key or "(" in key:
        return None
    if any(character_keys(e)[0].endswith(" " + key) for e in others):
        return None  # a surname here, not a first name
    fulls = [e for e in others if character_keys(e)[0].startswith(key + " ") and _is_person_target(e)]
    if len({character_keys(e)[0] for e in fulls}) != 1:
        return None
    if any(character_keys(e)[0].startswith(key + " ") and not _is_person_target(e) for e in others):
        return None  # "Kaia-Tayac" next to "Kaia-Tayac (first)": a line of bearers, not one person
    target = ([e for e in fulls if not _TRAILING_PAREN.search(e)] or fulls)[0]
    if descriptions is not None:
        mine, theirs = descriptions.get(name, ""), descriptions.get(target, "")
        # Two distinctive words in common, not one: "Priya" at the Smithsonian collections desk and
        # Priya Mehta on the museum's legal team shared only "member".
        if mine.strip() and theirs.strip() and len(_significant_words(mine) & _significant_words(theirs)) < 2:
            return None
    return target


def first_name_entry_to_rename(name: str, existing: list[str]) -> str | None:
    """The first-name-only entry a new full name should take over, or None.

    "Osei" is in the bible and "Osei Asante" arrives: when "Osei" is the only entry with that first
    name and no other full name starts with it, it is the same person, so the entry is renamed rather
    than a second "character" added.
    """
    key, _alias = character_keys(name)
    if " " not in key:
        return None
    first = key.split(" ", 1)[0]
    singles = [e for e in existing if character_keys(e)[0] == first]
    fulls = [
        e for e in existing if character_keys(e)[0].startswith(first + " ") and character_keys(e)[0] != key
    ]
    return singles[0] if len(singles) == 1 and not fulls else None


async def _live_character_names(client: Any, project_id: str) -> dict[str, str] | None:
    """Live character entries for the project, name -> description. None when it cannot be read.

    None, not ``{}``: an empty roster means "no characters yet", and persist_bible would then write
    every variant ("Osei Asante" beside "Osei") as a new person (CR-002) on one failed read.
    """
    try:
        resp = await (
            client.table("story_bible_v2")
            .select("name,description")
            .eq("project_id", project_id)
            .eq("entry_type", "character")
            .is_("deleted_at", None)
            .limit(2000)
            .execute()
        )
        return {str(r["name"]): str(r.get("description") or "") for r in await _rows(resp) if r.get("name")}
    except SUPABASE_ERRORS as exc:
        logger.warning(
            "persist.bible_roster_unreadable",
            project_id=str(project_id),
            error=f"{type(exc).__name__}: {str(exc)[:160]}",
        )
        return None


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
    failures: list[str] = []
    characters: dict[str, str] = {}
    roster: str = "unread"  # unread | ok | unreadable
    for e in entries:
        name = e.get("name")
        if not name:
            continue
        entry_type = e.get("entry_type") or "concept"
        if _is_junk_bible_name(str(name), entry_type):
            continue
        if entry_type == "character":
            # CR-002: "Osei" and "Osei Asante" were kept as two characters, and the writer's roster
            # then had two people where the book has one. A variant is written to the entry it names.
            if roster == "unread":
                loaded = await _live_character_names(client, project_id)
                roster = "ok" if loaded is not None else "unreadable"
                characters = loaded or {}
            if roster == "unreadable":
                # Without the roster a variant cannot be matched to its person, and writing it
                # anyway adds a second one. Skipped and counted; the next chapter's pass adds it.
                failures.append(f"{name}: character roster unreadable")
                continue
            descriptions = {**characters, str(name): str(e.get("description") or "")}
            canonical = resolve_character_variant(str(name), list(characters), descriptions=descriptions)
            if canonical:
                name = canonical
            else:
                short = first_name_entry_to_rename(str(name), list(characters))
                if short:
                    # The bible knew this person only by first name; give that entry the full name
                    # rather than adding a second person.
                    try:
                        await (
                            client.table("story_bible_v2")
                            .update({"name": name})
                            .eq("project_id", project_id)
                            .eq("entry_type", "character")
                            .eq("name", short)
                            .is_("deleted_at", None)
                            .execute()
                        )
                    except SUPABASE_ERRORS as exc:
                        # Was suppressed, and the full name was then inserted beside the first-name
                        # entry: two people again. Not renamed, so this sighting updates "Osei".
                        logger.warning(
                            "persist.bible_rename_failed",
                            project_id=str(project_id),
                            error=f"{type(exc).__name__}: {str(exc)[:160]}",
                        )
                        name = short
                    else:
                        characters[str(name)] = characters.pop(short, "")
                characters.setdefault(str(name), str(e.get("description") or ""))
        row = {
            "user_id": user_id,
            "project_id": project_id,
            "entry_type": entry_type,
            "name": name,
            "description": e.get("description") or "",
        }
        # Only a chapter sighting moves this; a hand-added entry must not null it out.
        if chapter_number is not None:
            row["last_chapter_seen"] = chapter_number
        try:
            # Live rows only: matching a soft-deleted duplicate updated the trashed copy and left the
            # entry the author sees stale.
            existing = await (
                client.table("story_bible_v2")
                .select("id")
                .eq("project_id", project_id)
                .eq("entry_type", entry_type)
                .eq("name", name)
                .is_("deleted_at", None)
                .limit(1)
                .execute()
            )
            rows = await _rows(existing)
            if rows:
                await client.table("story_bible_v2").update(row).eq("id", rows[0]["id"]).execute()
            else:
                await client.table("story_bible_v2").insert(row).execute()
            count += 1
        except SUPABASE_ERRORS as exc:
            # C4: was a bare `continue`, so 0 persisted entries looked the same as 50 failures.
            # Counted and summarised once rather than logged per row — a chapter can emit dozens.
            failures.append(f"{name}: {type(exc).__name__}")
            continue
    if failures:
        logger.warning(
            "persist.bible_entries_failed",
            project_id=str(project_id),
            failed=len(failures),
            persisted=count,
            sample=failures[:3],
        )
    return count


async def persist_research(
    client: Any,
    *,
    project_id: str | None,
    user_id: str,
    topic: str,
    content: str,
    genre_slug: str = "",
    replace_same_topic: bool = False,
) -> str:
    """Insert a research report (W5) and, when a project is given, link it to that project via the
    research_report_projects_v2 meta table (CR-006) so the UI research tab can filter by project.
    research_reports_v2 itself is a base table with no project_id column, so the link lives in the
    meta table. The caller passes the topic as the user should READ it: the project id belongs in the
    link row, not in the title.

    ``replace_same_topic``: update the user's live report with this exact topic instead of adding
    another. The chapter path uses it, because its topic names the chapter ("… — Chapter 4
    research") and every rewrite used to add a copy: 114 duplicates across 103 chapters on DEV.
    """
    if replace_same_topic:
        found = await _rows(
            await client.table("research_reports_v2")
            .select("id")
            .eq("user_id", user_id)
            .eq("topic", topic)
            .is_("deleted_at", None)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if found:
            from datetime import UTC, datetime

            report_id = str(found[0]["id"])
            await (
                client.table("research_reports_v2")
                .update(
                    {
                        "content": content,
                        "genre_slug": genre_slug,
                        "updated_at": datetime.now(UTC).isoformat(),
                    }
                )
                .eq("id", report_id)
                .execute()
            )
            return report_id
    resp = await (
        client.table("research_reports_v2")
        .insert(
            {
                "user_id": user_id,
                "topic": topic,
                "genre_slug": genre_slug,
                "content": content,
                "status": "draft",
            }
        )
        .execute()
    )
    rows = await _rows(resp)
    report_id = str(rows[0]["id"]) if rows else ""
    if report_id and project_id:
        # Best-effort link — a missing meta table (pre-migration-026) must not fail the report write.
        # But not silent: an unlinked report is saved yet missing from the project's research tab.
        try:
            await (
                client.table("research_report_projects_v2")
                .insert({"report_id": report_id, "project_id": str(project_id), "user_id": user_id})
                .execute()
            )
        except SUPABASE_ERRORS as exc:
            logger.warning(
                "persist.research_link_failed",
                report_id=report_id,
                project_id=str(project_id),
                error=f"{type(exc).__name__}: {str(exc)[:160]}",
            )
    return report_id


async def persist_content(
    client: Any,
    *,
    user_id: str,
    title: str,
    content_type: str,
    content_text: str,
    genre_slug: str = "",
    project_id: str | None = None,
    metadata: dict | None = None,
) -> str:
    """Insert a standalone piece (blog_post / short_story / etc.) into published_content_v2 + a
    content_versions_v2 snapshot. For non-chapter content (no chapter_number)."""
    ins = await (
        client.table("published_content_v2")
        .insert(
            {
                "user_id": user_id,
                "title": title,
                "content_type": content_type,
                "genre_slug": genre_slug,
                "content_text": content_text,
                "status": "draft",
                "project_id": project_id,
                "metadata": metadata or {},
            }
        )
        .execute()
    )
    content_id = str((await _rows(ins) or [{"id": str(uuid4())}])[0]["id"])
    await (
        client.table("content_versions_v2")
        .insert(
            {
                "user_id": user_id,
                "content_id": content_id,
                "version_number": 1,
                "content_text": content_text,
                "changed_by": "engine",
                "change_note": f"{content_type} (engine write)",
            }
        )
        .execute()
    )
    token_accounting.annotate(project_id=project_id, content_id=content_id)
    return content_id


async def persist_token_usage(
    client: Any,
    *,
    user_id: str | None = None,
    workflow: str = "",
    calls: list[dict] | None = None,
    metadata: dict | None = None,
    rows: list[dict] | None = None,
) -> int:
    """CR-007 — write one ``token_usage_v2`` row per paid call.

    ``rows`` are complete rows built by :mod:`writer_engine.telemetry.token_accounting` (migration 044
    columns: operation, provider, units, unit_prices, cost_source, run_id, ...); they are inserted
    as-is. Rows carrying a ``request_id`` are upserted on ``(provider, request_id)`` with
    ignore-duplicates, so a provider task recorded twice cannot be billed twice. The older
    ``calls``/``workflow`` form is kept for callers written before 044. Returns rows written.

    Every row leaves here with ``provider``, ``operation`` and ``source`` set (:func:`label_token_rows`):
    47 DEV rows were written with all three NULL by the pre-044 form, which put the provider only in
    metadata, and the cost view cannot group or price a row it cannot label."""
    if rows is None:
        rows = _legacy_token_rows(user_id=user_id, workflow=workflow, calls=calls, metadata=metadata)
    rows = label_token_rows(rows)
    if rows:
        keyed = [r for r in rows if r.get("request_id")]
        plain = [r for r in rows if not r.get("request_id")]
        if plain:
            await client.table("token_usage_v2").insert(plain).execute()
        for r in keyed:
            try:
                await client.table("token_usage_v2").insert(r).execute()
            except Exception as exc:  # 23505 = already recorded under this request id
                if "23505" not in str(exc) and "duplicate key" not in str(exc):
                    raise
    return len(rows)


def _legacy_token_rows(
    *, user_id: str | None, workflow: str, calls: list[dict] | None, metadata: dict | None
) -> list[dict]:
    """Rows for the pre-044 ``calls``/``workflow`` form, now with the 044 label columns filled."""
    rows = []
    for c in calls or []:
        inp = int(c.get("input_tokens") or 0)
        out = int(c.get("output_tokens") or 0)
        cr = int(c.get("cache_read_tokens") or 0)
        cw = int(c.get("cache_write_tokens") or 0)
        rows.append(
            {
                "user_id": user_id,
                "workflow_name": workflow,
                "operation": workflow,
                "provider": c.get("provider"),
                "model": c.get("model"),
                "input_tokens": inp,
                "output_tokens": out,
                # total includes cache tokens so cost analytics reflect the full billable footprint
                "total_tokens": inp + out + cr + cw,
                "cost_usd": c.get("cost_usd") or 0,
                "metadata": {
                    **(metadata or {}),
                    "provider": c.get("provider"),
                    "cache_read_tokens": cr,
                    "cache_write_tokens": cw,
                },
            }
        )
    return rows


UNKNOWN_PROVIDER = "unknown"


def label_token_rows(rows: list[dict]) -> list[dict]:
    """Make sure every cost row names its provider, operation and source before it is written.

    A row missing one is still written — dropping it would lose billing data — but never silently:
    it is logged at ERROR with what was missing, defaulted (provider from metadata, else ``unknown``;
    operation from ``workflow_name``, else ``unattributed.<provider>``; source ``engine``) and tagged
    ``metadata.label_defaulted`` so the cost view and an audit can find it.
    """
    out = []
    for row in rows:
        row = dict(row)
        meta = dict(row.get("metadata") or {})
        missing = []
        if not str(row.get("provider") or "").strip():
            missing.append("provider")
            row["provider"] = str(meta.get("provider") or "").strip() or UNKNOWN_PROVIDER
        if not str(row.get("operation") or "").strip():
            missing.append("operation")
            row["operation"] = (
                str(row.get("workflow_name") or "").strip() or f"unattributed.{row['provider']}"
            )
        if not str(row.get("workflow_name") or "").strip():
            row["workflow_name"] = row["operation"]
        if not str(row.get("source") or "").strip():
            row["source"] = "engine"
        if missing:
            meta["label_defaulted"] = missing
            row["metadata"] = meta
            logger.error(
                "token_usage.unlabelled_row",
                missing=missing,
                provider=row["provider"],
                operation=row["operation"],
                model=row.get("model"),
            )
        out.append(row)
    return out


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
