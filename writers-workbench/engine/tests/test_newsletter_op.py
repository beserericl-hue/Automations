"""E2E-3 — unit test for chapter.newsletter (`_op_newsletter`).

Mocks the LLM router + research + persist so the structured assembly (subject_line / pre_header /
intro / sections / outro → markdown) and the content_type=newsletter persist are verified offline.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import chapter_step.main as ch


class _Router:
    def __init__(self, text):
        self._text = text

    async def complete(self, **k):
        return SimpleNamespace(text=self._text, citations=[])


def test_newsletter_assembles_structure_and_persists_as_newsletter(monkeypatch):
    payload_json = json.dumps({
        "subject_line": "Power Structures in Space",
        "pre_header": "How sci-fi predicts real politics",
        "intro": "The intro hook.",
        "sections": [
            {"heading": "Empires", "body": "Body about empires. See https://example.com/a"},
            {"heading": "Rebellions", "body": "Body about rebellions."},
        ],
        "outro": "What do you think?",
        "title": "Power Structures in Space",
    })
    captured: dict = {}

    async def fake_research(*a, **k):
        return ("RESEARCHED FACTS with https://example.com/a", [])

    async def fake_genre(genre_slug):
        return ("Political Sci-Fi", "cerebral, tense")

    async def fake_persist(payload, *, title, content_type, content_text, genre_slug, metadata=None):
        captured.update(content_type=content_type, title=title, body=content_text, meta=metadata)
        return {"persisted": True, "content_id": "c1"}

    monkeypatch.setattr(ch, "_chapter_research", fake_research)
    monkeypatch.setattr(ch, "_load_genre_guidelines", fake_genre)
    monkeypatch.setattr(ch, "_persist_simple", fake_persist)
    monkeypatch.setattr(ch, "get_router", lambda **k: _Router(payload_json))

    out = asyncio.run(ch._op_newsletter({
        "topic": "Power Structures in Space", "genre_slug": "political-scifi",
        "user_id": "+14105914612", "persist": True, "date": "2026-03-10",
    }))

    assert out["written"] is True
    assert out["subject_line"] == "Power Structures in Space"
    assert out["section_count"] == 2
    # assembled markdown carries intro, both section headings, and the outro
    body = out["content_text"]
    assert "The intro hook." in body
    assert "## Empires" in body and "## Rebellions" in body
    assert "What do you think?" in body
    # persisted as a newsletter with subject_line in metadata
    assert captured["content_type"] == "newsletter"
    assert captured["meta"]["subject_line"] == "Power Structures in Space"
    assert captured["meta"]["send_date"] == "2026-03-10"
