"""Split a long manuscript into print volumes that END WHERE THE STORY WANTS TO END.

WHY THIS EXISTS. KDP's paperback maximum is 828 pages. A 600,000-word novel is 1,500-2,000 pages at
any honest type size, so it is physically three books. That is a printing constraint, and the naive
response — cut every 200 pages — is how a trilogy ends up with volume one stopping in the middle of
a conversation.

So the page budget is treated as a CONSTRAINT and the story as the OBJECTIVE. Every chapter boundary
inside the feasible window is a candidate; each is scored on how well it works as a volume ending;
and a dynamic program picks the set of splits that maximises total ending strength subject to no
volume exceeding the cap. Balance matters too, but less: a reader forgives a volume 80 pages shorter
than its sibling, and does not forgive one that stops mid-scene.

WHAT MAKES AN ENDING. Not "the most dramatic chapter" — the chapter after which a reader cannot
stop. Those are different things. A chapter that resolves everything can be the most dramatic in the
book and the worst possible volume ending. The scorer therefore rewards an unresolved question, a
reversal, a decision taken but not yet paid for, an arrival, a threat in motion — and penalises
resolution, summary and valediction.

The deterministic pass uses what the engine already stores per chapter. The LLM pass reads the last
pages of the serious candidates and judges them properly. The deterministic pass alone is enough to
shortlist; it is not enough to choose.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from itertools import pairwise
from typing import Any

# KDP's hard ceiling for a black-ink paperback on white or cream stock, across the common trims.
KDP_MAX_PAGES = 828
"""Above this the upload is rejected outright. Not a guideline."""

KDP_MIN_PAGES = 24
"""KDP will not print a shorter book."""

SAFE_MAX_PAGES = 780
"""Headroom under the cap.

Page estimates drift — front matter, chapter openers that start recto, widow control, and the real
typesetter's line breaking all add pages the estimate cannot see. Planning to 828 and discovering
831 after generating the interior means re-splitting the whole book and re-making every cover,
because the spine width moves with the page count."""

# Words per page by trim, for 11pt serif at 1.3 leading with normal margins. Deliberately
# conservative: underestimating words-per-page overestimates pages, and the error that matters is
# the one that busts the cap.
WORDS_PER_PAGE: dict[str, int] = {
    "5x8": 280,
    "5.06x7.81": 275,
    "5.25x8": 295,
    "5.5x8.5": 320,
    "6x9": 350,
    "6.14x9.21": 365,
    "6.69x9.61": 400,
    "7x10": 440,
    "8.5x11": 600,
}
DEFAULT_TRIM = "6x9"

FRONT_MATTER_PAGES = 8
"""Half title, title, copyright, dedication, epigraph and their blank versos."""

BACK_MATTER_PAGES = 6
"""Author's note, acknowledgements, about the author."""

CHAPTER_OPENER_WASTE = 0.5
"""A chapter opens on a fresh page, so on average half a page is lost per chapter."""


def words_per_page(trim: str) -> int:
    return WORDS_PER_PAGE.get(trim, WORDS_PER_PAGE[DEFAULT_TRIM])


def estimate_pages(words: int, chapters: int, trim: str = DEFAULT_TRIM, *, matter: bool = True) -> int:
    """Printed pages for a body of text. Rounded up, because half a page is a page."""
    wpp = words_per_page(trim)
    body = words / wpp + chapters * CHAPTER_OPENER_WASTE
    extra = (FRONT_MATTER_PAGES + BACK_MATTER_PAGES) if matter else 0
    return int(body + extra + 0.999)


# --- how good an ending is this? ----------------------------------------------------------------

# Closing moves that leave a reader standing on a ledge.
_OPEN_SIGNALS = (
    r"\?\s*$",  # the chapter ends on a question
    r"\b(would|will|was going to|had to)\b[^.]{0,60}$",
    r"\b(not yet|too late|no time|before (?:the|he|she|they)|until)\b",
    r"\b(coming|arriv\w+|waiting|watching|behind (?:him|her|them))\b",
)
# Closing moves that tuck the reader in.
_CLOSED_SIGNALS = (
    r"\b(at last|finally|for the last time|never again|it was over|it was done|enough)\b",
    r"\b(slept|rest(?:ed)?|peace|settled|home again|closed (?:his|her|their) eyes)\b",
    r"\b(years later|and so|in the end)\b",
)


MID_SCENE_CAP = 0.3
"""The most a mid-scene stop can score. It is a cut, not an ending, and a book that stops in the
middle of a moment reads to its buyer as a book with its last pages missing."""


def series_ending_score(closes: float, opens: float, mid_scene: bool) -> float:
    """How well an ending works as the end of ONE BOOK IN A SERIES.

    Both halves are required, so they are multiplied rather than added: an ending that settles the
    book but opens nothing gives no reason to buy the next one, and an ending that opens everything
    but settles nothing is a cliffhanger, which reads as the book being cut short. The geometric
    mean keeps a 0.9/0.9 ending at 0.9 and puts a 1.0/0.1 ending at about 0.3.
    """
    score = math.sqrt(max(0.0, min(1.0, closes)) * max(0.0, min(1.0, opens)))
    return min(score, MID_SCENE_CAP) if mid_scene else score


@dataclass
class ChapterInfo:
    """What the planner needs to know about one chapter."""

    number: int
    title: str
    words: int
    tail: str = ""  # the closing ~1,200 words, for judging the ending
    story_turn_density: float | None = None
    # Filled by the LLM pass when it runs: how well this chapter ENDS A BOOK IN A SERIES.
    judged: float | None = None
    judged_reason: str = ""
    # What the ending settles, and the question it hands the reader for the next book.
    resolves: str = ""
    carries: str = ""

    @property
    def ending_score(self) -> float:
        """0-1. The LLM judgement when there is one, otherwise the cheap estimate."""
        if self.judged is not None:
            return self.judged
        return self.heuristic_ending_score

    @property
    def heuristic_ending_score(self) -> float:
        """A shortlist, not a verdict.

        `story_turn_density` is the closest stored signal — it measures whether things CHANGE in a
        chapter — but it says nothing about whether the last change is left hanging, which is the
        whole question. So it contributes at most half, and the closing sentences carry the rest.
        """
        score = 0.5 * (self.story_turn_density if self.story_turn_density is not None else 0.5)
        closing = " ".join((self.tail or "").split())[-400:].lower()
        if closing:
            opens = sum(1 for p in _OPEN_SIGNALS if re.search(p, closing))
            closes = sum(1 for p in _CLOSED_SIGNALS if re.search(p, closing))
            score += 0.18 * min(opens, 2) - 0.22 * min(closes, 2)
        return max(0.0, min(1.0, score))


@dataclass
class Volume:
    """One printed book."""

    index: int  # 1-based
    first_chapter: int
    last_chapter: int
    chapters: list[int]
    words: int
    estimated_pages: int
    ending_score: float
    ending_title: str = ""
    ending_reason: str = ""
    ending_resolves: str = ""
    ending_carries: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class VolumePlan:
    trim: str
    volumes: list[Volume] = field(default_factory=list)
    total_words: int = 0
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "trim": self.trim,
            "total_words": self.total_words,
            "volume_count": len(self.volumes),
            "volumes": [v.as_dict() for v in self.volumes],
            "warnings": self.warnings,
        }


def compare_trims(chapters: list[ChapterInfo], *, cap: int = SAFE_MAX_PAGES) -> list[dict[str, Any]]:
    """Every trim size, with what it costs: total pages, how many volumes, pages per volume.

    Trim is the author's choice and it is not only an aesthetic one — it decides how many books
    this becomes. A 600,000-word manuscript is three volumes at 6x9 and may be two at 6.69x9.61,
    and that is a decision about the shape of the series, not about paper. So the planner shows the
    consequence rather than quietly defaulting.
    """
    words = sum(c.words for c in chapters)
    out: list[dict[str, Any]] = []
    for trim in WORDS_PER_PAGE:
        total = estimate_pages(words, len(chapters), trim)
        vols = minimum_volumes(chapters, trim, cap)
        out.append(
            {
                "trim": trim,
                "words_per_page": words_per_page(trim),
                "total_pages_if_one_volume": total,
                "minimum_volumes": vols,
                "approx_pages_per_volume": int(total / vols) if vols else total,
                "fits_one_volume": total <= KDP_MAX_PAGES,
            }
        )
    return sorted(out, key=lambda r: (r["minimum_volumes"], r["trim"]))


def minimum_volumes(chapters: list[ChapterInfo], trim: str, cap: int = SAFE_MAX_PAGES) -> int:
    """Fewest volumes the page cap allows. One is the answer for most books."""
    total = estimate_pages(sum(c.words for c in chapters), len(chapters), trim)
    n = max(1, -(-total // cap))
    # Each extra volume carries its own front and back matter, which can tip the count up again.
    while True:
        per = estimate_pages(sum(c.words for c in chapters) // n, len(chapters) // max(n, 1), trim)
        if per <= cap or n >= len(chapters):
            return n
        n += 1


def plan_volumes(
    chapters: list[ChapterInfo],
    *,
    trim: str = DEFAULT_TRIM,
    volume_count: int | None = None,
    cap: int = SAFE_MAX_PAGES,
    balance_weight: float = 0.45,
    breaks: list[int] | None = None,
) -> VolumePlan:
    """Choose split points: strongest endings, subject to no volume over the cap.

    ``balance_weight`` trades evenness against ending strength. It is below 0.5 on purpose — pages
    are a constraint, the story is the point, and a reader notices a bad ending long before an
    uneven spine.

    ``breaks`` are the author's own: the chapter NUMBERS that end each book but the last. They are
    used as given — the planner reports what they cost (pages, a weak ending) but never moves them.
    """
    plan = VolumePlan(trim=trim, total_words=sum(c.words for c in chapters))
    if not chapters:
        plan.warnings.append("no chapters")
        return plan
    if breaks:
        return _plan_from_breaks(plan, chapters, trim=trim, breaks=breaks, cap=cap)

    n_vol = volume_count or minimum_volumes(chapters, trim, cap)
    n = len(chapters)
    if n_vol <= 1:
        total_pages = estimate_pages(plan.total_words, n, trim)
        plan.volumes = [
            Volume(
                index=1,
                first_chapter=chapters[0].number,
                last_chapter=chapters[-1].number,
                chapters=[c.number for c in chapters],
                words=plan.total_words,
                estimated_pages=total_pages,
                ending_score=chapters[-1].ending_score,
                ending_title=chapters[-1].title,
                ending_reason=chapters[-1].judged_reason,
                ending_resolves=chapters[-1].resolves,
                ending_carries=chapters[-1].carries,
            )
        ]
        if total_pages > KDP_MAX_PAGES:
            plan.warnings.append(
                f"{total_pages} pages exceeds KDP's {KDP_MAX_PAGES}-page maximum — split required"
            )
        return plan
    if n_vol > n:
        plan.warnings.append(f"asked for {n_vol} volumes from {n} chapters")
        n_vol = n

    prefix = [0]
    for c in chapters:
        prefix.append(prefix[-1] + c.words)

    def pages_for(i: int, j: int) -> int:
        """Pages for chapters[i:j]."""
        return estimate_pages(prefix[j] - prefix[i], j - i, trim)

    target = plan.total_words / n_vol

    def cost(i: int, j: int) -> float:
        """Lower is better. Imbalance penalty minus the strength of the ending at j-1."""
        words = prefix[j] - prefix[i]
        imbalance = abs(words - target) / target
        return balance_weight * imbalance - chapters[j - 1].ending_score

    # dp[v][j] = best cost using v volumes over the first j chapters.
    INF = float("inf")
    dp = [[INF] * (n + 1) for _ in range(n_vol + 1)]
    back = [[-1] * (n + 1) for _ in range(n_vol + 1)]
    dp[0][0] = 0.0
    for v in range(1, n_vol + 1):
        for j in range(1, n + 1):
            for i in range(v - 1, j):
                if dp[v - 1][i] == INF:
                    continue
                if pages_for(i, j) > cap:
                    continue  # the constraint, enforced rather than weighted
                total = dp[v - 1][i] + cost(i, j)
                if total < dp[v][j]:
                    dp[v][j] = total
                    back[v][j] = i

    if dp[n_vol][n] == INF:
        plan.warnings.append(
            f"no split into {n_vol} volumes keeps every volume under {cap} pages — try more volumes "
            "or a larger trim size"
        )
        return plan

    cuts: list[tuple[int, int]] = []
    j = n
    for v in range(n_vol, 0, -1):
        i = back[v][j]
        cuts.append((i, j))
        j = i
    cuts.reverse()

    _fill_volumes(plan, chapters, cuts, trim)
    return plan


def _fill_volumes(
    plan: VolumePlan, chapters: list[ChapterInfo], cuts: list[tuple[int, int]], trim: str
) -> None:
    """Build the volumes for `cuts` (half-open index ranges) and warn about weak endings."""
    for idx, (i, j) in enumerate(cuts, start=1):
        last = chapters[j - 1]
        words = sum(c.words for c in chapters[i:j])
        plan.volumes.append(
            Volume(
                index=idx,
                first_chapter=chapters[i].number,
                last_chapter=last.number,
                chapters=[c.number for c in chapters[i:j]],
                words=words,
                estimated_pages=estimate_pages(words, j - i, trim),
                ending_score=round(last.ending_score, 3),
                ending_title=last.title,
                ending_reason=last.judged_reason,
                ending_resolves=last.resolves,
                ending_carries=last.carries,
            )
        )

    for vol in plan.volumes[:-1]:
        if vol.ending_score < 0.5:
            plan.warnings.append(
                f"volume {vol.index} ends on chapter {vol.last_chapter} with a weak hook "
                f"({vol.ending_score:.2f}) — consider strengthening it before publishing"
            )


def break_indices(chapters: list[ChapterInfo], breaks: list[int]) -> list[int] | str:
    """Chapter indices for the author's break chapter numbers, or why they cannot be used.

    A break must be a chapter in the book, not the last one (that ends the series, not a book), and
    the breaks must run in order with at least one chapter between them.
    """
    position = {c.number: k for k, c in enumerate(chapters)}
    out: list[int] = []
    for b in breaks:
        k = position.get(b)
        if k is None:
            return f"chapter {b} is not in the book"
        if k == len(chapters) - 1:
            return f"chapter {b} is the last chapter — it ends the series, not a book"
        if out and k <= out[-1]:
            return "each book must end after the one before it"
        out.append(k)
    return out


def _plan_from_breaks(
    plan: VolumePlan, chapters: list[ChapterInfo], *, trim: str, breaks: list[int], cap: int
) -> VolumePlan:
    idx = break_indices(chapters, breaks)
    if isinstance(idx, str):
        plan.warnings.append(f"breaks not used: {idx}")
        return plan
    edges = [0, *[k + 1 for k in idx], len(chapters)]
    _fill_volumes(plan, chapters, list(pairwise(edges)), trim)
    for vol in plan.volumes:
        if vol.estimated_pages > cap:
            plan.warnings.append(
                f"volume {vol.index} is about {vol.estimated_pages} pages — over the {cap}-page "
                "limit; end it earlier or choose a larger trim"
            )
    return plan


def split_candidates(
    chapters: list[ChapterInfo], *, trim: str, volume_count: int, cap: int = SAFE_MAX_PAGES
) -> list[int]:
    """Chapter indices that could legally end a volume, so the LLM only judges plausible ones.

    Scoring every chapter would be most of a book's worth of calls to answer a question about a
    handful of boundaries.
    """
    n = len(chapters)
    prefix = [0]
    for c in chapters:
        prefix.append(prefix[-1] + c.words)
    per = prefix[-1] / max(volume_count, 1)
    out: set[int] = set()
    for v in range(1, volume_count):
        ideal_words = per * v
        for j in range(1, n):
            if (
                abs(prefix[j] - ideal_words) <= per * 0.22
                and estimate_pages(prefix[j] - prefix[0], j, trim) <= cap * v
            ):
                out.add(j - 1)
    return sorted(out)


__all__ = [
    "CHAPTER_OPENER_WASTE",
    "KDP_MAX_PAGES",
    "KDP_MIN_PAGES",
    "SAFE_MAX_PAGES",
    "WORDS_PER_PAGE",
    "ChapterInfo",
    "Volume",
    "VolumePlan",
    "break_indices",
    "compare_trims",
    "estimate_pages",
    "minimum_volumes",
    "plan_volumes",
    "split_candidates",
    "words_per_page",
]
