"""Seed the post calendar's set-up — social channels, radar subscriptions, the two radar editions and
their feed sources — on DEV or, deliberately, on PROD.

    python scripts/seed_social.py                                   dry run against DEV (default)
    python scripts/seed_social.py --apply                           write to DEV
    python scripts/seed_social.py --target prod --confirm           dry run against PROD (reads only)
    python scripts/seed_social.py --target prod --confirm --apply   write to PROD
    python scripts/seed_social.py --target prod --offline           print the plan, touch no database

``seed_social_dev.py`` refuses anything but DEV, so there was no tool for the PROD cutover. This one
keeps the same rows (imported from it, so the two cannot drift) and adds the guard rails a PROD write
needs:

* **Dry run by default.** Nothing is written without ``--apply``. A dry run prints every row it would
  write and, unless ``--offline``, reads the target to say which are inserts and which are updates.
* **PROD only on purpose.** ``--target prod`` refuses to touch the network at all without
  ``--confirm``, and ``SUPABASE_URL`` must actually be the PROD project for ``--target prod`` (and the
  DEV project for ``--target dev``): a DEV key pointed at by a PROD flag, or the reverse, is refused.
* **Idempotent.** Subscriptions and editions are upserts on their keys. Channels and the Blotato
  account (user_integrations_v2, migration 043) are user settings now, so — like seed_social_dev.py —
  they are inserted only when missing and never overwrite what the owner set in the UI; API keys are
  entered in Settings -> Integrations, never here. A feed source is added only when the edition does
  not already have that URL (its unique index is on ``lower(url)``,
  which PostgREST cannot upsert on). A row already as seeded is not written at all ("same"), and an
  update names the fields it changes, so a second run writes nothing.
* **Never takes over someone else's edition.** An edition id that already exists under a different
  user is skipped and reported, not overwritten.
* **Disabled by default on PROD.** Enabled radar subscriptions draft posts every week and enabled
  channels are posted to, so on PROD the rows are written ``enabled=false`` unless ``--enable``. DEV
  keeps the DEV seed's behaviour (enabled).
* The target user must already exist in ``users_v2`` (checked before any write).

Credentials come from the environment only (e.g. ``railway run -s WritersWorkbench -e develop -- ...``):
``SUPABASE_URL``, ``SUPABASE_SERVICE_ROLE_KEY``. No secret is ever written to a row or printed: the
Blotato key and the blog token are entered per user in Settings -> Integrations.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seed_social_dev import BLOTATO_ACCOUNT_ID, CHANNELS, EDITIONS, USER  # noqa: E402  (one definition of the rows)

REFS = {"dev": "gvbvwcnmjkdpclcisqrr", "prod": "faklxfakgzkpkbxfihzh"}

TREND_CHANNELS = ["website", "li_techahir", "li_agile", "li_personal"]
DEV_CHANNELS = ["li_techahir", "li_agile", "li_personal"]


class Refused(SystemExit):
    """A guard rail said no. Exit code 2, message on stderr."""

    def __init__(self, message: str) -> None:
        print(f"REFUSING: {message}", file=sys.stderr)
        super().__init__(2)


# --------------------------------------------------------------------------- the plan


@dataclass
class Step:
    table: str
    key: str  # what identifies the row, for the report
    row: dict[str, Any]
    on_conflict: str | None  # None = insert-if-absent (feed sources)
    action: str = "upsert"  # upsert | insert | update | skip
    note: str = ""


@dataclass
class Plan:
    target: str
    user_id: str
    enabled: bool
    steps: list[Step] = field(default_factory=list)


def build_plan(*, target: str, user_id: str, enabled: bool) -> Plan:
    """Every row the seed writes, in dependency order (editions before their feed sources)."""
    plan = Plan(target=target, user_id=user_id, enabled=enabled)
    # Channels and the Blotato account are user settings (Settings -> Integrations, migration 043):
    # inserted when missing, never overwritten — the same rule as seed_social_dev.py.
    for c in CHANNELS:
        plan.steps.append(
            Step("social_channels_v2", c["channel"], {"user_id": user_id, "enabled": enabled, **c}, None)
        )
    plan.steps.append(
        Step(
            "user_integrations_v2",
            "blotato",
            {"user_id": user_id, "provider": "blotato", "channel": None, "config": {"account_id": BLOTATO_ACCOUNT_ID}},
            None,
        )
    )
    for radar, chans, edition in (("trend", TREND_CHANNELS, "ai-mvp"), ("dev", DEV_CHANNELS, "ai-dev-roundup")):
        plan.steps.append(
            Step(
                "radar_subscriptions_v2",
                radar,
                {
                    "user_id": user_id,
                    "radar": radar,
                    "enabled": enabled,
                    "settings": {"channels": chans, "edition_id": edition},
                },
                "user_id,radar",
            )
        )
    for e in EDITIONS:
        row = {k: v for k, v in e.items() if k != "feeds"}
        plan.steps.append(
            Step("newsletter_editions_v2", e["id"], {**row, "user_id": user_id, "enabled": enabled}, "id")
        )
        for name, url, kind in e["feeds"]:
            plan.steps.append(
                Step(
                    "newsletter_feed_sources_v2",
                    f"{e['id']} {url}",
                    {
                        "user_id": user_id,
                        "edition_id": e["id"],
                        "name": name,
                        "url": url,
                        "url_type": kind,
                        "active": True,
                        "fetch_interval_minutes": 1440,
                    },
                    None,
                )
            )
    return plan


# --------------------------------------------------------------------------- the database


class Supabase:
    """Minimal PostgREST client (service role). Every request is logged by method + table only."""

    def __init__(self, url: str, key: str) -> None:
        self.url = url.rstrip("/")
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        self.writes = 0

    def _req(self, method: str, path: str, body: Any = None, prefer: str = "") -> Any:
        headers = {**self.headers, "User-Agent": "seed-social"}
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise SystemExit(f"{method} {path.split('?')[0]} -> {exc.code}: {exc.read()[:300]!r}") from exc
        return json.loads(raw) if raw else None

    def select(self, table: str, query: str) -> list[dict[str, Any]]:
        return self._req("GET", f"{table}?{query}") or []

    def upsert(self, table: str, row: dict[str, Any], on_conflict: str) -> None:
        self.writes += 1
        self._req(
            "POST",
            f"{table}?on_conflict={on_conflict}",
            [row],
            "resolution=merge-duplicates,return=minimal",
        )

    def insert(self, table: str, row: dict[str, Any]) -> None:
        self.writes += 1
        self._req("POST", table, [row], "return=minimal")


def _q(v: str) -> str:
    return urllib.parse.quote(v, safe="")


def classify(plan: Plan, db: Supabase) -> None:
    """Read the target and mark each step insert / update / skip. Reads only."""
    uid = _q(plan.user_id)
    for s in plan.steps:
        r = s.row
        if s.table in ("social_channels_v2", "user_integrations_v2"):
            if s.table == "social_channels_v2":
                q = f"select=user_id&user_id=eq.{uid}&channel=eq.{_q(r['channel'])}"
            else:
                q = f"select=user_id&user_id=eq.{uid}&provider=eq.{_q(r['provider'])}"
            if db.select(s.table, q):
                s.action, s.note = "same", "exists; settings made in the UI are kept"
            else:
                s.action = "insert"
            continue
        if s.table == "radar_subscriptions_v2":
            have = db.select(s.table, f"select=*&user_id=eq.{uid}&radar=eq.{_q(r['radar'])}")
        elif s.table == "newsletter_editions_v2":
            have = db.select(s.table, f"select=*&id=eq.{_q(r['id'])}")
            if have and have[0].get("user_id") != plan.user_id:
                s.action, s.note = "skip", "edition id already belongs to another user; not overwritten"
                continue
        else:
            rows = db.select(s.table, f"select=url&user_id=eq.{uid}&edition_id=eq.{_q(r['edition_id'])}")
            if any(str(x.get("url") or "").lower() == r["url"].lower() for x in rows):
                s.action, s.note = "same", "feed source already present"
                continue
            have = []
        if not have:
            s.action = "insert"
            continue
        changed = sorted(k for k, v in r.items() if have[0].get(k) != v)
        if changed:
            s.action, s.note = "update", "changes: " + ", ".join(changed)
        else:
            s.action, s.note = "same", "already as seeded"
    # A feed source of a skipped edition would attach to someone else's edition.
    skipped = {s.row["id"] for s in plan.steps if s.table == "newsletter_editions_v2" and s.action == "skip"}
    for s in plan.steps:
        if s.table == "newsletter_feed_sources_v2" and s.row["edition_id"] in skipped and s.action != "skip":
            s.action, s.note = "skip", "its edition was skipped"


def apply(plan: Plan, db: Supabase) -> None:
    for s in plan.steps:
        if s.action in ("skip", "same"):
            continue
        if s.on_conflict:
            db.upsert(s.table, s.row, s.on_conflict)
        else:
            db.insert(s.table, s.row)


# --------------------------------------------------------------------------- guard rails


def resolve_target(args: argparse.Namespace, env: dict[str, str]) -> tuple[str, str] | None:
    """(url, key) for the target, or None for --offline. Raises Refused on any mismatch."""
    if args.target == "prod" and not args.confirm and not args.offline:
        raise Refused("--target prod needs --confirm (add --offline to only print the plan)")
    if args.apply and args.offline:
        raise Refused("--apply and --offline together make no sense")
    if args.offline:
        return None
    url = (env.get("SUPABASE_URL") or "").strip().strip('"').rstrip("/")
    key = (env.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip().strip('"')
    if not url or not key:
        raise Refused("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (use railway run)")
    want, other = REFS[args.target], REFS["prod" if args.target == "dev" else "dev"]
    if want not in url or other in url:
        raise Refused(f"--target {args.target} but SUPABASE_URL is not the {args.target.upper()} project ({want})")
    return url, key


def report(plan: Plan, *, mode: str) -> str:
    lines = [f"seed_social: target={plan.target} user={plan.user_id} enabled={plan.enabled} mode={mode}"]
    for s in plan.steps:
        shown = {k: v for k, v in s.row.items() if k != "user_id"}
        lines.append(f"  {s.action:<7} {s.table:<27} {s.key}" + (f"  ({s.note})" if s.note else ""))
        lines.append(f"          {json.dumps(shown, sort_keys=True)}")
    counts: dict[str, int] = {}
    for s in plan.steps:
        counts[s.action] = counts.get(s.action, 0) + 1
    lines.append("  totals: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return "\n".join(lines)


def main(argv: list[str] | None = None, env: dict[str, str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--target", choices=("dev", "prod"), default="dev")
    ap.add_argument("--confirm", action="store_true", help="required for any contact with PROD")
    ap.add_argument("--apply", action="store_true", help="write; without it this is a dry run")
    ap.add_argument("--offline", action="store_true", help="print the plan without reading any database")
    ap.add_argument("--user-id", default=USER)
    ap.add_argument(
        "--enable",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="seed channels/subscriptions/editions enabled (default: on for dev, off for prod)",
    )
    args = ap.parse_args(argv)
    env = dict(os.environ) if env is None else env

    creds = resolve_target(args, env)
    enabled = args.enable if args.enable is not None else args.target == "dev"
    plan = build_plan(target=args.target, user_id=args.user_id, enabled=enabled)

    if creds is None:
        print(report(plan, mode="offline dry run (no database read)"))
        return 0

    db = Supabase(*creds)
    if not db.select("users_v2", f"select=user_id&user_id=eq.{_q(args.user_id)}"):
        raise Refused(f"user {args.user_id} does not exist in users_v2 on {args.target}")
    classify(plan, db)
    if not args.apply:
        print(report(plan, mode="dry run (read-only; add --apply to write)"))
        return 0
    apply(plan, db)
    print(report(plan, mode=f"applied ({db.writes} writes)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
