"""StealthGPT humanize pass (E6).

API, as settled in the vault on 2026-09-18 and not re-litigated here:

    POST https://www.stealthgpt.ai/api/stealthify
    headers: api-token: <key> · Content-Type: application/json
    body:    {prompt (<=3000 words), rephrase: true, model: super|standard|lite,
              mode: High|Medium|Low, qualityMode, outputFormat}
    returns: {result, howLikelyToBeDetected, wordsSpent, remainingCredits, billingMode}

Synchronous, billed per word, hard cap of 3000 words per request. A 7k-word chapter therefore needs
three or more calls.

THREE THINGS THIS MODULE IS CAREFUL ABOUT, each because of something that has already gone wrong
in this codebase:

1. **It chunks on SCENE BREAKS first.** The humanizer rewrites prose, so handing it a whole chapter
   invites it to drop or reword the ``---`` separators that A13 added structurally. Splitting on
   them, humanizing each scene independently and re-joining with the separator means the scene
   structure survives by construction rather than by hoping the model preserves it. (A13's breaks
   were already destroyed once today, by a regex — see chapter_step._strip_em_dashes.)

2. **It re-applies the dash ban afterwards.** The writing directive forbids em-dashes, and a
   rewriting pass reintroduces them freely. Humanizing and then NOT re-stripping would quietly undo
   the line-edit's work.

3. **A failed chunk falls back to the original text, and says so.** Per the decision on 2026-10-17:
   retry first (via the B8 machinery, which honours Retry-After), then keep the original for that
   chunk. The chapter stays complete and readable, and ``failed_chunks`` records which parts are not
   humanized so a partially-humanized chapter is never silently presented as a finished one.

Off unless ``STEALTHGPT_API_KEY`` is set. It costs real money per word and, on fiction, a strong
setting can flatten literary voice — so it never runs just because a key happens to exist.

MEASURED AGAINST THE LIVE API, 2026-10-17, on one 29-word passage of The Burial Mound. The numbers
are a single sample, but the behaviours were consistent and they decide how this should be used:

    mode   model      detect  billed  kept the character's name?
    High   standard   86       67     NO  — replaced "Tayak" with "He"
    Low    standard   99       61     yes — but changed "frost" to "snow"
    Low    super      90      195     yes — reordered events, invented "They were all right"
    Medium standard   88       60     yes — returned the text UNCHANGED, and billed for it
    Medium super      85      158     yes — invented "careful not to kick ice crystals into the night"

Three conclusions worth keeping:

* ``howLikelyToBeDetected`` RISES as the mode weakens (Low 99 > Medium 88 > High 86), so a lower
  number is better. On a 29-word sample the figure is probably not meaningful at all.
* ``super`` bills roughly 6x the input words and invents content. For fiction that is worse than
  flattening: it adds events the author did not write.
* Billing is ~2x input words even on ``standard``, and ``meteredChargedCredits`` is the real cost
  signal on a pay-as-you-go account where ``remainingCredits`` sits at 0.

Hence ``humanize_max_words_per_run``: nothing else in the system would stop a mistaken pass over a
whole novel.
"""

from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("humanize")

ENDPOINT = "https://www.stealthgpt.ai/api/stealthify"

# The API's hard cap is 3000 words; 2800 leaves headroom for its own tokenisation differing from a
# naive whitespace split. Matches the n8n sub's threshold so engine and n8n chunk alike.
CHUNK_WORDS = 2800

# Below this a "chunk" is a fragment — a line of dialogue, a scene-break remnant — and humanizing it
# costs credits for no benefit while risking a rewrite that reads nothing like its neighbours.
MIN_WORDS = 20

# The separator A13 joins sub-chapters with. Imported as a literal rather than from chapter_step,
# which is a service and must not become a dependency of the shared package.
SCENE_BREAK = "\n\n---\n\n"
_SCENE_SPLIT = re.compile(r"\n\s*-{3,}\s*\n")

_PARA_SPLIT = re.compile(r"\n\s*\n")


@dataclass
class HumanizeResult:
    """Outcome of a humanize pass over one piece of content."""

    text: str
    chunks: int = 0
    humanized_chunks: int = 0
    failed_chunks: list[int] = field(default_factory=list)
    words_spent: int = 0
    charged_credits: int = 0
    """`meteredChargedCredits` — the actual cost on a pay-as-you-go account, which is what
    `remainingCredits` does NOT tell you when the balance is already 0."""
    remaining_credits: int | None = None
    detectability: Any = None
    stopped_at_budget: bool = False
    """True when the per-run word ceiling halted the pass. The remaining chunks keep their original
    text, exactly like a failed chunk."""
    skipped: str = ""
    """Why nothing happened, when nothing happened (not configured / empty input)."""

    @property
    def ok(self) -> bool:
        return not self.skipped and not self.failed_chunks

    @property
    def partial(self) -> bool:
        """Some chunks are the original text. The caller must not call this a humanized chapter."""
        return bool(self.failed_chunks) and self.humanized_chunks > 0

    def as_report(self) -> dict[str, Any]:
        return {
            "chunks": self.chunks,
            "humanized_chunks": self.humanized_chunks,
            "failed_chunks": self.failed_chunks,
            "partial": self.partial,
            "words_spent": self.words_spent,
            "charged_credits": self.charged_credits,
            "remaining_credits": self.remaining_credits,
            "detectability": self.detectability,
            "stopped_at_budget": self.stopped_at_budget,
            "skipped": self.skipped or None,
        }


def enabled() -> bool:
    """True when a key is configured. Everything else checks this first."""
    return bool(get_settings().stealthgpt_api_key.strip())


def chunk_text(text: str, *, max_words: int = CHUNK_WORDS) -> list[str]:
    """Split ``text`` into request-sized pieces, preferring scene then paragraph boundaries.

    Order matters: scene breaks first, so a scene is never split across two requests and the
    separators can be re-inserted verbatim afterwards. Only a scene that is itself over the cap is
    split further, on paragraph boundaries. A single paragraph over the cap is passed through whole
    rather than cut mid-sentence — the API will reject or truncate it, which is visible, whereas a
    sentence sliced in half is not.
    """
    if not text.strip():
        return []
    chunks: list[str] = []
    for scene in _SCENE_SPLIT.split(text):
        if not scene.strip():
            continue
        if len(scene.split()) <= max_words:
            chunks.append(scene)
            continue
        current: list[str] = []
        count = 0
        for para in _PARA_SPLIT.split(scene):
            words = len(para.split())
            if current and count + words > max_words:
                chunks.append("\n\n".join(current))
                current, count = [], 0
            current.append(para)
            count += words
        if current:
            chunks.append("\n\n".join(current))
    return chunks


def _scene_count(text: str) -> int:
    return len([s for s in _SCENE_SPLIT.split(text) if s.strip()])


async def _stealthify(chunk: str, *, model: str, mode: str, key: str, timeout_s: float) -> dict[str, Any]:
    """One stealthify call. Raises on a non-2xx so the retry layer can see it."""
    body = {
        "prompt": chunk,
        "rephrase": True,
        "model": model,
        "mode": mode,
        "qualityMode": "quality",
        "outputFormat": "text",
    }
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(
            ENDPOINT,
            headers={"api-token": key, "Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
        return dict(resp.json() or {})


async def humanize_text(
    text: str,
    *,
    model: str | None = None,
    mode: str | None = None,
    timeout_s: float = 180.0,
) -> HumanizeResult:
    """Humanize ``text``, preserving its scene structure and the dash ban.

    Never raises for a provider failure: a chunk that cannot be humanized keeps its original text
    and is listed in ``failed_chunks``.
    """
    settings = get_settings()
    key = settings.stealthgpt_api_key.strip()
    if not key:
        return HumanizeResult(text=text, skipped="STEALTHGPT_API_KEY not set")
    if not text.strip():
        return HumanizeResult(text=text, skipped="empty input")

    use_model = (model or settings.stealthgpt_model or "standard").strip()
    use_mode = (mode or settings.stealthgpt_mode or "High").strip()

    scenes_before = _scene_count(text)
    chunks = chunk_text(text)
    out = HumanizeResult(text=text, chunks=len(chunks))
    pieces: list[str] = []

    from writer_engine.rate_limit.provider_budget import call_provider

    budget_words = max(0, int(settings.humanize_max_words_per_run))
    for i, chunk in enumerate(chunks):
        if len(chunk.split()) < MIN_WORDS:
            # Passed through, not counted as a failure: there is nothing here worth paying to rewrite.
            pieces.append(chunk)
            continue
        if budget_words and out.words_spent >= budget_words:
            # Stop spending, keep the rest of the text as written, and say so. Billing is ~2x the
            # input words on `standard` and ~6x on `super`, and the account has no credit buffer, so
            # the ceiling is the only thing between a mistaken "humanize all" and a large bill.
            out.stopped_at_budget = True
            out.failed_chunks.append(i)
            pieces.append(chunk)
            continue

        # Bound as a default argument, not captured: a closure over the loop variable would send
        # the LAST chunk on every retry.
        async def _call(c: str = chunk) -> dict[str, Any]:
            return await _stealthify(c, model=use_model, mode=use_mode, key=key, timeout_s=timeout_s)

        try:
            payload = await call_provider(
                "stealthgpt",
                _call,
                model=use_model,
                input_tokens=len(chunk.split()),
                attempts=3,  # retry, then fall back — the 2026-10-17 decision
            )
        except Exception as exc:
            logger.warning(
                "humanize.chunk_failed",
                chunk=i,
                of=len(chunks),
                words=len(chunk.split()),
                error=f"{type(exc).__name__}: {str(exc)[:160]}",
            )
            out.failed_chunks.append(i)
            pieces.append(chunk)
            continue

        result = str(payload.get("result") or "").strip()
        if not result:
            # A 200 with no text is still a failure; treating it as success would silently blank
            # part of the chapter.
            logger.warning("humanize.empty_result", chunk=i, of=len(chunks))
            out.failed_chunks.append(i)
            pieces.append(chunk)
            continue

        pieces.append(result)
        out.humanized_chunks += 1
        out.words_spent += int(payload.get("wordsSpent") or 0)
        with contextlib.suppress(TypeError, ValueError):
            out.charged_credits += int(payload.get("meteredChargedCredits") or 0)
        if payload.get("remainingCredits") is not None:
            # Informational only — a provider that changes this field's type must not fail the pass.
            with contextlib.suppress(TypeError, ValueError):
                out.remaining_credits = int(payload["remainingCredits"])
        if payload.get("howLikelyToBeDetected") is not None:
            out.detectability = payload["howLikelyToBeDetected"]

    # Re-join with the separator, so the scene structure is restored exactly however the model
    # chose to reword the scenes themselves.
    joined = SCENE_BREAK.join(pieces) if len(pieces) > 1 else (pieces[0] if pieces else text)
    out.text = strip_banned_dashes(joined)

    scenes_after = _scene_count(out.text)
    if scenes_before and scenes_after < scenes_before:
        # Should be impossible given the re-join; logged rather than asserted because losing a
        # scene break silently is exactly the failure A13 fixed and a regex undid.
        logger.warning("humanize.scene_breaks_lost", before=scenes_before, after=scenes_after)

    if out.stopped_at_budget:
        logger.warning(
            "humanize.budget_reached",
            words_spent=out.words_spent,
            ceiling=budget_words,
            unhumanized_chunks=len(out.failed_chunks),
        )
    logger.info(
        "humanize.done",
        chunks=out.chunks,
        humanized=out.humanized_chunks,
        failed=len(out.failed_chunks),
        words_spent=out.words_spent,
        charged_credits=out.charged_credits,
        remaining_credits=out.remaining_credits,
        stopped_at_budget=out.stopped_at_budget,
    )
    return out


# Kept here rather than imported from chapter_step so the shared package does not depend on a
# service. Must stay in step with chapter_step._strip_em_dashes — including its lookarounds, without
# which this would eat the scene separators it just restored.
_BANNED_DASH_RE = re.compile("\\s*(?:\u2014|\u2013|(?<!-)--(?!-))\\s*")


def strip_banned_dashes(text: str) -> str:
    """Re-apply the no-em-dash writing directive after a rewriting pass reintroduces them."""
    return _BANNED_DASH_RE.sub(", ", text)


__all__ = [
    "CHUNK_WORDS",
    "ENDPOINT",
    "MIN_WORDS",
    "SCENE_BREAK",
    "HumanizeResult",
    "chunk_text",
    "enabled",
    "humanize_text",
    "strip_banned_dashes",
]
