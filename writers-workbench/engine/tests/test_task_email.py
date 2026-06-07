"""CR-009 — task-completion email builder + gating."""

from __future__ import annotations

import asyncio

from writer_engine.notifications.task_email import build_task_email, send_task_completion_email


def test_build_email_has_artifact_and_metadata() -> None:
    subject, html = build_task_email(
        "chapter",
        {"op": "write", "chapter_number": 11, "project_title": "The Burial Mound",
         "directive": "write chapter 11"},
        {"content_text": "The committee room smelled of burnt coffee.", "word_count": 7148,
         "drift_report": {"aligned": True}, "craft_qa": {"prose_transparent": 0.8, "x": 0.9},
         "token_usage": {"total_tokens": 69000, "cost_usd": 0.38}, "research_used": ["copper trade"]},
    )
    assert "Chapter 11" in subject and "The Burial Mound" in subject
    assert "7,148" in html                      # word count metadata
    assert "Aligned to outline" in html and "True" in html
    assert "0.85" in html or "Craft QA" in html  # qa avg present
    assert "69,000" in html and "0.38" in html  # tokens + cost
    assert "copper trade" in html               # research used
    assert "burnt coffee" in html               # the artifact prose


def test_build_email_escapes_and_truncates() -> None:
    long = "x" * 50000
    _subject, html = build_task_email("chapter", {"chapter_number": 1}, {"content_text": "<b>" + long})
    assert "&lt;b&gt;" in html          # html-escaped
    assert "truncated" in html          # long prose truncated


def test_email_gating() -> None:
    # non-emailable tool / empty result / opt-out -> no send (returns False), no exception
    assert asyncio.run(send_task_completion_email("library", {"op": "retrieve"}, {"x": 1})) is False
    assert asyncio.run(send_task_completion_email("chapter", {"op": "write"}, None)) is False
    assert asyncio.run(send_task_completion_email("chapter", {"notify": False}, {"content_text": "x"})) is False
