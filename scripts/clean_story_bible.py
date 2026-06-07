#!/usr/bin/env python3
"""CR-009 parity — dedupe a project's story_bible_v2 to a canonical cast.

The per-chapter bible extraction accreted a new row per name variant ("Marcus" / "Marcus Fenn" /
"Marcus Redcloud"; possessives like "Kimi's boyfriend"; "The ..." fragments), so a project's bible
grew to ~1000 self-contradictory rows. The engine's junk filter (persist_helpers) stops NEW pollution;
this one-time pass cleans the EXISTING rows: drop junk names, and keep one row per (entry_type,
canonical name) — the one with the longest description (then latest updated_at). Deletes the rest.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Args: PROJECT_ID (env) and optional --dry-run.
"""

from __future__ import annotations

import os
import re
import sys
import json
import urllib.request

URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PID = os.environ.get("PROJECT_ID", "62cc734f-c861-4210-bc12-e9ea002fcf66")
DRY = "--dry-run" in sys.argv
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "content-type": "application/json"}


def req(path, method="GET", body=None):
    r = urllib.request.Request(f"{URL}/rest/v1/{path}", data=json.dumps(body).encode() if body else None,
                               method=method, headers=H)
    with urllib.request.urlopen(r, timeout=60) as f:
        return json.loads(f.read() or "[]")


def is_junk(name: str, entry_type: str) -> bool:
    n = (name or "").strip()
    if len(n) < 2:
        return True
    low = n.lower()
    if "'s " in low or low.endswith("'s") or "’s" in low:
        return True
    if entry_type == "character":
        if re.match(r"^(the|a|an)\s", low):
            return True
        if n == low and not re.search(r"[A-Z]", n):
            return True
    return False


def canon(name: str) -> str:
    return re.sub(r"['’]s\b.*$", "", re.sub(r"^the\s+", "", (name or "").strip().lower())).strip()


def fetch_all(select: str) -> list[dict]:
    """PostgREST caps reads at 1000; page through with offset until exhausted."""
    out, offset = [], 0
    while True:
        page = req(f"story_bible_v2?select={select}&project_id=eq.{PID}"
                   f"&order=id&limit=1000&offset={offset}")
        if not page:
            break
        out.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    return out


def main() -> int:
    rows = fetch_all("id,entry_type,name,description,updated_at")
    print(f"project {PID[:8]}: {len(rows)} bible rows (paginated)")
    keep: dict[tuple, dict] = {}
    junk_ids, dup_ids = [], []
    for r in rows:
        if is_junk(r.get("name", ""), r.get("entry_type", "")):
            junk_ids.append(r["id"])
            continue
        key = (r["entry_type"], canon(r["name"]))
        cur = keep.get(key)
        better = (cur is None
                  or len(r.get("description") or "") > len(cur.get("description") or "")
                  or (r.get("updated_at") or "") > (cur.get("updated_at") or ""))
        if better:
            if cur:
                dup_ids.append(cur["id"])
            keep[key] = r
        else:
            dup_ids.append(r["id"])
    to_delete = junk_ids + dup_ids
    from collections import Counter
    kept_types = Counter(k[0] for k in keep)
    print(f"keep {len(keep)} canonical ({dict(kept_types)}); delete {len(junk_ids)} junk + {len(dup_ids)} dups = {len(to_delete)}")
    if DRY:
        print("(dry-run — nothing deleted)")
        return 0
    deleted = 0
    for i in range(0, len(to_delete), 50):  # delete in batches via id=in.(...)
        batch = to_delete[i:i + 50]
        req(f"story_bible_v2?id=in.({','.join(batch)})", "DELETE")
        deleted += len(batch)
    print(f"deleted {deleted}; remaining: {len(fetch_all('id'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
