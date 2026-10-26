#!/usr/bin/env python
"""CR-001 W8: the top-down run. One new project, every artifact generated AND persisted by the engine.

Drives the deployed gateway the way the Workbench does, then reads the database back and fails
unless every stage left its rows:

  1. brainstorm.create-project       -> writing_projects_v2 (a NEW project)
  2. brainstorm.story  (persist)      -> writing_projects_v2.outline (+ outline_versions_v2 when one existed)
  3. chapter.plan      (persist) x N  -> outline.chapters[n].chapter_outline.sub_chapters (+ snapshot)
  4. research.run      (persist)      -> research_reports_v2 + research_report_projects_v2 link
  5. chapter.write     (persist) x N  -> published_content_v2 chapter + content_versions_v2 + story_bible_v2

DEV only: it refuses a Supabase URL that is not the DEV project. Credentials come from the
environment (read them from Railway, never from a file in the repo):

    ENGINE_GATEWAY_URL=https://writer-engine-gateway-develop.up.railway.app \\
    SERVICE_SHARED_SECRET=... SUPABASE_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co \\
    SUPABASE_SERVICE_ROLE_KEY=... \\
    uv run python scripts/cr001_topdown.py --user-id +14105914612 --chapters 2

`--chapters 84` is the full Burial Mound run; the default of 2 proves every stage at a few dollars.
Prints a JSON report and exits non-zero if any check fails.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from typing import Any

DEV_SUPABASE = "gvbvwcnmjkdpclcisqrr"
PREMISE = (
    "The Burial Mound. A Piscataway historic preservation officer, a museum physical anthropologist and "
    "a Jesuit archivist work to repatriate ossuary remains excavated from a Potomac bluff between 1935 "
    "and 1951, while the tribe's recognition petition hangs on what the record can prove. The story "
    "moves between the present-day repatriation and the people who built, lived and buried on the bluff."
)


def _http(method: str, url: str, *, headers: dict[str, str], body: Any = None, timeout: float = 120) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"null")


class Engine:
    def __init__(self, gateway: str, secret: str) -> None:
        self.gateway = gateway.rstrip("/")
        self.headers = {"x-service-secret": secret}

    def call(self, tool: str, body: dict[str, Any], *, wait_s: float = 1800) -> dict[str, Any]:
        """Run one write tool. Async jobs are polled to completion; returns the step result."""
        out = _http("POST", f"{self.gateway}/internal/write/{tool}", headers=self.headers, body=body, timeout=600)
        job_id = out.get("job_id") if isinstance(out, dict) else None
        if job_id:
            deadline = time.time() + wait_s
            while time.time() < deadline:
                time.sleep(10)
                job = _http("GET", f"{self.gateway}/internal/write/jobs/{job_id}", headers=self.headers)
                if job.get("status") in {"complete", "error", "failed", "not_found"}:
                    out = job.get("result") or job
                    break
            else:
                raise TimeoutError(f"{tool} job {job_id} did not finish in {wait_s:.0f}s")
        payload = (out or {}).get("payload") if isinstance(out, dict) else None
        result = (payload or {}).get("result") if isinstance(payload, dict) else None
        if (out or {}).get("status") not in (None, "ok") and not result:
            raise RuntimeError(f"{tool}.{body.get('op')} failed: {json.dumps(out)[:400]}")
        return result or {}


class Db:
    def __init__(self, url: str, key: str) -> None:
        self.base = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": key, "authorization": f"Bearer {key}", "user-agent": "cr001-topdown"}

    def get(self, table: str, query: str) -> list[dict[str, Any]]:
        return _http("GET", f"{self.base}/{table}?{query}", headers=self.headers) or []


def run(args: argparse.Namespace) -> dict[str, Any]:
    eng = Engine(os.environ["ENGINE_GATEWAY_URL"], os.environ["SERVICE_SHARED_SECRET"])
    db = Db(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    n = args.chapters
    title = f"{args.title} ({time.strftime('%Y-%m-%d %H:%M')})"
    report: dict[str, Any] = {"title": title, "chapters": n, "stages": {}, "checks": {}}
    base = {"user_id": args.user_id, "persist": True, "genre_slug": args.genre}

    t0 = time.time()
    created = eng.call("brainstorm", {**base, "op": "create-project", "title": title, "async": False})
    project_id = str(created.get("project_id") or (created.get("project") or {}).get("id") or "")
    if not project_id:
        raise RuntimeError(f"create-project returned no project id: {json.dumps(created)[:300]}")
    report["project_id"] = project_id
    report["stages"]["create"] = round(time.time() - t0)

    t0 = time.time()
    eng.call("brainstorm", {**base, "op": "story", "project_id": project_id, "title": title,
                            "premise": PREMISE, "target_chapter_count": n, "async": True})
    report["stages"]["outline"] = round(time.time() - t0)

    t0 = time.time()
    for ch in range(1, n + 1):
        eng.call("chapter", {**base, "op": "plan", "project_id": project_id, "project_title": title,
                             "chapter_number": ch, "async": True})
    report["stages"]["plans"] = round(time.time() - t0)

    t0 = time.time()
    eng.call("research", {**base, "op": "run", "project_id": project_id,
                          "topic": f"{title}: Piscataway ossuary burial practice on the Potomac", "async": True})
    report["stages"]["research"] = round(time.time() - t0)

    t0 = time.time()
    for ch in range(1, n + 1):
        eng.call("chapter", {**base, "op": "write", "project_id": project_id, "project_title": title,
                             "chapter_number": ch, "async": True})
    report["stages"]["chapters"] = round(time.time() - t0)

    # --- read everything back ----------------------------------------------------------------
    proj = db.get("writing_projects_v2", f"id=eq.{project_id}&select=outline")
    chapters = ((proj[0] if proj else {}).get("outline") or {}).get("chapters") or []
    planned = [c for c in chapters if ((c.get("chapter_outline") or {}).get("sub_chapters"))]
    written = db.get("published_content_v2",
                     f"project_id=eq.{project_id}&content_type=eq.chapter&deleted_at=is.null&select=id,chapter_number,content_text")
    words = {int(r["chapter_number"]): len(str(r.get("content_text") or "").split()) for r in written}
    ids = ",".join(str(r["id"]) for r in written) or "00000000-0000-0000-0000-000000000000"
    versions = db.get("content_versions_v2", f"content_id=in.({ids})&select=content_id")
    bible = db.get("story_bible_v2", f"project_id=eq.{project_id}&deleted_at=is.null&select=entry_type")
    links = db.get("research_report_projects_v2", f"project_id=eq.{project_id}&select=report_id")
    snapshots = db.get("outline_versions_v2", f"project_id=eq.{project_id}&select=id")

    checks = report["checks"]
    checks["outline_has_chapters"] = len(chapters) >= n
    checks["every_chapter_planned"] = len(planned) >= n
    checks["outline_snapshots_before_plans"] = len(snapshots) >= n
    checks["every_chapter_written_200w"] = all(words.get(c, 0) >= 200 for c in range(1, n + 1))
    checks["every_chapter_versioned"] = len({v["content_id"] for v in versions}) >= n
    checks["bible_has_characters"] = sum(1 for b in bible if b.get("entry_type") == "character") >= 1
    checks["research_linked_to_project"] = len(links) >= 1
    report["counts"] = {
        "outline_chapters": len(chapters), "planned": len(planned), "outline_snapshots": len(snapshots),
        "words": words, "versions": len(versions), "bible": len(bible), "research_links": len(links),
    }
    report["passed"] = all(checks.values())
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--user-id", required=True)
    ap.add_argument("--chapters", type=int, default=2)
    ap.add_argument("--title", default="The Burial Mound (CR-001 top-down)")
    ap.add_argument("--genre", default="ancient-history")
    args = ap.parse_args()
    if DEV_SUPABASE not in os.environ.get("SUPABASE_URL", ""):
        print("REFUSING: SUPABASE_URL is not the DEV project.", file=sys.stderr)
        return 2
    report = run(args)
    print(json.dumps(report, indent=1))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
