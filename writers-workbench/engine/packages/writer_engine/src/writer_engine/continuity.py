"""Cross-chapter continuity: a named character who outlives what a person can outlive.

WHY THIS EXISTS. Every quality check in this engine scores ONE chapter against its own brief. That
is the right unit for pacing, prose and period diction, and it is structurally blind to the error
that matters most in a book spanning deep time: the same character name appearing in chapters set
centuries apart.

Found by a reader, not by the engine: "Strikes-Twice" appears in chapters 2 and 3 (ca. 10,500 BCE)
and again in chapter 4 (ca. 10,200 BCE). Three hundred years. Nothing flagged it, and nothing could
have — the craft QA never sees a sibling chapter, and the deterministic name check only compares
against the project's character roster, which on that book is six modern people.

WHAT IT DOES NOT DO. It does not call an LLM and it does not decide. An inherited name across
generations is a real and deliberate device — it is the spine of the book this was written for — so
a span is REPORTED for a human to confirm or dismiss, never auto-corrected. The value is that a
300-year span becomes visible in a second instead of requiring someone to hold 96 chapters in their
head at once.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import pairwise

# A capitalised word of 4+ letters, optionally hyphenated ("Strikes-Twice", "Running-Water"). The
# length floor and the stop list keep ordinary sentence-initial words out; precision matters more
# than recall here, because a report full of "Three" and "Without" is a report nobody reads.
_NAME = re.compile(r"\b[A-Z][a-z]{3,}(?:-[A-Z][a-z]{2,})*\b")

_STOP = {
    "about",
    "after",
    "again",
    "against",
    "almost",
    "alone",
    "along",
    "already",
    "also",
    "always",
    "another",
    "anything",
    "around",
    "because",
    "before",
    "behind",
    "below",
    "beneath",
    "beside",
    "between",
    "beyond",
    "both",
    "catch",
    "could",
    "during",
    "each",
    "early",
    "enough",
    "even",
    "every",
    "everything",
    "except",
    "first",
    "from",
    "give",
    "half",
    "have",
    "here",
    "himself",
    "idea",
    "inside",
    "instead",
    "into",
    "just",
    "keep",
    "know",
    "last",
    "late",
    "later",
    "least",
    "leave",
    "less",
    "like",
    "little",
    "long",
    "look",
    "made",
    "make",
    "many",
    "maybe",
    "might",
    "more",
    "most",
    "much",
    "must",
    "near",
    "need",
    "never",
    "next",
    "nobody",
    "none",
    "nothing",
    "once",
    "only",
    "other",
    "others",
    "outside",
    "over",
    "part",
    "past",
    "people",
    "perhaps",
    "place",
    "right",
    "same",
    "seen",
    "should",
    "since",
    "some",
    "someone",
    "something",
    "sometimes",
    "soon",
    "still",
    "such",
    "take",
    "than",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "things",
    "think",
    "this",
    "those",
    "though",
    "three",
    "through",
    "time",
    "today",
    "together",
    "toward",
    "under",
    "until",
    "upon",
    "very",
    "want",
    "well",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "will",
    "with",
    "within",
    "without",
    "would",
    "year",
    "years",
    "your",
    # Days, months and common titles read as names and recur across every era.
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "mister",
    "missus",
    "doctor",
    "father",
    "mother",
    "uncle",
    "aunt",
    "grandmother",
    "grandfather",
}

MODERN_FROM = 1900
"""A chapter at or after this year is "the present" for a book like this.

A present-day scene naming a seventeenth-century figure is historiography, not a continuity error —
characters in 2011 discuss Kittamaquund and Mary Brent because that is the subject of the book. So a
jump INTO a modern chapter is never treated as a mistake. Two chapters both set in the past that
share a name across centuries are a different matter, and that is the case this check exists for."""

LIFESPAN_YEARS = 90
"""Beyond this, one person cannot appear in both chapters.

Deliberately generous. The question this check answers is not "is this character slightly old" but
"has a name survived longer than a human can", and a false alarm costs a glance while a miss costs
a reader's trust in the chronology."""

_COMMA_NUM = re.compile(r"(\d[\d,]*)")


def parse_period_year(period: str) -> int | None:
    """Approximate calendar year for a period label. BCE is negative. None when unreadable.

    Handles the shapes these outlines actually use: "ca. 10,500 BCE", "10,200 BCE", "March 2011",
    "1655", "ca. AD 1300", "contemporary".
    """
    if not period:
        return None
    text = period.strip()
    low = text.lower()
    if low in {"contemporary", "present day", "the present"}:
        from datetime import UTC, datetime

        return datetime.now(UTC).year
    found: list[int] = []
    for m in _COMMA_NUM.finditer(text):
        try:
            found.append(int(m.group(1).replace(",", "")))
        except ValueError:
            continue
    if not found:
        return None
    # The LARGEST number, not the first. "9 January 2012" parsed as year 9 under first-match, which
    # put every modern chapter two thousand years before the rest of the book and invented a
    # 2,003-year span for every present-day character in it.
    year = max(found)
    if re.search(r"\b(bce|bc)\b", low):
        return -year
    return year


@dataclass(frozen=True)
class NameSpan:
    """One name, and the widest period gap it is used across."""

    name: str
    earliest_chapter: int
    latest_chapter: int
    earliest_year: int
    latest_year: int
    chapters: tuple[int, ...]
    occurrences: int
    # The worst jump between two ADJACENT chapters, as (earlier chapter, later chapter, years).
    # None when the name never carries straight across a chapter boundary.
    adjacent_jump: tuple[int, int, int] | None = None

    @property
    def gap_years(self) -> int:
        return abs(self.latest_year - self.earliest_year)

    @property
    def reads_as_an_error(self) -> bool:
        """Does this span look like a mistake rather than a deliberate echo?

        A name reappearing twenty chapters and four thousand years later reads as what it usually
        is: a naming tradition, a descendant, an echo. The reader has long since let the first
        bearer go. The same name carried straight ACROSS A CHAPTER BOUNDARY into a period centuries
        later is different — the reader is still holding the person from the previous page, so they
        read continuity and get confusion.

        That is exactly the case a reader caught here: chapters 2 and 3 at 10,500 BCE, then chapter
        4 at 10,200 BCE, same name, no gap to signal the leap."""
        return self.adjacent_jump is not None

    def describe(self) -> str:
        def fmt(y: int) -> str:
            return f"{abs(y):,} BCE" if y < 0 else f"{y:,}"

        return (
            f'"{self.name}" appears in chapters {", ".join(str(c) for c in self.chapters)} — '
            f"ch{self.earliest_chapter} ({fmt(self.earliest_year)}) to "
            f"ch{self.latest_chapter} ({fmt(self.latest_year)}), a span of {self.gap_years:,} years"
        )


def names_in(text: str, *, min_occurrences: int = 2) -> dict[str, int]:
    """Candidate character names in one chapter, with their counts.

    ``min_occurrences`` defaults to 2 because a name used once is as likely to be a place, a stray
    capitalised noun, or a one-line walk-on as a character worth tracking across a book.
    """
    counts: dict[str, int] = {}
    for w in _NAME.findall(text or ""):
        if w.lower() in _STOP:
            continue
        # A hyphenated name is kept whole; its parts are not separately credible as names.
        counts[w] = counts.get(w, 0) + 1
    return {k: v for k, v in counts.items() if v >= min_occurrences}


_LOWER_WORD = re.compile(r"\b[a-z]{4,}(?:-[a-z]+)*\b")
_THE_BEFORE = "the"
_PLACE_PREPOSITIONS = (
    "in",
    "at",
    "to",
    "from",
    "on",
    "across",
    "along",
    "near",
    "above",
    "below",
    "up",
    "down",
    "into",
    "toward",
    "towards",
    "through",
    "past",
    "beyond",
)

ARTICLE_RATIO = 0.35
"""Above this share of "the <Name>" uses, the word is a thing, a people or a place — not a person.

"the English", "the Potomac", "the Piscataway" all pass every other test: they are capitalised, they
never appear lowercase, and they legitimately recur across four hundred years. What separates them
from a character is the article."""

PREPOSITION_RATIO = 0.35
"""Above this share of "in/at/to <Name>" uses, the word is somewhere rather than someone."""


def _corpus_filters(
    chapters: list[tuple[int, str, str]],
) -> tuple[set[str], dict[str, float], dict[str, float]]:
    """Corpus-wide evidence for telling a character from everything else that is capitalised.

    Three signals, all drawn from the book itself rather than from a word list that would need
    maintaining per project:

    * a word that ALSO appears in lower case somewhere is an ordinary English word that happened to
      start a sentence — "Good", "Four", "Somewhere", "Tomorrow", "Water", "Tell";
    * a word usually preceded by "the" is a thing, a people or a river — "the English", "the
      Potomac", "the Piscataway";
    * a word usually preceded by a place preposition is a location — "in Maryland", "to Annapolis".

    Without these the check reported 120 spans on a 96-chapter book, almost all of them place names
    and ordinary words, which is a report nobody would read twice.
    """
    lowercase_seen: set[str] = set()
    article_hits: dict[str, int] = {}
    prep_hits: dict[str, int] = {}
    totals: dict[str, int] = {}
    prep_alt = "|".join(_PLACE_PREPOSITIONS)
    for _, _, text in chapters:
        body = text or ""
        lowercase_seen.update(_LOWER_WORD.findall(body))
        for m in _NAME.finditer(body):
            w = m.group(0)
            totals[w] = totals.get(w, 0) + 1
            before = body[max(0, m.start() - 24) : m.start()]
            if re.search(rf"\b{_THE_BEFORE}\s+$", before, re.I):
                article_hits[w] = article_hits.get(w, 0) + 1
            elif re.search(rf"\b({prep_alt})\s+(the\s+)?$", before, re.I):
                prep_hits[w] = prep_hits.get(w, 0) + 1
    article_ratio = {w: article_hits.get(w, 0) / n for w, n in totals.items() if n}
    prep_ratio = {w: prep_hits.get(w, 0) / n for w, n in totals.items() if n}
    return lowercase_seen, article_ratio, prep_ratio


def looks_like_a_person(
    name: str,
    lowercase_seen: set[str],
    article_ratio: dict[str, float],
    prep_ratio: dict[str, float],
) -> bool:
    """Is this capitalised word plausibly a character rather than a place, a people or a word?"""
    if name.lower() in lowercase_seen:
        return False
    if article_ratio.get(name, 0.0) >= ARTICLE_RATIO:
        return False
    return not prep_ratio.get(name, 0.0) >= PREPOSITION_RATIO


def find_impossible_spans(
    chapters: list[tuple[int, str, str]],
    *,
    lifespan_years: int = LIFESPAN_YEARS,
    min_occurrences: int = 2,
) -> list[NameSpan]:
    """Names used across a period gap no person could span.

    ``chapters`` is (chapter_number, period_label, text). Chapters whose period cannot be parsed are
    skipped rather than guessed at — an invented year would invent a span.

    Sorted widest gap first: the worst offender is the one worth looking at.
    """
    lowercase_seen, article_ratio, prep_ratio = _corpus_filters(chapters)
    seen: dict[str, dict[int, int]] = {}
    years: dict[int, int] = {}
    for number, period, text in chapters:
        year = parse_period_year(period)
        if year is None:
            continue
        years[number] = year
        for name, count in names_in(text, min_occurrences=min_occurrences).items():
            if not looks_like_a_person(name, lowercase_seen, article_ratio, prep_ratio):
                continue
            seen.setdefault(name, {})[number] = count

    spans: list[NameSpan] = []
    for name, per_chapter in seen.items():
        if len(per_chapter) < 2:
            continue
        ordered = sorted(per_chapter, key=lambda c: years[c])
        lo, hi = ordered[0], ordered[-1]
        if abs(years[hi] - years[lo]) <= lifespan_years:
            continue
        in_book = sorted(per_chapter)
        worst: tuple[int, int, int] | None = None
        for a, b in pairwise(in_book):
            if b - a != 1:
                continue  # not adjacent in the book; the reader has had chapters to let go
            # EITHER side being modern means this is the book alternating between a present-day
            # thread and a historical one — chapter 53 (2011) sits between chapter 52 and chapter 54
            # (both 1640), so the pair jumps forward and then back. Neither direction is an error.
            if years[a] >= MODERN_FROM or years[b] >= MODERN_FROM:
                continue
            jump = abs(years[b] - years[a])
            if jump > lifespan_years and (worst is None or jump > worst[2]):
                worst = (a, b, jump)
        spans.append(
            NameSpan(
                name=name,
                earliest_chapter=lo,
                latest_chapter=hi,
                earliest_year=years[lo],
                latest_year=years[hi],
                chapters=tuple(in_book),
                occurrences=sum(per_chapter.values()),
                adjacent_jump=worst,
            )
        )
    # Spans that carry across a chapter boundary first: those are the ones a reader trips over.
    return sorted(spans, key=lambda s: (s.reads_as_an_error, s.gap_years), reverse=True)


__all__ = [
    "ARTICLE_RATIO",
    "LIFESPAN_YEARS",
    "MODERN_FROM",
    "PREPOSITION_RATIO",
    "NameSpan",
    "find_impossible_spans",
    "looks_like_a_person",
    "names_in",
    "parse_period_year",
]
