"""The ``content_ingestion_v2.key`` convention, ported from n8n (E1).

``key`` is the identity of an ingested item and the only dedupe handle the pipeline has. It is also
the prefix the newsletter gathers on (``gather_step`` queries ``key like '<send_date>/%'``), and the
storage path: the blobs live at ``<key>.md`` and ``<key>.html`` inside the ``newsletter-ingestion``
bucket. Getting it wrong does not error — it silently splits an item from its own history.

Shape, from migration 009 and the 3,926 rows already in DEV::

    {YYYY-MM-DD}/{slug-of-title}.{source-name}

The n8n ``get_identity`` node built it with::

    $json.isoDate.substring(0, 10) + "/" + title.toLowerCase()
        .replace(/[^a-z0-9 -]/g, '').trim().replace(/\\s+/g, '-').replace(/-+/g, '-')
      + '.' + $json.sourceName

**That expression is J6.** Every four hours since 2026-09-24 the DEV ingestion workflow died at
``search_existing`` with ``prefix: key is required`` — because an item with no ``isoDate`` (or no
title) produced an empty ``uploadFileName``, and one bad item in a batch took the whole execution
down with it. 23 days of ingestion lost to a missing field on a single feed entry.

So this port keeps the shape byte-for-byte and changes only the failure behaviour:

* a missing or unparseable published date falls back to **today** (UTC) rather than raising — the
  item is still worth having, and a date-prefixed key only has to be stable, not perfect
* a title that slugifies to nothing yields ``None`` from :func:`build_key`, and the caller skips
  that one item instead of losing the batch

The slug is capped at :data:`MAX_SLUG_CHARS`. The upload path enforces 512 characters on the whole
key, and an untruncated news headline plus a long source tag can get close.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime

MAX_SLUG_CHARS = 120
"""Cap on the title slug. The n8n original had none; the DB cap is 512 for the whole key."""

# The upload route's own safety test (`isUnsafeKey`): anything outside this set is rejected there, so
# a key that fails it here would 400 later.
_SAFE_KEY = re.compile(r"^[A-Za-z0-9._\-/]+$")

# Exactly the n8n character class: strip everything that is not a-z, 0-9, space or dash. Applied
# AFTER lowercasing, which is why there is no A-Z here.
_DROP = re.compile(r"[^a-z0-9 -]")
_SPACES = re.compile(r"\s+")
_DASHES = re.compile(r"-+")


def slugify_title(title: str) -> str:
    """The n8n title slug: lowercase, drop punctuation, spaces to dashes, collapse dashes.

    Returns "" when nothing survives (a CJK or emoji-only headline), which the caller must treat as
    "skip this item" — a key of ``2026-10-17/.bbc`` would pass the safety regex and be meaningless.
    """
    text = _DROP.sub("", (title or "").lower())
    text = _SPACES.sub("-", text.strip())
    text = _DASHES.sub("-", text).strip("-")
    return text[:MAX_SLUG_CHARS].strip("-")


def slugify_source(name: str) -> str:
    """Slug for the source tag. Same rules as the title, shorter cap, dots collapsed to dashes."""
    return slugify_title((name or "").replace(".", " "))[:48].strip("-")


def parse_published_date(value: object, *, now: datetime | None = None) -> date:
    """The date half of the key: the item's published date, or today when it has none.

    Tolerates the four shapes the feeds actually produce — an ISO-8601 string with or without ``Z``,
    a ``datetime``, a ``date``, and a Reddit epoch (``created_utc``, seconds, int or float).
    """
    today = (now or datetime.now(UTC)).astimezone(UTC).date()
    if isinstance(value, datetime):
        return value.astimezone(UTC).date() if value.tzinfo else value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool):
        # Reddit's created_utc. Guard against 0 / negative / absurd values rather than letting
        # fromtimestamp raise (or produce 1970, which would bury the item under a dead prefix).
        try:
            if 1_000_000_000 < float(value) < 4_000_000_000:
                return datetime.fromtimestamp(float(value), tz=UTC).date()
        except (OverflowError, OSError, ValueError):
            return today
        return today
    text = str(value or "").strip()
    if not text:
        return today
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        # RFC-822 `pubDate` ("Fri, 17 Oct 2026 09:30:00 GMT") — what plain RSS XML carries.
        for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        else:
            return today
    return parsed.astimezone(UTC).date() if parsed.tzinfo else parsed.date()


def build_key(
    *, title: str, source_name: str, published: object = None, now: datetime | None = None
) -> str | None:
    """Build the key, or ``None`` when this item cannot have one.

    ``None`` means "skip this item": either the title slugified to nothing, or the source tag did.
    Both are per-item conditions, and the caller counts them rather than failing the feed — the
    whole point of the J6 fix.
    """
    slug = slugify_title(title)
    tag = slugify_source(source_name)
    if not slug or not tag:
        return None
    key = f"{parse_published_date(published, now=now).isoformat()}/{slug}.{tag}"
    return key if is_safe_key(key) else None


def is_safe_key(key: str) -> bool:
    """Mirror of the upload route's ``isUnsafeKey`` guard, inverted.

    Duplicated deliberately: the engine writes storage directly rather than through the Express
    route, so the one place that used to enforce this is no longer on the path.
    """
    if not key or len(key) > 512:
        return False
    if "\0" in key or key.startswith("/") or ".." in key:
        return False
    return bool(_SAFE_KEY.match(key))


__all__ = [
    "MAX_SLUG_CHARS",
    "build_key",
    "is_safe_key",
    "parse_published_date",
    "slugify_source",
    "slugify_title",
]
