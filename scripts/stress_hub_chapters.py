#!/usr/bin/env python3
"""CR-004/005 stress test — drive chapter writes through the engine hub API entry (same as Eve).

Everything goes through POST /internal/hub with a natural-language message; the Gemini router picks
chapter.write, the load-bearing job is queued (arq), and we poll for completion. For every finished
chapter we pull the artifacts from the DB (the source of truth the UI reads) and mirror them into the
Obsidian vault so they can be verified outside the UI:

    knowledgebase/Writers Workbench Wiki/Workbench-Test-Output-7/
        README.md                  run config + per-chapter table + aggregate
        chapters/chapter-N.md      prose + telemetry header (drift/QA/research/bible-loaded)
        research/chapter-N.md      the write-time research report
        story-bible.md             current bible snapshot (characters + research entries)

Failure detection is triangulated: arq job status (hard failures) + DB artifacts (persistence) +
telemetry row (drift/QA/research-used/bible-loaded). Job success is necessary, NOT sufficient.

Env required: HUB_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Usage:
    python3 scripts/stress_hub_chapters.py --gate 11           # single chapter
    python3 scripts/stress_hub_chapters.py --range 11 95 --concurrency 10
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

GATEWAY = os.environ.get("GATEWAY", "https://writer-engine-gateway-develop.up.railway.app")
SECRET = os.environ.get("HUB_SECRET", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

PROJECT_ID = os.environ.get("PROJECT_ID", "62cc734f-c861-4210-bc12-e9ea002fcf66")
PROJECT_TITLE = os.environ.get("PROJECT_TITLE", "The Burial Mound")
USER_ID = os.environ.get("USER_ID", "+14105914612")  # eric@agileadtesting.com

REPO = Path(__file__).resolve().parent.parent
VAULT = REPO / "knowledgebase" / "Writers Workbench Wiki" / "Workbench-Test-Output-7"

POLL_INTERVAL_S = 20
JOB_TIMEOUT_S = 6300  # poll ceiling per chapter — must exceed the engine job_timeout (5400s)


def _req(url: str, *, method: str = "GET", headers: dict | None = None, body: dict | None = None,
         timeout: float = 60.0) -> tuple[int, dict | list | str]:
    data = json.dumps(body).encode() if body is not None else None
    # PostgREST filter values (e.g. ilike.*Chapter 11 research*) contain spaces; urllib rejects raw
    # control chars in the URL. Encode spaces (and other unsafe chars) without touching the query
    # operators PostgREST needs (= & , . * ( ) / ? : %).
    url = urllib.parse.quote(url, safe="=&,.*()/?:%+@")
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def _hub(message: str, context: dict) -> dict:
    code, body = _req(
        f"{GATEWAY}/internal/hub", method="POST",
        headers={"content-type": "application/json", "x-service-secret": SECRET},
        body={"message": message, "user_id": USER_ID, "context": context},
    )
    if code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"hub POST failed: {code} {body}")
    return body


def _job(job_id: str) -> dict:
    code, body = _req(
        f"{GATEWAY}/internal/write/jobs/{job_id}",
        headers={"x-service-secret": SECRET},
    )
    if code != 200 or not isinstance(body, dict):
        return {"status": "poll_error", "code": code, "body": body}
    return body


def _sb(path: str) -> list:
    code, body = _req(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
    )
    return body if isinstance(body, list) else []


# ----------------------------------------------------------------- one chapter

def run_chapter(n: int, message: str | None = None) -> dict:
    """Submit chapter n through the hub, poll to completion, return a result record.

    Default message is a write; pass a 'fix …' message to drive the repair op instead (same entry,
    the Gemini router picks chapter.repair)."""
    rec: dict = {"chapter": n, "started": time.time()}
    try:
        resp = _hub(message or f"write chapter {n} of {PROJECT_TITLE}",
                    {"project_id": PROJECT_ID, "project_title": PROJECT_TITLE})
    except Exception as exc:
        rec.update(status="submit_failed", error=str(exc)[:300])
        return rec
    rec["routed"] = {"kind": resp.get("kind"), "tool": resp.get("tool"), "op": resp.get("op")}
    if resp.get("kind") != "queued" or not resp.get("job_id"):
        rec.update(status="not_queued", hub_response=resp)
        return rec
    job_id = resp["job_id"]
    rec["job_id"] = job_id

    deadline = time.time() + JOB_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        j = _job(job_id)
        st = j.get("status")
        if st in ("complete", "error", "not_found", "poll_error"):
            rec["job_status"] = st
            if st != "complete":
                rec.update(status="job_failed", detail=str(j.get("error") or j)[:400])
                rec["duration_s"] = round(time.time() - rec["started"], 1)
                return rec
            break
    else:
        rec.update(status="timeout")
        rec["duration_s"] = round(time.time() - rec["started"], 1)
        return rec

    rec["duration_s"] = round(time.time() - rec["started"], 1)
    rec.update(_verify_db(n))
    rec["status"] = "ok" if rec.get("chapter_row") and rec.get("telemetry_row") else "incomplete_persist"
    return rec


def run_repair(n: int) -> dict:
    """Drive the repair op through the hub ('fix …' routes to chapter.repair)."""
    return run_chapter(n, message=f"fix the drift in chapter {n} of {PROJECT_TITLE}")


def drifted_chapters(lo: int = 11, hi: int = 95) -> list[int]:
    """Chapters whose LATEST telemetry row says aligned is false (the genuinely-flagged ones)."""
    rows = _sb(f"chapter_qa_v2?select=chapter_number,aligned,created_at&project_id=eq.{PROJECT_ID}"
               f"&chapter_number=gte.{lo}&chapter_number=lte.{hi}&order=created_at.desc")
    latest: dict[int, bool] = {}
    for r in rows:  # rows are newest-first; first seen per chapter is the latest
        ch = r["chapter_number"]
        if ch not in latest:
            latest[ch] = r.get("aligned")
    return sorted(ch for ch, aligned in latest.items() if aligned is False)


def _verify_db(n: int) -> dict:
    """Pull the artifacts the UI reads — the source of truth for 'did it really land'."""
    out: dict = {}
    chap = _sb(f"published_content_v2?select=title,content_text,status,metadata&project_id=eq.{PROJECT_ID}"
               f"&content_type=eq.chapter&chapter_number=eq.{n}")
    out["chapter_row"] = bool(chap)
    if chap:
        c = chap[0]
        out["title"] = c.get("title")
        out["content_text"] = c.get("content_text") or ""
        out["word_count"] = len((c.get("content_text") or "").split())
    tele = _sb(f"chapter_qa_v2?select=*&project_id=eq.{PROJECT_ID}&chapter_number=eq.{n}"
               f"&order=created_at.desc&limit=1")
    out["telemetry_row"] = bool(tele)
    if tele:
        t = tele[0]
        out["aligned"] = t.get("aligned")
        out["drift_report"] = t.get("drift_report")
        out["craft_qa"] = t.get("craft_qa")
        out["research_used"] = t.get("research_used")
        out["bible_loaded"] = t.get("bible_entries_loaded")
    res = _sb(f"research_reports_v2?select=topic,content&topic=ilike.*Chapter {n} research*&limit=1")
    out["research_row"] = bool(res)
    if res:
        out["research_content"] = res[0].get("content") or ""
    return out


# ----------------------------------------------------------------- vault mirror

def mirror_to_vault(rec: dict) -> None:
    n = rec["chapter"]
    (VAULT / "chapters").mkdir(parents=True, exist_ok=True)
    (VAULT / "research").mkdir(parents=True, exist_ok=True)
    qa = rec.get("craft_qa") or {}
    qa_avg = round(sum(qa.values()) / len(qa), 3) if qa else None
    header = (
        f"# Chapter {n}: {rec.get('title') or '(untitled)'}\n\n"
        f"> **drift aligned:** {rec.get('aligned')}  |  **QA avg:** {qa_avg}  |  "
        f"**words:** {rec.get('word_count')}  |  **job:** {rec.get('job_status')}  "
        f"({rec.get('duration_s')}s)\n>\n"
        f"> **research topics used:** {', '.join(rec.get('research_used') or []) or '(none)'}\n>\n"
        f"> **bible entries loaded into prompt:** {', '.join(rec.get('bible_loaded') or []) or '(none)'}\n>\n"
        f"> **drift report:** `{json.dumps(rec.get('drift_report'))}`\n\n---\n\n"
    )
    (VAULT / "chapters" / f"chapter-{n:02d}.md").write_text(header + (rec.get("content_text") or ""))
    if rec.get("research_content"):
        (VAULT / "research" / f"chapter-{n:02d}.md").write_text(
            f"# Chapter {n} — write-time research\n\n{rec['research_content']}")


def snapshot_bible() -> None:
    rows = _sb(f"story_bible_v2?select=entry_type,name,description,last_chapter_seen"
               f"&project_id=eq.{PROJECT_ID}&order=entry_type,name")
    lines = ["# Story Bible snapshot\n"]
    cur = None
    for r in rows:
        if r["entry_type"] != cur:
            cur = r["entry_type"]
            lines.append(f"\n## {cur}\n")
        lines.append(f"- **{r['name']}** (last seen ch {r.get('last_chapter_seen')}): "
                     f"{(r.get('description') or '')[:300]}")
    VAULT.mkdir(parents=True, exist_ok=True)
    (VAULT / "story-bible.md").write_text("\n".join(lines))


def write_readme(results: list[dict], cfg: dict) -> None:
    VAULT.mkdir(parents=True, exist_ok=True)
    ok = [r for r in results if r.get("status") == "ok"]
    drift = [r for r in ok if r.get("aligned") is False]
    fails = [r for r in results if r.get("status") != "ok"]
    durs = [r["duration_s"] for r in results if r.get("duration_s")]
    lines = [
        "# Workbench-Test-Output-7 — engine hub stress test (Path B, CR-004/005)\n",
        f"- entry: POST /internal/hub (same as Eve), Gemini router",
        f"- project: {PROJECT_TITLE} ({PROJECT_ID}), user_id {USER_ID}",
        f"- range: {cfg.get('range')}, concurrency: {cfg.get('concurrency')}",
        f"- chapters ok: {len(ok)}/{len(results)}  |  drifted: {len(drift)}  |  failed: {len(fails)}",
        f"- wall-clock per chapter: min {min(durs) if durs else '-'}s / "
        f"max {max(durs) if durs else '-'}s / avg {round(sum(durs)/len(durs)) if durs else '-'}s\n",
        "## Per-chapter\n",
        "| ch | status | job | dur(s) | words | aligned | QA avg | research | bible loaded |",
        "|----|--------|-----|--------|-------|---------|--------|----------|--------------|",
    ]
    for r in sorted(results, key=lambda x: x["chapter"]):
        qa = r.get("craft_qa") or {}
        qa_avg = round(sum(qa.values()) / len(qa), 2) if qa else "-"
        lines.append(
            f"| {r['chapter']} | {r.get('status')} | {r.get('job_status','-')} | {r.get('duration_s','-')} "
            f"| {r.get('word_count','-')} | {r.get('aligned','-')} | {qa_avg} "
            f"| {len(r.get('research_used') or [])} | {len(r.get('bible_loaded') or [])} |"
        )
    if fails:
        lines.append("\n## Failures\n")
        for r in fails:
            lines.append(f"- ch {r['chapter']}: {r.get('status')} — {r.get('error') or r.get('detail') or ''}")
    (VAULT / "README.md").write_text("\n".join(lines))


# ----------------------------------------------------------------- drivers

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gate", type=int, help="run a single chapter and report")
    ap.add_argument("--mirror", type=int, help="verify + vault-mirror an already-written chapter (no gen)")
    ap.add_argument("--range", nargs=2, type=int, metavar=("START", "END"))
    ap.add_argument("--repair-drifted", action="store_true",
                    help="re-scan + fix every chapter whose latest telemetry is aligned=false (via hub)")
    ap.add_argument("--repair", type=str, help="repair a specific comma-separated chapter list, e.g. 12,30,50")
    ap.add_argument("--concurrency", type=int, default=10)
    args = ap.parse_args()

    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2
    if args.mirror is None and not SECRET:
        print("ERROR: set HUB_SECRET (hub calls require it)", file=sys.stderr)
        return 2

    if args.mirror is not None:
        rec = {"chapter": args.mirror, **_verify_db(args.mirror)}
        if rec.get("chapter_row"):
            mirror_to_vault(rec)
            snapshot_bible()
            print(f"mirrored ch{args.mirror}: words={rec.get('word_count')} aligned={rec.get('aligned')} "
                  f"research={len(rec.get('research_used') or [])} bible_loaded={len(rec.get('bible_loaded') or [])}")
        else:
            print(f"ch{args.mirror}: no chapter row in DB")
        return 0

    if args.gate is not None:
        print(f"[gate] writing chapter {args.gate} through the hub ...", flush=True)
        rec = run_chapter(args.gate)
        if rec.get("chapter_row"):
            mirror_to_vault(rec)
            snapshot_bible()
        print(json.dumps({k: v for k, v in rec.items() if k != "content_text"}, indent=2, default=str))
        return 0 if rec.get("status") == "ok" else 1

    if getattr(args, "repair", None):
        chapters = [int(x) for x in args.repair.split(",") if x.strip()]
        print(f"[repair-list] {chapters}", flush=True)
        results = []
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = {ex.submit(run_repair, n): n for n in chapters}
            for fut in as_completed(futs):
                rec = fut.result()
                results.append(rec)
                if rec.get("chapter_row"):
                    mirror_to_vault(rec)
                print(f"  ch {rec['chapter']}: {rec.get('status')} job={rec.get('job_status','-')} "
                      f"{rec.get('duration_s','-')}s aligned={rec.get('aligned','-')} "
                      f"words={rec.get('word_count','-')}", flush=True)
        still = sorted(r["chapter"] for r in results if r.get("aligned") is False)
        print(f"\n[repair-list done] still drifted: {len(still)} {still}")
        return 0

    if getattr(args, "repair_drifted", False):
        chapters = drifted_chapters()
        cfg = {"range": f"repair-drifted ({len(chapters)})", "concurrency": args.concurrency}
        print(f"[repair] {len(chapters)} drifted chapters: {chapters}", flush=True)
        results: list[dict] = []
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = {ex.submit(run_repair, n): n for n in chapters}
            for fut in as_completed(futs):
                rec = fut.result()
                results.append(rec)
                if rec.get("chapter_row"):
                    mirror_to_vault(rec)
                print(f"  ch {rec['chapter']}: {rec.get('status')} job={rec.get('job_status','-')} "
                      f"{rec.get('duration_s','-')}s aligned={rec.get('aligned','-')} "
                      f"words={rec.get('word_count','-')}", flush=True)
        snapshot_bible()
        still = [r["chapter"] for r in results if r.get("aligned") is False]
        print(f"\n[repair done] {len(results)} repaired; still drifted: {len(still)} {sorted(still)}")
        return 0

    if args.range:
        start, end = args.range
        chapters = list(range(start, end + 1))
        cfg = {"range": f"{start}-{end}", "concurrency": args.concurrency}
        print(f"[range] {len(chapters)} chapters {start}-{end}, concurrency {args.concurrency}", flush=True)
        results: list[dict] = []
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = {ex.submit(run_chapter, n): n for n in chapters}
            for fut in as_completed(futs):
                rec = fut.result()
                results.append(rec)
                if rec.get("chapter_row"):
                    mirror_to_vault(rec)
                print(f"  ch {rec['chapter']}: {rec.get('status')} "
                      f"job={rec.get('job_status','-')} {rec.get('duration_s','-')}s "
                      f"aligned={rec.get('aligned','-')} words={rec.get('word_count','-')}", flush=True)
        snapshot_bible()
        write_readme(results, cfg)
        ok = sum(1 for r in results if r.get("status") == "ok")
        print(f"\n[done] {ok}/{len(results)} ok; vault: {VAULT}")
        return 0 if ok == len(results) else 1

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
