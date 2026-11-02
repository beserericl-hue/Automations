/**
 * Item 7 — the server's outline schema agrees with the engine's, case for case. The cases are shared
 * with engine/tests/test_outline_schema.py (writers-workbench/shared/outline-schema-cases.json).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeOutline, OutlineValidationError } from '../lib/outline-schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesFile = path.resolve(here, '../../../shared/outline-schema-cases.json');
const { cases } = JSON.parse(readFileSync(casesFile, 'utf8')) as {
  cases: Array<{ name: string; in: unknown; out?: unknown; reject?: string[] }>;
};

describe('a rejected outline over HTTP', () => {
  it('the error handler answers 422 with every problem, not a 500', async () => {
    const { errorHandler } = await import('../middleware/error-handler.js');
    let status = 0;
    let body: any = null;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { body = b; return res; } };
    let err: Error | null = null;
    try {
      normalizeOutline({ chapters: [{ title: 'no number' }], logline: 'x' });
    } catch (e) {
      err = e as Error;
    }
    errorHandler(err!, { headers: {}, originalUrl: '/x' } as any, res, () => {});
    expect(status).toBe(422);
    expect(body.error.code).toBe('INVALID_OUTLINE');
    expect(body.error.problems).toHaveLength(2);
  });
});

describe('outline schema (shared cases)', () => {
  it('has cases to run', () => expect(cases.length).toBeGreaterThan(15));

  for (const c of cases) {
    it(c.name, () => {
      const before = JSON.stringify(c.in);
      if (c.reject) {
        let err: unknown;
        try {
          normalizeOutline(c.in);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(OutlineValidationError);
        for (const needle of c.reject) expect((err as Error).message).toContain(needle);
      } else {
        const out = normalizeOutline(c.in);
        expect(out).toEqual(c.out);
        expect(normalizeOutline(out)).toEqual(out); // idempotent
      }
      expect(JSON.stringify(c.in)).toBe(before); // never mutates its input
    });
  }
});
