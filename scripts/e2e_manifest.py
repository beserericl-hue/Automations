#!/usr/bin/env python3
"""Parse the engine E2E suite markdown into a structured manifest of all 161 tests.

Emits scripts/e2e_out/manifest.json: a list of {id, title, source, prompt, route, prerequisite,
expected[]} so the runner can drive each test through the engine chat / voice webhook in order.
"""
from __future__ import annotations

import json
import os
import re

SUITE = "knowledgebase/Writers Workbench Wiki/Engineering/testing/engine-chat-e2e-suite.md"


def parse(md: str) -> list[dict]:
    # split into test blocks at "### <ID>: <title>"
    blocks = re.split(r"\n(?=### [RV]\d+[ :])", md)
    tests: list[dict] = []
    for b in blocks:
        m = re.match(r"### ([RV]\d+)[ :]+(.*)", b)
        if not m:
            continue
        tid, title = m.group(1), m.group(2).strip()
        route = ""
        rm = re.search(r"\*\*Engine route:\*\*\s*(.+)", b)
        if rm:
            route = rm.group(1).split("·")[0].strip().strip("`")
        prereq = ""
        pm = re.search(r"\*\*Prerequisite:\*\*\s*(.+)", b)
        if pm:
            prereq = pm.group(1).strip()

        source, prompt = "chat", ""
        vm = re.search(r'\*\*Voice webhook:\*\*\s*`?\{user_message_request:\s*"((?:[^"\\]|\\.)*)"', b)
        if vm:
            source = "voice"
            prompt = vm.group(1).encode().decode("unicode_escape")
        else:
            cm = re.search(r"\*\*Command:\*\*\s*\n\s*```\n(.*?)\n\s*```", b, re.S)
            if cm:
                prompt = cm.group(1).strip()
        # expected checks: "- [ ] ..." lines, or the inline "**Expected:**" sentence for voice
        expected = re.findall(r"- \[ \] (.+)", b)
        if not expected:
            em = re.search(r"\*\*Expected[^:]*:\*\*\s*(.+)", b)
            if em:
                expected = [s.strip() for s in re.split(r";\s*", em.group(1)) if s.strip()]
        tests.append({
            "id": tid, "title": title, "source": source, "prompt": prompt,
            "route": route, "prerequisite": prereq, "expected": expected,
        })
    return tests


if __name__ == "__main__":
    tests = parse(open(SUITE).read())
    os.makedirs("scripts/e2e_out", exist_ok=True)
    with open("scripts/e2e_out/manifest.json", "w") as f:
        json.dump(tests, f, indent=2)
    chat = [t for t in tests if t["source"] == "chat"]
    voice = [t for t in tests if t["source"] == "voice"]
    missing = [t["id"] for t in tests if not t["prompt"]]
    print(f"parsed {len(tests)} tests: {len(chat)} chat + {len(voice)} voice")
    print(f"missing prompt: {missing or 'none'}")
    print("first 3:", json.dumps(tests[:3], indent=2)[:900])
