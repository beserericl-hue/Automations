#!/usr/bin/env python3
"""CR-006 one-time backfill — link existing research_reports_v2 rows to projects.

research_reports_v2 has no project_id; the engine recorded the project in a "[project <uuid>] ..."
topic prefix. This populates research_report_projects_v2 (migration 026) from that prefix so the UI
research tab can filter by project. Reports with no parseable project stay unlinked (they show in a
"general / unassigned" bucket, not under a wrong project).

Run AFTER migration 026 is applied to the target DB.
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: DEFAULT_PROJECT_ID + DEFAULT_TOPIC_MATCH to
link a known unprefixed report (e.g. "Piscataway Burial Practices" -> the Burial Mound project).
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
DEFAULT_PROJECT_ID = os.environ.get("DEFAULT_PROJECT_ID", "")
DEFAULT_TOPIC_MATCH = os.environ.get("DEFAULT_TOPIC_MATCH", "")  # case-insensitive substring

H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "content-type": "application/json"}
_PROJ_RE = re.compile(r"\[project\s+([0-9a-f-]{36})\]", re.I)


def _req(path: str, *, method: str = "GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, method=method, headers=H)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> int:
    _, reports = _req("research_reports_v2?select=id,user_id,topic")
    if not isinstance(reports, list):
        print("could not read research_reports_v2:", reports, file=sys.stderr)
        return 2
    _, existing = _req("research_report_projects_v2?select=report_id")
    linked = {r["report_id"] for r in existing} if isinstance(existing, list) else set()

    # valid project ids (so we never link to a deleted/wrong project)
    _, projects = _req("writing_projects_v2?select=id")
    valid = {p["id"] for p in projects} if isinstance(projects, list) else set()

    made, skipped, unresolved = 0, 0, []
    for rep in reports:
        rid = rep["id"]
        if rid in linked:
            skipped += 1
            continue
        m = _PROJ_RE.search(rep.get("topic") or "")
        pid = m.group(1) if m else ""
        if not pid and DEFAULT_PROJECT_ID and DEFAULT_TOPIC_MATCH:
            if DEFAULT_TOPIC_MATCH.lower() in (rep.get("topic") or "").lower():
                pid = DEFAULT_PROJECT_ID
        if not pid or pid not in valid:
            unresolved.append(rep.get("topic"))
            continue
        code, resp = _req("research_report_projects_v2", method="POST",
                          body={"report_id": rid, "project_id": pid, "user_id": rep["user_id"]})
        if code in (200, 201):
            made += 1
            print(f"  linked {rid[:8]} -> {pid[:8]}  ({(rep.get('topic') or '')[:60]})")
        else:
            print(f"  FAILED {rid[:8]}: {code} {resp}", file=sys.stderr)

    print(f"\nlinked={made} already={skipped} unresolved={len(unresolved)}")
    for t in unresolved:
        print(f"  UNRESOLVED (no project): {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
