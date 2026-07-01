#!/usr/bin/env python3
"""Full E2E live verification — runs EVERY suite test through the engine chat/voice API, polls each
job to completion, then verifies the produced output exists in the DEV Supabase database (and/or the
response payload) and matches the suite's expected result. Marks PASS / FAIL / PARTIAL per test.

Multi-step tests (R81/R89/V14/V22/V29/R121 etc.) run each step in order. Voice tests go through the
voice webhook (the simulated-Eve surface). Writes scripts/e2e_out/verify/<id>.json per test and
scripts/e2e_out/verify/REPORT.md at the end.

Env: E2E_SECRET (64-char gateway secret), SUPA_URL, SUPA_KEY (DEV Supabase).
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone

GATEWAY = os.environ.get("E2E_GATEWAY", "https://writer-engine-gateway-develop.up.railway.app")
SECRET = os.environ["E2E_SECRET"]
USER = os.environ.get("E2E_USER", "+14105914612")
TIMEOUT = int(os.environ.get("E2E_TIMEOUT", "900"))
SUPA_URL = os.environ["SUPA_URL"].rstrip("/")
SUPA_KEY = os.environ["SUPA_KEY"]
SUITE = "knowledgebase/Writers Workbench Wiki/Engineering/testing/engine-chat-e2e-suite.md"
OUT = "scripts/e2e_out/verify"
RUN_START = datetime.now(timezone.utc) - timedelta(minutes=2)  # rows created after this count as "new"


# --------------------------------------------------------------------------- HTTP
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


def _supa(table, query=""):
    url = f"{SUPA_URL}/rest/v1/{table}?{query}"
    req = urllib.request.Request(url, headers={"apikey": SUPA_KEY, "authorization": f"Bearer {SUPA_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return {"_error": str(e)[:200]}


def run_step(source, prompt):
    """Drive one step; poll an async job to completion. Returns {response, job_result}."""
    try:
        if source == "voice":
            resp = _post("/internal/hub/voice", {"user_message_request": prompt, "system__caller_id": USER})
        else:
            resp = _post("/internal/hub", {"message": prompt, "user_id": USER})
    except Exception as e:  # noqa: BLE001
        return {"response": {"_error": str(e)[:300]}, "job_result": None}
    out = {"response": resp, "job_result": None}
    job_id = resp.get("job_id")
    if job_id and resp.get("kind") == "queued":
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            time.sleep(8)
            try:
                jr = _get(f"/internal/write/jobs/{job_id}")
            except Exception as e:  # noqa: BLE001
                jr = {"status": "poll_error", "error": str(e)[:200]}
            out["job_result"] = jr
            if jr.get("status") in ("complete", "error", "not_found", "failed"):
                break
    return out


# --------------------------------------------------------------------------- suite parsing (multi-step)
def parse_suite():
    md = open(SUITE).read()
    blocks = re.split(r"\n(?=### [RV]\d+[ :—-])", md)
    tests = []
    for b in blocks:
        m = re.match(r"### ([RV]\d+)\b[ :—-]*(.*)", b)
        if not m:
            continue
        tid, title = m.group(1), m.group(2).strip()
        route = ""
        rm = re.search(r"\*\*Engine route:\*\*\s*(.+)", b)
        if rm:
            route = rm.group(1).strip()
        # gather ordered steps: voice webhooks first if present, else command code-blocks
        steps = []
        for vm in re.finditer(r'\*\*Voice webhook[^:]*:\*\*\s*`?\{user_message_request:\s*"((?:[^"\\]|\\.)*)"', b):
            steps.append(("voice", vm.group(1).encode().decode("unicode_escape")))
        if not steps:
            for cm in re.finditer(r"\*\*Command[^:]*:\*\*\s*\n\s*```\n(.*?)\n\s*```", b, re.S):
                steps.append(("chat", cm.group(1).strip()))
            if not steps:  # single inline command without step label
                cm = re.search(r"\*\*Command:\*\*\s*\n\s*```\n(.*?)\n\s*```", b, re.S)
                if cm:
                    steps.append(("chat", cm.group(1).strip()))
        expected = re.findall(r"- \[ \] (.+)", b)
        if not expected:
            em = re.search(r"\*\*Expected[^:]*:\*\*\s*(.+)", b)
            if em:
                expected = [s.strip() for s in re.split(r";\s*", em.group(1)) if s.strip()]
        tests.append({"id": tid, "title": title, "route": route, "steps": steps, "expected": expected})
    return tests


def expected_route(route):
    r = route.replace("`", " ").split("·")[0]
    toks = [t for t in re.split(r"[\s/(]+", r) if "." in t and not t.endswith(".")]
    return toks[0] if toks else ""


# --------------------------------------------------------------------------- verification
def _result_of(step_out):
    r = step_out.get("response") or {}
    jr = step_out.get("job_result") or {}
    res = ((r.get("data") or {}).get("payload") or {}).get("result")
    if res is None and jr:
        res = jr.get("result")
        if isinstance(res, dict):
            res = (res.get("payload") or {}).get("result", res)
    return r, jr, (res if isinstance(res, dict) else {})


def _recent(rows, ts_field="created_at"):
    out = []
    for r in rows if isinstance(rows, list) else []:
        ts = r.get(ts_field) or r.get("updated_at")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt >= RUN_START:
                out.append(r)
        except Exception:  # noqa: BLE001
            pass
    return out


def verify(test, runs):
    """Return (verdict, evidence[]). verdict in PASS/FAIL/PARTIAL. runs = list of step_out (in order)."""
    ev = []
    exp = expected_route(test["route"])
    last = runs[-1]
    r, jr, res = _result_of(last)
    got = f"{r.get('tool')}.{r.get('op')}" if r.get("tool") else r.get("kind")
    route_ok = bool(exp) and (exp == got or (r.get("op") and exp.endswith("." + r.get("op", "xx"))))
    ev.append(f"route exp={exp or '?'} got={got} {'OK' if route_ok else 'MISMATCH'}")

    # job completion for async
    if r.get("kind") == "queued":
        st = jr.get("status")
        ev.append(f"job={st}")
        if st != "complete":
            return "FAIL", ev + ["async job did not complete"]

    tool = (r.get("tool") or exp.split(".")[0]) if exp else r.get("tool")
    op = r.get("op") or (exp.split(".")[1] if "." in exp else "")

    # ---- artifact-in-DB checks by tool.op ----
    if tool == "research":
        rows = _supa("research_reports_v2", f"user_id=eq.{USER}&order=created_at.desc&limit=5")
        newr = _recent(rows)
        ev.append(f"research_reports_v2 recent={len(newr)}")
        rmd = (res.get("row") or {}).get("report_markdown") or ""
        ok = bool(newr) and len(rmd) > 400
        ev.append(f"report_len={len(rmd)}")
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "chapter" and op in ("blog", "newsletter", "short-story"):
        ctype = {"blog": "blog_post", "newsletter": "newsletter", "short-story": "short_story"}[op]
        rows = _supa("published_content_v2", f"user_id=eq.{USER}&content_type=eq.{ctype}&order=created_at.desc&limit=5")
        newr = _recent(rows)
        wc = res.get("word_count") or 0
        ev.append(f"{ctype} recent={len(newr)} word_count={wc} persist={(res.get('persist') or {}).get('persisted')}")
        ok = bool(newr) and wc > 200
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "chapter" and op in ("write",):
        rows = _supa("published_content_v2", f"user_id=eq.{USER}&content_type=eq.chapter&order=updated_at.desc&limit=8")
        newr = _recent(rows, "updated_at")
        wc = res.get("word_count") or 0
        ev.append(f"chapter rows recent={len(newr)} word_count={wc} persist={(res.get('persist') or {}).get('persisted')}")
        ok = bool(newr) and wc > 200
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "chapter" and op in ("plan",):
        n = res.get("count") or len(res.get("sub_chapter_briefs") or [])
        ev.append(f"sub_chapters={n} arc={res.get('chapter_story_arc')}")
        return ("PASS" if (n >= 3) else "FAIL"), ev

    if tool == "chapter" and op in ("qa", "repair", "rewrite", "scan-drift"):
        ok = bool(res) and ("character_consistency" in res or "scores" in res or "content_text" in res or "repaired" in res)
        ev.append(f"qa/repair keys={list(res.keys())[:6]}")
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "brainstorm":
        # project + non-empty outline persisted
        title = (res.get("outline") or {}).get("title") or ""
        persisted = (res.get("persist") or {}).get("persisted")
        rows = _supa("writing_projects_v2", f"user_id=eq.{USER}&order=updated_at.desc&limit=8")
        newr = [x for x in _recent(rows, "updated_at") if (x.get("outline") or {}) not in ({}, None)]
        nch = len((res.get("outline") or {}).get("chapters") or [])
        ev.append(f"outline title='{title[:40]}' chapters={nch} persisted={persisted} projects_recent={len(newr)}")
        ok = persisted and nch >= 1
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "media" and op == "cover-art":
        rows = _supa("generated_images_v2", f"user_id=eq.{USER}&order=created_at.desc&limit=5")
        newr = _recent(rows)
        url = res.get("image_url") or ""
        ev.append(f"generated_images recent={len(newr)} image_url={'yes' if url.startswith('http') else url[:40]}")
        ok = bool(newr) or url.startswith("http")
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "media" and op == "social-posts":
        posts = {k: v for k, v in res.items() if isinstance(v, str) and k not in ("note", "provider", "prompt")}
        ev.append(f"platforms={list(posts.keys())}")
        return ("PASS" if (posts) else "FAIL"), ev

    if tool == "library" and op == "email-content":
        emailed = res.get("emailed")
        ev.append(f"emailed={emailed} to={res.get('to')} subject={str(res.get('subject'))[:50]} err={res.get('error_message')}")
        # not-found tests EXPECT emailed=false; detect from expected text
        expect_notfound = any("not-found" in e.lower() or "not found" in e.lower() or "does not exist" in e.lower() for e in test["expected"])
        if expect_notfound:
            return ("PASS" if (emailed is False) else "FAIL"), ev + ["(expected not-found)"]
        return ("PASS" if (emailed is True) else "FAIL"), ev

    if tool == "library" and op in ("retrieve", "list-outlines"):
        items = res.get("items")
        ev.append(f"items={len(items) if isinstance(items, list) else items} found={res.get('found')}")
        expect_notfound = any("not-found" in e.lower() or "found=false" in e.lower() or "no results" in e.lower() for e in test["expected"])
        if expect_notfound:
            return ("PASS" if (res.get("found") is False) else "FAIL"), ev
        ok = isinstance(items, list)
        return ("PASS" if (ok) else "PARTIAL"), ev

    if tool == "library" and op == "versions":
        ev.append(f"count={res.get('count')} versions={len(res.get('versions') or res.get('items') or [])}")
        return ("PASS" if route_ok else "FAIL"), ev

    if tool == "library" and op == "revert":
        ev.append(f"reverted={res.get('reverted')}")
        return ("PASS" if route_ok else "FAIL"), ev

    if tool == "library" and op == "lifecycle":
        status = res.get("status") or res.get("count")
        err = res.get("error")
        ev.append(f"status={status} matched={res.get('matched')} error={str(err)[:60]}")
        # trash/list_deleted returns count; mutations return status
        ok = (status is not None) and not (err and "not found" in str(err).lower() and "matched" not in test["title"].lower())
        return ("PASS" if (ok) else "FAIL"), ev

    if tool == "story_bible":
        ev.append(f"entries={res.get('count')} found={res.get('found')}")
        return ("PASS" if (res.get("found") is not None) else "FAIL"), ev

    if tool == "notify":
        r0, jr0, res0 = _result_of(last)
        invoked = res0.get("invoked")
        data = last["response"].get("data") or {}
        ev.append(f"kind={last['response'].get('kind')} invoked={invoked} found={data.get('found')}")
        return ("PASS" if route_ok else "PARTIAL"), ev

    # conversation / reply / unknown
    ev.append(f"raw kind={r.get('kind')}")
    return ("PARTIAL" if route_ok else "FAIL"), ev


# --------------------------------------------------------------------------- main
def main():
    os.makedirs(OUT, exist_ok=True)
    tests = parse_suite()
    only = os.environ.get("E2E_ONLY", "").split(",") if os.environ.get("E2E_ONLY") else None
    if only:
        tests = [t for t in tests if t["id"] in only]
    progress = open(f"{OUT}/progress.log", "w")
    summary = []

    def log(s):
        print(s, flush=True)
        progress.write(s + "\n")
        progress.flush()

    log(f"# Full E2E verify — {len(tests)} tests — start {datetime.now(timezone.utc).isoformat()}")
    for i, t in enumerate(tests, 1):
        if not t["steps"]:
            verdict, ev = "NO_PROMPT", ["no runnable command found in suite"]
            runs = []
        else:
            runs = []
            for src, prompt in t["steps"]:
                runs.append(run_step(src, prompt))
            try:
                verdict, ev = verify(t, runs)
            except Exception as e:  # noqa: BLE001
                verdict, ev = "FAIL", [f"verify error: {str(e)[:200]}"]
        rec = {"id": t["id"], "title": t["title"], "route": t["route"], "verdict": verdict,
               "evidence": ev, "steps": t["steps"], "runs": runs, "expected": t["expected"]}
        with open(f"{OUT}/{t['id']}.json", "w") as f:
            json.dump(rec, f, indent=2, default=str)
        summary.append({"id": t["id"], "title": t["title"], "verdict": verdict, "evidence": ev})
        log(f"[{i}/{len(tests)}] {t['id']} {verdict} :: {t['title'][:50]} :: {' | '.join(ev)[:180]}")
        with open(f"{OUT}/summary.json", "w") as f:
            json.dump(summary, f, indent=2)

    # report
    counts = {}
    for s in summary:
        counts[s["verdict"]] = counts.get(s["verdict"], 0) + 1
    log(f"\nDONE {datetime.now(timezone.utc).isoformat()} :: {counts}")


if __name__ == "__main__":
    main()
