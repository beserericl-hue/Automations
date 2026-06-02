"""Chapter / long-form schemas (F1 write workshop). Mirrors the n8n ``write_chapter`` worker."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class WriteChapterRequest(BaseModel):
    """Public ``/v1/chapters/write`` shape — also the internal step payload."""

    model_config = ConfigDict(extra="ignore")

    project_id: UUID
    chapter_number: int
    chapter_run_id: UUID
    llm_strategy: Literal["sonnet", "haiku", "hybrid-draft-polish", "hybrid-smart", "tier-default"] = (
        "tier-default"
    )
    research_topic: str | None = None
    style_directives: list[str] = Field(default_factory=list)
    sub_chapter_count_override: int | None = None
    use_qa_report_as_input: bool = False
    citation_mode: Literal["auto", "invisible", "inline"] = "auto"


class WriteChapterResponse(BaseModel):
    chapter_id: UUID
    chapter_run_id: UUID
    content_text: str
    word_count: int
    sub_chapter_count: int
    bible_entries_added: int = 0
    craft_passes: int = 0  # how many craft-revision passes ran (0 = single draft)
    craft_qa: dict[str, float] | None = None  # final craft-QA scores when the revision loop ran


class BibleEntry(BaseModel):
    entry_type: Literal["character", "place", "object", "concept", "event"]
    name: str
    description: str


class QaReport(BaseModel):
    chapter_id: UUID
    scores: dict[str, float]
    findings: list[dict[str, str]] = Field(default_factory=list)


class ChapterCraftQa(BaseModel):
    """LLM-scored craft-QA result — "does the chapter follow the writing-craft guides?"

    The dimensions map to the Follett craft rubrics (Writing Craft vault pages): each is the answer
    to a "does X follow the guide?" question. ``findings`` lists concrete violations with a fix.
    """

    model_config = ConfigDict(extra="ignore")

    character_follows_guide: float = Field(ge=0.0, le=1.0)
    outline_follows_guide: float = Field(ge=0.0, le=1.0)
    dialogue_follows_guide: float = Field(ge=0.0, le=1.0)
    prose_transparent: float = Field(ge=0.0, le=1.0)
    story_turn_density: float = Field(ge=0.0, le=1.0)
    no_boring_paragraphs: float = Field(ge=0.0, le=1.0)
    period_language_ok: float = Field(ge=0.0, le=1.0)
    findings: list[dict[str, str]] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _unwrap_scores_envelope(cls, data: Any) -> Any:
        """Tolerate the ``{"scores": {...}, "findings": [...]}`` envelope the LLM sometimes returns.

        Observed on a live DB regression: the model nests the seven dimensions under a ``scores``
        key instead of emitting them flat. Hoist them so validation passes, and coerce any score
        given as a 0-100 int to the 0-1 float the schema expects.
        """
        if not isinstance(data, dict):
            return data
        out = dict(data)
        scores = out.pop("scores", None)
        if isinstance(scores, dict):
            for k, v in scores.items():
                out.setdefault(k, v)
        for dim in (
            "character_follows_guide",
            "outline_follows_guide",
            "dialogue_follows_guide",
            "prose_transparent",
            "story_turn_density",
            "no_boring_paragraphs",
            "period_language_ok",
        ):
            v = out.get(dim)
            if isinstance(v, (int, float)) and v > 1:
                out[dim] = round(v / 100.0, 3)
        return out


class DriftFinding(BaseModel):
    kind: str
    detail: str
    location: str | None = None


class DriftScanResult(BaseModel):
    chapter_id: UUID
    findings: list[DriftFinding] = Field(default_factory=list)


class BrainstormStoryRequest(BaseModel):
    project_id: UUID
    requirements: str
    story_arc: str | None = None
    research_topic: str | None = None


class BrainstormStoryResponse(BaseModel):
    outline: dict[str, object]


class ResearchRequest(BaseModel):
    project_id: UUID | None = None
    topic: str
    depth: Literal["quick", "standard", "deep"] = "standard"


class ResearchReportRow(BaseModel):
    id: UUID | None = None
    topic: str
    questions: list[str]
    report_markdown: str


class ResearchQuestion(BaseModel):
    """One craft-derived research question (follett_seeds.research.derive categories)."""

    model_config = ConfigDict(extra="ignore")

    question: str
    category: Literal[
        "framework", "daily_life", "object_technology", "profession_role", "geography", "language"
    ] = "framework"
    why: str = ""


class ResearchPlan(BaseModel):
    """Output of the derive step — 8-15 scene-generating questions across the craft categories."""

    model_config = ConfigDict(extra="ignore")

    questions: list[ResearchQuestion] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        """Tolerate a bare list of questions or {questions:[strings]} from the LLM."""
        if isinstance(data, list):
            data = {"questions": data}
        if isinstance(data, dict):
            qs = data.get("questions")
            if isinstance(qs, list):
                data = {**data, "questions": [{"question": q} if isinstance(q, str) else q for q in qs]}
        return data
