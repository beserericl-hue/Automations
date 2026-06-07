"""Hub router — turn a free-text (or transcribed voice) message into a :class:`HubDecision`.

Primary path is **Gemini** (CR-004 spec): a short structured call that picks a tool from the catalog
and extracts params. Two deterministic layers wrap it:

* **numbered-list selection** runs first — "3" / "#2" / "the first one" only mean something against the
  last list shown, which the LLM can't see; we resolve it here (ports the n8n ``preprocess_message``).
* **regex heuristics** are the fallback when Gemini is unavailable or returns junk — and the offline
  path the unit tests exercise. They mirror the server ``classifier.ts`` rules so the two never drift.

The router never raises: a total failure degrades to a ``conversation`` decision (the hub asks the
user to clarify) rather than 500-ing.
"""

from __future__ import annotations

import re
from typing import Any

from writer_engine.config import get_settings
from writer_engine.llm.factory import get_router
from writer_engine.llm.router import LLMRouter, ProviderNotRegistered
from writer_engine.llm.structured import complete_structured
from writer_engine.telemetry.logging import get_logger

from .catalog import ToolSpec, lookup, render_catalog_prompt
from .schemas import HubDecision, HubRequest

logger = get_logger("hub.router")

# --------------------------------------------------------------------------- heuristics
#
# This is NOT a thin keyword table. It is a faithful port of the n8n hub's ``preprocess_message`` —
# ~100 lines of routing precedence and EXCLUSIONS that were each added to fix a specific misroute in
# production (the "revert outline → brainstorm" trap, "write the outline" wrongly hitting chapter-write,
# small edits regenerating the whole outline, approve-by-number, the format-kindle/chapter-outline
# shortcuts). Gemini is the primary router; this is the deterministic fallback AND the regression net
# that keeps those fixed bugs fixed. Order and the `not X` guards are load-bearing — do not reorder
# without re-checking the misroute each rule defends against. Cross-ref: server/src/lib/jobs/classifier.ts
# and workflows/01_the_author_agent_hub_v2.json::preprocess_message.

_URL_RE = re.compile(r"https?://\S+", re.I)
_CHAPTER_NUM_RE = re.compile(r"\bchapter\s+(\d{1,3})\b", re.I)

# --- intent detectors (mirrors preprocess_message, same flags/exclusions) ---
_IS_LIST = re.compile(r"\b(list|show|all|retrieve|get)\s", re.I)
_IS_WRITE = re.compile(r"\b(re)?(write|draft|compose)\s", re.I)
_HAS_LIBRARY_ACTION = re.compile(
    r"\b(approve|publish|reject|delete|undelete|schedule|unschedule|unpublish)\b", re.I)
_RETRIEVE = re.compile(
    r"\b(retrieve|pull\s+up|fetch\s+my|find\s+my|get\s+my\s+(draft|chapter|story|blog|newsletter|article|report)|"
    r"chapters?\s+from|all\s+chapters?\s+(from|of|in)|list\s+(story\s+)?arcs?|what\s+story\s+arcs?|available\s+arcs?|"
    r"(list|show|all)\s+(my\s+|all\s+)?(chapter\s+|book\s+)?outlines?|outline\s+(list|version|history)|"
    r"revert.{0,20}outline|restore.{0,20}outline|outline.{0,20}version|"
    r"revert.{0,20}chapter|restore.{0,20}chapter|chapter.{0,20}version.{0,5}history)", re.I)
_QA_CHAPTER = re.compile(
    r"\b(q/?a|qa|quality\s*(check|review|cleanup|clean\s*up)|clean\s*up|fix\s*(duplicate|name|inconsistenc)|dedup|edit)"
    r"\s*.{0,30}(chapter|prologue|epilogue)", re.I)
_QA_CHAPTER2 = re.compile(
    r"\b(chapter|prologue|epilogue).{0,20}(q/?a|cleanup|clean\s*up|fix\s*(duplicate|name)|dedup)", re.I)
_FIX_CHAPTER = re.compile(r"\bfix.{0,30}(chapter|prologue|epilogue)", re.I)
_QA_FIXY = re.compile(r"\b(fix|repair|clean\s*up|dedup|duplicate|inconsist)", re.I)  # → repair vs qa split
_EDIT_OUTLINE = re.compile(
    r"\b(make\s+\w+.{0,20}(years?\s+old|age\s+\d)|change.{0,20}(age|name|title|role|description)|"
    r"rename\s+(chapter|character)|rename\s+\w+\s+to\b|update.{0,20}(age|description|premise|role)|"
    r"using\s+this\s+outline.{0,20}(make|change|update|fix|set)|edit.{0,15}outline|"
    r"fix.{0,20}(chapter|brief|inconsisten|outline)|character\s+role\s+change|\d+\s+years?\s+old)", re.I)
_EDIT_OUTLINE_EXCLUDE = re.compile(
    r"\b(add.{0,10}chapter|new\s+chapter|change.{0,15}(arc|structure|timeline)|restructure|expand|brainstorm|rework)",
    re.I)
_BRAINSTORM = re.compile(
    r"\b(brainstorm|expand.{0,25}outline|add.{0,15}(more\s+)?chapter|develop.{0,20}character|"
    r"revis(e|ing).{0,20}(outline|story\s+arc)|rework.{0,20}(outline|story)|outline\s+(a|the|my|this)\s+\w|"
    r"plan\s+(a|the|my)\s+(novel|book|story)|create\s+(a|the|my)\s+(outline|book))", re.I)
_BRAINSTORM_REVISE = re.compile(  # revising an EXISTING outline vs a brand-new story
    r"\b(revis(e|ing)|rework|expand|add.{0,15}chapter|develop.{0,20}character)", re.I)
_PROJECT_LIST = re.compile(
    r"\b(list\s+(my\s+|all\s+)?projects?|my\s+projects?|all\s+projects?|what\s+projects?|show.{0,15}projects?)", re.I)
_LIBRARY = re.compile(
    r"\b(approve|unschedule|unpublish|publish|reject|schedule|delete|undelete|restore\s+from\s+trash|"
    r"email\s+(me\s+)?(the\s+|my\s+|this\s+)?(outline|research|chapter|story|blog|newsletter|report|draft)|"
    r"send\s+(me\s+)?(the\s+|my\s+|this\s+)?(outline|research|chapter|story|blog|newsletter|report|draft)|"
    r"list\s+(all|draft|published|scheduled|approved|rejected|deleted)|show\s+(deleted|trash)|content\s+librar|"
    r"version\s+histor|list\s+version|get\s+version)", re.I)
_FORMAT_KINDLE = re.compile(r"\b(format|kindle|manuscript|docx|generate\s+kdp)", re.I)
_FORMAT_KINDLE_OBJ = re.compile(r"\b(book|project|novel)\b", re.I)
_WRITING = re.compile(r"\b(re)?(write|draft|compose)\b[\w\s]{0,30}\b(chapter|prologue|epilogue)\b", re.I)
_WRITING_OUTLINE_EXCLUDE = re.compile(r"\b(write|draft|compose).{0,30}outline", re.I)
_CHAPTER_OUTLINE = re.compile(
    r"\b(chapter\s+outline|outline.{0,15}(chapter|prologue|epilogue)|"
    r"create.{0,15}(chapter|prologue|epilogue).{0,15}outline|plan.{0,15}(chapter|prologue|epilogue)|"
    r"prepare.{0,15}(chapter|prologue|epilogue))", re.I)
_BULK_APPROVE = re.compile(r"\b(approve|publish)\s+(all|every)\s+(chapters?|drafts?)", re.I)
_APPROVE_BY_NUM = re.compile(
    r"^(approve|publish|reject|delete|schedule)\s+(?:(?:chapter|ch)\s*)?#?(\d{1,2})(?:\s+(?:of|for|from|in)\s+(.+))?\s*$",
    re.I)
_PAGE_SIZE = re.compile(r"(\d+\.?\d*\s*x\s*\d+\.?\d*)", re.I)
_PROJECT_TAIL = re.compile(r"(?:of|for|from|in)\s+(?:the\s+)?(.+?)\s*$", re.I)

_ORDINALS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "last": -1,
}


def _extract_chapter_number(message: str) -> int | str | None:
    """Pull a chapter target from the message: prologue/epilogue (string) or an integer."""
    low = message.lower()
    if "prologue" in low:
        return "Prologue"
    if "epilogue" in low:
        return "Epilogue"
    m = _CHAPTER_NUM_RE.search(message)
    return int(m.group(1)) if m else None


def _extract_project_title(message: str) -> str | None:
    """Best-effort project title from a trailing 'of/for/from/in <title>' clause."""
    m = _PROJECT_TAIL.search(message)
    if not m:
        return None
    title = re.sub(r"\s*(for|in|as)\s+kindle.*$", "", m.group(1), flags=re.I).strip()
    # drop a leading "chapter N" that the tail regex may have swept in
    title = re.sub(r"^chapter\s+\d+\s*", "", title, flags=re.I).strip(" .")
    return title or None


def _chapter_params(message: str) -> dict[str, Any]:
    params: dict[str, Any] = {}
    ch = _extract_chapter_number(message)
    if ch is not None:
        params["chapter_number"] = ch
    title = _extract_project_title(message)
    if title:
        params["project_title"] = title
    return params


def _decide(tool: str, op: str, params: dict[str, Any], conf: float = 0.6) -> HubDecision:
    spec = lookup(tool, op)
    return HubDecision(
        kind=spec.kind if spec else "task", tool=tool, op=op, params=params,
        assistant_message="", confidence=conf,
    )


def _numbered_selection(req: HubRequest) -> HubDecision | None:
    """Resolve "3" / "#2" / "show me 3" / "the first one" / "the last one" against
    ``context['last_list']`` (ports preprocess_message's number-reference handling)."""
    items = req.context.get("last_list")
    if not isinstance(items, list) or not items:
        return None
    msg = req.message.strip().lower()

    idx: int | None = None
    m = (re.fullmatch(r"#?\s*(\d{1,2})", msg)
         or re.fullmatch(r"(?:show\s+(?:me\s+)?|get\s+|open\s+|select\s+|pick\s+)#?(\d{1,2})", msg))
    if m:
        idx = int(m.group(1))
    else:
        om = re.fullmatch(
            r"(?:show\s+(?:me\s+)?|get\s+|open\s+|select\s+|pick\s+)?(?:the\s+)?"
            r"(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)(?:\s+one)?", msg)
        if om:
            idx = _ORDINALS[om.group(1)]
    if idx is None:
        return None

    item = items[-1] if idx == -1 else (items[idx - 1] if 1 <= idx <= len(items) else None)
    if not isinstance(item, dict):
        return None
    title = item.get("project_title") or item.get("title") or item.get("name")
    params: dict[str, Any] = {"content_type": item.get("content_type", "outline")}
    if title:
        params["project_title"] = title
    if item.get("project_id"):
        params["project_id"] = item["project_id"]
    return HubDecision(
        kind="info", tool="library", op="retrieve", params=params,
        assistant_message=f"Opening {title or 'that item'}.", confidence=0.9,
    )


def _heuristic_route(message: str) -> HubDecision:
    """Deterministic precedence routing — Gemini's fallback and the offline regression net.

    Mirrors preprocess_message's order exactly: the chapter-outline shortcut and approve-by-number
    fire first; then a set of mutually-excluding flags resolve in a fixed priority so an ambiguous
    message (e.g. 'fix the outline') lands on the op that production proved correct."""
    msg = (message or "").strip()
    low = msg.lower()

    # 0. CHAPTER-OUTLINE shortcut — "outline ... prologue/epilogue" or "chapter outline", but NOT a
    #    list/retrieve and NOT a write. (preprocess line 1-11)
    is_list = bool(_IS_LIST.search(low))
    is_write = bool(_IS_WRITE.search(low))
    is_outline_kw = ("chapter outline" in low) or ("outline" in low and ("prologue" in low or "epilogue" in low))
    if not is_list and not is_write and is_outline_kw:
        return _decide("chapter", "plan", _chapter_params(msg), 0.7)

    # 1. APPROVE/PUBLISH/REJECT BY NUMBER — "approve 3", "publish chapter 5 of X" (preprocess line 21)
    m = _APPROVE_BY_NUM.match(msg)
    if m:
        params: dict[str, Any] = {"action": m.group(1).lower(), "chapter_number": int(m.group(2))}
        if m.group(3):
            params["project_title"] = m.group(3).strip()
        return _decide("library", "lifecycle", params, 0.8)

    # 1b. blog / short-story (n8n parity) — specific, BEFORE the generic brainstorm/write flags.
    if re.search(r"\bblog\b", low) and _IS_WRITE.search(low):
        return _decide("chapter", "blog", {"topic": msg}, 0.7)
    if re.search(r"\bshort\s+stor", low):
        if re.search(r"\b(brainstorm|outline|plan)\b", low):
            return _decide("brainstorm", "short-story", {"premise": msg}, 0.7)
        if _IS_WRITE.search(low):
            return _decide("chapter", "short-story", {"premise": msg}, 0.7)

    # 2. mutually-excluding flags (computed once, resolved in priority order)
    has_lib_action = bool(_HAS_LIBRARY_ACTION.search(low))
    is_retrieve = (not has_lib_action) and bool(_RETRIEVE.search(low))
    is_qa = bool(_QA_CHAPTER.search(low) or _QA_CHAPTER2.search(low) or _FIX_CHAPTER.search(low))
    is_edit = (not is_retrieve and not is_qa
               and bool(_EDIT_OUTLINE.search(low)) and not _EDIT_OUTLINE_EXCLUDE.search(low))
    is_brainstorm = (not is_retrieve and not is_edit and bool(_BRAINSTORM.search(low)))
    is_project = bool(_PROJECT_LIST.search(low))
    is_format_kindle = bool(_FORMAT_KINDLE.search(low) and _FORMAT_KINDLE_OBJ.search(low))
    is_library = bool(_LIBRARY.search(low))
    is_writing = (not is_qa and bool(_WRITING.search(low)) and not _WRITING_OUTLINE_EXCLUDE.search(low))
    is_chapter_outline = (not is_retrieve and not is_writing and bool(_CHAPTER_OUTLINE.search(low)))
    is_bulk_approve = bool(_BULK_APPROVE.search(low))

    # priority order mirrors preprocess_message's sequence of early returns
    if is_format_kindle:
        params = {}
        title = _extract_project_title(msg)
        if title:
            params["project_title"] = title
        ps = _PAGE_SIZE.search(msg)
        params["page_size"] = ps.group(1) if ps else "6x9"
        return _decide("chapter", "format-kindle", params, 0.7)
    if is_retrieve:
        # revert/restore want the item itself; list/version/history want the listing
        if re.search(r"\b(revert|restore)\b", low):
            return _decide("library", "retrieve", {"content_type": "outline", "search_term": msg}, 0.7)
        if re.search(r"\b(list|version|history|arcs?)\b", low):
            return _decide("library", "list-outlines", {}, 0.7)
        return _decide("library", "retrieve", {"search_term": msg}, 0.7)
    if is_qa:
        op = "repair" if _QA_FIXY.search(low) else "qa"
        return _decide("chapter", op, _chapter_params(msg), 0.7)
    if is_edit:
        params = {"directive": msg}
        title = _extract_project_title(msg)
        if title:
            params["project_title"] = title
        return _decide("brainstorm", "edit-outline", params, 0.7)
    if is_brainstorm:
        op = "revise-outline" if _BRAINSTORM_REVISE.search(low) else "story"
        params = {"directive": msg} if op == "revise-outline" else {}
        title = _extract_project_title(msg)
        if title and op == "revise-outline":
            params["project_title"] = title
        return _decide("brainstorm", op, params, 0.7)
    if is_project:
        return _decide("library", "list-outlines", {"content_type": "project"}, 0.7)
    if is_bulk_approve:
        op_action = "publish" if "publish" in low else "approve"
        params = {"action": op_action, "scope": "all_chapters"}
        title = _extract_project_title(msg)
        if title:
            params["project_title"] = title
        return _decide("library", "lifecycle", params, 0.7)
    if is_library:
        params = {}
        if has_lib_action:
            am = re.search(r"\b(approve|unschedule|unpublish|publish|reject|schedule|delete|undelete)\b", low)
            if am:
                params["action"] = am.group(1)
            return _decide("library", "lifecycle", params, 0.6)
        return _decide("library", "list-outlines", {}, 0.6)
    if is_writing:
        return _decide("chapter", "write", _chapter_params(msg), 0.7)
    if is_chapter_outline:
        return _decide("chapter", "plan", _chapter_params(msg), 0.7)

    # remaining single-keyword tasks not covered above
    if re.search(r"\bresearch\b", low):
        return _decide("research", "run", {"topic": msg}, 0.6)
    if re.search(r"\b(cover\s+art|generate\s+(a\s+)?cover|cover\s+image)\b", low):
        return _decide("media", "cover-art", {}, 0.6)
    if re.search(r"\b(repurpose|social\s+(media\s+)?posts?)\b", low):
        return _decide("media", "social-posts", {}, 0.6)
    if re.search(r"\bscrape\b", low):
        u = _URL_RE.search(msg)
        return _decide("media", "scrape-url", {"url": u.group(0)} if u else {}, 0.6)

    return HubDecision(kind="conversation", assistant_message="", confidence=0.3)


# --------------------------------------------------------------------------- Gemini

def _router_system() -> str:
    return (
        "You are the routing brain of 'The Author Agent', a sci-fi/fiction writing assistant. "
        "Given the user's message, choose exactly ONE capability from the menu below, or classify it "
        "as plain conversation.\n\n"
        "CAPABILITIES (pick tool + op verbatim from this list):\n"
        f"{render_catalog_prompt()}\n\n"
        "RULES (these encode hard-won fixes — follow them exactly):\n"
        "- 'info' ops are fast reads; 'task' ops are heavy generation that will be queued.\n"
        "- RETRIEVE/LIST WINS: if the user wants to see, open, revert, restore, or list existing work, "
        "pick the info op — NEVER regenerate. 'revert outline' / 'restore outline' = library.retrieve, "
        "NOT brainstorm.\n"
        "- OUTLINE ≠ CHAPTER WRITE: 'write/draft the outline' is a brainstorm op, never chapter.write. "
        "chapter.write is only for an actual chapter/prologue/epilogue narrative.\n"
        "- OUTLINE EDIT TIERS: a SMALL targeted change (rename, change an age/role/description, one beat) "
        "= brainstorm.edit-outline; 'revise/rework/expand the outline' or 'add a chapter' on an existing "
        "project = brainstorm.revise-outline; a brand-new story from a premise = brainstorm.story.\n"
        "- CHAPTER FIXES: 'qa'/'quality check' a chapter = chapter.qa; 'fix/clean up/dedup/repair' a "
        "chapter = chapter.repair.\n"
        "- 'chapter outline' / 'plan the chapter' / 'outline the prologue' = chapter.plan.\n"
        "- 'approve/publish/reject/schedule [#N] [of <title>]' = library.lifecycle (put action + "
        "chapter_number + project_title in params).\n"
        "- Extract any params you can from the message into 'params' (project_title, chapter_number, "
        "genre, story_arc, url, directive, action). Leave unknown params out — do not invent values.\n"
        "- If the message is chit-chat, a greeting, or a question you can answer without a tool, set "
        "kind='conversation' and put the answer in assistant_message.\n"
        "- For a task, set assistant_message to a one-line acknowledgement (e.g. 'Queuing chapter 5 — "
        "I'll let you know when it's ready.').\n\n"
        "Output JSON: {kind: conversation|info|task, tool, op, params, assistant_message, confidence}."
    )


async def _gemini_route(req: HubRequest, router: LLMRouter, model: str) -> HubDecision:
    ctx = ""
    if req.context.get("project_title"):
        ctx += f"\nActive project: {req.context['project_title']}"
    if req.context.get("last_list"):
        n = len(req.context["last_list"])
        ctx += f"\n(There is a list of {n} items currently shown to the user.)"
    prompt = f"User message:\n{req.message}{ctx}"
    decision, _resp = await complete_structured(
        router, provider="gemini", model=model, system=_router_system(),
        prompt=prompt, schema=HubDecision, max_tokens=1024, temperature=0.1,
    )
    return _normalise(decision)


def _normalise(decision: HubDecision) -> HubDecision:
    """Snap router output onto a real catalog entry; fix kind to match the spec."""
    if decision.kind == "conversation":
        return decision
    spec: ToolSpec | None = lookup(decision.tool, decision.op)
    if spec is None:
        # Unknown tool/op from the model — degrade to conversation rather than dispatch nonsense.
        return HubDecision(
            kind="conversation",
            assistant_message=decision.assistant_message
            or "I'm not sure which tool that needs — could you rephrase?",
            confidence=0.2,
        )
    return HubDecision(
        kind=spec.kind, tool=spec.tool, op=spec.op, params=decision.params,
        assistant_message=decision.assistant_message, confidence=decision.confidence,
    )


async def route_message(
    req: HubRequest, *, llm_router: LLMRouter | None = None, model: str | None = None
) -> HubDecision:
    """Route a normalised request to a :class:`HubDecision`. Never raises."""
    # 1. numbered-list selection (needs conversation context the LLM can't see)
    sel = _numbered_selection(req)
    if sel is not None:
        return sel

    # 2. Gemini (primary) — falls through to heuristics if unavailable or it returns junk
    router = llm_router or get_router(service="hub")
    settings = get_settings()
    try:
        decision = await _gemini_route(req, router, model or settings.hub_router_model)
        logger.info(
            "hub.route.gemini", source=req.source, kind=decision.kind,
            tool=decision.tool, op=decision.op, confidence=decision.confidence,
            msg_preview=req.message[:120],
        )
        return decision
    except ProviderNotRegistered:
        logger.warning("hub.route.no_gemini", msg_preview=req.message[:120])
    except Exception as exc:  # the failure the stress test must be able to see
        logger.warning("hub.route.gemini_failed", error=str(exc)[:300], msg_preview=req.message[:120])

    # 3. deterministic regex fallback
    fallback = _heuristic_route(req.message)
    logger.info(
        "hub.route.heuristic", source=req.source, kind=fallback.kind,
        tool=fallback.tool, op=fallback.op, msg_preview=req.message[:120],
    )
    return fallback
