/**
 * Searching archives for real photographs.
 *
 * The value of this feature is entirely in its provenance, so that is what is asserted: an archive
 * that fails must be reported as failed rather than looking like one with no results, and the
 * licence classification must be conservative, because a wrong "open" here means someone prints a
 * photograph they had no right to.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchArchives } from '../lib/image-archives.js';

const COMMONS = {
  query: {
    pages: {
      '1': {
        title: 'File:Piscataway dancer 2.jpeg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/x.jpeg',
            thumburl: 'https://upload.wikimedia.org/thumb.jpeg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Piscataway_dancer_2.jpeg',
            width: 6016,
            height: 4016,
            extmetadata: {
              LicenseShortName: { value: 'Public domain' },
              Artist: { value: '<a href="#">3d U.S. Infantry Regiment</a>' },
              DateTimeOriginal: { value: '2019-11-13 12:29' },
              Credit: { value: '191113-A-SE781-077' },
              ImageDescription: { value: 'Soldiers &amp; dancers at a heritage event' },
            },
          },
        ],
      },
    },
  },
};

function stubFetch(byUrl: Record<string, { ok?: boolean; status?: number; body?: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = Object.keys(byUrl).find((k) => String(url).includes(k));
      if (!key) throw new Error(`unexpected fetch: ${url}`);
      const r = byUrl[key];
      if (r.ok === false) return { ok: false, status: r.status ?? 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => r.body };
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('searching the archives', () => {
  it('returns provenance, not just a picture', async () => {
    stubFetch({
      'commons.wikimedia.org': { body: COMMONS },
      'loc.gov': { body: { results: [] } },
    });
    const r = await searchArchives({ query: 'Piscataway', sources: ['wikimedia', 'loc'] });
    const img = r.images[0];
    expect(img.title).toBe('Piscataway dancer 2');
    expect(img.creator).toBe('3d U.S. Infantry Regiment'); // markup stripped
    expect(img.description).toBe('Soldiers & dancers at a heritage event'); // entities decoded
    expect(img.date_taken).toBe('2019-11-13 12:29');
    expect(img.institution).toBe('191113-A-SE781-077');
    expect(img.source_page_url).toContain('commons.wikimedia.org');
    expect(img.reuse).toBe('open');
  });

  it('reports an archive that failed instead of showing it as empty', async () => {
    stubFetch({
      'commons.wikimedia.org': { body: COMMONS },
      'loc.gov': { ok: false, status: 503 },
    });
    const r = await searchArchives({ query: 'Piscataway', sources: ['wikimedia', 'loc'] });
    const loc = r.sources.find((s) => s.source === 'loc')!;
    expect(loc.searched).toBe(true);
    expect(loc.note).toMatch(/could not be reached/);
    // And one archive failing must not lose the other's results.
    expect(r.images).toHaveLength(1);
  });

  it('says why the Smithsonian was not searched rather than omitting it', async () => {
    delete process.env.SMITHSONIAN_API_KEY;
    stubFetch({ 'commons.wikimedia.org': { body: COMMONS }, 'loc.gov': { body: { results: [] } } });
    const r = await searchArchives({ query: 'Turkey Tayac' });
    const si = r.sources.find((s) => s.source === 'smithsonian')!;
    expect(si.searched).toBe(false);
    expect(si.note).toMatch(/SMITHSONIAN_API_KEY/);
    expect(si.note).toMatch(/api\.data\.gov/);
  });

  it.each([
    ['Public domain', 'open'],
    ['CC0', 'open'],
    ['CC BY 4.0', 'open'],
    ['CC BY-SA 3.0', 'open'],
    ['CC BY-NC 4.0', 'check'],
    ['CC BY-NC-SA 4.0', 'check'],
    ['No known restrictions on publication', 'check'],
    ['', 'check'],
    ['All rights reserved', 'check'],
  ])('classifies %s as %s', async (license, expected) => {
    stubFetch({
      'commons.wikimedia.org': {
        body: {
          query: {
            pages: {
              '1': {
                title: 'File:x.jpg',
                imageinfo: [
                  { url: 'https://u/x.jpg', extmetadata: { LicenseShortName: { value: license } } },
                ],
              },
            },
          },
        },
      },
      'loc.gov': { body: { results: [] } },
    });
    const r = await searchArchives({ query: 'x', sources: ['wikimedia', 'loc'] });
    expect(r.images[0].reuse).toBe(expected);
  });

  it('puts the usable photographs first', async () => {
    stubFetch({
      'commons.wikimedia.org': {
        body: {
          query: {
            pages: {
              '1': {
                title: 'File:restricted.jpg',
                imageinfo: [{ url: 'https://u/a.jpg', extmetadata: { LicenseShortName: { value: '' } } }],
              },
              '2': {
                title: 'File:open.jpg',
                imageinfo: [
                  { url: 'https://u/b.jpg', extmetadata: { LicenseShortName: { value: 'CC0' } } },
                ],
              },
            },
          },
        },
      },
      'loc.gov': { body: { results: [] } },
    });
    const r = await searchArchives({ query: 'x', sources: ['wikimedia', 'loc'] });
    expect(r.images[0].reuse).toBe('open');
  });

  it('skips a record with no file at all', async () => {
    stubFetch({
      'commons.wikimedia.org': { body: { query: { pages: { '1': { title: 'File:x.jpg' } } } } },
      'loc.gov': { body: { results: [{ id: 'y', title: 'No image here' }] } },
    });
    const r = await searchArchives({ query: 'x', sources: ['wikimedia', 'loc'] });
    expect(r.images).toHaveLength(0);
  });
});
