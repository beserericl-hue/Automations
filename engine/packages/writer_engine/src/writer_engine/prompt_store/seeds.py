"""Default prompt seeds loaded at process start.

These are minimal, structured-output-friendly placeholders keyed by the same names the n8n workflow uses
(``newsletter.pick_top_stories``, etc.). The verbatim n8n prompts will be ported into ``app_config.prompts``
(Supabase) and hot-reloaded via ``POST /admin/reload-prompts``; that's the [[engine-api-system-tests]] L5 parity
target. Defaults here ensure the engine boots without DB access and gives sensible structured output during
development.
"""

from __future__ import annotations

from writer_engine.prompt_store.store import get_prompt_store

DEFAULT_PROMPTS: dict[str, str] = {
    # ---- Newsletter ---------------------------------------------------------
    "newsletter.pick_top_stories.system": (
        "You are an AI news editor. Given the day's ingested articles, pick the top stories that matter most to a "
        "technical reader. Output strict JSON matching the PickedStories schema."
    ),
    "newsletter.pick_top_stories.user_template": (
        "Today's articles:\n{articles}\n\nPick the top {max_stories} stories. Return JSON with keys "
        "'top_selected_stories' (array of {{title, summary, identifiers, external_source_links}}) and "
        "'chain_of_thought' (your selection reasoning)."
    ),
    "newsletter.subject.system": (
        "You write subject lines + preheaders for a tech-newsletter. Return strict JSON matching the "
        "SubjectLineProposal schema."
    ),
    "newsletter.subject.user_template": (
        "Selected stories:\n{stories}\n\nWrite a primary subject_line, pre_header_text, three "
        "additional_subject_lines, and brief reasoning for each."
    ),
    "newsletter.segment.system": (
        "You write per-story newsletter sections in the Writers Workbench voice. Return JSON matching StorySegment."
    ),
    "newsletter.segment.user_template": (
        "Story:\n{story_json}\n\nSource articles (markdown):\n{sources}\n\nImage options:\n{images}\n\nWrite "
        "the newsletter_section_content. If image options exist, choose one for chosen_image_url; otherwise leave null."
    ),
    "newsletter.image.system": (
        "Given a story and its source articles, return up to 5 image URLs (from the article HTML) as JSON "
        "matching ImageOptions."
    ),
    "newsletter.image.user_template": "Story: {story_json}\nSources: {sources}",
    "newsletter.intro.system": (
        "Write a 2-3 sentence intro for today's newsletter referencing the selected stories. Plain text."
    ),
    "newsletter.intro.user_template": "Stories:\n{stories}",
    "newsletter.other_top_stories.system": (
        "Write a short 'Other top stories' roundup in bullet-list markdown referencing remaining ingested items."
    ),
    "newsletter.other_top_stories.user_template": "Remaining items:\n{items}",
    # ---- Chapter ------------------------------------------------------------
    "chapter.write.system": "You write a novel chapter with the LOCKED CHARACTER ROSTER and outline below.",
    "chapter.write.user_template": "ROSTER:\n{roster}\n\nOUTLINE:\n{outline}\n\nWrite chapter {chapter_number}.",
    "chapter.qa.system": "You QA the chapter against the 9-check rubric. Return JSON scores 0..1 per dimension.",
    "chapter.qa.user_template": "Chapter:\n{chapter}",
    # ---- Brainstorm ---------------------------------------------------------
    "brainstorm.story.system": "You brainstorm a novel outline (premise, themes, chapter beats, characters).",
    "brainstorm.story.user_template": "Requirements: {requirements}\nStory arc hint: {story_arc}",
    # ---- Research -----------------------------------------------------------
    "research.derive_questions.system": "Generate 3-5 focused research questions for the topic.",
    "research.derive_questions.user_template": "Topic: {topic}\nContext: {context}",
    "research.synthesize.system": "Compose a markdown research report citing the source URLs.",
    "research.synthesize.user_template": "Questions + answers:\n{qa}",
}


def seed_default_prompts() -> int:
    """Register every default prompt + the verbatim n8n baseline. Idempotent.

    Returns the total number of keys registered (placeholders + n8n baseline).
    """
    store = get_prompt_store()
    for key, value in DEFAULT_PROMPTS.items():
        store.register_default(key, value)
    # Also load the verbatim n8n baseline under the ``n8n_baseline.*`` prefix (separate namespace; the step
    # services keep using DEFAULT_PROMPTS until the n8n-token-to-engine-vars mapping is in place).
    from writer_engine.prompt_store.n8n_seeds import load_n8n_seeds

    n8n_count = load_n8n_seeds()
    return len(DEFAULT_PROMPTS) + n8n_count
