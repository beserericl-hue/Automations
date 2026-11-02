/**
 * Item 16 — the single-delivery probe's verdict. The probe itself runs live (e2e/regression/
 * engine-single-delivery.spec.ts); these pin what counts as a pass.
 */
import { describe, it, expect } from 'vitest';
import { planProbe, submissions, judge, isProbeTag, MAX_PROBE_JOBS, MAX_PROBE_DUPES } from '../lib/single-delivery-probe.js';

describe('planProbe', () => {
  it('submits every unique run once and every duplicate run twice', () => {
    const plan = planProbe(3, 2, 1_700_000_000_000);
    expect(isProbeTag(plan.tag)).toBe(true);
    const subs = submissions(plan);
    expect(subs).toHaveLength(3 + 2 * 2);
    expect(subs.filter((s) => s === `${plan.tag}-d1`)).toHaveLength(2);
  });

  it('caps the burst so an admin cannot flood the queue', () => {
    const plan = planProbe(10_000, 10_000);
    expect(plan.unique).toHaveLength(MAX_PROBE_JOBS);
    expect(plan.dupes).toHaveLength(MAX_PROBE_DUPES);
  });
});

describe('judge', () => {
  const tag = 'sdp-abc123';
  const row = (id: string, status = 'complete', attempts = 1) => ({ run_id: `${tag}-${id}`, status, attempts });

  it('passes when every run completed once', () => {
    const v = judge(tag, [row('u0'), row('u1'), row('d0')], 3);
    expect(v.verdict).toBe('PASS');
    expect(v.max_attempts).toBe(1);
  });

  it('fails a run that executed twice, even when it completed', () => {
    const v = judge(tag, [row('u0'), row('d0', 'complete', 2)], 2);
    expect(v.verdict).toBe('FAIL');
    expect(v.problems[0]).toContain('executed 2 times');
  });

  it('is pending until every expected run has a finished row', () => {
    expect(judge(tag, [row('u0')], 2).verdict).toBe('PENDING');
    expect(judge(tag, [row('u0'), row('u1', 'in_progress')], 2).verdict).toBe('PENDING');
  });

  it('ignores rows from other probes and rejects non-probe tags', () => {
    const v = judge(tag, [row('u0'), { run_id: 'sdp-other-u0', status: 'complete', attempts: 5 }], 1);
    expect(v.verdict).toBe('PASS');
    expect(isProbeTag('job-1')).toBe(false);
    expect(isProbeTag("sdp-x'; drop")).toBe(false);
  });
});
