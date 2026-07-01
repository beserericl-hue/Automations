"""Regression tests for the E2E gap repairs (G1-G20).

Offline / pure-function coverage of the orchestration fixes the live suite flagged: word-count and
Prologue coercion (G6/G19), completion-email deliverables (G1/G20), strict lifecycle/email resolution
(G11/G18), retrieve search + not-found (G15), story arcs (G16), and the deterministic routing overrides
(G3/G4/G7/G10/G13/G16/G17). The DB-touching ops use the fake-client style of test_email_content.
"""

from __future__ import annotations

import asyncio

import chapter_step.main as chap
import library_step.main as lib

from writer_engine.hub.router import _heuristic_route
from writer_engine.library_helpers.outline_render import render_outline_markdown
from writer_engine.notifications.task_email import _deliverable_html, build_task_email


# --------------------------------------------------------------------------- G6 / G19 coercion
def test_coerce_int_handles_word_count_strings():
    assert chap._coerce_int("1500 words", 1000) == 1500
    assert chap._coerce_int("2,500", 1000) == 2500
    assert chap._coerce_int("", 1234) == 1234
    assert chap._coerce_int(None, 42) == 42
    assert chap._coerce_int(3000, 1) == 3000


def test_coerce_chapter_number_prologue_epilogue():
    assert chap._coerce_chapter_number("Prologue") == 0
    assert chap._coerce_chapter_number("the epilogue") == 999
    assert chap._coerce_chapter_number("chapter 7") == 7
    assert chap._coerce_chapter_number(None, 1) == 1


# --------------------------------------------------------------------------- G1 / G20 deliverables
def test_render_outline_markdown_tolerates_varied_keys():
    md = render_outline_markdown({
        "title": "The Seed Vault", "premise": "A vault keeps the last seeds.",
        "characters": [{"name": "Tayak", "role": "keeper"}],
        "chapters": [{"number": 1, "title": "Descent", "summary": "She goes under."},
                     {"chapter_number": 2, "title": "The Door", "beat": "It opens."}],
    })
    assert "# The Seed Vault" in md
    assert "**Tayak**" in md
    assert "1. **Descent** — She goes under." in md
    assert "2. **The Door** — It opens." in md
    # no blank ". ** ** —" lines
    assert ". **** —" not in md


def test_deliverable_html_research_report():
    html = _deliverable_html("research", "run", {"row": {"topic": "Rome", "report_markdown": "# Findings\n\nFact."}})
    assert "Findings" in html and "Fact." in html


def test_deliverable_html_cover_art_embeds_image():
    html = _deliverable_html("media", "cover-art", {"image_url": "https://x.supabase.co/img.png"})
    assert "<img" in html and "img.png" in html


def test_deliverable_html_social_posts():
    html = _deliverable_html("media", "social-posts", {"twitter": "hi twitter", "linkedin": "hi linkedin"})
    assert "hi twitter" in html and "hi linkedin" in html


def test_deliverable_html_outline():
    html = _deliverable_html("brainstorm", "story", {"outline": {"title": "T", "chapters": [{"chapter_number": 1, "title": "A", "beat": "b"}]}})
    assert "Chapters" in html and "A" in html


def test_build_task_email_research_subject_uses_topic():
    subject, html = build_task_email("research", {"op": "run"}, {"row": {"topic": "Gladiators", "report_markdown": "R"}})
    assert "Gladiators" in subject
    assert "R" in html


# --------------------------------------------------------------------------- G11 strict match
def test_strict_best_match_never_falls_back_to_first_row():
    rows = [{"title": "An AI trained on 50"}, {"title": "The Graveyard of Good Ideas"}]
    # empty term → None (never rows[0])
    assert lib._strict_best_match(rows, "", ("title",)) is None
    # a term matching nothing → None
    assert lib._strict_best_match(rows, "Nonexistent Thing Zzz", ("title",)) is None
    # exact-ish term → the right row, not the most recent
    m = lib._strict_best_match(rows, "The Graveyard of Good Ideas", ("title",))
    assert m and m["title"] == "The Graveyard of Good Ideas"


# --------------------------------------------------------------------------- G15 retrieve search/found
class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, data):
        self._data = data

    def __getattr__(self, _n):
        return lambda *a, **k: self

    async def execute(self):
        return _Resp(self._data)


class _Client:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _Query(self.tables.get(name, []))


def _retrieve(tables, payload):
    async def fake():
        return _Client(tables)

    import library_step.main as m
    orig = m._supabase_or_none
    m._supabase_or_none = fake
    try:
        return asyncio.run(m._op_retrieve(payload))
    finally:
        m._supabase_or_none = orig


def test_retrieve_applies_search_term_and_found_flag():
    rows = [
        {"id": "1", "title": "My Titanic Draft", "content_type": "blog_post", "status": "draft"},
        {"id": "2", "title": "Space Opera", "content_type": "blog_post", "status": "draft"},
    ]
    hit = _retrieve({"published_content_v2": rows}, {"search_term": "Titanic", "user_id": "u1"})
    assert hit["found"] is True and hit["count"] == 1 and hit["items"][0]["id"] == "1"
    miss = _retrieve({"published_content_v2": rows}, {"search_term": "quantum surfing on Jupiter", "user_id": "u1"})
    assert miss["found"] is False and miss["count"] == 0


def test_retrieve_story_arcs(monkeypatch):
    arcs = [{"name": "Freytags Pyramid", "description": "5-act", "user_id": None}]
    out = _retrieve({"story_arcs_v2": arcs}, {"content_type": "story_arc", "user_id": "u1"})
    assert out["found"] is True and out["items"][0]["name"] == "Freytags Pyramid"


# --------------------------------------------------------------------------- routing overrides
def _route(msg):
    return _heuristic_route(msg)


def test_route_list_drafts_by_type():  # G10/G14
    d = _route("List my draft blog posts")
    assert (d.tool, d.op) == ("library", "retrieve")
    assert d.params.get("status") == "draft" and d.params.get("content_type") == "blog_post"


def test_route_list_published():  # G14
    d = _route("List my published content")
    assert (d.tool, d.op) == ("library", "retrieve") and d.params.get("status") == "published"


def test_route_social_repurpose_with_platform_and_inline():  # G7/G17
    d = _route("Repurpose this into LinkedIn posts: My robot learned to paint today.")
    assert (d.tool, d.op) == ("media", "social-posts")
    assert "linkedin" in d.params.get("platforms", [])
    assert "robot learned to paint" in d.params.get("summary", "")


def test_route_list_story_arcs():  # G16
    d = _route("List the story arcs")
    assert (d.tool, d.op) == ("library", "retrieve") and d.params.get("content_type") == "story_arc"


def test_route_get_research_report_does_not_run_new():  # G13
    d = _route("Get the research report about Post-Apocalyptic Fiction Trends 2026")
    assert (d.tool, d.op) == ("library", "retrieve") and d.params.get("content_type") == "research"


def test_route_run_research_still_generates():  # G13 guard — don't steal real research runs
    d = _route("Research the daily life of Roman gladiators")
    assert (d.tool, d.op) == ("research", "run")


def test_route_story_bible_read():  # G3
    d = _route("Get the story bible for The Seed Vault")
    assert (d.tool, d.op) == ("story_bible", "list")
    assert "Seed Vault" in (d.params.get("project_title") or "")


def test_route_research_keeps_genre_slug():  # G4
    d = _route("Research post-apocalyptic survival tactics with genre slug post-apocalyptic")
    assert d.tool == "research" and d.params.get("genre_slug") == "post-apocalyptic"


def test_route_lifecycle_threads_title():  # G11
    d = _route('Publish the blog post titled "The Graveyard of Good Ideas"')
    assert (d.tool, d.op) == ("library", "lifecycle") and d.params.get("action") == "publish"
    assert "Graveyard" in (d.params.get("project_title") or d.params.get("search_term") or "")


def test_route_email_still_wins_over_research_listing():  # precedence guard
    d = _route("Email me the research report on Rome")
    assert (d.tool, d.op) == ("library", "email-content")


# --------------------------------------------------------------------------- live-run regressions
def test_route_retrieve_outline_by_title():  # R70 — outline retrieval, not generate
    d = _route('Retrieve the outline for "The Accord"')
    assert (d.tool, d.op) == ("library", "retrieve")
    assert d.params.get("content_type") == "outline" and "Accord" in d.params.get("search_term", "")


def test_route_show_my_outlines_lists():  # R83 — 'show me my outlines'
    d = _route("Show me my outlines")
    assert (d.tool, d.op) == ("library", "list-outlines")


def test_route_find_draft_story_retrieves_not_generates():  # V25 — must not write a new story
    d = _route("Find my draft short story about the Titanic")
    assert (d.tool, d.op) == ("library", "retrieve")
    assert d.params.get("content_type") == "short_story"


def test_route_delete_not_stolen_by_retrieve():  # lifecycle delete still routes to lifecycle
    d = _route('Delete the draft titled "The Forgotten Engineers of Rome"')
    assert (d.tool, d.op) == ("library", "lifecycle") and d.params.get("action") == "delete"


def test_route_callback_not_stolen_by_retrieve():  # 'pull up … and call me back' stays callback
    d = _route("Pull up my research report about Rome and call me back to review it")
    assert (d.tool, d.op) == ("notify", "eve-callback")


def test_route_write_chapter_not_stolen_by_retrieve():  # generation still generates
    d = _route('Write chapter 5 of "The Seed Vault"')
    assert (d.tool, d.op) == ("chapter", "write")


def test_ct_alias_research_report(monkeypatch):  # R102 — email-content research_report alias
    assert lib._CT_ALIAS.get("research_report") == "research"
    assert lib._CT_ALIAS.get("blog_post") == "blog"
