"""CR-004 engine hub — router classification, numbered-selection, dispatch plan, catalog.

These run fully offline: an empty LLMRouter is passed so the Gemini path raises
ProviderNotRegistered and ``route_message`` degrades to its deterministic regex layer — which is
exactly the fallback that must keep the hub working when Gemini is down. So the same tests prove the
routing rules AND the degradation path.
"""

from __future__ import annotations

import asyncio

from writer_engine.hub import build_dispatch_plan, route_message, split_tasks
from writer_engine.hub.catalog import CATALOG, lookup, render_catalog_prompt, tool_names
from writer_engine.hub.router import _heuristic_route, _normalise
from writer_engine.hub.schemas import HubDecision, HubRequest
from writer_engine.llm.router import LLMRouter


def _route(message: str, **ctx) -> HubDecision:
    req = HubRequest(message=message, user_id="u1", context=ctx)
    return asyncio.run(route_message(req, llm_router=LLMRouter()))


# --------------------------------------------------------------------------- catalog

def test_catalog_unique_names() -> None:
    names = tool_names()
    assert len(names) == len(set(names))
    assert "chapter.write" in names and "library.retrieve" in names


def test_catalog_prompt_lists_kinds() -> None:
    p = render_catalog_prompt()
    assert "chapter.write [task]" in p
    assert "library.retrieve [info]" in p


def test_lookup_resolves_aliases() -> None:
    assert lookup("chapter", "write").name == "chapter.write"
    assert lookup(None, "write_chapter").name == "chapter.write"  # alias
    assert lookup("library", "list_outlines").name == "library.list-outlines"  # alias
    assert lookup("nope", "nope") is None


def test_every_task_op_is_load_bearing_and_info_is_read() -> None:
    info = {s.name for s in CATALOG if s.kind == "info"}
    task = {s.name for s in CATALOG if s.kind == "task"}
    assert "chapter.write" in task and "brainstorm.story" in task and "research.run" in task
    assert "library.retrieve" in info and "library.list-outlines" in info


# --------------------------------------------------------------------------- routing (info)

def test_write_chapter_routes_to_task() -> None:
    d = _route("write the next chapter")
    assert d.tool == "chapter" and d.op == "write" and d.kind == "task"


def test_list_outlines_is_info() -> None:
    d = _route("list all my outlines")
    assert d.tool == "library" and d.op == "list-outlines" and d.kind == "info"


def test_retrieve_is_info() -> None:
    d = _route("pull up The Burial Mound")
    assert d.tool == "library" and d.op == "retrieve" and d.kind == "info"


def test_revert_outline_does_not_brainstorm() -> None:
    # the classic n8n bug: "revert" matched the brainstorm regex -> full regenerate. Now revert is its
    # own library.revert op (task), not a regenerate — assert it never lands on brainstorm.story.
    d = _route("revert outline for The Burial Mound to version 2")
    assert d.tool == "library" and d.op == "revert"
    assert d.op != "story"
    assert d.params["version_number"] == 2 and d.params["scope"] == "outline"


def test_revise_vs_edit_outline() -> None:
    assert _route("revise the outline").op == "revise-outline"
    assert _route("edit the outline to rename Tayak to Tara").op == "edit-outline"


def test_brainstorm_story_is_task() -> None:
    d = _route("brainstorm a new sci-fi novel about a generation ship")
    assert d.tool == "brainstorm" and d.op == "story" and d.kind == "task"


def test_repair_plan_qa_routes() -> None:
    assert _route("fix chapter 8").op == "repair"
    assert _route("plan the chapter").op == "plan"
    assert _route("run QA on chapter 3").op == "qa"


def test_chapter_number_extracted() -> None:
    assert _route("write chapter 9 of The Burial Mound").params["chapter_number"] == 9
    assert _route("fix chapter 8").params["chapter_number"] == 8
    assert _route("write the prologue").params["chapter_number"] == "Prologue"
    assert _route("write the epilogue").params["chapter_number"] == "Epilogue"


# --------------------------------------------------------------------------- email-content (E2E-1)

def test_email_content_is_task_and_in_catalog() -> None:
    assert lookup("library", "email-content").name == "library.email-content"
    assert lookup(None, "email_report").name == "library.email-content"  # alias
    assert "library.email-content" in {s.name for s in CATALOG if s.kind == "task"}


def test_email_inline_extracts_content_subject_recipient() -> None:
    d = _route(
        'Send me an email report with this content:\n\n# Trends\n\n- a\n\n'
        'Send it to eric@agileadtesting.com with subject line "Regression Test: Email Report"'
    )
    assert d.tool == "library" and d.op == "email-content" and d.kind == "task"
    assert d.params["content"].startswith("# Trends")
    assert "Send it to" not in d.params["content"]  # trailing instruction stripped
    assert d.params["subject"] == "Regression Test: Email Report"
    assert d.params["recipient"] == "eric@agileadtesting.com"


def test_email_resolve_modes() -> None:
    d = _route('Email me the outline for "The Seed Vault"')
    assert d.op == "email-content" and d.params["content_type"] == "outline"
    assert d.params["title"] == "The Seed Vault"

    d = _route('Email me chapter 1 of "The Seed Vault"')
    assert d.op == "email-content" and d.params["content_type"] == "chapter"
    assert d.params["chapter_number"] == 1 and d.params["title"] == "The Seed Vault"

    d = _route("Email me the short story about the Roman soldier and the Colosseum")
    assert d.op == "email-content" and d.params["content_type"] == "short_story"
    assert "search_term" in d.params  # descriptive, no quoted title


def test_email_beats_retrieve_and_chapter_write() -> None:
    # "email me" must win over the retrieve/chapter branches the same words would otherwise hit.
    assert _route("Email me the newsletter about revolutions").op == "email-content"
    assert _route("Email me chapter 1 of The Seed Vault").op == "email-content"


# --------------------------------------------------------------------------- versions / revert / trash (E2E-2)

def test_versions_outline_vs_content() -> None:
    d = _route('Show outline version history for "The Accord"')
    assert d.tool == "library" and d.op == "versions" and d.kind == "info"
    assert d.params["scope"] == "outline" and d.params["project_title"] == "The Accord"

    d = _route("Show version history for 11111111-2222-3333-4444-555555555555")
    assert d.op == "versions" and d.params["scope"] == "content"
    assert d.params["content_id"] == "11111111-2222-3333-4444-555555555555"

    d = _route("Get version 1 of 11111111-2222-3333-4444-555555555555")
    assert d.op == "versions" and d.params["mode"] == "get" and d.params["version_number"] == 1


def test_revert_is_task_with_version() -> None:
    d = _route('Revert the outline for "The Accord" to version 1')
    assert d.tool == "library" and d.op == "revert" and d.kind == "task"
    assert d.params["scope"] == "outline" and d.params["version_number"] == 1
    assert d.params["project_title"] == "The Accord"


def test_trash_actions_route_and_dispatch_kind() -> None:
    # delete/undelete are forced async (queued) via build_dispatch_plan; list_deleted stays sync.
    d = _route('Delete the draft titled "The Forgotten Engineers of Rome"')
    assert d.op == "lifecycle" and d.params["action"] == "delete"
    assert build_dispatch_plan(d, HubRequest(message="x", user_id="u1")).action == "enqueue"

    d = _route("Undelete The Forgotten Engineers of Rome")
    assert d.op == "lifecycle" and d.params["action"] == "undelete"
    assert build_dispatch_plan(d, HubRequest(message="x", user_id="u1")).action == "enqueue"

    d = _route("Show my deleted blog posts")
    assert d.op == "lifecycle" and d.params["action"] == "list_deleted"
    assert d.params["content_type_filter"] == "blog_post"
    assert build_dispatch_plan(d, HubRequest(message="x", user_id="u1")).action == "call_sync"

    assert _route("Show me my trash").params["action"] == "list_deleted"


# --------------------------------------------------------------------------- newsletter (E2E-3)

def test_newsletter_is_task_with_topic_genre_date() -> None:
    d = _route('Write a newsletter for the political-scifi genre. Topic: "Power Structures in Space". '
               'Genre slug: political-scifi. Date: 2026-03-10.')
    assert d.tool == "chapter" and d.op == "newsletter" and d.kind == "task"
    assert d.params["genre_slug"] == "political-scifi"
    assert d.params["topic"] == "Power Structures in Space"
    assert d.params["date"] == "2026-03-10"


def test_newsletter_voice_phrasing_and_today() -> None:
    d = _route("Write me a newsletter for the political history genre about revolutions that "
               "changed the world date today")
    assert d.op == "newsletter" and d.params["genre_slug"] == "political-history"
    assert d.params["date"] == "today"


def test_email_newsletter_is_not_write_newsletter() -> None:
    # "email me the newsletter" must stay library.email-content, never chapter.newsletter.
    assert _route("Email me the newsletter about revolutions").op == "email-content"


# --------------------------------------------------------------------------- chapter.plan dual-arc (E2E-4)

def test_brainstorm_with_arc_extracts_arc_title_chapters() -> None:
    d = _route('Brainstorm a book using the Hero\'s Journey called "The Signal Beneath." '
               "Genre: post-apocalyptic. 8 chapters.")
    assert d.tool == "brainstorm" and d.op == "story"
    assert d.params["story_arc"] == "Hero's Journey"
    assert d.params["title"] == "The Signal Beneath"
    assert d.params["target_chapter_count"] == 8


def test_chapter_plan_arc_override() -> None:
    d = _route('Create a chapter outline for Chapter 2 of "The Signal Beneath" using the Fichtean Curve')
    assert d.tool == "chapter" and d.op == "plan"
    assert d.params["chapter_number"] == 2
    assert d.params["chapter_story_arc"] == "Fichtean Curve"
    assert d.params["project_title"] == "The Signal Beneath"


def test_chapter_plan_nonconflict_arc_and_prologue() -> None:
    d = _route('Create a chapter outline for Chapter 4 of "The Signal Beneath" using Kishōtenketsu. '
               "This should be a quieter chapter.")
    assert d.op == "plan" and d.params["chapter_story_arc"] == "Kishōtenketsu"
    assert d.params["project_title"] == "The Signal Beneath"

    d = _route('Create a chapter outline for the Prologue of "The Signal Beneath"')
    assert d.op == "plan" and d.params["chapter_number"] == "Prologue"
    assert d.params["project_title"] == "The Signal Beneath"


# --------------------------------------------------------------------------- eve-callback (E2E-5)

def test_callback_routes_with_mode_and_type() -> None:
    d = _route("Pull up my draft blog post about aqueducts and call me back so we can revise it")
    assert d.tool == "notify" and d.op == "eve-callback" and d.kind == "task"
    assert d.params["callback_mode"] == "review" and d.params["content_type"] == "blog"

    d = _route("Load the research report on post apocalyptic trends and call me back let's brainstorm")
    assert d.op == "eve-callback" and d.params["callback_mode"] == "brainstorm"
    assert d.params["content_type"] == "research_report"


def test_callback_help_me_improve_variant() -> None:
    # V28: retrieve verb + "help me improve" (no literal "call me back") still routes to the callback.
    d = _route("Get my short story about the Roman soldier under the Colosseum and help me improve it")
    assert d.op == "eve-callback" and d.params["content_type"] == "short_story"
    # a plain chat edit with no "get my" must NOT hijack to the callback
    assert _route("fix chapter 3").op != "eve-callback"


# --------------------------------------------------------------------------- short-story arc, R119, multi-task

def test_brainstorm_short_story_arc_title_sections() -> None:
    d = _route("Brainstorm a short story using Freytags Pyramid about a plague doctor in Manhattan. "
               "Genre: post-apocalyptic. Title: The Inoculator. Sections: 5.")
    assert d.tool == "brainstorm" and d.op == "short-story"
    assert d.params["story_arc"] == "Freytags Pyramid"
    assert d.params["title"] == "The Inoculator"
    assert d.params["sections"] == 5


def test_character_consistency_check_routes_to_qa() -> None:
    d = _route('Check Chapter 1 of "The Signal Beneath" for character name consistency with the book outline')
    assert d.tool == "chapter" and d.op == "qa"
    assert d.params["chapter_number"] == 1 and d.params["project_title"] == "The Signal Beneath"


def test_split_tasks_multi_and_single() -> None:
    parts = split_tasks("Write a newsletter for the ancient history genre and also pull up my research "
                        "report and call me back to brainstorm")
    assert len(parts) == 2 and parts[0].startswith("Write a newsletter")
    assert "call me back" in parts[1]
    # a normal single-task message is never split
    assert split_tasks("Write chapter 5 of The Burial Mound") == ["Write chapter 5 of The Burial Mound"]


def test_research_and_cover_and_social() -> None:
    assert _route("research Late Woodland burial mounds").op == "run"
    assert _route("generate cover art").op == "cover-art"
    assert _route("repurpose this for social media posts").op == "social-posts"


def test_scrape_extracts_url() -> None:
    d = _route("scrape https://example.com/article")
    assert d.tool == "media" and d.op == "scrape-url"
    assert d.params.get("url") == "https://example.com/article"


def test_unmatched_is_conversation() -> None:
    d = _route("hey there, how are you?")
    assert d.kind == "conversation"


# --------------------------------------------------------------------------- anti-misroute (ported)
# Each of these defends a specific bug the n8n hub's preprocess_message was patched to fix.

def test_write_outline_is_not_chapter_write() -> None:
    # "write the outline" must NOT hit chapter.write — it's a brainstorm op
    d = _route("write the outline for my new novel")
    assert not (d.tool == "chapter" and d.op == "write")


def test_restore_outline_does_not_brainstorm() -> None:
    d = _route("restore the outline for The Burial Mound")
    assert d.kind == "info" and d.tool == "library"


def test_add_chapter_is_revise_not_edit() -> None:
    # "add a chapter" is excluded from edit-outline -> revise-outline (structural change)
    d = _route("add a chapter to The Burial Mound about the flood")
    assert d.tool == "brainstorm" and d.op == "revise-outline"


def test_make_character_age_is_edit_outline() -> None:
    d = _route("make Nora 40 years old")
    assert d.tool == "brainstorm" and d.op == "edit-outline"
    assert d.params.get("directive")


def test_approve_by_number() -> None:
    d = _route("approve 3")
    assert d.tool == "library" and d.op == "lifecycle"
    assert d.params["action"] == "approve" and d.params["chapter_number"] == 3


def test_approve_chapter_of_project() -> None:
    d = _route("publish chapter 5 of The Burial Mound")
    assert d.op == "lifecycle" and d.params["action"] == "publish"
    assert d.params["chapter_number"] == 5
    assert "burial mound" in d.params["project_title"].lower()


def test_qa_vs_repair_split() -> None:
    assert _route("quality check chapter 3").op == "qa"
    assert _route("clean up the duplicates in chapter 3").op == "repair"


def test_outline_prologue_is_chapter_plan() -> None:
    d = _route("outline the prologue")
    assert d.tool == "chapter" and d.op == "plan"


def test_format_kindle_is_not_an_engine_op() -> None:
    # CR-010 A1: Kindle/.docx export is a server-side download (Workbench Export tab → POST
    # /api/export/docx), not an engine op. The old `chapter.format-kindle` stub returned a fake path
    # and was removed; a "format for kindle" chat message degrades to conversation so the agent can
    # point the user at the Export tab.
    for msg in ("format the book for kindle at 5x8", "format my novel for kindle"):
        d = _route(msg)
        assert d.kind == "conversation"
        assert d.tool is None and d.op is None


def test_list_projects_routes_to_list() -> None:
    d = _route("list all my projects")
    assert d.tool == "library" and d.op == "list-outlines"


def test_write_chapter_extracts_project_title() -> None:
    d = _route("write chapter 9 of The Burial Mound")
    assert d.op == "write" and d.params["chapter_number"] == 9
    assert "burial mound" in d.params["project_title"].lower()


# --------------------------------------------------------------------------- numbered selection

def test_numbered_selection_picks_item() -> None:
    last = [
        {"project_title": "Alpha", "project_id": "a1", "content_type": "outline"},
        {"project_title": "Beta", "project_id": "b2", "content_type": "outline"},
    ]
    d = _route("2", last_list=last)
    assert d.kind == "info" and d.op == "retrieve"
    assert d.params["project_title"] == "Beta" and d.params["project_id"] == "b2"


def test_numbered_selection_ordinal_and_hash() -> None:
    last = [{"project_title": "Alpha"}, {"project_title": "Beta"}, {"project_title": "Gamma"}]
    assert _route("the first one", last_list=last).params["project_title"] == "Alpha"
    assert _route("#3", last_list=last).params["project_title"] == "Gamma"
    assert _route("the last one", last_list=last).params["project_title"] == "Gamma"


def test_numbered_selection_needs_context() -> None:
    # a bare number with no last_list is not a selection -> falls through to conversation
    assert _route("2").kind == "conversation"


# --------------------------------------------------------------------------- normalise

def test_normalise_unknown_tool_degrades_to_conversation() -> None:
    out = _normalise(HubDecision(kind="task", tool="teleport", op="now"))
    assert out.kind == "conversation"


def test_normalise_snaps_kind_to_spec() -> None:
    # router mislabels a retrieve as a task -> snapped back to info
    out = _normalise(HubDecision(kind="task", tool="library", op="retrieve"))
    assert out.kind == "info"


# --------------------------------------------------------------------------- dispatch

def _plan(message: str, **ctx):
    req = HubRequest(message=message, user_id="u1", context=ctx)
    return build_dispatch_plan(_heuristic_route(message) if not ctx else _route(message, **ctx), req)


def test_dispatch_conversation_replies() -> None:
    req = HubRequest(message="hi", user_id="u1")
    plan = build_dispatch_plan(HubDecision(kind="conversation", assistant_message="Hello!"), req)
    assert plan.action == "reply" and plan.assistant_message == "Hello!"


def test_dispatch_info_is_sync() -> None:
    req = HubRequest(message="list outlines", user_id="u1")
    d = HubDecision(kind="info", tool="library", op="list-outlines")
    plan = build_dispatch_plan(d, req)
    assert plan.action == "call_sync"
    assert plan.body["async"] is False and plan.body["op"] == "list-outlines"
    assert plan.body["user_id"] == "u1"


def test_dispatch_task_enqueues_with_persist() -> None:
    req = HubRequest(message="write chapter 5", user_id="u1")
    d = HubDecision(kind="task", tool="chapter", op="write", params={"chapter_number": 5})
    plan = build_dispatch_plan(d, req)
    assert plan.action == "enqueue"
    assert plan.body["async"] is True and plan.body["persist"] is True
    assert plan.body["chapter_number"] == 5 and plan.body["op"] == "write"


def test_dispatch_fills_project_anchor_from_context() -> None:
    req = HubRequest(message="write the next chapter", user_id="u1",
                     context={"project_id": "p1", "project_title": "The Burial Mound"})
    d = HubDecision(kind="task", tool="chapter", op="write", params={})
    plan = build_dispatch_plan(d, req)
    assert plan.body["project_id"] == "p1"
    assert plan.body["project_title"] == "The Burial Mound"


# --------------------------------------------------------------------------- conversation-context pronouns

def test_blog_about_that_binds_research_anchor() -> None:
    # V22 msg2: "now write a blog post about that" resolves "that" to the prior research topic.
    d = _route("Now write a blog post about that for the ancient history genre about fifteen hundred words",
               last_research_title="the fall of the Roman Empire")
    assert d.tool == "chapter" and d.op == "blog"
    assert d.params.get("topic") == "the fall of the Roman Empire"


def test_email_that_research_binds_anchor_when_threaded() -> None:
    # V03 with conversation context: "summary of that research" → the report just discussed.
    d = _route("Send me an email with a summary of that research use the subject line voice test research report",
               last_research_title="the fall of the Roman Empire")
    assert d.tool == "library" and d.op == "email-content"
    assert d.params.get("title") == "the fall of the Roman Empire"


def test_email_that_research_flags_allow_recent_without_context() -> None:
    # V03 single-turn: no anchor → flag the op to fall back to the most-recent report.
    d = _route("Send me an email with a summary of that research use the subject line voice test research report")
    assert d.tool == "library" and d.op == "email-content"
    assert d.params.get("allow_recent") is True
    assert not d.params.get("title")


def test_concrete_blog_topic_not_overwritten_by_context() -> None:
    # A message that names its own topic must be left alone even with a stale anchor present.
    d = _route("Write a blog post about quantum computing for the ai-marketing genre",
               last_research_title="the fall of the Roman Empire")
    assert d.tool == "chapter" and d.op == "blog"
    assert "quantum computing" in (d.params.get("topic") or "").lower()


def test_explicit_blog_write_is_deterministic() -> None:
    # V22: "write a blog post about that" must ALWAYS route to chapter.blog (Gemini flakes to conversation).
    for msg in ["Now write a blog post about that for the ancient history genre about 1500 words",
                "write me a blog post about the fall of Rome"]:
        d = _route(msg)
        assert d.tool == "chapter" and d.op == "blog", msg


def test_explicit_newsletter_and_short_story_writes_are_deterministic() -> None:
    assert (_route("write a newsletter for the ai-marketing genre").tool,
            _route("write a newsletter for the ai-marketing genre").op) == ("chapter", "newsletter")
    d = _route("write a short story about a lighthouse keeper")
    assert d.tool == "chapter" and d.op == "short-story"


def test_blog_write_with_context_binds_research_anchor() -> None:
    # The override routes to blog; conversation-context then swaps "that" for the prior research topic.
    d = _route("Now write a blog post about that for the ancient history genre",
               last_research_title="the fall of the Roman Empire")
    assert d.tool == "chapter" and d.op == "blog"
    assert d.params.get("topic") == "the fall of the Roman Empire"


def test_email_me_the_blog_is_not_a_blog_write() -> None:
    # "email me the blog" must stay email-content, not get stolen by the blog-write override.
    d = _route("email me the blog post about Rome")
    assert d.tool == "library" and d.op == "email-content"


def test_social_params_natural_phrasing_extracts_project_and_topic() -> None:
    """Regression: a real user's phrasing (no 'repurpose' keyword) must still resolve the project and
    give the generator real content — otherwise posts persist with project_id=NULL (invisible in the
    project Social tab) and the generator falls back to a '(fixture)' placeholder. See media_step bug
    2026-07-05."""
    from writer_engine.hub.router import _social_params

    p = _social_params("write a social media post for the last signal introducing our newsletter")
    assert (p.get("project_title") or "").lower() == "last signal"
    assert p.get("summary") and "fixture" not in p["summary"].lower()
    assert len(p["summary"]) > 5

    # Platform-only ask must NOT invent a project named "social media" / a platform.
    q = _social_params("make a twitter post for social media")
    assert q.get("project_title") is None

    # Canonical 'repurpose' phrasing still works.
    r = _social_params("Repurpose The Last Signal for social media")
    assert (r.get("project_title") or "").lower() == "last signal"
