"""Chapter / long-form schemas (F1 write workshop). Mirrors the n8n ``write_chapter`` worker."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


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


class BibleEntry(BaseModel):
    entry_type: Literal["character", "place", "object", "concept", "event"]
    name: str
    description: str


class QaReport(BaseModel):
    chapter_id: UUID
    scores: dict[str, float]
    findings: list[dict[str, str]] = Field(default_factory=list)


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
