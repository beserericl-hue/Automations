/**
 * The print cover wrap.
 *
 * A paperback cover is ONE image — back, spine and front side by side with bleed on all four
 * outside edges — and two numbers decide whether it prints correctly. The spine width comes from
 * the interior's real page count, because being 2mm out puts the title off-centre on a physical
 * object; and KDP stamps a barcode into a 2" x 1.2" area at the back cover's bottom right, so that
 * rectangle has to be left clear deliberately rather than by luck.
 */

import { describe, it, expect } from 'vitest';
import {
  BARCODE_H_IN,
  BARCODE_W_IN,
  BLEED_IN,
  MIN_SPINE_TEXT_PAGES,
  PAPER_THICKNESS,
  composeCoverWrap,
  spineWidthInches,
} from '../lib/cover.js';

type SharpFn = (input?: Buffer | Record<string, unknown>) => {
  png(): { toBuffer(): Promise<Buffer> };
  metadata(): Promise<{ width?: number; height?: number }>;
};
async function loadSharp(): Promise<SharpFn> {
  const mod = (await import('sharp')) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}
async function squareArt(): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#7a4a24' } })
    .png()
    .toBuffer();
}

const BLURB =
  'Four ossuaries. Twelve thousand years. One question nobody wants answered.\n\n' +
  'When a preservation officer petitions for the return of his ancestors, the record that should ' +
  'prove his claim turns out to have been written by the people who took them.';

describe('spine width', () => {
  it('is page count times paper thickness, not an estimate', () => {
    expect(spineWidthInches(610, 'white')).toBeCloseTo(610 * PAPER_THICKNESS.white, 6);
    expect(spineWidthInches(610, 'cream')).toBeGreaterThan(spineWidthInches(610, 'white'));
  });

  it('states the spine-text rule in pages, which is how KDP states it', () => {
    // An earlier version expressed this as an inch threshold and had it wrong by half, which would
    // have put type on a spine too thin to carry it.
    expect(MIN_SPINE_TEXT_PAGES).toBe(100);
  });
});

describe('wrap geometry', () => {
  it('is two trims plus the spine plus bleed on both sides', async () => {
    const r = await composeCoverWrap({
      art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser',
      pageCount: 610, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    expect(r).not.toBeNull();
    const expectedW = 6 * 2 + spineWidthInches(610) + BLEED_IN * 2;
    expect(r!.widthIn).toBeCloseTo(expectedW, 3);
    expect(r!.heightIn).toBeCloseTo(9 + BLEED_IN * 2, 3);
    expect(r!.spineIn).toBeCloseTo(spineWidthInches(610), 4);
  }, 60_000);

  it('omits spine type on a book too thin for it', async () => {
    const r = await composeCoverWrap({
      art: await squareArt(), title: 'T', author: 'A',
      pageCount: 80, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    expect(r!.spineCarriesText).toBe(false);
  }, 60_000);

  it('carries spine type on a thick one', async () => {
    const r = await composeCoverWrap({
      art: await squareArt(), title: 'T', author: 'A',
      pageCount: 610, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    expect(r!.spineCarriesText).toBe(true);
  }, 60_000);

  it('renders at the pixel size those inches imply at 300dpi', async () => {
    const r = await composeCoverWrap({
      art: await squareArt(), title: 'T', author: 'A',
      pageCount: 610, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    const sharp = await loadSharp();
    const m = await sharp(r!.png).metadata();
    expect(m.width).toBe(Math.round(r!.widthIn * 300));
    expect(m.height).toBe(Math.round(r!.heightIn * 300));
  }, 60_000);

  it('grows with the page count — a thicker book is a wider wrap', async () => {
    const art = await squareArt();
    const thin = await composeCoverWrap({
      art, title: 'T', author: 'A', pageCount: 300, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    const thick = await composeCoverWrap({
      art, title: 'T', author: 'A', pageCount: 700, trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB,
    });
    expect(thick!.widthIn).toBeGreaterThan(thin!.widthIn);
  }, 90_000);

  it('reserves room for the barcode KDP will stamp on', () => {
    // Not asserted on pixels — asserted as the contract the layout is built against.
    expect(BARCODE_W_IN).toBe(2.0);
    expect(BARCODE_H_IN).toBe(1.2);
  });
});

describe('it refuses rather than printing something broken', () => {
  it('returns null without art', async () => {
    expect(
      await composeCoverWrap({
        art: Buffer.alloc(0), title: 'T', author: 'A', pageCount: 610,
        trimWidthIn: 6, trimHeightIn: 9,
      }),
    ).toBeNull();
  });

  it('returns null for a nonsense page count', async () => {
    expect(
      await composeCoverWrap({
        art: await squareArt(), title: 'T', author: 'A', pageCount: 0,
        trimWidthIn: 6, trimHeightIn: 9,
      }),
    ).toBeNull();
  }, 30_000);

  it('renders a long blurb completely or not at all', async () => {
    // The failure this guards: opentype.js dropped 2 of 3 blurb lines and the wrap printed with a
    // near-empty back cover, which reads as a printing fault rather than a choice.
    const r = await composeCoverWrap({
      art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser', pageCount: 610,
      trimWidthIn: 6, trimHeightIn: 9, blurb: BLURB, authorBio: 'He writes from Maryland.',
    });
    expect(r, 'back-cover copy lost glyphs — see lineToPaths in cover.ts').not.toBeNull();
  }, 60_000);
});
