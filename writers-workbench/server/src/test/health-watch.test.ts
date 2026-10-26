/**
 * The health watch: an alert when a dependency has been down for two checks running, a reminder
 * every six hours while it stays down, and one when it recovers. Nothing while healthy, and nothing
 * for a single failed check, which is what a deploy's restart looks like.
 */
import { describe, it, expect } from 'vitest';
import { transitions } from '../lib/health-watch.js';

const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 0, min));
const ok = { ok: true, detail: 'ok' };
const bad = { ok: false, detail: 'no PONG' };

function run(seq: Array<Record<string, { ok: boolean; detail: string }>>, step = 5) {
  let state = {};
  const out: { down: string[]; recovered: string[] }[] = [];
  seq.forEach((checks, i) => {
    const t = transitions(state, checks, at(i * step));
    state = t.next;
    out.push({ down: t.down, recovered: t.recovered });
  });
  return out;
}

describe('health watch', () => {
  it('stays quiet while healthy', () => {
    expect(run([{ redis: ok }, { redis: ok }]).flatMap((o) => [...o.down, ...o.recovered])).toEqual([]);
  });

  it('says nothing about one failed check (a deploy restarting the engine)', () => {
    expect(run([{ engine: ok }, { engine: bad }, { engine: ok }]).flatMap((o) => [...o.down, ...o.recovered])).toEqual([]);
  });

  it('alerts after two failed checks, once, and reports the recovery', () => {
    const out = run([{ redis: ok }, { redis: bad }, { redis: bad }, { redis: bad }, { redis: ok }]);
    expect(out.map((o) => o.down)).toEqual([[], [], ['redis'], [], []]);
    expect(out[4].recovered).toEqual(['redis']);
  });

  it('reminds every six hours while it stays down', () => {
    // 5-minute checks for 7 hours of outage: alerts at the second check and six hours after it.
    const seq = [{ redis: ok }, ...Array.from({ length: 84 }, () => ({ redis: bad }))];
    const alerts = run(seq).filter((o) => o.down.length).length;
    expect(alerts).toBe(2);
  });
});
