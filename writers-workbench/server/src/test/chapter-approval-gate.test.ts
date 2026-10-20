/**
 * The approval gate, and the craft annotations it reads alongside.
 *
 * Approval is not a label — `routes/export.ts` filters the manuscript export on
 * `status in ('approved','published')`, so what this gate lets through is literally what ends up in
 * the book. Two failure directions matter and they pull against each other:
 *
 *   Too strict and nothing ships. Measured over a real 96-chapter book, the two craft dimensions
 *   fail in 51 and 39 chapters. Gating on those blocks two thirds of the book on a limitation of
 *   the generator that no automated pass fixes — so they are advisories, not blockers.
 *
 *   Too loose and you approve prose nobody read. That already happened: a repair pass rewrote four
 *   chapters and left their Q/A reports twelve minutes stale, still showing "5/8 passed" against
 *   text that no longer existed. So a report that does not demonstrably describe the current prose
 *   blocks approval.
 */

import { describe, it, expect } from 'vitest';
import {
  assessChapter,
  proseFingerprint,
  buildCraftAnnotations,
} from '../routes/content-actions.js';

const PROSE = 'The heater ticked as it cooled. She did not get out of the truck.';

function check(name: string, status: 'PASS' | 'NEEDS_REVIEW') {
  return { name, status };
}

const ALL_PASS = [
  check('Character craft', 'PASS'),
  check('Character consistency', 'PASS'),
  check('Follows the outline', 'PASS'),
  check('Period language', 'PASS'),
  check('Dialogue', 'PASS'),
  check('Prose clarity', 'PASS'),
  check('Story turns / pacing', 'PASS'),
  check('No flat paragraphs', 'PASS'),
];

function chapter(over: Record<string, unknown> = {}) {
  const checks = (over.checks as ReturnType<typeof check>[]) ?? ALL_PASS;
  const text = (over.content_text as string) ?? PROSE;
  return {
    id: 'c1',
    chapter_number: 7,
    title: 'The Hydrology Report',
    status: 'draft',
    content_text: text,
    metadata: {
      qa_report: {
        checks,
        scored_sha256: (over.scored_sha256 as string) ?? proseFingerprint(text),
        ...(over.reportExtra as object),
      },
      ...(over.metaExtra as object),
    },
    ...(over.row as object),
  };
}

describe('approval gate — what blocks', () => {
  it('passes a clean chapter whose report matches its prose', () => {
    const v = assessChapter(chapter());
    expect(v.eligible).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it('blocks a continuity failure, because that is a real defect', () => {
    const v = assessChapter(chapter({ checks: [...ALL_PASS.slice(1), check('Character consistency', 'NEEDS_REVIEW')] }));
    expect(v.eligible).toBe(false);
    expect(v.blockers.join(' ')).toContain('Character consistency');
  });

  it.each(['Character craft', 'Follows the outline', 'Period language', 'Dialogue', 'Prose clarity'])(
    'blocks on %s',
    (name) => {
      const checks = ALL_PASS.map((c) => (c.name === name ? check(name, 'NEEDS_REVIEW') : c));
      expect(assessChapter(chapter({ checks })).eligible).toBe(false);
    },
  );

  it('does NOT block on pacing — it fails in 51 of 96 chapters and no pass fixes it', () => {
    const checks = ALL_PASS.map((c) =>
      c.name === 'Story turns / pacing' ? check(c.name, 'NEEDS_REVIEW') : c,
    );
    const v = assessChapter(chapter({ checks }));
    expect(v.eligible).toBe(true);
    expect(v.advisories.join(' ')).toContain('Story turns / pacing');
  });

  it('does NOT block on flat paragraphs either', () => {
    const checks = ALL_PASS.map((c) => (c.name === 'No flat paragraphs' ? check(c.name, 'NEEDS_REVIEW') : c));
    const v = assessChapter(chapter({ checks }));
    expect(v.eligible).toBe(true);
    expect(v.advisories).toHaveLength(1);
  });

  it('reports both at once without confusing them', () => {
    const checks = ALL_PASS.map((c) =>
      c.name === 'Dialogue' || c.name === 'No flat paragraphs' ? check(c.name, 'NEEDS_REVIEW') : c,
    );
    const v = assessChapter(chapter({ checks }));
    expect(v.blockers).toHaveLength(1);
    expect(v.advisories).toHaveLength(1);
  });
});

describe('approval gate — the staleness rule', () => {
  it('blocks when the report describes an earlier draft', () => {
    const v = assessChapter(chapter({ scored_sha256: proseFingerprint('completely different prose') }));
    expect(v.eligible).toBe(false);
    expect(v.blockers.join(' ')).toContain('earlier draft');
  });

  it('blocks an unstamped report rather than trusting it', () => {
    const row = chapter();
    delete (row.metadata.qa_report as Record<string, unknown>).scored_sha256;
    const v = assessChapter(row);
    expect(v.eligible).toBe(false);
    expect(v.blockers.join(' ')).toContain('cannot be confirmed');
  });

  it('blocks when there is no report at all', () => {
    const v = assessChapter({ ...chapter(), metadata: {} });
    expect(v.eligible).toBe(false);
    expect(v.blockers.join(' ')).toContain('No Q/A report');
  });

  it('blocks an empty chapter', () => {
    const v = assessChapter(chapter({ content_text: '   ' }));
    expect(v.eligible).toBe(false);
    expect(v.blockers.join(' ')).toContain('no text');
  });

  it('a whitespace-only edit still counts as a different draft', () => {
    // The fingerprint is over raw bytes on purpose: if the stored text differs at all, the report
    // was computed from something else.
    expect(proseFingerprint(PROSE)).not.toBe(proseFingerprint(PROSE + ' '));
  });
});

describe('craft annotations', () => {
  const dismissedNone = new Set<string>();

  function meta(findings: Record<string, unknown>[]) {
    return { craft_findings: { findings } };
  }

  it('offers a one-click replace when the quote is in the chapter', () => {
    const a = buildCraftAnnotations(
      meta([
        {
          dimension: 'story_turn_density',
          problem: 'nothing changes',
          quote: 'The heater ticked as it cooled.',
          replacement: 'The heater ticked, and she finally opened the door.',
        },
      ]),
      7,
      PROSE,
      dismissedNone,
    );
    expect(a[0].suggestion).toEqual({
      action: 'replace',
      target_text: 'The heater ticked as it cooled.',
      replacement_text: 'The heater ticked, and she finally opened the door.',
      delta_chars: 'The heater ticked, and she finally opened the door.'.length - 'The heater ticked as it cooled.'.length,
    });
  });

  it('degrades to a note when the quote is no longer in the chapter', () => {
    // The author edited there since the report ran. Showing an Apply would 422 on click.
    const a = buildCraftAnnotations(
      meta([{ dimension: 'prose_transparent', problem: 'dense', quote: 'a line since deleted', replacement: 'x' }]),
      7,
      PROSE,
      dismissedNone,
    );
    expect(a[0].suggestion).toEqual({ action: 'note' });
    expect(a[0].evidence_quote).toBeNull();
  });

  it('keeps a chapter-wide finding as a note instead of dropping it', () => {
    const a = buildCraftAnnotations(meta([{ dimension: 'story_turn_density', problem: 'the ending is flat' }]), 7, PROSE, dismissedNone);
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain('the ending is flat');
  });

  it('ranks continuity above pacing so the rare real defect is not buried', () => {
    const a = buildCraftAnnotations(
      meta([
        { dimension: 'story_turn_density', problem: 'p' },
        { dimension: 'character_consistency', problem: 'q' },
      ]),
      7,
      PROSE,
      dismissedNone,
    );
    expect(a.find((x) => x.raw && (x.raw as Record<string, unknown>).dimension === 'story_turn_density')?.severity).toBe('low');
    expect(a.find((x) => x.raw && (x.raw as Record<string, unknown>).dimension === 'character_consistency')?.severity).toBe('high');
  });

  it('honours a dismissal', () => {
    const first = buildCraftAnnotations(meta([{ dimension: 'story_turn_density', problem: 'p' }]), 7, PROSE, dismissedNone);
    const again = buildCraftAnnotations(
      meta([{ dimension: 'story_turn_density', problem: 'p' }]),
      7,
      PROSE,
      new Set([first[0].id]),
    );
    expect(again[0].dismissed).toBe(true);
  });

  it('gives the same finding a stable id across refetches, so a dismissal sticks', () => {
    const build = () =>
      buildCraftAnnotations(
        meta([{ dimension: 'story_turn_density', problem: 'p', quote: 'The heater ticked as it cooled.' }]),
        7,
        PROSE,
        dismissedNone,
      )[0].id;
    expect(build()).toBe(build());
  });

  it('is empty when there are no craft findings', () => {
    expect(buildCraftAnnotations({}, 7, PROSE, dismissedNone)).toEqual([]);
  });
});

describe('a suggestion says what accepting it costs', () => {
  // Measured on a real chapter the moment the new prompt went in: a 749-character research-dump
  // paragraph came back with a 73-character replacement. That is a legitimate editorial call — the
  // problem WAS the dump — but accepting it silently removes two thirds of a passage, and silent
  // removal is exactly how every automated repair attempt damaged the book.
  const dismissedNone = new Set<string>();
  const PROSE2 = 'The tribal meeting hall sat at the end of a gravel road off Route 5.';

  function build(replacement: string) {
    return buildCraftAnnotations(
      {
        craft_findings: {
          findings: [{ dimension: 'no_boring_paragraphs', problem: 'dump', quote: PROSE2, replacement }],
        },
      },
      7,
      PROSE2,
      dismissedNone,
    )[0];
  }

  it('reports a cut as a negative delta', () => {
    const a = build('The hall sat off Route 5.');
    expect(a.suggestion?.delta_chars).toBe(25 - PROSE2.length);
    expect(a.suggestion?.delta_chars).toBeLessThan(0);
  });

  it('reports an expansion as a positive delta', () => {
    const longer = PROSE2 + ' He had been coming here since he was nine years old.';
    expect(build(longer).suggestion?.delta_chars).toBeGreaterThan(0);
  });

  it('is zero for a same-length rewrite', () => {
    expect(build('x'.repeat(PROSE2.length)).suggestion?.delta_chars).toBe(0);
  });

  it('is absent on a note, which replaces nothing', () => {
    const a = buildCraftAnnotations(
      { craft_findings: { findings: [{ dimension: 'story_turn_density', problem: 'flat ending' }] } },
      7,
      PROSE2,
      dismissedNone,
    )[0];
    expect(a.suggestion).toEqual({ action: 'note' });
  });
});
