"""The narrator's direction.

A text-to-speech voice that is only handed text reads it flat. The model follows plain-language
direction, so the difference between a robotic read and a performed one is this paragraph. Every
style starts from the same base (a performing audiobook narrator, American English, varied pitch and
pace, a distinct but restrained voice for dialogue) and a preset adds what the genre wants.

The direction never asks the voice to change the words: an audiobook that paraphrases is a different
book from the one the author wrote.
"""

from __future__ import annotations

BASE = (
    "You are a professional audiobook narrator performing a novel for an American audience, in natural "
    "American English. Perform the text; do not just read it. Vary pitch, pace and volume with the "
    "meaning of each sentence, the way a gifted human narrator does: slow down and soften for quiet or "
    "emotional moments, tighten and quicken for action and tension, and let a sentence land before "
    "starting the next. Give dialogue a subtly different voice from the narration, with feeling in it, "
    "but never a cartoonish accent or caricature. Pause naturally at commas, full stops, dashes and "
    "paragraph ends. Never sound flat, monotone, rushed, sing-song or robotic. Read the text exactly as "
    "written: do not add, skip, repeat or paraphrase any words, and never read punctuation marks or "
    "formatting aloud."
)

PRESETS: dict[str, str] = {
    "fiction": "Overall delivery: warm, engaged and expressive, a confident storyteller.",
    "thriller": (
        "Overall delivery: tense and controlled. Keep the narration low and measured so that the "
        "moments of danger and revelation hit hard; speed up through action, and go quiet and close "
        "before something is about to happen."
    ),
    "intimate": (
        "Overall delivery: intimate and gentle, as if telling the story to one person close by. "
        "Softer volume, unhurried pacing, plenty of breath and feeling in the emotional lines."
    ),
    "epic": (
        "Overall delivery: grand and dramatic, with gravity in the narration and real weight on big "
        "moments. Let the scale of the world and the stakes come through in the voice."
    ),
}

DEFAULT_STYLE = "fiction"


def instructions_for(style: str, custom: str = "") -> str:
    """The full direction for a style key; ``custom`` is the author's own addition (any style)."""
    key = style if style in PRESETS else DEFAULT_STYLE
    parts = [BASE, PRESETS[key]]
    extra = " ".join((custom or "").split())[:600]
    if extra:
        parts.append(f"The author also asks: {extra}")
    return " ".join(parts)
