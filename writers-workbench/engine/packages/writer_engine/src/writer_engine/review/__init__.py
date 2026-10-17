"""Editorial review lenses (E7) — the Draft Review Kit, as an engine op.

``chapter.qa`` scores craft automatically and the consistency rubric checks pass/fail. Neither is a
*critique*: they tell you a dimension scored 0.62, not that the scene stands and explains instead of
walking and talking. These lenses are the named voices a user invokes on purpose.

``lenses`` holds the vendored prompts and the lens taxonomy; ``runner`` runs them and shapes the
findings into the ``{name, status, details}`` rows the Q/A panel already renders.

Provenance: EveryInc's draft-review-kit (MIT, Katie Parrott). ``skills/LICENSE`` is the kit's licence
and must stay with the copies.
"""

from writer_engine.review.lenses import ALL_LENSES, DEFAULT_LENSES, SINGLE_LENSES, UnknownLens, expand
from writer_engine.review.runner import LensReport, review_draft, run_lens

__all__ = [
    "ALL_LENSES",
    "DEFAULT_LENSES",
    "SINGLE_LENSES",
    "LensReport",
    "UnknownLens",
    "expand",
    "review_draft",
    "run_lens",
]
