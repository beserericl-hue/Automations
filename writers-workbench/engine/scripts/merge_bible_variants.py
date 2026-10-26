#!/usr/bin/env python
"""CR-002: merge name-variant character entries in existing story bibles (DEV).

New chapters stop creating variants (`persist_helpers.resolve_character_variant` runs in
`persist_bible`). This cleans up the bibles written before that, with the same rule:

* a bracketed alias is the same person: "Adaeze Okonkwo (A. Okonkwo)" -> "Adaeze Okonkwo";
* a first name alone, when the bible holds exactly one full name starting with it: "Osei" ->
  "Osei Asante".

Anything ambiguous ("Delia" next to three Delias, "Taya (child)" next to "Taya (the first)") is
left alone and listed. A merge soft-deletes the variant and appends its description to the entry it
names when that text is not already there. Every change goes into an undo file first.

    SUPABASE_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \\
    uv run python scripts/merge_bible_variants.py [--project <uuid>] [--apply] [--undo-file path]

Dry run by default.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Any

from writer_engine.persist_helpers import character_keys, resolve_character_variant

DEV_SUPABASE = "gvbvwcnmjkdpclcisqrr"
MAX_DESCRIPTION = 2000


class Rest:
    def __init__(self, url: str, key: str) -> None:
        self.base = url.rstrip("/") + "/rest/v1"
        self.headers = {
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
            "user-agent": "merge-bible-variants",
        }

    def _req(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}/{path}", data=data, method=method, headers=self.headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None

    def characters(self, project: str | None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        q = "entry_type=eq.character&deleted_at=is.null&select=id,project_id,name,description,created_at&order=created_at.asc"
        if project:
            q += f"&project_id=eq.{project}"
        offset = 0
        while True:
            page = self._req("GET", f"story_bible_v2?{q}&limit=1000&offset={offset}") or []
            out += page
            if len(page) < 1000:
                return out
            offset += 1000

    def patch(self, row_id: str, fields: dict[str, Any]) -> None:
        self._req("PATCH", f"story_bible_v2?id=eq.{urllib.parse.quote(row_id)}", fields)


def plan(rows: list[dict[str, Any]]) -> tuple[list[tuple[dict, dict]], list[str]]:
    """``[(variant_row, canonical_row)]`` and the ambiguous names left alone."""
    by_project: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_project[str(r["project_id"])].append(r)
    merges: list[tuple[dict, dict]] = []
    ambiguous: list[str] = []
    for prows in by_project.values():
        names = [str(r["name"]) for r in prows]
        by_name = {str(r["name"]): r for r in prows}
        descriptions = {str(r["name"]): str(r.get("description") or "") for r in prows}
        target: dict[str, str] = {}
        for name in names:
            canonical = resolve_character_variant(name, names, descriptions=descriptions)
            if canonical:
                target[name] = canonical
            elif " " not in character_keys(name)[0]:
                first = character_keys(name)[0]
                if sum(1 for n in names if character_keys(n)[0].startswith(first + " ")) > 1:
                    ambiguous.append(name)
        for name, canonical in target.items():
            seen = {name}
            while canonical in target and canonical not in seen:  # follow a chain to its end
                seen.add(canonical)
                canonical = target[canonical]
            if canonical != name and canonical in by_name:
                merges.append((by_name[name], by_name[canonical]))
    return merges, sorted(set(ambiguous))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument(
        "--undo-file",
        default=os.path.expanduser(
            f"~/.config/writers-workbench/bible-variants-{time.strftime('%Y-%m-%d')}.json"
        ),
    )
    args = ap.parse_args()
    url = os.environ.get("SUPABASE_URL", "")
    if DEV_SUPABASE not in url:
        print("REFUSING: SUPABASE_URL is not the DEV project.", file=sys.stderr)
        return 2
    db = Rest(url, os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    rows = db.characters(args.project)
    merges, ambiguous = plan(rows)
    report = {
        "characters": len(rows),
        "merges": [
            {
                "variant": v["name"],
                "into": c["name"],
                "project_id": v["project_id"],
                "variant_description": str(v.get("description") or "")[:140],
                "into_description": str(c.get("description") or "")[:140],
            }
            for v, c in merges
        ],
        "ambiguous_left_alone": ambiguous,
    }
    if args.apply and merges:
        undo = [
            {"variant": v, "canonical": {"id": c["id"], "description": c.get("description")}}
            for v, c in merges
        ]
        os.makedirs(os.path.dirname(args.undo_file), exist_ok=True)
        with open(args.undo_file, "w") as fh:
            json.dump(undo, fh, indent=1)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for v, c in merges:
            vd, cd = str(v.get("description") or "").strip(), str(c.get("description") or "").strip()
            if vd and vd not in cd:
                c["description"] = (cd + ("\n\n" if cd else "") + vd)[:MAX_DESCRIPTION]
                db.patch(str(c["id"]), {"description": c["description"]})
            db.patch(str(v["id"]), {"deleted_at": now})
        report["applied"] = len(merges)
        report["undo_file"] = args.undo_file
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
