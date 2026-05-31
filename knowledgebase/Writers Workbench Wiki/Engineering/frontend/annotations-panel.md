---
name: Annotations panel
description: Sprint 12 S12-13 shared annotations UI for drift + genre-evaluation flags on chapters.
type: concept
tags: [frontend, annotations, sprint-12]
last_reviewed: 2026-05-09
---

# Annotations panel

`client/src/components/content/AnnotationsPanel.tsx`. Renders on `ContentDetail` for `content_type='chapter'` only.

Surfaces annotations from two sources:
- **Character drift scan** (`writing_projects_v2.outline._character_drift_scan`).
- **Genre evaluation** (`published_content_v2.metadata.genre_eval`).

## Server endpoints

[`server/src/routes/content-actions.ts`](../../../../writers-workbench/server/src/routes/content-actions.ts).

### `GET /api/content/:id/annotations`

Returns `{annotations: UnifiedAnnotation[]}`:

```ts
type UnifiedAnnotation = {
  id: string;                           // deterministic — collapses on re-scan
  source: 'drift_scan' | 'genre_eval';
  kind: 'reverse_order_drift' | 'forward_drift' | 'unknown_person' | 'prose_adaptation' | 'outline_adaptation' | 'observation';
  severity: 'high' | 'medium' | 'low';
  chapter_number: number;
  evidence_quote: string;               // verbatim from chapter
  evidence_context: string;             // computed server-side from quote position (Sprint 12 S12-11 anti-fabrication)
  suggested_replacement?: string;       // auto-derived for reverse-order drift; LLM-derived for genre eval
  raw: object;                          // full source row
};
```

ID format: `<source>:<chapter_number>:<kind>:<evidence_normalised>`. Same flag on a re-scan collapses onto the same row → previously-dismissed annotations don't re-surface.

Honors `metadata.dismissed_annotations[]` filter.

### `POST /api/content/:id/annotations/apply`

```json
{ "annotation_id": "drift_scan:5:reverse_order_drift:Rodriguez,_Elena", "replacement": "Morales, Elena" }
```

Server flow:
1. Validate annotation exists.
2. Snapshot prior text into `content_versions_v2`:
   ```sql
   INSERT INTO content_versions_v2 (content_id, user_id, version_number, content_text, changed_by, change_note)
   VALUES (?, ?, NEXT, ?, 'annotation_apply', 'annotation_apply:drift_scan:5')
   ```
3. `text.split(target).join(replacement)` — replaces ALL occurrences of the target in `content_text`.
4. `UPDATE published_content_v2 SET content_text = …`.
5. Mark annotation dismissed: append id to `metadata.dismissed_annotations[]`.
6. Return `{success, version_number, occurrences_replaced}`.

422 stale-anchor: target text not found in `content_text`. Surfaces "Re-scan needed" CTA in the UI.

### `POST /api/content/:id/annotations/dismiss`

```json
{ "annotation_id": "..." }
```

Appends to `metadata.dismissed_annotations[]`. No content mutation.

## Drift scanner (Sprint 12 S12-12) — algorithm v4

Lives in DEV workflow `fJWDHXhle345f6jY` (`Tool - Scan Character Drift`). Major pivot from LLM-based to deterministic regex driven by user feedback ("create an algorithm that will work for all chapter sizes").

Cuts wall time from 5+ min to <1 sec; eliminates parse failures, token-limit issues, fabrication risk.

**Phase 0 — reverse-order drift.** Detects `<Surname>, <canonical first>` form (e.g. "Rodriguez, Elena" when canonical is "Elena Morales"). Required structural anchor: must follow `Case #N:`, `Subject Name:`, `Detainee:`, etc. Rules out sentence-boundary commas and paragraph breaks.

**Phase 1 — canonical matches.** Longest-first pattern ordering. Consumed-range masking so once a string is matched as "Captain Vael Reyes", "Reyes" alone in `allowed_set` doesn't re-flag.

**Phase 2 — forward drift candidates.** `<canonical first> <unknown surname>` (e.g. "Elena Smith" when canonical is "Elena Morales").

**Phase 3 — unknown-person mentions.** With shape-based noise filter:
- HONORIFICS expanded: senator, lord, pastor, captain, elder, etc.
- HEADER_TOKENS catch bureaucratic / place / institution shapes (clause, statute, county, conclave, guild).
- Per-project `outline._scanner_exclusions: string[]` for the long tail (e.g. "Yick Wo", "Justice Brennan").

NON_PERSON_PATTERNS is intentionally short and universal (calendar, US states, generic constitutional terms, agency acronyms `^[A-Z]{2,5}\d{0,3}$`). Story-specific names DO NOT belong here.

Result on *The Invisible Wall* (PROD):
- 1 real drift surfaced (Ch5 "Rodriguez, Elena" → "Morales, Elena").
- 144 → 32 unknowns (78% noise drop).
- 0 false positives.
- Multi-genre smoke (sci-fi/romance/fantasy/political) clean.

## Genre evaluator (Sprint 12 S12-11)

DEV workflow `e9LEpCM5L7zVpQxl` (`Tool - Evaluate Genre Compliance`). Computed-before validator:

Server computes `evidence.context` from the verified `evidence.quote` position rather than trusting Claude's context field. This defends against fabrication — Claude can't claim "this is at the start of chapter 3" if the quote actually appears at the end of chapter 5.

Three-stream output:
- `prose_adaptations` — specific phrasing changes ("rewrite this sentence to add…").
- `outline_adaptations` — structural changes ("add a chapter on X").
- `observations` — non-actionable notes.

Persists to `published_content_v2.metadata.genre_eval`.

## UI rendering

```tsx
{annotations.map(a => (
  <div key={a.id} className={severityColor(a.severity)}>
    <SeverityBadge severity={a.severity} />
    <KindBadge kind={a.kind} source={a.source} />
    <blockquote>{a.evidence_quote}</blockquote>
    {a.suggested_replacement && (
      <div className="bg-green-50 p-2">{a.suggested_replacement}</div>
    )}
    <div>
      <button onClick={() => apply(a.id, a.suggested_replacement)}>Apply</button>
      <button onClick={() => dismiss(a.id)}>Dismiss</button>
    </div>
  </div>
))}
```

Two source sections (drift first, then genre eval).

## Hand-fix verification (real Ch5 fix)

The 2026-04-26 session ran the apply endpoint code path against DEV Supabase:
- Replaced the 1 occurrence of "Rodriguez, Elena" with "Morales, Elena" in chapter `d2063a9f-...` (The Efficiency Report).
- Snapshotted prior text into `content_versions_v2` (version_number=2, changed_by='annotation_apply').
- Marked annotation `drift_scan:5:reverse_order_drift:Rodriguez, Elena` as dismissed.
- Re-scan confirmed 0 drift flags.

Same code path the deployed apply endpoint uses — proves the surface end-to-end.

## Cross-system payoff

The drift scanner and the story-bible extractor (hotfix 2026-04-29) feed each other:
- Story-bible extractor now populates `story_bible_v2` with characters as chapters are written.
- Drift scanner uses `story_bible_v2` to know which characters are canonical.
- Together, they catch and surface drifts that previously slipped through silently.

Architecturally: this was the design intent all along; the bug was that `concatenate_chapter` hardcoded `new_story_bible_entries: []`. With that fixed, the two systems work together.

## Common gotchas

- **`content_versions_v2.changed_by`** (NOT `version_type`). `change_note` (NOT `change_summary`). Sprint 12 schema gotcha.
- **`text.split(target).join(replacement)`** replaces ALL occurrences. For a case-file table that drifts twice in the same chapter, both get fixed in one click — usually desired.
- **Stale anchor** (target text gone) → 422. Don't 500.
- **`metadata.dismissed_annotations[]`** is the dismissal store. Don't store dismissal in a separate table — keeping it on the content row means cascade-on-content-delete works trivially.
- **Re-scan after apply** doesn't re-flag the same id (because the text is now fixed). But you can dismiss BEFORE applying to suppress the row without changing content.
- **Inline gutter markers** were specced but descoped. Side panel only for now.
- **Edit `_scanner_exclusions`** has no UI yet — direct DB edit.
