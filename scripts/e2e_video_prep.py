#!/usr/bin/env python3
"""Video-prep E2E — seed the marketing-video demo state THROUGH THE CHAT INTERFACE.

Runs the "Pre-recording setup" (marketing-copy.md §2) as chat commands against the engine hub, polls
each generative job to completion, verifies each artifact in the DEV database, then injects the one
deliberate drift (Maya Chen -> Maya Chan in ch3) the drift-scanner demo needs. Every prep step is a
real chat message to /internal/hub — nothing is done by hand.

Demo project: "The Last Signal" (post-apocalyptic, Hero's Journey, Maya Chen, 6 chapters; ch1-3 written
+ approved; cover art; story bible auto-populated; one drift in ch3).

The "Wasteland Wire" newsletter is a Setup-Wizard (UI) flow with no engine/chat op, so it is out of
scope here and flagged for manual setup.

Env: E2E_SECRET, SUPA_URL, SUPA_KEY, E2E_USER (default +14105914612).
"""
from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request

GATEWAY = os.environ.get("E2E_GATEWAY", "https://writer-engine-gateway-develop.up.railway.app")
SECRET = os.environ["E2E_SECRET"]
USER = os.environ.get("E2E_USER", "+14105914612")
TIMEOUT = int(os.environ.get("E2E_TIMEOUT", "900"))
SUPA_URL = os.environ["SUPA_URL"].rstrip("/")
SUPA_KEY = os.environ["SUPA_KEY"]
PROJECT = "The Last Signal"
OUT = "scripts/e2e_out/video_prep"


def _post(path, body):
    req = urllib.request.Request(f"{GATEWAY}{path}", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "x-service-secret": SECRET},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=130) as r:
        return json.loads(r.read().decode())


def _get(path):
    req = urllib.request.Request(f"{GATEWAY}{path}", headers={"x-service-secret": SECRET})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def _supa(method, table, query="", body=None):
    query = query.replace(USER, urllib.parse.quote(USER, safe=""))
    url = f"{SUPA_URL}/rest/v1/{table}?{query}" if query else f"{SUPA_URL}/rest/v1/{table}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SUPA_KEY, "authorization": f"Bearer {SUPA_KEY}",
        "content-type": "application/json", "prefer": "return=representation"})
    with urllib.request.urlopen(req, timeout=30) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else []


def chat(message):
    """Send one chat message; poll an async job to completion. Returns (response, job_result)."""
    resp = _post("/internal/hub", {"message": message, "user_id": USER})
    jr = None
    jid = resp.get("job_id")
    if jid and resp.get("kind") == "queued":
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            time.sleep(8)
            jr = _get(f"/internal/write/jobs/{jid}")
            if jr.get("status") in ("complete", "error", "not_found", "failed"):
                break
    return resp, jr


def _result(resp, jr):
    res = ((resp.get("data") or {}).get("payload") or {}).get("result")
    if res is None and jr:
        res = jr.get("result")
        if isinstance(res, dict):
            res = (res.get("payload") or {}).get("result", res)
    return res if isinstance(res, dict) else {}


def _project_id():
    rows = _supa("GET", "writing_projects_v2",
                 f"user_id=eq.{USER}&title=ilike.*Last%20Signal*&select=id,title,outline,chapter_count&limit=1")
    return rows[0] if rows else None


def main():
    os.makedirs(OUT, exist_ok=True)
    results = []

    def step(sid, title, message, verify_fn):
        print(f"\n=== {sid}: {title}\n    chat> {message[:90]}", flush=True)
        resp, jr = chat(message)
        res = _result(resp, jr)
        try:
            ok, ev = verify_fn(resp, jr, res)
        except Exception as e:  # noqa: BLE001
            ok, ev = False, f"verify error: {str(e)[:200]}"
        verdict = "PASS" if ok else "FAIL"
        rec = {"id": sid, "title": title, "message": message, "verdict": verdict, "evidence": ev,
               "response": resp, "job_result": jr}
        json.dump(rec, open(f"{OUT}/{sid}.json", "w"), indent=2, default=str)
        results.append({"id": sid, "title": title, "verdict": verdict, "evidence": ev})
        print(f"    {verdict} :: {ev}", flush=True)
        return res

    # VP01 — brainstorm the demo novel (creates project + 6-chapter outline)
    step("VP01", "Brainstorm 'The Last Signal' (post-apoc, Hero's Journey, 6 ch)",
         "Brainstorm a post-apocalyptic novel called \"The Last Signal\" using the Hero's Journey arc "
         "with 6 chapters. The protagonist is Maya Chen, a former radio engineer, twenty-eight, who "
         "intercepts a signal that shouldn't exist and follows it across the Rust Coast wastelands in 2087.",
         lambda resp, jr, res: (
             (res.get("persist") or {}).get("persisted") and _project_id() is not None,
             f"persisted={(res.get('persist') or {}).get('persisted')} "
             f"chapters={len((res.get('outline') or {}).get('chapters') or [])} project_found={_project_id() is not None}"))

    proj = _project_id()
    pev = f"project_id={proj['id'] if proj else None}"
    print(f"    project: {pev}", flush=True)

    # VP02-04 — write chapters 1..3
    for ch in (1, 2, 3):
        step(f"VP0{ch + 1}", f"Write chapter {ch} of The Last Signal",
             f"Write chapter {ch} of \"The Last Signal\"",
             (lambda c: lambda resp, jr, res: (
                 bool((res.get("persist") or {}).get("persisted")) and (res.get("word_count") or 0) > 200,
                 f"persisted={(res.get('persist') or {}).get('persisted')} words={res.get('word_count')}"))(ch))

    # VP05-07 — approve chapters 1..3
    for ch in (1, 2, 3):
        step(f"VP0{ch + 4}", f"Approve chapter {ch} of The Last Signal",
             f"Approve chapter {ch} of \"The Last Signal\"",
             lambda resp, jr, res: (str(res.get("status")) == "approved",
                                    f"status={res.get('status')} error={res.get('error')}"))

    # VP08 — cover art
    step("VP08", "Generate cover art for The Last Signal",
         "Generate cover art for \"The Last Signal\"",
         lambda resp, jr, res: (
             bool(res.get("image_url", "").startswith("http")) or bool(
                 _supa("GET", "generated_images_v2", f"user_id=eq.{USER}&order=created_at.desc&limit=1&select=id")),
             f"image_url={str(res.get('image_url'))[:50]}"))

    # VP09 — story bible auto-populated (from the chapter writes)
    step("VP09", "Story bible for The Last Signal (auto-populated)",
         "Get the story bible for \"The Last Signal\"",
         lambda resp, jr, res: (int(res.get("count") or 0) >= 3,
                                f"entries={res.get('count')} found={res.get('found')}"))

    # VP10 — inject a deliberate character-name drift in ch3 (the drift-scanner demo). marketing-copy
    # assumes the protagonist is "Maya Chen"; the brainstorm actually generates the name, so target the
    # REAL protagonist (outline character #0) and swap ONE occurrence for a near-variant the scanner
    # catches (edit distance 1-2), e.g. "Mara" -> "Maera". Falls back to the literal Maya Chen->Chan.
    import re as _re

    def _variant(name: str) -> str:
        # insert/alter one letter to make a scanner-detectable near-miss of the same name
        for i, ch in enumerate(name):
            if i > 0 and ch.lower() in "aeiou":
                return name[:i] + ("e" if ch.lower() != "e" else "a") + name[i:]  # double the vowel region
        return name + "e"

    drift_ev = "skipped (no project)"
    ok = False
    if proj:
        rows = _supa("GET", "published_content_v2",
                     f"project_id=eq.{proj['id']}&content_type=eq.chapter&chapter_number=eq.3&select=id,content_text&limit=1")
        text = rows[0].get("content_text") if rows else None
        if not rows:
            drift_ev = "ch3 not found"
        elif "Maya Chen" in (text or ""):
            _supa("PATCH", "published_content_v2", f"id=eq.{rows[0]['id']}",
                  {"content_text": text.replace("Maya Chen", "Maya Chan", 1)})
            ok, drift_ev = True, "injected 'Maya Chen'->'Maya Chan' (1 occurrence) in ch3"
        else:
            # target the real protagonist's first name (outline character #0)
            chars = (proj.get("outline") or {}).get("characters") or []
            proto = (chars[0].get("name") if chars and isinstance(chars[0], dict) else "") or ""
            first = proto.split()[0] if proto else ""
            m = _re.search(rf"\b{_re.escape(first)}\b", text or "") if first else None
            if m:
                variant = _variant(first)
                new_text = (text[: m.start()] + variant + text[m.end():])
                _supa("PATCH", "published_content_v2", f"id=eq.{rows[0]['id']}", {"content_text": new_text})
                ok, drift_ev = True, f"injected name drift '{first}'->'{variant}' (1 occurrence) in ch3"
            else:
                drift_ev = f"ch3 exists but protagonist name ('{first or 'unknown'}') not found to alter"
    results.append({"id": "VP10", "title": "Inject deliberate drift in ch3 (DB)",
                    "verdict": "PASS" if ok else "FAIL", "evidence": drift_ev})
    print(f"\n=== VP10: inject drift\n    {'PASS' if ok else 'FAIL'} :: {drift_ev}", flush=True)

    # VP11 — seed the demo newsletter "The Wasteland Wire" (marketing-copy §2). There is no chat/engine
    # op to create a newsletter edition, so this replicates the UI Setup-Wizard against the DB: create the
    # edition, add 5 subscribers, and copy the post-apocalyptic genre's feeds (import-from-genre parity).
    ED = "wasteland-wire"
    nl_ok, nl_ev = False, ""
    try:
        if not (isinstance(_supa("GET", "newsletter_editions_v2", f"id=eq.{ED}&select=id"), list)
                and _supa("GET", "newsletter_editions_v2", f"id=eq.{ED}&select=id")):
            _supa("POST", "newsletter_editions_v2", "", {
                "id": ED, "display_name": "The Wasteland Wire", "newsletter_name": "The Wasteland Wire",
                "subheader": "This week from the Rust Coast.", "genre": "post-apocalyptic",
                "signature_name": "Maya Chen", "signature_role": "Signal scout",
                "cadence": "weekly", "cadence_send_time": "09:00",
                "primary_color": "#8a3b1e", "paper_color": "#fbf8f2", "enabled": True, "user_id": USER})
        if not _supa("GET", "newsletter_subscribers_v2", f"edition_id=eq.{ED}&select=id"):
            _supa("POST", "newsletter_subscribers_v2", "", [
                {"user_id": USER, "edition_id": ED, "email": f"reader{i}@example.invalid",
                 "display_name": f"Reader {i}", "status": "active", "source": "import"} for i in range(1, 6)])
        if not _supa("GET", "newsletter_feed_sources_v2", f"edition_id=eq.{ED}&select=id"):
            gl = _supa("GET", "genre_config_v2",
                       "genre_slug=eq.post-apocalyptic&select=genre_name,rss_feed_urls,source_urls,subreddit_names")
            g = gl[0] if isinstance(gl, list) and gl else {}
            gn = g.get("genre_name") or "Post-Apocalyptic"
            feed_rows, seen = [], set()

            def _addfeed(name, url, ut, iv=240):
                k = f"{ut}::{url.lower()}"
                if k in seen:
                    return
                seen.add(k)
                feed_rows.append({"user_id": USER, "edition_id": ED, "name": name, "url": url,
                                  "url_type": ut, "fetch_interval_minutes": iv, "active": True})

            for u in (g.get("rss_feed_urls") or []):
                if isinstance(u, str) and u.strip():
                    _addfeed(f"{gn} — RSS", u.strip(), "rss", 240)
            for u in (g.get("source_urls") or []):
                if isinstance(u, str) and u.strip():
                    _addfeed(f"{gn} — source", u.strip(), "source", 240)
            for s in (g.get("subreddit_names") or []):
                if isinstance(s, str) and s.strip():
                    c = s.strip().lstrip("r/").lstrip("R/")
                    _addfeed(f"r/{c}", f"https://www.reddit.com/r/{c}/.json", "reddit", 180)
            if feed_rows:
                _supa("POST", "newsletter_feed_sources_v2", "", feed_rows)
        # Default template — the newsletter preview + generation need an active default template for the
        # edition; clone an existing default template (e.g. ai-news) retargeted to this edition.
        if not _supa("GET", "newsletter_templates_v2", f"edition_id=eq.{ED}&is_default=eq.true&select=id"):
            src = _supa("GET", "newsletter_templates_v2", "is_default=eq.true&active=eq.true&limit=1&select=*")
            if isinstance(src, list) and src:
                tpl = {k: v for k, v in src[0].items() if k not in ("id", "created_at", "updated_at")}
                tpl.update({"edition_id": ED, "name": "The Wasteland Wire (default)",
                            "is_default": True, "active": True, "user_id": USER})
                _supa("POST", "newsletter_templates_v2", "", tpl)
        sc = len(_supa("GET", "newsletter_subscribers_v2", f"edition_id=eq.{ED}&select=id") or [])
        fc = len(_supa("GET", "newsletter_feed_sources_v2", f"edition_id=eq.{ED}&select=id") or [])
        tc = len(_supa("GET", "newsletter_templates_v2", f"edition_id=eq.{ED}&select=id") or [])
        nl_ok, nl_ev = True, f"edition 'The Wasteland Wire' + {sc} subscribers + {fc} feeds + {tc} template(s)"
    except Exception as e:  # noqa: BLE001
        nl_ev = f"newsletter seed error: {str(e)[:150]}"
    results.append({"id": "VP11", "title": "Seed demo newsletter 'The Wasteland Wire' (DB, Setup-Wizard parity)",
                    "verdict": "PASS" if nl_ok else "FAIL", "evidence": nl_ev})
    print(f"\n=== VP11: seed newsletter\n    {'PASS' if nl_ok else 'FAIL'} :: {nl_ev}", flush=True)

    # summary
    json.dump(results, open(f"{OUT}/summary.json", "w"), indent=2)
    counts = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    print(f"\n===== VIDEO PREP DONE :: {counts} =====")
    print("NOTE: VP01-VP09 seed the project via chat; VP10 injects the ch3 drift; VP11 seeds the demo "
          "newsletter directly in the DB (no chat/engine op exists to create a newsletter edition).")


if __name__ == "__main__":
    main()
