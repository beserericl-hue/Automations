"""The Content Studio assistant's command grammar — deterministic, before any LLM.

The n8n studios were chat agents whose system prompts listed the commands; the model then decided. The
commands are regular enough to parse, which is cheaper, instant, and never misroutes a "cancel 4"
into something else. Anything this does not recognise goes to the Gemini router restricted to the
studio ops (``writer_engine.hub.router``).

Numbers: after **generate** (and **put … in the newsletter**) a plain number is a SLATE rank, as in
n8n ("generate 1-5, 8, 12-16"). Everywhere else a number is a POST number, ``#N`` or ``N``, as in the
n8n queue ("edit 12", "cancel 4"). In the newsletter commands ``#N`` is a post and ``N`` a rank.
"""

from __future__ import annotations

import re
from typing import Any

_NUMS = r"(?:#?\s*\d+(?:\s*-\s*#?\s*\d+)?)(?:\s*(?:,|and|&)\s*#?\s*\d+(?:\s*-\s*#?\s*\d+)?)*"
_DAY = (
    r"today|tomorrow|(?:next\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|mon|tue|wed|thu|fri|sat|sun|"
    r"\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}"
)

HELP = (
    "I can: show the slate · generate 1-5, 8 · revise #3 to be shorter · regenerate #3 · undo #3 · "
    "approve #3 (or approve all) · discard #3 · image on/off #3 · schedule #3 [tuesday afternoon | "
    "2026-11-10 | now] · schedule all approved · list the queue · cancel #4 · requeue #4 · email #3 · "
    "email the digest · put 1-6 in the newsletter · add #3 to the newsletter · remove #3 from the "
    "newsletter · show the newsletter · start a new issue."
)


def normalise_numbers(text: str) -> str:
    """ "1-5 and 8 & #12" → "1-5, 8, #12"."""
    t = re.sub(r"\s*(?:,|\band\b|&)\s*", ", ", text.strip())
    return re.sub(r"\s*-\s*", "-", t)


def _split_hash(spec: str) -> tuple[str, str]:
    """Split a number list into (plain ranks, #posts)."""
    ranks: list[str] = []
    posts: list[str] = []
    for part in normalise_numbers(spec).split(","):
        p = part.strip()
        if not p:
            continue
        (posts if p.startswith("#") else ranks).append(p.lstrip("#").replace("#", ""))
    return ", ".join(ranks), ", ".join(posts)


def _posts(spec: str) -> str:
    return normalise_numbers(spec).replace("#", "")


def parse(message: str) -> tuple[str, dict[str, Any]] | None:
    """``(op, params)`` for a studio command, or None."""
    m0 = (message or "").strip().rstrip(".!")
    low = m0.lower()
    if not low:
        return None

    if re.fullmatch(r"(?:help|commands|what can you do\??)", low):
        return "help", {}

    # --- newsletter selection (before generate/remove/show, which share words)
    if re.search(r"\b(newsletter|issue|digest)\b", low) and not re.match(r"(?:email|send|mail)\b", low):
        if re.search(r"\b(new|fresh|next)\s+(issue|selection)\b|\bstart\b", low) and not re.search(
            r"\d", low
        ):
            return "issue", {"action": "new"}
        m = re.search(rf"\b(put|add|include|use)\s+(?:(?:topics?|posts?|items?|stories)\s+)?({_NUMS})", low)
        if m:
            ranks, posts = _split_hash(m.group(2))
            replace = m.group(1) == "use" or bool(re.search(r"\bonly\b", low))
            return "issue", {"action": "set" if replace else "add", "ranks": ranks, "posts": posts}
        m = re.search(rf"\b(remove|drop|take)\s+(?:(?:topics?|posts?|items?|stories)\s+)?({_NUMS})", low)
        if m:
            ranks, posts = _split_hash(m.group(2))
            return "issue", {"action": "remove", "ranks": ranks, "posts": posts}
        if re.search(r"\b(clear|empty)\b", low):
            return "issue", {"action": "set", "ranks": "", "posts": ""}
        if re.search(r"\b(show|list|what'?s|view|see)\b", low):
            return "issue", {"action": "show"}

    # --- generate N (slate ranks)
    m = re.match(
        rf"(?:please\s+)?(?:re-?)?(generate|draft|write)\s+(?:(?:topics?|items?|numbers?)\s+)?(all|everything|{_NUMS})\b",
        low,
    )
    if m and not re.search(r"#", m.group(2)):
        spec = "all" if m.group(2) in ("all", "everything") else normalise_numbers(m.group(2))
        return "generate", {"numbers": spec, "redo": low.startswith(("regenerate", "re-generate", "redraft"))}
    if re.match(r"(generate|draft)\s+(the\s+)?(whole|entire)\s+(slate|week)", low):
        return "generate", {"numbers": "all"}

    # --- slate
    if re.fullmatch(
        r"(?:show|list|see|view|get)?\s*(?:me\s+)?(?:the\s+|this\s+week'?s\s+)?(?:slate|topics|menu|options)(?:\s+for\s+.*)?",
        low,
    ) or low in ("hi", "hello", "topics"):
        wk = re.search(r"\d{4}-\d{2}-\d{2}", low)
        return "slate", {"week_of": wk.group(0)} if wk else {}

    # --- regenerate / undo #N
    m = re.match(rf"(?:regenerate|redraft|re-draft|redo)\s+({_NUMS})$", low)
    if m:
        return "revise", {"posts": _posts(m.group(1)), "mode": "regenerate"}
    m = re.match(rf"(?:undo|revert|restore)\s+({_NUMS})$", low)
    if m:
        return "revise", {"posts": _posts(m.group(1)), "mode": "undo"}

    # --- revise #N <instruction>
    m = re.match(
        r"(revise|rewrite|edit|tighten|shorten|expand|punch up|restyle|improve|change)\s+(?:post\s+)?(#\s*\d+|\d+)\b[:,]?\s*(.*)$",
        m0,
        re.I,
    )
    if m:
        verb, num, rest = m.group(1).lower(), m.group(2), m.group(3).strip()
        instruction = rest
        if verb not in ("revise", "rewrite", "edit", "change"):
            instruction = f"{verb} it" + (f" {rest}" if rest else "")
        instruction = re.sub(r"^(to\s+|so\s+(?:that\s+)?)", "", instruction, flags=re.I).strip()
        if instruction:
            return "revise", {"posts": _posts(num), "instruction": instruction, "mode": "revise"}

    # --- image on/off
    m = re.search(rf"\b(no|remove|drop|without)\s+(?:the\s+)?image\s+(?:on|from|for)\s+({_NUMS})", low)
    if m:
        return "update", {"action": "image_off", "posts": _posts(m.group(2))}
    m = re.search(rf"\b(?:add\s+(?:an?\s+)?|with\s+(?:an?\s+)?|)image\s+(?:on|to|for)\s+({_NUMS})", low)
    if m:
        return "update", {"action": "image_on", "posts": _posts(m.group(1))}

    # --- approve / discard / cancel / requeue / unschedule
    for verbs, action in (
        (r"approve", "approve"),
        (r"unapprove|back to draft", "unapprove"),
        (r"discard|delete|trash|reject", "discard"),
        (r"cancel|remove", "cancel"),
        (r"requeue|retry|re-queue", "requeue"),
        (r"unschedule", "unschedule"),
    ):
        m = re.match(rf"(?:{verbs})\s+(?:posts?\s+)?(all(?:\s+drafts)?|{_NUMS})$", low)
        if m:
            target = m.group(1)
            if target.startswith("all"):
                return "update", {"action": action, "posts": "all"}
            return "update", {"action": action, "posts": _posts(target)}

    # --- schedule / publish
    m = re.match(
        r"(?:publish|post)\s+(?:(all\s+approved|everything\s+approved|" + _NUMS + r"))\s+(?:right\s+)?now$",
        low,
    ) or re.match(r"(?:publish|post)\s+(" + _NUMS + r")$", low)
    if m:
        target = m.group(1)
        return "schedule", {"posts": "approved" if "approved" in target else _posts(target), "mode": "now"}
    m = re.match(
        r"schedule\s+(all\s+(?:the\s+)?approved(?:\s+posts)?|all(?:\s+drafts)?|approved|" + _NUMS + r")(.*)$",
        low,
    )
    if m:
        target, rest = m.group(1), m.group(2).strip()
        posts = (
            "approved" if "approved" in target else ("drafts" if target.startswith("all") else _posts(target))
        )
        params: dict[str, Any] = {"posts": posts, "mode": "next"}
        if re.search(r"\bnow\b", rest):
            params["mode"] = "now"
        else:
            day = re.search(rf"\b({_DAY})\b", rest)
            at = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", rest)
            slot = "afternoon" if re.search(r"afternoon|\bpm\b|2\s*pm", rest) else "morning"
            if day:
                params["day"] = day.group(1)
                if at:
                    params["mode"] = "at"
                    params["time"] = f"{at.group(1)}:{at.group(2) or '00'} {at.group(3) or ''}".strip()
                else:
                    params["mode"] = "slot"
                    params["slot"] = slot
        chan = re.search(
            r"\bto\s+((?:website|techahir|agile|personal|linkedin|both)(?:\s*(?:,|and)\s*(?:website|techahir|agile|personal|linkedin|both))*)",
            rest,
        )
        if chan:
            params["channels"] = chan.group(1)
        return "schedule", params

    # --- queue
    if (
        re.fullmatch(
            r"(?:show|list|see|view)?\s*(?:me\s+)?(?:the\s+)?(?:queue|schedule|scheduled(?:\s+posts)?|calendar)",
            low,
        )
        or low == "list"
    ):
        return "queue", {"status": "queue"}
    if re.fullmatch(
        r"(?:show|list|see|view)?\s*(?:me\s+)?(?:the\s+|my\s+)?(?:drafts|draft posts|review queue)", low
    ):
        return "queue", {"status": "drafts"}
    if re.fullmatch(r"(?:show|list|see|view)?\s*(?:me\s+)?(?:the\s+|my\s+)?(?:approved(?:\s+posts)?)", low):
        return "queue", {"status": "approved"}
    m = re.match(r"(?:show|get|open)\s+(#\s*\d+|\d+)$", low)
    if m:
        return "queue", {"status": "one", "posts": _posts(m.group(1))}

    # --- email
    if re.match(r"(?:email|mail|send)\s+(?:me\s+)?(?:the\s+)?(?:roundup|digest|slate|week)", low) or low in (
        "email all",
        "send the digest",
    ):
        return "email", {"target": "digest"}
    m = re.match(rf"(?:email|mail|send)\s+(?:me\s+)?(?:post\s+)?({_NUMS})", low)
    if m:
        return "email", {"posts": _posts(m.group(1))}
    return None
