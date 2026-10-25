/**
 * The KDP upload package: every file Amazon asks for, built from what the project already holds.
 *
 * WHY ONE FUNCTION. There is no KDP API — the upload is a human filling in a web form and attaching
 * files. So the deliverable is not an API call, it is a folder a person can work through without
 * going back to the manuscript for anything: the interior, the cover wrap, the ebook and its cover,
 * the listing text to paste into the form, and a report saying whether any of it will be refused.
 * Assembled in one pass because the pieces depend on each other — the spine width is a function of
 * the interior's real page count, and the gutter margin is a function of it too, so building them
 * separately means building them wrong.
 *
 * THE TWO-PASS INTERIOR. KDP's minimum inside margin grows with page count, and the page count
 * depends on the margin. The first pass uses an estimate to get a real count; the second rebuilds
 * at the gutter that count requires. One pass would ship a book whose inside margin is legal for
 * the length it was guessed to be.
 */

import JSZip from 'jszip';
import { bookMatter, volumeTitle, type VolumeInfo } from './bookmatter.js';
import { buildPrintPdf, gutterInches, TRIM_SIZES, type PrintChapter } from './print-pdf.js';
import {
  composeCover,
  composeCoverWrap,
  EBOOK_COVER_H,
  EBOOK_COVER_W,
  type PaperStock,
} from './cover.js';
import {
  formatFindings,
  validateCoverWrap,
  validateEbookCover,
  validateEpub,
  validatePrintPdf,
  type ValidationResult,
} from './kdp-validate.js';
import { buildEpub, type EpubChapter } from './epub.js';
import { logger } from './logger.js';

/** The listing copy, as the engine and the publishing route store it. */
export interface Marketing {
  blurb?: string;
  back_cover?: string;
  hook?: string;
  keywords?: string[];
  categories?: string[];
  comparable_titles?: string[];
  author_bio?: string;
}

export interface PackageChapter {
  chapter_number: number | null;
  title: string | null;
  content_text: string | null;
  status?: string | null;
}

export interface PackageSettings {
  trim: string;
  paper: PaperStock;
  publisher: string;
  isbns: Record<string, string>;
  dedication: string;
  epigraph: string;
  epigraph_attribution: string;
  authors_note: string;
  acknowledgements: string;
  body_size: number;
}

export interface PlannedVolume {
  index: number;
  first_chapter: number;
  last_chapter: number;
  ending_score?: number;
  ending_reason?: string;
}

export interface BuildPackageOptions {
  title: string;
  author: string;
  authorBio: string;
  chapters: PackageChapter[];
  settings: PackageSettings;
  /** From the volume planner. Empty or absent means the whole book is one volume. */
  volumes?: PlannedVolume[];
  /** Build only this volume. Absent builds every one. */
  onlyVolume?: number | null;
  /** The project's selected cover art. Without it there is no cover of either kind. */
  art?: Buffer | null;
  /** Listing copy per volume index (as a string key), as stored on the outline. */
  marketing?: Record<string, Marketing | null>;
  /** Draft chapters are included by default — but then they are marked, not hidden. */
  onlyApproved?: boolean;
}

export interface VolumeArtifact {
  index: number;
  label: string;
  title: string;
  chapters: number;
  words: number;
  pageCount: number;
  spineIn: number | null;
  files: string[];
  findings: ValidationResult[];
}

export interface PackageResult {
  zip: Buffer;
  filename: string;
  volumes: VolumeArtifact[];
  /** Everything that would stop an upload, flattened across volumes, for the UI to show. */
  errors: string[];
  warnings: string[];
}

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'book'
  );
}

/**
 * The listing text, formatted to be pasted field by field into the KDP form.
 *
 * Plain text on purpose. This file is read by a person with the Amazon page open beside it, and the
 * headings are the names of the fields they are filling in.
 */
export function listingText(
  title: string,
  author: string,
  m: Marketing | null,
  isbn: string,
  volume?: VolumeInfo,
): string {
  const lines: string[] = [];
  const push = (heading: string, body: string): void => {
    lines.push(`=== ${heading} ===`, '', body.trim() || '(not written yet)', '', '');
  };
  lines.push(`KDP LISTING — ${volumeTitle(title, volume)}`, '='.repeat(60), '');
  push('TITLE', volumeTitle(title, volume));
  if (volume && volume.total > 1) {
    push('SERIES', `${title}  (book ${volume.index} of ${volume.total})`);
  }
  push('AUTHOR', author);
  push('DESCRIPTION  (paste into "Description")', m?.blurb ?? '');
  push('BACK COVER  (printed on the wrap; here for reference)', m?.back_cover ?? '');
  push('ONE-LINE HOOK  (for ads and social; not a KDP field)', m?.hook ?? '');
  const keywords = (m?.keywords ?? []).filter(Boolean);
  push(
    `KEYWORDS  (${keywords.length} of 7 slots — one per box)`,
    keywords.length ? keywords.map((k, i) => `${i + 1}. ${k}`).join('\n') : '',
  );
  push(
    'CATEGORIES  (up to 3)',
    (m?.categories ?? []).filter(Boolean).map((c, i) => `${i + 1}. ${c}`).join('\n'),
  );
  push(
    'COMPARABLE TITLES  (not a KDP field — for choosing categories and ads)',
    (m?.comparable_titles ?? []).filter(Boolean).map((c) => `• ${c}`).join('\n'),
  );
  push('AUTHOR BIO  (Author Central, and the back cover)', m?.author_bio ?? '');
  push('ISBN  (paperback; leave blank to let KDP assign one free)', isbn);
  return lines.join('\n');
}


/** Everything one volume's files are built from: its chapters, its matter, its copy. */
export interface VolumeParts {
  volume: VolumeInfo | undefined;
  label: string;
  fullTitle: string;
  rows: PackageChapter[];
  printChapters: PrintChapter[];
  matter: ReturnType<typeof bookMatter>;
  marketing: Marketing | null;
  isbn: string;
  bio: string;
}

/** The planned volumes, or the whole book as one when there is no plan. */
export function plannedVolumes(opts: Pick<BuildPackageOptions, 'volumes'>, all: PackageChapter[]): PlannedVolume[] {
  return opts.volumes && opts.volumes.length
    ? opts.volumes
    : [
        {
          index: 1,
          first_chapter: Number(all[0]?.chapter_number ?? 0),
          last_chapter: Number(all[all.length - 1]?.chapter_number ?? all.length),
        },
      ];
}

export function volumeParts(
  opts: BuildPackageOptions,
  planned: PlannedVolume[],
  all: PackageChapter[],
  v: PlannedVolume,
): VolumeParts {
  const volume: VolumeInfo | undefined =
    planned.length > 1
      ? { index: v.index, total: planned.length, firstChapter: v.first_chapter, lastChapter: v.last_chapter }
      : undefined;
  const label = planned.length > 1 ? `volume-${v.index}` : 'book';
  let rows = all;
  if (volume) {
    rows = all.filter((c) => {
      const n = Number(c.chapter_number ?? -1);
      return n >= v.first_chapter && n <= v.last_chapter;
    });
  }
  if (opts.onlyApproved) {
    rows = rows.filter((c) => ['approved', 'published'].includes(String(c.status ?? '')));
  }
  const marketing = opts.marketing?.[String(v.index)] ?? null;
  const isbn = String(opts.settings.isbns?.[String(v.index)] ?? '');
  // The bio printed in the book is the author's approved one. The copywriter's version is a
  // suggestion for Author Central; it is not allowed to become a fact on the back cover.
  const bio = opts.authorBio.trim() || String(marketing?.author_bio ?? '').trim();
  const matter = bookMatter({
    title: opts.title,
    author: opts.author,
    publisher: opts.settings.publisher || undefined,
    isbn: isbn || undefined,
    dedication: opts.settings.dedication || undefined,
    epigraph: opts.settings.epigraph
      ? { text: opts.settings.epigraph, attribution: opts.settings.epigraph_attribution || undefined }
      : undefined,
    authorsNote: opts.settings.authors_note || undefined,
    acknowledgements: opts.settings.acknowledgements || undefined,
    aboutTheAuthor: bio || undefined,
    volume,
    fiction: true,
  });
  return {
    volume,
    label,
    fullTitle: volumeTitle(opts.title, volume),
    rows,
    printChapters: rows.map((c) => ({ number: c.chapter_number, title: c.title, text: c.content_text })),
    matter,
    marketing,
    isbn,
    bio,
  };
}

/**
 * The paperback interior, at the gutter its own page count requires.
 *
 * Pass one for a real page count, then rebuild at the gutter that count requires — and keep going
 * until the two agree, because widening the gutter shortens the lines and so adds pages, which can
 * cross the next threshold. It settles in two passes in practice; the cap is there so a
 * pathological book cannot spin.
 */
export async function buildInterior(o: {
  title: string;
  author: string;
  chapters: PrintChapter[];
  matter: ReturnType<typeof bookMatter>;
  trim: string;
  bodySize?: number;
  bleedIn?: number;
}): Promise<Awaited<ReturnType<typeof buildPrintPdf>>> {
  const base = {
    title: o.title,
    author: o.author,
    chapters: o.chapters,
    front: o.matter.front,
    back: o.matter.back,
    trim: o.trim,
    bodySize: o.bodySize,
    bleedIn: o.bleedIn,
  };
  let interior = await buildPrintPdf(base);
  for (let pass = 0; pass < 3; pass += 1) {
    const required = gutterInches(interior.pageCount);
    if (required === interior.gutterInches) break;
    interior = await buildPrintPdf({ ...base, estimatedPages: interior.pageCount });
  }
  return interior;
}

/** Build the whole package. Throws only on something unrecoverable; everything else is a finding. */
export async function buildKdpPackage(opts: BuildPackageOptions): Promise<PackageResult> {
  const trimName = TRIM_SIZES[opts.settings.trim] ? opts.settings.trim : '6x9';
  const trim = TRIM_SIZES[trimName];
  const paper = opts.settings.paper ?? 'cream';

  const all = opts.chapters.filter((c) => String(c.content_text ?? '').trim());
  if (!all.length) throw new Error('NO_CHAPTERS');

  const planned = plannedVolumes(opts, all);
  const wanted = opts.onlyVolume
    ? planned.filter((v) => v.index === opts.onlyVolume)
    : planned;
  if (!wanted.length) throw new Error('NO_SUCH_VOLUME');

  const zip = new JSZip();
  const artifacts: VolumeArtifact[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const v of wanted) {
    const parts = volumeParts(opts, planned, all, v);
    const { volume, label, fullTitle, marketing, isbn, bio } = parts;
    const dir = zip.folder(label)!;
    if (!parts.rows.length) {
      errors.push(`${label}: no chapters with text in this volume`);
      continue;
    }
    const rows = parts.rows;

    const interior = await buildInterior({
      title: opts.title,
      author: opts.author,
      chapters: parts.printChapters,
      matter: parts.matter,
      trim: trimName,
      bodySize: opts.settings.body_size,
    });

    dir.file(`${slug(fullTitle)}-interior-${trimName}.pdf`, interior.pdf);
    const files = [`${label}/${slug(fullTitle)}-interior-${trimName}.pdf`];
    const findings: ValidationResult[] = [];
    const report: string[] = [`KDP PRE-FLIGHT — ${fullTitle}`, '='.repeat(60), ''];

    const interiorCheck = validatePrintPdf({
      pdf: interior.pdf,
      pageCount: interior.pageCount,
      trimWidthIn: trim.w,
      trimHeightIn: trim.h,
    });
    findings.push(interiorCheck);
    report.push(formatFindings('Paperback interior', interiorCheck), '');

    // The cover wrap. Its spine comes from the interior's real page count — never an estimate,
    // because a spine off by a tenth of an inch puts the title on the front of the book.
    let spineIn: number | null = null;
    if (opts.art?.length) {
      const wrap = await composeCoverWrap({
        art: opts.art,
        title: opts.title,
        author: opts.author,
        pageCount: interior.pageCount,
        trimWidthIn: trim.w,
        trimHeightIn: trim.h,
        paper,
        blurb: marketing?.back_cover || marketing?.blurb || undefined,
        authorBio: bio || undefined,
        volumeLabel: volume ? `Volume ${volume.index}` : undefined,
      });
      if (wrap) {
        spineIn = wrap.spineIn;
        dir.file(`${slug(fullTitle)}-cover-wrap.png`, wrap.png);
        files.push(`${label}/${slug(fullTitle)}-cover-wrap.png`);
        const wrapCheck = validateCoverWrap({
          widthIn: wrap.widthIn,
          heightIn: wrap.heightIn,
          pageCount: interior.pageCount,
          trimWidthIn: trim.w,
          trimHeightIn: trim.h,
          spineIn: wrap.spineIn,
          bleedIn: 0.125,
          dpi: wrap.dpi,
        });
        findings.push(wrapCheck);
        report.push(formatFindings('Paperback cover wrap', wrapCheck), '');
      } else {
        errors.push(`${label}: the cover wrap could not be composed from the selected art`);
      }
    } else {
      errors.push(`${label}: no cover art — neither the wrap nor the ebook cover can be built`);
    }

    // The ebook. Same matter, same bio, same blurb — a paperback and a Kindle edition that disagree
    // about the copyright page are two different books.
    const epubChapters: EpubChapter[] = rows.map((c) => ({
      chapter_number: c.chapter_number,
      title: c.title,
      content_text: c.content_text,
      status: c.status ?? null,
    }));
    let ebookCover: { data: Buffer; ext: 'jpg' | 'png' } | null = null;
    if (opts.art?.length) {
      const jacket = await composeCover({ art: opts.art, title: opts.title, author: opts.author });
      ebookCover = jacket ? { data: jacket, ext: 'jpg' } : { data: opts.art, ext: 'png' };
      dir.file(`${slug(fullTitle)}-ebook-cover.${ebookCover.ext}`, ebookCover.data);
      files.push(`${label}/${slug(fullTitle)}-ebook-cover.${ebookCover.ext}`);
      if (jacket) {
        // composeCover lays the jacket out at exactly these pixels. The fallback is the raw art at
        // whatever size it happens to be, and validating THAT against 1600x2560 would be a claim
        // about a file nothing measured.
        const coverCheck = validateEbookCover(EBOOK_COVER_W, EBOOK_COVER_H);
        findings.push(coverCheck);
        report.push(formatFindings('Ebook cover', coverCheck), '');
      } else {
        warnings.push(
          `${label}: the jacket could not be composed, so the raw art is the ebook cover — ` +
            'its size is unverified and it carries no title',
        );
      }
    }

    const epub = await buildEpub({
      title: opts.title,
      chapters: epubChapters,
      author: opts.author,
      markDrafts: !opts.onlyApproved,
      cover: ebookCover,
      frontMatter: parts.matter.front,
      backMatter: parts.matter.back,
    });
    dir.file(`${slug(fullTitle)}.epub`, epub);
    files.push(`${label}/${slug(fullTitle)}.epub`);
    const epubCheck = await validateEpub(epub);
    findings.push(epubCheck);
    report.push(formatFindings('Kindle EPUB', epubCheck), '');

    dir.file('kdp-listing.txt', listingText(opts.title, opts.author, marketing, isbn, volume));
    files.push(`${label}/kdp-listing.txt`);
    if (!marketing?.blurb?.trim()) {
      errors.push(`${label}: the description is empty — KDP requires one`);
    }

    dir.file('pre-flight.txt', report.join('\n'));
    files.push(`${label}/pre-flight.txt`);

    for (const r of findings) {
      for (const f of r.findings) {
        (f.severity === 'error' ? errors : warnings).push(`${label}: ${f.code} — ${f.message}`);
      }
    }

    artifacts.push({
      index: v.index,
      label,
      title: fullTitle,
      chapters: rows.length,
      words: rows.reduce((n, c) => n + String(c.content_text ?? '').split(/\s+/).filter(Boolean).length, 0),
      pageCount: interior.pageCount,
      spineIn,
      files,
      findings,
    });
  }

  // The one file somebody actually reads first: what this is and what to do with it.
  zip.file(
    'README.txt',
    [
      `${opts.title} — KDP upload package`,
      '='.repeat(60),
      '',
      `Author: ${opts.author || '(not set)'}`,
      `Trim: ${trimName} in   Paper: ${paper}`,
      `Volumes in this package: ${artifacts.length}${
        opts.onlyVolume ? ` (volume ${opts.onlyVolume} only)` : ''
      }`,
      '',
      ...artifacts.map(
        (a) =>
          `  ${a.label}:  ${a.title}\n` +
          `      ${a.chapters} chapters, ${a.words.toLocaleString()} words, ` +
          `${a.pageCount} pages${a.spineIn ? `, spine ${a.spineIn.toFixed(3)}"` : ''}`,
      ),
      '',
      'Each volume folder holds:',
      '  *-interior-<trim>.pdf    the paperback interior. Upload as the manuscript.',
      '  *-cover-wrap.png         back + spine + front at 300dpi with bleed. Upload as the cover.',
      '  *.epub                   the Kindle edition.',
      '  *-ebook-cover.*          the Kindle cover (1600x2560).',
      '  kdp-listing.txt          the listing copy, field by field, to paste into the KDP form.',
      '  pre-flight.txt           what was checked and what it found.',
      '',
      errors.length ? `BLOCKING (${errors.length}):` : 'No blocking problems found.',
      ...errors.map((e) => `  ! ${e}`),
      '',
      warnings.length ? `WORTH A LOOK (${warnings.length}):` : '',
      ...warnings.map((w) => `  - ${w}`),
      '',
      'Not checked here: epubcheck, which needs Java. Run it on the .epub before uploading —',
      'KDP runs its own and will refuse the file rather than tell you what is wrong with it.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  logger.info(
    { volumes: artifacts.length, bytes: zipBuffer.length, errors: errors.length, warnings: warnings.length },
    'kdp package built',
  );
  return {
    zip: zipBuffer,
    filename: `${slug(opts.title)}-kdp${opts.onlyVolume ? `-v${opts.onlyVolume}` : ''}.zip`,
    volumes: artifacts,
    errors,
    warnings,
  };
}
