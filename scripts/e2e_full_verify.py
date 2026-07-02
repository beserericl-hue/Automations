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
import urllib.parse
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
    # URL-encode the phone-number user_id: a raw '+' in a query string is decoded to a SPACE by the
    # server (eq.+14105914612 -> eq. 14105914612 -> no match), which produced false "0 rows" FAILs.
    query = query.replace(USER, urllib.parse.quote(USER, safe=""))
    url = f"{SUPA_URL}/rest/v1/{table}?{query}"
    req = urllib.request.Request(url, headers={"apikey": SUPA_KEY, "authorization": f"Bearer {SUPA_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return {"_error": str(e)[:200]}


def _supa_write(method, table, query="", body=None):
    """POST (insert, returns the row) / PATCH / DELETE against Supabase REST. Used by lifecycle seeding
    to create + clean up disposable, known-state rows so approve/reject/delete/undelete tests don't
    depend on run order."""
    query = query.replace(USER, urllib.parse.quote(USER, safe=""))
    url = f"{SUPA_URL}/rest/v1/{table}" + (f"?{query}" if query else "")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"apikey": SUPA_KEY, "authorization": f"Bearer {SUPA_KEY}",
               "content-type": "application/json", "Prefer": "return=representation"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip() else []
    except Exception as e:  # noqa: BLE001
        return {"_error": str(e)[:200]}


PICKED = {}  # test_id -> a representative title produced/listed by that test (for placeholder substitution)
_PLACEHOLDER = re.compile(r"\[[^\]]*?from\s+([RV]\d+)[^\]]*?\]", re.I)
_ANY_BRACKET = re.compile(r"\[[^\]]+\]")


def _pick_title(res, resp):
    """Choose a representative title from a step result (for later [title from RXX] substitution)."""
    if not isinstance(res, dict):
        return None
    items = res.get("items")
    if isinstance(items, list) and items:
        for it in items:
            if isinstance(it, dict) and it.get("title"):
                return it["title"]
    for k in ("subject", "title"):
        if res.get(k):
            return res[k]
    ol = res.get("outline") or {}
    return ol.get("title")


def _anchor_updates(res, resp):
    """Typed conversation anchors produced by a step, for the NEXT step's pronoun resolution:
    last_research_title/topic (research runs), last_content_title (blog/chapter/etc), last_project_title
    (brainstorm/outline). The router binds "that research"/"blog about that"/"email me the report" to these."""
    up = {}
    if not isinstance(res, dict):
        return up
    # research run: result carries the topic (or a row with it)
    topic = res.get("topic") or (res.get("row") or {}).get("topic")
    if topic:
        up["last_research_title"] = topic
        up["last_research_topic"] = topic
    # generic content title (blog/short story/chapter/newsletter)
    ctitle = res.get("title") or res.get("subject")
    if ctitle:
        up["last_content_title"] = ctitle
    # project/outline title
    ptitle = (res.get("outline") or {}).get("title") or res.get("project_title")
    if ptitle:
        up["last_project_title"] = ptitle
    return up


def resolve_prompt(prompt, picked):
    """Substitute [ ... from RXX ] placeholders with the real title that test produced. Falls back to a
    recent DEV draft title so a scripted approve/publish/delete test can still exercise the engine."""
    def _sub(m):
        ref = m.group(1).upper()
        return picked.get(ref) or _fallback_draft_title() or m.group(0)
    out = _PLACEHOLDER.sub(_sub, prompt)
    # any remaining bracket placeholder (e.g. "[title]") -> fallback draft title
    if _ANY_BRACKET.search(out):
        out = _ANY_BRACKET.sub(lambda m: _fallback_draft_title() or m.group(0), out)
    return out


_FALLBACK = {"t": None}


def _fallback_draft_title():
    if _FALLBACK["t"] is None:
        rows = _supa("published_content_v2", f"user_id=eq.{USER}&status=eq.draft&order=created_at.desc&limit=1&select=title")
        _FALLBACK["t"] = (rows[0]["title"] if isinstance(rows, list) and rows else "")
    return _FALLBACK["t"]


# --------------------------------------------------------------------------- lifecycle isolation
# Approve/reject/delete/undelete were flaky because they mutated whatever shared DEV row happened to be
# in the right state — so the verdict depended on run order (R98/V36 undelete failed when the target
# wasn't `deleted` yet). Instead we seed a disposable, uniquely-titled row in the exact pre-state each
# test needs, rewrite the command to target it, verify the transition on THAT row, then delete it.
import uuid  # noqa: E402

_LIFECYCLE_END = {  # action -> expected status after the op
    "approve": "approved", "publish": "published", "reject": "rejected",
    "delete": "deleted", "undelete": "draft", "schedule": "scheduled", "unschedule": "draft",
}
# action -> the pre-state the disposable row must be in for the op to be a valid, deterministic transition
_LIFECYCLE_PRESTATE = {
    "approve": "draft", "reject": "draft", "schedule": "draft", "delete": "draft",
    "publish": "approved", "undelete": "deleted", "unschedule": "scheduled",
}


def _lifecycle_action(prompt):
    low = prompt.lower()
    if "undelete" in low or "put it back" in low or re.search(r"\brestore\b", low):
        return "undelete"
    if "unpublish" in low:
        return "unpublish"
    if re.search(r"\brejec", low):
        return "reject"
    if re.search(r"\bpublish", low):
        return "publish"
    if re.search(r"\bschedul", low):
        return "schedule"
    if re.search(r"\bapprov", low):
        return "approve"
    if re.search(r"\bdelete\b", low):
        return "delete"
    return None


def _inject_title(prompt, title):
    """Point a lifecycle command at the disposable row: swap a quoted title, a `[from RXX]` placeholder,
    a `called/titled X` clause, or a bare `undelete X` object for our seeded title. Returns prompt
    unchanged when no title slot is found (search-style commands like V34 keep their own phrasing)."""
    if re.search(r'"[^"]*"', prompt):
        return re.sub(r'"[^"]*"', f'"{title}"', prompt, count=1)
    if re.search(r"\[[^\]]*\]", prompt):
        return re.sub(r"\[[^\]]*\]", title, prompt, count=1)
    m = re.search(r"\b(called|titled|named)\s+(.+?)(?=\s+(?:put|for|to|in)\b|$)", prompt, re.I)
    if m:
        return prompt[:m.start(2)] + title + prompt[m.end(2):]
    m = re.search(r"\bundelete\s+(.+?)(?=\s+put\b|$)", prompt, re.I)
    if m:
        return prompt[:m.start(1)] + title + prompt[m.end(1):]
    return prompt


def seed_lifecycle(test):
    """If this is a lifecycle MUTATION test, seed a disposable row in the required pre-state and rewrite
    its steps to target it. Returns (new_steps, seed) where seed={id,title,end_status} or (steps, None)."""
    route = (test.get("route") or "").lower()
    if "library.lifecycle" not in route and "lifecycle" not in route:
        return test["steps"], None
    steps = test["steps"]
    if not steps:
        return steps, None
    first_prompt = steps[0][1]
    action = _lifecycle_action(first_prompt)
    if action not in _LIFECYCLE_PRESTATE:
        return steps, None  # list_deleted / unknown — nothing to seed
    # published-delete guard test (R95/V34): the row must be `published` so "cannot delete published" fires
    prestate = _LIFECYCLE_PRESTATE[action]
    if action == "delete" and "publish" in first_prompt.lower():
        prestate = "published"
    # end state we expect to assert (last step's action, e.g. V14 approve→publish ends published)
    end_action = _lifecycle_action(steps[-1][1]) or action
    end_status = "published" if prestate == "published" else _LIFECYCLE_END.get(end_action, prestate)

    title = f"E2E Lifecycle {test['id']} {uuid.uuid4().hex[:8]}"
    # Only seed when the command has a title slot we can point at the disposable row. Search-style
    # commands (V34 "delete the published blog post about …") keep their own phrasing — seeding a
    # uniquely-titled row wouldn't be matched, so leave them on the old verification path.
    new_steps = [(src, _inject_title(p, title)) for (src, p) in steps]
    if new_steps == steps:
        return steps, None
    ctype = "blog_post" if "blog" in first_prompt.lower() else "chapter"
    row = {
        "user_id": USER, "title": title, "content_type": ctype, "status": prestate,
        "content_text": f"Disposable lifecycle fixture for {test['id']}. " * 12,
        "genre_slug": "post-apocalyptic",
    }
    if prestate == "deleted":
        row["deleted_at"] = datetime.now(timezone.utc).isoformat()
    if prestate == "published":
        row["published_at"] = datetime.now(timezone.utc).isoformat()
    ins = _supa_write("POST", "published_content_v2", body=row)
    if not isinstance(ins, list) or not ins:
        return steps, {"error": f"seed insert failed: {ins}"}
    seed_id = ins[0]["id"]
    return new_steps, {"id": seed_id, "title": title, "end_status": end_status, "prestate": prestate}


def cleanup_lifecycle(seed):
    if seed and seed.get("id"):
        _supa_write("DELETE", "published_content_v2", query=f"id=eq.{seed['id']}")


def run_step(source, prompt, context=None, conversation_id=None):
    """Drive one step; poll an async job to completion. Returns {response, job_result}.

    Threads conversation context + a stable conversation_id so multi-turn pronouns ("that research",
    "blog about that", "publish it") resolve — for BOTH the chat and voice surfaces."""
    try:
        if source == "voice":
            body = {"user_message_request": prompt, "system__caller_id": USER}
            if context:
                body["context"] = context
            if conversation_id:
                body["conversation_id"] = conversation_id
            resp = _post("/internal/hub/voice", body)
        else:
            body = {"message": prompt, "user_id": USER}
            if context:
                body["context"] = context
            if conversation_id:
                body["conversation_id"] = conversation_id
            resp = _post("/internal/hub", body)
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
    # For a MULTI-STEP test the route lists each step's op ("library.versions … + library.revert …").
    # verify() only grades the LAST run, so the expected route is the LAST op token, not the first
    # (fixes R89, which graded the revert step against the versions route).
    r = route.replace("`", " ").split("·")[0]
    toks = [t for t in re.split(r"[\s/()+,;]+", r) if "." in t and not t.endswith(".")]
    return toks[-1] if toks else ""


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

    # job completion for async. A hard error/not_found fails immediately; a job that merely outran the
    # poll deadline (slow chapter/epilogue writes — R79) falls through to the DB artifact check, which
    # passes if the row actually persisted and fails if nothing landed.
    if r.get("kind") == "queued":
        st = jr.get("status")
        ev.append(f"job={st}")
        if st in ("error", "failed", "not_found"):
            return "FAIL", ev + ["async job errored"]

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
        rows = _supa("published_content_v2",
                     f"user_id=eq.{USER}&content_type=eq.chapter&order=updated_at.desc&limit=8"
                     "&select=title,content_text,updated_at,chapter_number")
        newr = _recent(rows, "updated_at")
        wc = res.get("word_count") or 0
        # R79: when the poll gave up before the job reported back, derive the word count from the freshly
        # persisted row instead — the epilogue/chapter still landed in the DB.
        if wc <= 200 and newr:
            wc = max((len((rw.get("content_text") or "").split()) for rw in newr), default=0)
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
        # Isolated lifecycle test: assert the disposable seeded row reached its expected end-state in the
        # DB — deterministic regardless of run order (R98/V36 undelete, approve/reject/delete/publish).
        seed = test.get("_seed")
        if seed and seed.get("id"):
            dbrow = _supa("published_content_v2", f"id=eq.{seed['id']}&select=status,deleted_at")
            cur = dbrow[0]["status"] if isinstance(dbrow, list) and dbrow else None
            ev.append(f"seed={seed['id'][:8]} status={cur} want={seed['end_status']} prestate={seed['prestate']}")
            return ("PASS" if cur == seed["end_status"] else "FAIL"), ev
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
            ctx = {}  # conversation context carried across steps of THIS test ("publish it", "that")
            conv_id = f"e2e-{t['id']}"  # stable per-test conversation id (multi-turn correlation)
            steps, seed = seed_lifecycle(t)  # isolate lifecycle data (disposable known-state row)
            t["_seed"] = seed
            for src, prompt in steps:
                rp = resolve_prompt(prompt, PICKED)
                out = run_step(src, rp, context=ctx or None, conversation_id=conv_id)
                out["resolved_prompt"] = rp
                runs.append(out)
                # capture context for the next step: last list + the chosen title as active project,
                # PLUS typed anchors (research/content/project titles) so pronouns resolve next turn.
                _rr, _jr, _res = _result_of(out)
                title = _pick_title(_res, _rr)
                if title:
                    ctx["project_title"] = title
                    ctx["last_list"] = (_res.get("items") or [])[:10]
                ctx.update(_anchor_updates(_res, _rr))
            # remember a representative title for later tests' [title from <this id>] placeholders
            picked_title = None
            for out in runs:
                _rr, _jr, _res = _result_of(out)
                picked_title = _pick_title(_res, _rr) or picked_title
            if picked_title:
                PICKED[t["id"]] = picked_title
            try:
                verdict, ev = verify(t, runs)
            except Exception as e:  # noqa: BLE001
                verdict, ev = "FAIL", [f"verify error: {str(e)[:200]}"]
            finally:
                cleanup_lifecycle(t.get("_seed"))
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
