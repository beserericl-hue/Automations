"""story-bible-step — add / update / list with (entry_type, lower(name)) dedupe."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "story_bible"


async def _supabase_or_none():
    s = get_settings()
    if not s.supabase_url:
        return None
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _rows(resp: Any) -> list[dict]:
    return list(getattr(resp, "data", None) or [])


def _clean_name(v: Any) -> str:
    return " ".join(str(v or "").split()).strip(" \"'“”")


def _entry_from(payload: dict) -> dict:
    """The entry an add/update is about. The chapter path sends ``{entry: {...}}``; the hub sends the
    router's flat params (``name``, ``entry_type``, ``description``), under whichever key the model
    chose."""
    entry = dict(payload.get("entry") or {})
    for key, aliases in (
        ("name", ("name", "entry_name", "character_name")),
        ("entry_type", ("entry_type", "type", "category")),
        ("description", ("description", "details", "notes")),
    ):
        if not entry.get(key):
            for alias in aliases:
                if payload.get(alias):
                    entry[key] = payload[alias]
                    break
    if entry.get("name"):
        entry["name"] = _clean_name(entry["name"])
    return entry


async def _resolve_project(client: Any, payload: dict, entry: dict) -> tuple[str | None, str | None]:
    """``(project_id, error)`` for an add/update, owned by the caller.

    An id that came from conversation memory or the page is checked against ``user_id``: the hub
    fills ids from context, and a context that crossed users must not write into someone else's
    bible. A title is resolved the way every other hub op resolves one (``resolve_project_id``)."""
    user_id = str(entry.get("user_id") or payload.get("user_id") or "")
    project_id = str(entry.get("project_id") or payload.get("project_id") or "")
    title = str(payload.get("project_title") or "").strip()
    if project_id:
        owned = await _rows(
            await client.table("writing_projects_v2")
            .select("id,title")
            .eq("id", project_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if owned:
            return project_id, None
        if not title:
            return None, "That project isn't one of yours, so I didn't change its story bible."
    if title:
        from writer_engine.persist_helpers import resolve_project_id

        pid, _row = await resolve_project_id(client, user_id=user_id or None, title=title)
        if pid:
            return pid, None
        return None, f"I couldn't find a project matching '{title}'."
    return None, "Which project's story bible? Name the book, or open it in the Workbench first."


async def _live_entries(client: Any, project_id: str) -> list[dict]:
    return await _rows(
        await client.table("story_bible_v2")
        .select("id,name,entry_type,description,user_id,project_id")
        .eq("project_id", project_id)
        .is_("deleted_at", None)  # soft-deleted rows are not part of the bible
        .limit(5000)
        .execute()
    )


def _same_name(a: str, b: str) -> bool:
    """The same entry name, ignoring case and a bracketed alias ("Adaeze Okonkwo (A. Okonkwo)")."""
    from writer_engine.persist_helpers import character_keys

    ka, alias_a = character_keys(a)
    kb, alias_b = character_keys(b)
    return bool(ka) and (ka == kb or (bool(alias_a) and alias_a == kb) or (bool(alias_b) and alias_b == ka))


def _bad_type(raw: Any) -> dict:
    from writer_engine.persist_helpers import CANONICAL_ENTRY_TYPES

    return {
        "saved": False,
        "reason": "entry_type",
        "message": f"'{raw}' isn't a story bible type. Use one of: {', '.join(CANONICAL_ENTRY_TYPES)}.",
    }


async def _op_add(payload: dict) -> dict:
    """Add one entry, de-duped on (project_id, entry_type, name).

    Was ``upsert(on_conflict="project_id,entry_type,name")``, which needs a UNIQUE constraint the
    table does not have: on DEV every call raised 42P10, so "add X to the story bible" never saved.
    Goes through ``persist_bible`` now, the same select-then-write the chapter path uses — so a chat
    add gets the same junk-name filter and the same variant resolution ("Osei" lands on "Osei
    Asante") as an entry a chapter discovered.

    From the hub: the type is mapped onto the canonical vocabulary (an unrecognised one is refused
    rather than stored as a sixth type), the project may be a title, and an entry that already exists
    is reported rather than overwritten with an empty description.
    """
    client = await _supabase_or_none()
    entry = _entry_from(payload)
    if client is None:
        return {"entry": entry, "deduped": False}
    from writer_engine.persist_helpers import (
        _is_junk_bible_name,
        normalize_entry_type,
        persist_bible,
        resolve_character_variant,
    )

    user_id = str(entry.get("user_id") or payload.get("user_id") or "")
    if not user_id or not entry.get("name"):
        return {
            "entry": entry,
            "deduped": False,
            "saved": False,
            "reason": "project_id, user_id and name required",
            "message": "I need the name of the entry to add.",
        }
    project_id, error = await _resolve_project(client, payload, entry)
    if not project_id:
        return {"entry": entry, "deduped": False, "saved": False, "reason": "project", "message": error}

    raw_type = entry.get("entry_type")
    entry_type = normalize_entry_type(raw_type) if raw_type else "concept"
    if entry_type is None:
        return {"entry": entry, **_bad_type(raw_type)}
    name = str(entry["name"])
    if _is_junk_bible_name(name, entry_type):
        return {
            "entry": entry,
            "saved": False,
            "reason": "name",
            "message": f"'{name}' reads as a relation or a role, not a {entry_type}'s name, so I didn't add it.",
        }

    live = await _live_entries(client, project_id)
    same_type = [r for r in live if r.get("entry_type") == entry_type]
    final_name = name
    if entry_type == "character":
        names = [str(r["name"]) for r in same_type if r.get("name")]
        descriptions = {str(r["name"]): str(r.get("description") or "") for r in same_type}
        descriptions[name] = str(entry.get("description") or "")
        final_name = resolve_character_variant(name, names, descriptions=descriptions) or name
    existing = next((r for r in same_type if str(r.get("name") or "").lower() == final_name.lower()), None)
    description = str(entry.get("description") or "").strip()
    if existing is not None and not description:
        return {
            "entry": existing,
            "deduped": True,
            "saved": False,
            "project_id": project_id,
            "message": f"{existing['name']} is already in the story bible as a {entry_type}.",
        }

    to_save = {
        "name": existing["name"] if existing else final_name,
        "entry_type": entry_type,
        "description": description,
    }
    saved = await persist_bible(client, project_id=project_id, user_id=user_id, entries=[to_save])
    # Read the row back, so the reply names the entry as it was actually stored (persist_bible may
    # have folded a first-name-only entry into this full name).
    after = [r for r in await _live_entries(client, project_id) if r.get("entry_type") == entry_type]
    row = next((r for r in after if r.get("name") == to_save["name"]), None) or next(
        (r for r in after if _same_name(str(r.get("name") or ""), name)), None
    )
    verb = "Updated" if existing else "Added"
    return {
        "entry": row or {**to_save, "project_id": project_id},
        "deduped": existing is not None,
        "saved": bool(saved),
        "project_id": project_id,
        "message": (
            f"{verb} {(row or to_save)['name']} ({entry_type}) in the story bible."
            if saved
            else f"I couldn't save {name} to the story bible."
        ),
    }


def _find_live(live: list[dict], name: str, want_type: str | None) -> list[dict]:
    """The live entries ``name`` refers to: by name (alias-aware), then — for characters — through
    ``resolve_character_variant``, so "update Osei" finds "Osei Asante"."""
    from writer_engine.persist_helpers import resolve_character_variant

    pool = [r for r in live if want_type is None or r.get("entry_type") == want_type]
    matches = [r for r in pool if _same_name(str(r.get("name") or ""), name)]
    if matches:
        return matches
    chars = [r for r in pool if r.get("entry_type") == "character"]
    target = resolve_character_variant(name, [str(r["name"]) for r in chars if r.get("name")])
    return [r for r in chars if r.get("name") == target] if target else []


async def _op_update(payload: dict) -> dict:
    """Change an EXISTING live entry: its description (replace, or ``mode=append``), name or type.

    The target is found among LIVE rows only. A name that matches nothing live but matches a
    soft-deleted row is reported as in the trash and left alone — an update must not quietly edit or
    resurrect an entry the author deleted (restoring is the Story Bible tab's job). A rename (or a
    retype) onto a name another live entry of that type already has is refused: that would create
    the exact duplicate persist_bible exists to prevent.
    """
    client = await _supabase_or_none()
    entry = _entry_from(payload)
    if client is None:
        return {"entry": entry, "saved": False, "reason": "supabase not configured"}
    from writer_engine.persist_helpers import _is_junk_bible_name, normalize_entry_type

    user_id = str(entry.get("user_id") or payload.get("user_id") or "")
    name = str(entry.get("name") or "")
    if not user_id or not name:
        return {"saved": False, "reason": "name", "message": "Which story bible entry should I update?"}
    project_id, error = await _resolve_project(client, payload, entry)
    if not project_id:
        return {"saved": False, "reason": "project", "message": error}

    raw_type = entry.get("entry_type")
    want_type = normalize_entry_type(raw_type) if raw_type else None
    if raw_type and want_type is None:
        return _bad_type(raw_type)
    live = await _live_entries(client, project_id)
    matches = _find_live(live, name, want_type)
    if not matches:
        named = await _rows(
            await client.table("story_bible_v2")
            .select("id,name,entry_type,deleted_at")
            .eq("project_id", project_id)
            .eq("name", name)
            .limit(5)
            .execute()
        )
        if any(r.get("deleted_at") for r in named):
            return {
                "saved": False,
                "reason": "deleted",
                "project_id": project_id,
                "message": f"{name} is in the story bible's trash. Restore it in the Story Bible tab first.",
            }
        return {
            "saved": False,
            "reason": "not_found",
            "project_id": project_id,
            "message": f"There's no story bible entry named {name}. Say 'add {name} to the story bible' to create it.",
        }
    if len(matches) > 1:
        types = sorted({str(r.get("entry_type")) for r in matches})
        return {
            "saved": False,
            "reason": "ambiguous",
            "project_id": project_id,
            "candidates": [{"name": r.get("name"), "entry_type": r.get("entry_type")} for r in matches],
            "message": f"{name} is in the story bible more than once ({', '.join(types)}). Which one should I update?",
        }
    row = matches[0]

    changes: dict[str, str] = {}
    changed: list[str] = []
    description = str(entry.get("description") or "").strip()
    if description:
        current = str(row.get("description") or "").strip()
        if str(payload.get("mode") or "").lower() == "append" and current:
            changes["description"] = f"{current}\n\n{description}"
        else:
            changes["description"] = description
        changed.append("description")

    new_type_raw = payload.get("new_entry_type")
    if new_type_raw:
        new_type = normalize_entry_type(new_type_raw)
        if new_type is None:
            return _bad_type(new_type_raw)
        if new_type != row.get("entry_type"):
            changes["entry_type"] = new_type
            changed.append("type")

    final_type = changes.get("entry_type") or str(row.get("entry_type") or "concept")
    new_name = _clean_name(payload.get("new_name"))
    if new_name and new_name != row.get("name"):
        if _is_junk_bible_name(new_name, final_type):
            return {
                "saved": False,
                "reason": "name",
                "message": f"'{new_name}' reads as a relation or a role, not a name, so I didn't rename it.",
            }
        changes["name"] = new_name
        changed.append("name")
    final_name = changes.get("name") or str(row.get("name") or "")
    if "name" in changes or "entry_type" in changes:
        clash = next(
            (
                r
                for r in live
                if r.get("id") != row.get("id")
                and r.get("entry_type") == final_type
                and str(r.get("name") or "").lower() == final_name.lower()
            ),
            None,
        )
        if clash is not None:
            return {
                "saved": False,
                "reason": "duplicate",
                "project_id": project_id,
                "message": f"There's already a {final_type} named {clash['name']} in the story bible.",
            }

    if not changes:
        return {
            "entry": row,
            "saved": False,
            "reason": "no_change",
            "project_id": project_id,
            "message": f"What should I change about {row['name']}? A new description, name or type.",
        }
    changes["updated_at"] = datetime.now(UTC).isoformat()
    await client.table("story_bible_v2").update(changes).eq("id", row["id"]).execute()
    updated = {**row, **changes}
    return {
        "entry": updated,
        "saved": True,
        "changed": changed,
        "project_id": project_id,
        "message": f"Updated {updated['name']} ({updated.get('entry_type')}) in the story bible: {', '.join(changed)}.",
    }


async def _op_list(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"entries": []}
    # G3: chat/voice supply a project TITLE ('get the story bible for X'), not an id — resolve it.
    project_id = payload.get("project_id")
    if not project_id and payload.get("project_title"):
        from writer_engine.persist_helpers import resolve_project_id

        project_id, _row = await resolve_project_id(
            client, user_id=payload.get("user_id"), title=str(payload["project_title"])
        )
        if not project_id:
            return {
                "entries": [],
                "found": False,
                "message": f"No project matching '{payload['project_title']}' found.",
            }
    resp = await (
        client.table("story_bible_v2")
        .select("*")
        .eq("project_id", project_id)
        .is_("deleted_at", None)  # trashed entries are not part of the bible
        .execute()
    )
    rows = getattr(resp, "data", None) or []
    # "show me #3" after a bible list (hub.memory) asks for one entry by name.
    if payload.get("name"):
        rows = [r for r in rows if _same_name(str(r.get("name") or ""), str(payload["name"]))]
    return {"entries": rows, "count": len(rows), "found": bool(rows), "project_id": project_id}


OPS = {"add": _op_add, "update": _op_update, "list": _op_list}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "list")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": await OPS[op](inp.payload)},
    )


app = build_step_app(STEP_NAME, handler)
