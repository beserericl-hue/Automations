#!/usr/bin/env python3
"""
Sprint 12 hotfix: UI-dispatched rewrite bypasses hub TOOL OVERRIDE regexes.

The hub's preprocess_message has aggressive substring regexes that
prepend [TOOL OVERRIDE — qa_chapter], [TOOL OVERRIDE — brainstorm_story],
etc. based on keywords in the chat input. Example trigger:

  \b(chapter|prologue|epilogue).{0,20}(q\/?a|cleanup|...)

When the web UI's `Rewrite with research` button forms a prompt with
an explicit `rewrite_chapter_with_research` invocation and the user's
research_focus happens to contain both "chapter" and "qa" within 20
chars (often — e.g. "chapters 1-2. use_qa_report=true"), the hub
short-circuits to direct_qa_chapter and the rewrite never runs.

Fix: inject a bypass block at the top of preprocess_message that
recognises two signals and skips every TOOL OVERRIDE branch:

  1. `body._source === 'ui:rewrite-with-research'` (sentinel set by
     the Workbench content-actions route — authoritative)
  2. Explicit `rewrite_chapter_with_research` substring anywhere in
     the prompt (covers manual testing from curl or chat drawer)

The bypass falls through to the Author Agent with a clean chatInput,
so Gemini sees the named tool and picks it without TOOL OVERRIDE
prefix competing.

Replay-safe: idempotent. If the bypass block is already present the
script exits without modifying.

Usage:
  N8N_API_KEY=... python3 scripts/s12-hub-bypass-ui-rewrite.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_HUB_ID = "FLA6xIDEvejihQLP"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

BYPASS_BLOCK = """// --- S12 UI-rewrite bypass (do not remove) ---
// When the server's content-actions route dispatches a rewrite job,
// or any caller names rewrite_chapter_with_research explicitly in
// the prompt, skip the TOOL OVERRIDE regex short-circuits. Otherwise
// substring matches like "chapter ... qa" reroute to direct_qa_chapter
// and the rewrite never runs.
{
  const _msgRaw = ($input.first().json.chatInput || $input.first().json.body?.user_message_request || '').toString();
  const _uiSource = ($input.first().json.body?._source || '').toString();
  if (_uiSource === 'ui:rewrite-with-research' || /\\brewrite_chapter_with_research\\b/i.test(_msgRaw)) {
    const _uid = $input.first().json.body?.user_id || $input.first().json.user_id || '';
    return [{ json: {
      ...$input.first().json,
      body: $input.first().json.body,
      chatInput: _msgRaw,
      recipient_email: '',
      bcc_email: '',
      user_id: _uid,
      originalUserPrompt: _msgRaw,
      isAsyncOp: true,
      isWebhookTrigger: !!$input.first().json.body,
      _uiRewriteBypass: true,
    } }];
  }
}
// --- end S12 UI-rewrite bypass ---
"""


def api(method: str, path: str, body: Any | None = None) -> Any:
    key = os.environ.get("N8N_API_KEY")
    if not key:
        print("N8N_API_KEY not set", file=sys.stderr)
        sys.exit(2)
    req = Request(
        f"{N8N_BASE}/api/v1{path}",
        method=method,
        headers={
            "X-N8N-API-KEY": key,
            "User-Agent": UA,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:500]}", file=sys.stderr)
        raise


def clean_put_body(wf: dict) -> dict:
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


def main() -> int:
    wf = api("GET", f"/workflows/{DEV_HUB_ID}")
    changed = False
    for node in wf["nodes"]:
        if node.get("name") == "preprocess_message":
            code = node["parameters"].get("jsCode", "")
            if "S12 UI-rewrite bypass" in code:
                print("Bypass already installed — no change.")
                return 0
            # Insert after the existing S12-0 multi-step block if present,
            # otherwise at the very top.
            anchor = "// --- end S12-0 ---"
            if anchor in code:
                code = code.replace(anchor, anchor + "\n\n" + BYPASS_BLOCK)
            else:
                code = BYPASS_BLOCK + "\n" + code
            node["parameters"]["jsCode"] = code
            changed = True
            print("Injected UI-rewrite bypass into preprocess_message")
            break

    if not changed:
        print("No change needed.")
        return 0

    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/deactivate")
    except HTTPError as e:
        print(f"  deactivate returned {e.code}, continuing with PUT")
    api("PUT", f"/workflows/{DEV_HUB_ID}", clean_put_body(wf))
    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/activate")
    except HTTPError as e:
        print(f"  activate returned {e.code}; may already be active")
    print("DEV hub updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
