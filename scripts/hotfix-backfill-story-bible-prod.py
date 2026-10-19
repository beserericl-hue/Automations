#!/usr/bin/env python3
"""
PROD-targeted story-bible backfill — self-contained, no n8n round-trip.

Mirror of scripts/hotfix-backfill-story-bible.py but talks directly to:
  - PROD Supabase (writers-workbench/.env: SUPABASE_URL/SERVICE_ROLE_KEY)
  - Anthropic API (writers-workbench/.env: ANTHROPIC_API_KEY)

Uses the *same* extraction prompt the in-workflow extract_bible_prepare
node emits, and the *same* Supabase insert shape the in-workflow
parse_and_insert node uses. The DEV script proved correctness for The
Invisible Wall (37 entries across 7 chapters); this script applies the
same logic to PROD.

Idempotent: skips entries whose (project_id, lower(name), entry_type)
already exists in story_bible_v2.

Usage:
  python3 scripts/hotfix-backfill-story-bible-prod.py \
    --project-id 366ca0a0-18e8-45a5-83da-a6b3d23d760b \
    --user-id "+14105914612" \
    [--only-chapter 3] \
    [--dry-run]            # parse + show counts, don't insert
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def _enc(value: str) -> str:
    """URL-encode a PostgREST filter value. Critical for user_id values
    that begin with '+' (E.164 phone) which PostgREST otherwise reads as
    a space."""
    return quote(str(value), safe='')


def env_from_file() -> dict[str, str]:
    """Read writers-workbench/.env so we don't depend on shell exports."""
    here = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.normpath(os.path.join(here, '..', 'writers-workbench', '.env'))
    out: dict[str, str] = {}
    if not os.path.exists(env_path):
        return out
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.strip()] = v.strip()
    return out


ENV = env_from_file()
SUPABASE_URL = ENV.get('SUPABASE_URL') or os.environ.get('SUPABASE_URL') or ''
SUPABASE_KEY = ENV.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or ''
ANTHROPIC_KEY = ENV.get('ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_API_KEY') or ''
ANTHROPIC_MODEL = 'claude-sonnet-4-5'

if not SUPABASE_URL.startswith('https://faklxfakgzkpkbxfihzh'):
    print(f'ABORT — SUPABASE_URL is not the PROD URL: {SUPABASE_URL}', file=sys.stderr)
    sys.exit(2)
if not SUPABASE_KEY:
    print('ABORT — SUPABASE_SERVICE_ROLE_KEY missing', file=sys.stderr)
    sys.exit(2)
if not ANTHROPIC_KEY:
    print('ABORT — ANTHROPIC_API_KEY missing', file=sys.stderr)
    sys.exit(2)

UA = 'curl/8.0'
SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'User-Agent': UA,
}


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def sb_get(path: str) -> Any:
    req = Request(f'{SUPABASE_URL}{path}', headers=SB_HEADERS)
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def sb_post(path: str, body: list[dict] | dict) -> Any:
    req = Request(
        f'{SUPABASE_URL}{path}',
        method='POST',
        headers={**SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=representation'},
        data=json.dumps(body).encode(),
    )
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def load_project(project_id: str, user_id: str) -> dict:
    rows = sb_get(
        f'/rest/v1/writing_projects_v2?id=eq.{_enc(project_id)}'
        f'&user_id=eq.{_enc(user_id)}&select=id,title,outline'
    )
    if not rows:
        raise SystemExit(f'project {project_id} not found for user {user_id}')
    return rows[0]


def load_existing_bible(project_id: str) -> list[dict]:
    return sb_get(
        f'/rest/v1/story_bible_v2?project_id=eq.{_enc(project_id)}&deleted_at=is.null'
        f'&select=id,entry_type,name,description,chapter_introduced'
    )


def load_chapter(project_id: str, chapter_number: int) -> dict | None:
    rows = sb_get(
        f'/rest/v1/published_content_v2?project_id=eq.{_enc(project_id)}'
        f'&content_type=eq.chapter&deleted_at=is.null'
        f'&chapter_number=eq.{chapter_number}'
        f'&select=id,chapter_number,title,content_text&limit=1'
    )
    return rows[0] if rows else None


def list_chapter_numbers(project_id: str) -> list[int]:
    rows = sb_get(
        f'/rest/v1/published_content_v2?project_id=eq.{_enc(project_id)}'
        f'&content_type=eq.chapter&deleted_at=is.null'
        f'&select=chapter_number&order=chapter_number'
    )
    return [r['chapter_number'] for r in rows]


def insert_bible_rows(rows: list[dict]) -> int:
    if not rows:
        return 0
    inserted = sb_post('/rest/v1/story_bible_v2', rows)
    return len(inserted) if isinstance(inserted, list) else 0


# ---------------------------------------------------------------------------
# Prompt builder — verbatim transcription of the n8n extract_bible_prepare
# node from scripts/hotfix-backfill-story-bible.py PREPARE_CODE.
# ---------------------------------------------------------------------------

def build_prompt(project: dict, existing: list[dict], chapter: dict) -> str:
    outline = project.get('outline') or {}
    outline_chars = outline.get('characters') or []

    known_by_type: dict[str, list[str]] = {}
    for e in existing:
        t = (e.get('entry_type') or 'other').lower()
        known_by_type.setdefault(t, []).append(e.get('name') or '')

    known_chars = set(known_by_type.get('character', []))
    for c in outline_chars:
        nm = c.get('name_format') or c.get('name')
        if nm:
            known_chars.add(nm)

    def summarise(arr: list[str]) -> str:
        arr = [a for a in (arr or []) if a]
        return ', '.join(arr[:50]) if arr else '(none)'

    known_lines = '\n'.join([
        f"Characters already in canon: {summarise(list(known_chars))}",
        f"Locations already in canon: {summarise(known_by_type.get('location', []))}",
        f"Items already in canon: {summarise(known_by_type.get('item', []))}",
        f"Events already in canon: {summarise(known_by_type.get('event', []))}",
    ])

    prompt = (
        'You extract NEW story-bible entries from a chapter. Return STRICT JSON.\n\n'
        '## ALREADY KNOWN — do NOT re-emit:\n' + known_lines + '\n\n'
        '## CATEGORIES — only emit when the entity is plot-load-bearing:\n'
        '- character: a NAMED person (not "the agent", "a guard"). Has a real name in the prose.\n'
        '- location: a SPECIFIC place with a name (not "the office"). E.g. "Roosevelt Elementary".\n'
        '- item: a SIGNIFICANT object that recurs or carries plot weight.\n'
        '- event: a ONE-TIME story event that establishes canon and may be referenced later.\n\n'
        '## RULES\n'
        '- If the entity is in the "ALREADY KNOWN" lists above, DO NOT emit it again.\n'
        '- Be conservative. Better to miss a borderline entry than spam the bible.\n'
        '- Description: 1 to 2 sentences. Plain prose.\n'
        '- Names must be the canonical form as used in this chapter.\n\n'
        '## OUTPUT — STRICT JSON, no markdown fences\n'
        '{ "new_story_bible_entries": [ {"entry_type": "character|location|item|event", "name": "...", "description": "..."} ] }\n\n'
        'If there are no new entries: {"new_story_bible_entries": []}\n\n'
        f"## CHAPTER (Chapter {chapter['chapter_number']}"
        f"{(' — ' + chapter['title']) if chapter.get('title') else ''})\n\n"
        + (chapter.get('content_text') or '')
    )
    return prompt


# ---------------------------------------------------------------------------
# Anthropic API call (Messages API)
# ---------------------------------------------------------------------------

def call_claude(prompt: str) -> str:
    body = {
        'model': ANTHROPIC_MODEL,
        'max_tokens': 4096,
        'temperature': 0.2,
        'messages': [{'role': 'user', 'content': prompt}],
    }
    req = Request(
        'https://api.anthropic.com/v1/messages',
        method='POST',
        headers={
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'User-Agent': UA,
        },
        data=json.dumps(body).encode(),
    )
    with urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    parts = resp.get('content') or []
    text_parts = [p.get('text', '') for p in parts if p.get('type') == 'text']
    return ''.join(text_parts)


# ---------------------------------------------------------------------------
# Response parser — same forgiving shape as PARSE_AND_INSERT_CODE
# ---------------------------------------------------------------------------

import re

def parse_entries(raw: str) -> list[dict]:
    inner = (raw or '').strip()
    fence = re.match(r'^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$', inner)
    if fence:
        inner = fence.group(1).strip()
    parsed: dict | None = None
    try:
        parsed = json.loads(inner)
    except json.JSONDecodeError:
        m = re.search(r'\{[\s\S]*\}', inner)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except json.JSONDecodeError:
                parsed = None
    if not parsed:
        return []
    arr = parsed.get('new_story_bible_entries') or []
    return [
        e for e in arr
        if isinstance(e, dict) and e.get('entry_type') and e.get('name') and e.get('description')
    ]


def chapter_number_for_insert(raw_ch: Any) -> int:
    s = str(raw_ch or '').strip()
    if re.match(r'^(prologue|prol|0)$', s, re.I):
        return 0
    if re.match(r'^(epilogue|epil)$', s, re.I):
        return 999
    try:
        return int(s)
    except ValueError:
        return 0


def already_in_bible(existing: list[dict], entry_type: str, name: str) -> bool:
    """Cheap dedupe by (entry_type, lower(name)). Mirrors the script's
    'don't re-emit if already known' but as a final guard."""
    n = (name or '').lower().strip()
    for e in existing:
        if (e.get('entry_type') or '').lower() == entry_type.lower() and (e.get('name') or '').lower().strip() == n:
            return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-id', required=True)
    ap.add_argument('--user-id', required=True)
    ap.add_argument('--only-chapter', type=int, help='backfill a single chapter number')
    ap.add_argument('--dry-run', action='store_true', help='parse + count; do not insert')
    args = ap.parse_args()

    print(f'PROD backfill: project={args.project_id} user={args.user_id} dry_run={args.dry_run}')
    project = load_project(args.project_id, args.user_id)
    print(f'  project: "{project["title"]}"')

    existing = load_existing_bible(args.project_id)
    print(f'  existing bible entries: {len(existing)}')

    chapters_to_run = (
        [args.only_chapter]
        if args.only_chapter is not None
        else list_chapter_numbers(args.project_id)
    )
    print(f'  chapters to process: {chapters_to_run}')

    total_inserted = 0
    total_candidates = 0
    total_dedup_skipped = 0
    for cn in chapters_to_run:
        ch = load_chapter(args.project_id, cn)
        if not ch:
            print(f'  ch{cn}: NOT FOUND')
            continue
        prompt = build_prompt(project, existing, ch)
        try:
            raw = call_claude(prompt)
        except HTTPError as e:
            err_body = e.read().decode('utf-8', 'replace')[:300]
            print(f'  ch{cn}: ANTHROPIC HTTP {e.code} — {err_body}')
            continue
        candidates = parse_entries(raw)
        # In-script dedupe (paranoid second pass)
        new_rows = []
        for e in candidates:
            if already_in_bible(existing, e['entry_type'], e['name']):
                total_dedup_skipped += 1
                continue
            new_rows.append({
                'entry_type': e['entry_type'],
                'name': e['name'],
                'description': e['description'],
                'project_id': args.project_id,
                'user_id': args.user_id,
                'chapter_introduced': chapter_number_for_insert(cn),
                'last_chapter_seen': chapter_number_for_insert(cn),
            })
        total_candidates += len(candidates)

        if args.dry_run:
            print(f'  ch{cn}: candidates={len(candidates)} new={len(new_rows)} (dry-run, no insert)')
            for r in new_rows:
                print(f'      [{r["entry_type"]}] {r["name"]}')
            continue

        if not new_rows:
            print(f'  ch{cn}: candidates={len(candidates)} new=0 (all dedupe)')
            continue
        try:
            n = insert_bible_rows(new_rows)
            total_inserted += n
            existing.extend([
                {'entry_type': r['entry_type'], 'name': r['name'], 'description': r['description'],
                 'chapter_introduced': r['chapter_introduced']}
                for r in new_rows
            ])
            print(f'  ch{cn}: candidates={len(candidates)} inserted={n}')
        except HTTPError as e:
            err = e.read().decode('utf-8', 'replace')[:200]
            print(f'  ch{cn}: INSERT HTTP {e.code} — {err}')

    print()
    print(f'TOTAL candidates: {total_candidates}')
    print(f'TOTAL inserted  : {total_inserted}')
    print(f'TOTAL dedup-skip: {total_dedup_skipped}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
