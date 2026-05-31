"""Newsletter-pipeline schemas (decisions #1-#3).

Output shapes mirror the n8n parsers in `Content - Newsletter Agent V2` so the engine produces a
byte-comparable artifact (the parity target in :doc:`engine-api-system-tests`).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _coerce_str_list(v: Any) -> Any:
    """Coerce the messy shapes LLMs emit for a ``list[str]`` field into a clean list of strings.

    The picker (Gemini) frequently returns ``identifiers`` (and sometimes ``external_source_links``)
    as a dict like ``{"id": "<uuid>"}`` or a list of such dicts, instead of a flat list of id
    strings. Pydantic then rejects the whole ``PickedStories`` payload ("Input should be a valid
    list"). Normalise here in a ``mode="before"`` validator. Never raises — anything we can't make
    sense of is returned unchanged so pydantic produces its normal validation error.
    """

    def _one(item: Any) -> str | None:
        if item is None:
            return None
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            for key in ("id", "identifier", "uuid", "url", "link"):
                if key in item and item[key] is not None:
                    return str(item[key])
            vals = [x for x in item.values() if x is not None]
            return str(vals[0]) if vals else None
        return str(item)

    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        v = [v]
    if isinstance(v, list):
        return [s for s in (_one(x) for x in v) if s is not None and s != ""]
    return v  # unknown shape — let pydantic raise its normal error


class IngestedArticle(BaseModel):
    """An item lifted from ``content_ingestion_v2`` by ``gather-svc``."""

    model_config = ConfigDict(extra="ignore")

    id: str
    key: str
    user_id: str
    type: str
    title: str
    source_name: str | None = None
    source_url: str | None = None
    image_urls: list[str] = Field(default_factory=list)
    external_source_urls: list[str] = Field(default_factory=list)
    published_timestamp: str | None = None
    markdown: str | None = None


class SelectedStory(BaseModel):
    """One story chosen by ``pick-svc`` — schema mirrors the n8n ``top_stories_parser``."""

    title: str
    summary: str
    identifiers: list[str] = Field(default_factory=list)
    external_source_links: list[str] = Field(default_factory=list)

    @field_validator("identifiers", "external_source_links", mode="before")
    @classmethod
    def _normalise_str_lists(cls, v: Any) -> Any:
        return _coerce_str_list(v)


class PickedStories(BaseModel):
    top_selected_stories: list[SelectedStory]
    chain_of_thought: str = ""


class SubjectLineProposal(BaseModel):
    """Output of ``subject-svc`` — mirrors n8n ``subject_line_parser``."""

    subject_line: str
    pre_header_text: str
    additional_subject_lines: list[str] = Field(default_factory=list)
    subject_line_reasoning: str = ""
    pre_header_text_reasoning: str = ""


class StorySegment(BaseModel):
    """Output of ``segment-svc`` per story — mirrors ``story_segment_output_parser``."""

    story_title: str
    newsletter_section_content: str
    chosen_image_url: str | None = None
    image_options: list[str] = Field(default_factory=list)


class ImageOptions(BaseModel):
    """Output of ``image-svc`` — image candidates for one story."""

    story_title: str
    options: list[str] = Field(default_factory=list)
    auto_pick: str | None = None


class AssembledNewsletter(BaseModel):
    """``assemble-svc`` output — full markdown body of the newsletter."""

    intro: str
    segments: list[StorySegment]
    other_top_stories: str = ""
    markdown_body: str


class RenderedNewsletter(BaseModel):
    """``render-svc`` output — branded HTML body keyed off ``newsletter_templates_v2``."""

    html_body: str
    masthead_template_id: str | None = None


class NewsletterSendRow(BaseModel):
    """Shape persisted by ``persist-svc`` to ``newsletter_sends_v2``."""

    edition_id: str
    send_date: str
    subject: str
    pre_header_text: str | None = None
    markdown_body: str
    html_body: str
    status: str = "saved"
    metadata: dict[str, Any] = Field(default_factory=dict)


class DeliveryResult(BaseModel):
    """``deliver-svc`` output — BOTH email + web permalink per decision #1."""

    recipients_emailed: int = 0
    permalink_url: str | None = None
    message_ids: list[str] = Field(default_factory=list)


class ApprovalReviewPayload(BaseModel):
    """The blob shown in the UI at each HITL gate (replaces the dropped share_*_email content)."""

    stage: str
    title: str
    body: dict[str, Any]


class NewsletterRunConfig(BaseModel):
    """Top-level input to ``newsletter-orch.run``."""

    edition_id: str
    send_date: str
    user_id: str | None = None
    previous_newsletter_content: str = ""
    max_stories: int = 5
