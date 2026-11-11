"""Chapter prose -> what the voice is given, in order, with the pauses between.

The speech provider takes a bounded amount of text per call, and a chapter is far longer, so the
chapter is cut into chunks at paragraph (then sentence) boundaries — never mid-sentence, which would
put a breath in the wrong place. A scene break (``---``) becomes a long pause; the gap between two
chunks is a short one, so the join is not heard as a join.

Markup the manuscript uses is stripped, never spoken: ``*italic*`` becomes plain words, headings lose
their ``#``. The words themselves are untouched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# What a single speech call is given. The provider's limit is in tokens (about 2,000), well above
# this; a smaller chunk also keeps one failed call cheap to retry and the delivery consistent.
MAX_CHUNK_CHARS = 2400

# Pauses, in seconds.
PAUSE_BETWEEN_CHUNKS = 0.4
PAUSE_AFTER_TITLE = 1.1
PAUSE_SCENE_BREAK = 1.8

_SCENE_BREAK = re.compile(r"^\s*(?:-{3,}|\*{3,}|(?:\*\s+){2,}\*|#{3}|~{3,}|_{3,})\s*$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+")
# A sentence ends at . ! ? or an ellipsis (U+2026), plus any closing quote or bracket (straight, or the
# curly U+201D / U+2019). Built from code points so no look-alike character sits in the source.
_ENDERS = ".!?" + chr(0x2026)
_CLOSERS = "".join(chr(c) for c in (0x22, 0x27, 0x201D, 0x2019, 0x29, 0x5D))
_SENTENCE_END = re.compile(f"(?<=[{re.escape(_ENDERS)}])[{re.escape(_CLOSERS)}]*\\s+")


@dataclass(frozen=True)
class Segment:
    """Either a stretch of speech or a pause. Exactly one of ``text`` / ``seconds`` is set."""

    text: str = ""
    seconds: float = 0.0

    @property
    def is_pause(self) -> bool:
        return not self.text


def clean(text: str) -> str:
    """Strip markup from one block, keeping every word."""
    t = _HEADING.sub("", text)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S)
    t = re.sub(r"(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])", r"\1", t)
    t = re.sub(r"(?<![\w_])_(\S(?:[^_\n]*\S)?)_(?![\w_])", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)  # [text](url) -> text
    t = t.replace(chr(0xA0), " ")  # a no-break space is a space to the ear
    return re.sub(r"[ \t]+", " ", re.sub(r"\s*\n\s*", " ", t)).strip()


def _split_long(paragraph: str) -> list[str]:
    """A paragraph longer than one chunk, cut at sentence ends (a very long sentence at a space)."""
    out: list[str] = []
    cur = ""
    for sentence in _SENTENCE_END.split(paragraph):
        while len(sentence) > MAX_CHUNK_CHARS:
            cut = sentence.rfind(" ", 0, MAX_CHUNK_CHARS)
            cut = cut if cut > 0 else MAX_CHUNK_CHARS
            if cur:
                out.append(cur)
                cur = ""
            out.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if cur and len(cur) + 1 + len(sentence) > MAX_CHUNK_CHARS:
            out.append(cur)
            cur = sentence
        else:
            cur = f"{cur} {sentence}".strip()
    if cur:
        out.append(cur)
    return out


def segments(body: str, *, title_line: str = "") -> list[Segment]:
    """The narration of ``body`` (chapter prose), optionally led by a spoken ``title_line``."""
    out: list[Segment] = []
    if title_line.strip():
        out.append(Segment(text=clean(title_line)))
        out.append(Segment(seconds=PAUSE_AFTER_TITLE))

    chunk = ""

    def flush() -> None:
        nonlocal chunk
        if chunk:
            if out and not out[-1].is_pause:
                out.append(Segment(seconds=PAUSE_BETWEEN_CHUNKS))
            out.append(Segment(text=chunk))
            chunk = ""

    for raw in re.split(r"\n\s*\n", body or ""):
        block = raw.strip()
        if not block:
            continue
        if _SCENE_BREAK.match(block):
            flush()
            if out and out[-1].is_pause:
                out[-1] = Segment(seconds=max(out[-1].seconds, PAUSE_SCENE_BREAK))
            elif out:
                out.append(Segment(seconds=PAUSE_SCENE_BREAK))
            continue
        para = clean(block)
        if not para:
            continue
        for piece in _split_long(para) if len(para) > MAX_CHUNK_CHARS else [para]:
            if chunk and len(chunk) + 2 + len(piece) > MAX_CHUNK_CHARS:
                flush()
            chunk = f"{chunk}\n\n{piece}" if chunk else piece
    flush()
    return out


def pronunciation_entries(raw: object) -> list[tuple[str, str]]:
    """The author's guide as (word, say) pairs: well-formed entries only, longest word first.

    Longest first so "Harrow Vale" is respelled as a whole before "Harrow" gets a chance to be.
    """
    out: list[tuple[str, str]] = []
    if isinstance(raw, list):
        for e in raw[:300]:
            if isinstance(e, dict):
                word, say = (
                    " ".join(str(e.get("word") or "").split()),
                    " ".join(str(e.get("say") or "").split()),
                )
                if word and say:
                    out.append((word[:60], say[:80]))
    return sorted(out, key=lambda p: -len(p[0]))


def apply_pronunciations(body: str, raw: object) -> str:
    """Swap each guide word for its respelling, in the narration text only.

    Whole words, case-sensitive ("Mara" is a name; "mara" is not), so "Mara's" becomes "Mah-rah's" and
    "Maraud" is left alone. A multi-word entry matches across any run of spaces.
    """
    for word, say in pronunciation_entries(raw):
        pattern = r"(?<!\w)" + r"\s+".join(re.escape(w) for w in word.split()) + r"(?!\w)"
        body = re.sub(
            pattern, say.replace("\\", "\\\\"), body
        )  # a literal replacement, never a back-reference
    return body


def speech_chars(segs: list[Segment]) -> int:
    return sum(len(s.text) for s in segs)
