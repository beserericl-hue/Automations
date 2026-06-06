"""Chapter / long-form schemas (F1 write workshop). Mirrors the n8n ``write_chapter`` worker."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class WriteChapterRequest(BaseModel):
    """Public ``/v1/chapters/write`` shape — also the internal step payload."""

    model_config = ConfigDict(extra="ignore")

    project_id: UUID
    chapter_number: int
    # A unique id for THIS write run. The n8n path always supplied it; the engine hub (Path B, CR-004)
    # and Eve do not, so it defaults — a missing run id must not 500 the whole chapter write.
    chapter_run_id: UUID = Field(default_factory=uuid4)
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
    # Two-cycle QA telemetry: QA cycle 1 detects drift (vs outline/arc/roster) + research gaps;
    # QA cycle 2 corrects the drift and weaves in the researched facts. Surfaced for review.
    drift_report: dict[str, object] | None = None  # DriftReport from QA cycle 1 (pre-correction)
    research_gaps_filled: list[str] = Field(default_factory=list)  # research topics grounded at write-time
    research_facts: str = ""  # the period facts / local color woven into the chapter as written
    sub_chapter_briefs: list[dict[str, object]] = Field(default_factory=list)  # the chapter's sub-beats
    # Prompt-cache effectiveness across the sub-chapter calls (high cache_read vs input = caching works).
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


class SubChapterBrief(BaseModel):
    """One sub-chapter beat in a chapter's fan-out plan."""

    model_config = ConfigDict(extra="ignore")

    title: str = ""
    beat: str = ""
    pov_character: str = ""


class SubChapterPlan(BaseModel):
    """Plan that splits one chapter into N sub-chapters for depth (F1-1 fan-out)."""

    model_config = ConfigDict(extra="ignore")

    subchapters: list[SubChapterBrief] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        """Tolerate {subchapters|sub_chapters|chapters: [...]} and bare-string lists."""
        if isinstance(data, list):
            data = {"subchapters": data}
        if isinstance(data, dict):
            arr = data.get("subchapters") or data.get("sub_chapters") or data.get("chapters")
            if isinstance(arr, list):
                norm = [{"beat": x} if isinstance(x, str) else x for x in arr]
                data = {**data, "subchapters": norm}
        return data


class BibleEntry(BaseModel):
    entry_type: Literal["character", "place", "object", "concept", "event"]
    name: str
    description: str


class QaReport(BaseModel):
    chapter_id: UUID
    scores: dict[str, float]
    findings: list[dict[str, str]] = Field(default_factory=list)


class GenreEval(BaseModel):
    """LLM genre-fit score for a chapter (F1-2 genre-eval)."""

    model_config = ConfigDict(extra="ignore")

    genre_score: float = Field(ge=0.0, le=1.0)
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if not ({"genre_score", "notes"} & set(out)) and len(out) == 1:
            inner = next(iter(out.values()))
            if isinstance(inner, dict):
                out = dict(inner)
        v = out.get("genre_score")
        if isinstance(v, (int, float)) and v > 1:  # 0-100 -> 0-1
            out["genre_score"] = round(v / 100.0, 3)
        notes = out.get("notes")
        if isinstance(notes, str):
            out["notes"] = [notes] if notes.strip() else []
        return out


_BIBLE_TYPES = {"character", "place", "object", "concept", "event"}


class BibleExtract(BaseModel):
    """A chapter's extracted story-bible entries (F1-2 extract-bible)."""

    model_config = ConfigDict(extra="ignore")

    entries: list[BibleEntry] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        if isinstance(data, list):
            data = {"entries": data}
        if not isinstance(data, dict):
            return data
        arr = data.get("entries") or data.get("bible") or data.get("items") or []
        norm = []
        for e in arr if isinstance(arr, list) else []:
            if not isinstance(e, dict):
                continue
            t = str(e.get("entry_type") or e.get("type") or "concept").strip().lower()
            if t not in _BIBLE_TYPES:
                t = "concept"
            name = e.get("name") or e.get("title")
            desc = e.get("description") or e.get("desc") or ""
            if name:
                norm.append({"entry_type": t, "name": str(name), "description": str(desc)})
        return {"entries": norm}


class ChapterCraftQa(BaseModel):
    """LLM-scored craft-QA result — "does the chapter follow the writing-craft guides?"

    The dimensions map to the Follett craft rubrics (Writing Craft vault pages): each is the answer
    to a "does X follow the guide?" question. ``findings`` lists concrete violations with a fix.
    """

    model_config = ConfigDict(extra="ignore")

    # Every dimension defaults to 1.0 ("not flagged"): the model intermittently returns `null` for a
    # dimension it can't assess (e.g. outline_follows_guide when the QA prompt has no outline to
    # compare against). A single null used to fail the WHOLE QA (required float, None disallowed) ->
    # _score_chapter swallowed it -> craft_qa: null. The validator now coerces null/missing/non-numeric
    # to the default so one un-assessable dimension never discards the rest of the scores.
    character_follows_guide: float = Field(default=1.0, ge=0.0, le=1.0)
    outline_follows_guide: float = Field(default=1.0, ge=0.0, le=1.0)
    dialogue_follows_guide: float = Field(default=1.0, ge=0.0, le=1.0)
    prose_transparent: float = Field(default=1.0, ge=0.0, le=1.0)
    story_turn_density: float = Field(default=1.0, ge=0.0, le=1.0)
    no_boring_paragraphs: float = Field(default=1.0, ge=0.0, le=1.0)
    period_language_ok: float = Field(default=1.0, ge=0.0, le=1.0)
    character_consistency: float = Field(default=1.0, ge=0.0, le=1.0)
    # Places the chapter asserts a historical/period fact that should be researched/verified, or where
    # a researched detail would deepen the scene. Each: a short phrase. Drives "add research if needed".
    research_gaps: list[str] = Field(default_factory=list)
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
        # Unwrap a single-key wrapper envelope, e.g. {"chapter_craft_qa": {...}} or {"qa": {...}},
        # which the model sometimes adds around the real object (observed on a live run).
        dims = {
            "character_follows_guide",
            "outline_follows_guide",
            "dialogue_follows_guide",
            "prose_transparent",
            "story_turn_density",
            "no_boring_paragraphs",
            "period_language_ok",
            "character_consistency",
        }
        if not (dims & set(out)) and len(out) == 1:
            inner = next(iter(out.values()))
            if isinstance(inner, dict):
                out = dict(inner)
        scores = out.pop("scores", None)
        if isinstance(scores, dict):
            for k, v in scores.items():
                out.setdefault(k, v)
        for dim in dims:
            v = out.get(dim)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                # null / "N/A" / missing / a bool: the model couldn't (or wouldn't) score this
                # dimension — drop it so the field's default (1.0 = not flagged) applies instead of
                # failing the whole QA.
                out.pop(dim, None)
            elif v > 1:
                out[dim] = round(v / 100.0, 3)  # 0-100 scale -> 0-1
        return out


class DriftFinding(BaseModel):
    kind: str
    detail: str
    location: str | None = None


class DriftScanResult(BaseModel):
    chapter_id: UUID
    findings: list[DriftFinding] = Field(default_factory=list)


class DriftReport(BaseModel):
    """QA cycle 1 output — does the written chapter drift from the plan?

    ``story_drift``: ways the chapter deviates from the OUTLINE / story arc (wrong or missing beats,
    events that contradict the planned arc, continuity breaks). ``character_drift``: ways a character
    acts/looks/sounds inconsistently with the established roster (renamed, changed trait/age/role,
    out-of-character action, wrong relationship). ``research_gaps``: period facts / local color /
    events to verify or add. ``aligned`` is True only when none of the three lists has a real issue.
    QA cycle 2 consumes this to correct the drift and weave in the researched facts.
    """

    model_config = ConfigDict(extra="ignore")

    aligned: bool = True
    story_drift: list[str] = Field(default_factory=list)
    character_drift: list[str] = Field(default_factory=list)
    research_gaps: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        """Tolerate a single-key wrapper, dict-shaped drift entries, and an `aligned` derived from
        empty lists when the model omits it."""
        if not isinstance(data, dict):
            return data
        out = dict(data)
        keys = {"story_drift", "character_drift", "research_gaps", "aligned"}
        if not (keys & set(out)) and len(out) == 1:
            inner = next(iter(out.values()))
            if isinstance(inner, dict):
                out = dict(inner)
        for k in ("story_drift", "character_drift", "research_gaps"):
            v = out.get(k)
            if v is None:
                out[k] = []
            elif isinstance(v, str):
                out[k] = [v] if v.strip() else []
            elif isinstance(v, list):
                # entries may be plain strings, {"item": ...}/{"issue": ...} dicts, or stray None/empty
                # values — flatten to non-empty phrases (a None element must not crash the validator).
                flat = []
                for x in v:
                    if x is None:
                        continue
                    if isinstance(x, str):
                        s = x
                    elif isinstance(x, dict):
                        s = str(
                            x.get("item") or x.get("issue") or x.get("detail")
                            or x.get("problem") or x.get("description") or x
                        )
                    else:
                        s = str(x)
                    if s.strip():
                        flat.append(s)
                out[k] = flat
        if "aligned" not in out:
            out["aligned"] = not (out.get("story_drift") or out.get("character_drift"))
        return out


class BrainstormStoryRequest(BaseModel):
    project_id: UUID
    requirements: str
    story_arc: str | None = None
    research_topic: str | None = None


class BrainstormStoryResponse(BaseModel):
    outline: dict[str, object]


class StoryOutline(BaseModel):
    """Craft-composed outline (parity with the DB outline JSONB shape + Follett plot fields)."""

    model_config = ConfigDict(extra="ignore")

    title: str = "Untitled"
    premise: str = ""
    themes: list[str] = Field(default_factory=list)
    story_arc_name: str = ""
    dramatic_question: str = ""
    wow_factor: str = ""
    characters: list[dict[str, object]] = Field(default_factory=list)
    chapters: list[dict[str, object]] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        """Tolerate string themes + an {outline:{...}} envelope from the LLM."""
        if isinstance(data, dict):
            if isinstance(data.get("outline"), dict):
                data = data["outline"]
            themes = data.get("themes")
            if isinstance(themes, str):
                data = {**data, "themes": [t.strip() for t in themes.split(",") if t.strip()]}
        return data


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
    # Free string, not a Literal: the LLM returns the category in many casings/spellings
    # ("PROFESSION / ROLE", "FRAMEWORK") that a strict enum rejects. Normalised in the validator.
    category: str = "framework"
    why: str = ""

    @model_validator(mode="before")
    @classmethod
    def _norm_category(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("category"), str):
            c = data["category"].strip().lower().replace(" / ", "_").replace("/", "_").replace(" ", "_")
            data = {**data, "category": c or "framework"}
        return data


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
