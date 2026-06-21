#!/usr/bin/env python3
"""Explicit batch: lifecycle/versions (dependency placeholders substituted with real DEV drafts) +
brainstorm/retrieve. Run with E2E_SECRET set."""
import json
import sys

sys.path.insert(0, "scripts")
import e2e_runner as R  # noqa: E402

BLOG = "The Graveyard of Good Ideas: What Your Draft Folder Says About You as a Writer"
BLOG_ID = "4285e4f3-ad0c-4a7b-94d3-65ff488656d6"
NL1 = "Power Structures in Space: How Sci-Fi Predicts Real-World Politics"
NL2 = "This Month in Political History: Revolutions That Changed the Map"

TESTS = [
    ("R22", "chat", f'Approve the draft titled "{BLOG}"'),
    ("R23", "chat", f'Publish the content titled "{BLOG}"'),
    ("R24", "chat", "List my published content"),
    ("R25", "chat", f'Reject the draft titled "{NL1}"'),
    ("R26", "chat", f'Schedule the draft titled "{NL2}" for 2026-03-20'),
    ("R27", "chat", "List my scheduled content"),
    ("R28", "chat", f"Show version history for {BLOG_ID}"),
    ("R29", "chat", f"Get version 1 of {BLOG_ID}"),
    ("R30", "chat", 'Brainstorm a post-apocalyptic story called "The Seed Vault" about the last seed '
                    "bank on Earth and the botanist who must protect it. 8 chapters."),
    ("R32", "chat", 'Get the story bible for project "The Seed Vault"'),
    ("R33", "chat", "List my research reports"),
    ("R34", "chat", 'Get the research report about "Post-Apocalyptic Fiction Trends 2026"'),
]

for label, src, msg in TESTS:
    out = R.run(src, msg)
    json.dump({"test": {"id": label, "prompt": msg}, **out},
              open(f"scripts/e2e_out/{label}.json", "w"), indent=2)
    print(R._summarize(label, out))
    print("-")
