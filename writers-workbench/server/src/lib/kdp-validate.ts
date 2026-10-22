/**
 * Pre-flight for KDP: the checks Amazon actually rejects on.
 *
 * WHAT THIS IS NOT. It is not epubcheck. epubcheck is the authoritative EPUB validator, it is a
 * Java tool, and there is no Java runtime here — so this cannot pretend to be it, and says so.
 * What it does instead is check the things that actually bounce a KDP upload, most of which
 * epubcheck would also catch, plus several it would not because they are KDP policy rather than
 * EPUB spec: page-count ceilings, trim consistency, spine arithmetic, cover ratios.
 *
 * The point is to fail here, in a second, rather than after a twenty-minute upload and a rejection
 * email that says "we were unable to process your file" and names nothing.
 *
 * Severity is meant literally. `error` means the upload will be refused or the book will print
 * wrong. `warning` means it will go through and something is worse than it should be. Nothing is
 * reported as an error on suspicion.
 */

import JSZip from 'jszip';

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  /** What to do about it, when that is not obvious from the message. */
  fix?: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
  /** Facts worth printing next to the verdict. */
  facts: Record<string, string | number | boolean>;
}

function result(findings: Finding[], facts: Record<string, string | number | boolean> = {}): ValidationResult {
  return { ok: !findings.some((f) => f.severity === 'error'), findings, facts };
}

// ---------------------------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------------------------

/** KDP's ebook upload ceiling. */
export const MAX_EPUB_BYTES = 650 * 1024 * 1024;

export async function validateEpub(epub: Buffer): Promise<ValidationResult> {
  const f: Finding[] = [];
  const facts: Record<string, string | number | boolean> = { bytes: epub.length };

  if (epub.length > MAX_EPUB_BYTES) {
    f.push({
      severity: 'error',
      code: 'EPUB_TOO_LARGE',
      message: `${(epub.length / 1048576).toFixed(0)}MB exceeds KDP's 650MB limit`,
    });
  }

  // The mimetype rules are checked at the byte level, because they are byte-level rules: readers
  // sniff a fixed offset, and a compressed or non-first mimetype is the commonest reason a
  // hand-built EPUB opens in one reader and silently fails in another.
  if (epub.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') {
    f.push({ severity: 'error', code: 'NOT_A_ZIP', message: 'not a ZIP archive' });
    return result(f, facts);
  }
  const nameLen = epub.readUInt16LE(26);
  const firstName = epub.subarray(30, 30 + nameLen).toString('latin1');
  if (firstName !== 'mimetype') {
    f.push({
      severity: 'error',
      code: 'MIMETYPE_NOT_FIRST',
      message: `first archive entry is "${firstName}", must be "mimetype"`,
    });
  } else if (epub.readUInt16LE(8) !== 0) {
    f.push({
      severity: 'error',
      code: 'MIMETYPE_COMPRESSED',
      message: 'the mimetype entry is compressed; it must be STORED',
    });
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(epub);
  } catch (err) {
    f.push({ severity: 'error', code: 'UNREADABLE', message: `cannot read the archive: ${String(err)}` });
    return result(f, facts);
  }
  const names = Object.keys(zip.files);
  facts.entries = names.length;

  const container = zip.file('META-INF/container.xml');
  if (!container) {
    f.push({ severity: 'error', code: 'NO_CONTAINER', message: 'META-INF/container.xml is missing' });
    return result(f, facts);
  }
  const containerXml = await container.async('string');
  const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath || !zip.file(opfPath)) {
    f.push({
      severity: 'error',
      code: 'NO_OPF',
      message: `container.xml points at "${opfPath ?? '(nothing)'}", which is not in the archive`,
    });
    return result(f, facts);
  }
  const opf = await zip.file(opfPath)!.async('string');
  const opfDir = opfPath.includes('/') ? opfPath.replace(/\/[^/]+$/, '/') : '';

  // Metadata KDP reads off the file rather than the form.
  for (const [tag, code] of [
    ['dc:title', 'NO_TITLE'],
    ['dc:language', 'NO_LANGUAGE'],
    ['dc:identifier', 'NO_IDENTIFIER'],
  ] as const) {
    if (!new RegExp(`<${tag}[^>]*>`).test(opf)) {
      f.push({ severity: 'error', code, message: `the package has no <${tag}>` });
    }
  }
  if (!/<dc:creator[^>]*>/.test(opf)) {
    f.push({
      severity: 'warning',
      code: 'NO_CREATOR',
      message: 'no <dc:creator> — the book will be filed under "Unknown Author"',
      fix: 'set the author on export',
    });
  }

  // Every manifest href must exist. A missing one is the classic silent-failure upload.
  const hrefs = [...opf.matchAll(/<item\b[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const missing = hrefs.filter((h) => !/^https?:/i.test(h) && !zip.file(decodeURIComponent(opfDir + h)));
  if (missing.length) {
    f.push({
      severity: 'error',
      code: 'MANIFEST_MISSING_FILES',
      message: `${missing.length} manifest item(s) are not in the archive: ${missing.slice(0, 3).join(', ')}`,
    });
  }
  const remote = hrefs.filter((h) => /^https?:/i.test(h));
  if (remote.length) {
    f.push({
      severity: 'error',
      code: 'REMOTE_RESOURCES',
      message: `${remote.length} manifest item(s) point at the internet; KDP requires a self-contained file`,
    });
  }

  // Spine must reference manifest ids that exist, or the reader has nothing to open.
  const ids = new Set([...opf.matchAll(/<item\b[^>]*id="([^"]+)"/g)].map((m) => m[1]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  facts.spineItems = spine.length;
  const dangling = spine.filter((id) => !ids.has(id));
  if (dangling.length) {
    f.push({
      severity: 'error',
      code: 'SPINE_DANGLING',
      message: `spine references ${dangling.length} id(s) with no manifest item`,
    });
  }
  if (!spine.length) {
    f.push({ severity: 'error', code: 'EMPTY_SPINE', message: 'the spine is empty — there is nothing to read' });
  }

  // Navigation. KDP wants a working TOC; a book without one is accepted and reads badly.
  const hasNav = /properties="[^"]*\bnav\b[^"]*"/.test(opf);
  if (!hasNav) {
    f.push({
      severity: 'warning',
      code: 'NO_NAV',
      message: 'no navigation document — readers will have no table of contents',
    });
  }

  // Cover. Declared and present, or the shelf shows a grey rectangle.
  const coverItem = /<item\b[^>]*properties="[^"]*\bcover-image\b[^"]*"[^>]*href="([^"]+)"/.exec(opf)
    ?? /<item\b[^>]*href="([^"]+)"[^>]*properties="[^"]*\bcover-image\b/.exec(opf);
  if (!coverItem) {
    f.push({
      severity: 'warning',
      code: 'NO_COVER',
      message: 'no cover-image declared; KDP will ask for one separately',
    });
  } else if (!zip.file(decodeURIComponent(opfDir + coverItem[1]))) {
    f.push({
      severity: 'error',
      code: 'COVER_MISSING',
      message: `cover-image "${coverItem[1]}" is declared but not in the archive`,
    });
  } else {
    facts.cover = coverItem[1];
  }

  // Content sanity, on the documents themselves.
  let unescaped = 0;
  let noDecl = 0;
  for (const name of names.filter((n) => /\.(xhtml|html)$/i.test(n))) {
    const xml = await zip.file(name)!.async('string');
    if (!xml.trimStart().startsWith('<?xml')) noDecl += 1;
    if (xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '').includes('&')) unescaped += 1;
  }
  if (unescaped) {
    f.push({
      severity: 'error',
      code: 'UNESCAPED_AMPERSAND',
      message: `${unescaped} document(s) contain a bare "&" — invalid XHTML`,
    });
  }
  if (noDecl) {
    f.push({
      severity: 'warning',
      code: 'NO_XML_DECLARATION',
      message: `${noDecl} document(s) have no XML declaration`,
    });
  }

  f.push({
    severity: 'warning',
    code: 'EPUBCHECK_NOT_RUN',
    message:
      'epubcheck has not been run — it is the authoritative validator and needs a Java runtime, ' +
      'which this environment does not have',
    fix: 'run `epubcheck book.epub` locally before uploading, or rely on KDP’s own previewer',
  });

  return result(f, facts);
}

// ---------------------------------------------------------------------------------------------
// Print interior
// ---------------------------------------------------------------------------------------------

export const KDP_MIN_PAGES = 24;
export const KDP_MAX_PAGES = 828;

export interface PrintPdfCheck {
  pdf: Buffer;
  pageCount: number;
  trimWidthIn: number;
  trimHeightIn: number;
}

export function validatePrintPdf(c: PrintPdfCheck): ValidationResult {
  const f: Finding[] = [];
  const raw = c.pdf.toString('latin1');
  const facts: Record<string, string | number | boolean> = {
    pages: c.pageCount,
    trim: `${c.trimWidthIn}x${c.trimHeightIn}`,
    bytes: c.pdf.length,
  };

  if (!raw.startsWith('%PDF-')) {
    f.push({ severity: 'error', code: 'NOT_A_PDF', message: 'not a PDF' });
    return result(f, facts);
  }

  // The count is read from the page tree rather than trusted from the caller: the generator and
  // the tree disagreed once, by three pages, and the spine is computed from this number.
  const treeCount = Number(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(raw)?.[1] ?? -1);
  facts.pageTreeCount = treeCount;
  if (treeCount > 0 && treeCount !== c.pageCount) {
    f.push({
      severity: 'error',
      code: 'PAGE_COUNT_MISMATCH',
      message: `the caller says ${c.pageCount} pages, the PDF page tree says ${treeCount}`,
      fix: 'the cover spine is computed from this; regenerate before making a cover',
    });
  }

  const pages = treeCount > 0 ? treeCount : c.pageCount;
  if (pages < KDP_MIN_PAGES) {
    f.push({
      severity: 'error',
      code: 'TOO_FEW_PAGES',
      message: `${pages} pages is under KDP's ${KDP_MIN_PAGES}-page minimum`,
    });
  }
  if (pages > KDP_MAX_PAGES) {
    f.push({
      severity: 'error',
      code: 'TOO_MANY_PAGES',
      message: `${pages} pages exceeds KDP's ${KDP_MAX_PAGES}-page maximum`,
      fix: 'split into more volumes, or choose a larger trim',
    });
  }

  // Embedded fonts. An unembedded font is rejected, and it is rejected AFTER the upload.
  const embedded = (raw.match(/\/FontFile[23]?\b/g) || []).length;
  facts.embeddedFontStreams = embedded;
  if (!embedded) {
    f.push({
      severity: 'error',
      code: 'FONTS_NOT_EMBEDDED',
      message: 'no embedded font streams — KDP requires every font to be embedded',
    });
  }

  // Every page the same size. A single stray MediaBox is a print that comes back wrong.
  const boxes = new Set(
    [...raw.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+?)\]/g)].map((m) => m[1].trim().replace(/\s+/g, ' ')),
  );
  facts.distinctMediaBoxes = boxes.size;
  if (boxes.size > 1) {
    f.push({
      severity: 'error',
      code: 'MIXED_PAGE_SIZES',
      message: `${boxes.size} different page sizes in one interior`,
    });
  }
  const first = [...boxes][0]?.split(' ').map(Number);
  if (first && first.length === 4) {
    const wIn = (first[2] - first[0]) / 72;
    const hIn = (first[3] - first[1]) / 72;
    facts.actualTrim = `${wIn.toFixed(2)}x${hIn.toFixed(2)}`;
    if (Math.abs(wIn - c.trimWidthIn) > 0.02 || Math.abs(hIn - c.trimHeightIn) > 0.02) {
      f.push({
        severity: 'error',
        code: 'TRIM_MISMATCH',
        message: `pages are ${wIn.toFixed(2)}x${hIn.toFixed(2)}in, not the ${c.trimWidthIn}x${c.trimHeightIn} requested`,
      });
    }
  }

  return result(f, facts);
}

// ---------------------------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------------------------

/** KDP's ideal ebook cover: 1.6:1, at least 1000px on the long edge. */
export function validateEbookCover(widthPx: number, heightPx: number): ValidationResult {
  const f: Finding[] = [];
  const ratio = heightPx / widthPx;
  const facts = { widthPx, heightPx, ratio: Number(ratio.toFixed(3)) };
  if (Math.max(widthPx, heightPx) < 1000) {
    f.push({
      severity: 'error',
      code: 'COVER_TOO_SMALL',
      message: `longest edge is ${Math.max(widthPx, heightPx)}px; KDP wants at least 1000`,
    });
  }
  if (Math.abs(ratio - 1.6) > 0.15) {
    f.push({
      severity: 'warning',
      code: 'COVER_RATIO',
      message: `aspect ratio is ${ratio.toFixed(2)}:1; KDP's ideal is 1.6:1 (1600x2560)`,
      fix: 'a square cover gets letterboxed with grey bars in the shelf view',
    });
  }
  return result(f, facts);
}

export interface WrapCheck {
  widthIn: number;
  heightIn: number;
  pageCount: number;
  trimWidthIn: number;
  trimHeightIn: number;
  spineIn: number;
  bleedIn: number;
  dpi: number;
}

export function validateCoverWrap(c: WrapCheck): ValidationResult {
  const f: Finding[] = [];
  const expectedW = c.trimWidthIn * 2 + c.spineIn + c.bleedIn * 2;
  const expectedH = c.trimHeightIn + c.bleedIn * 2;
  const facts = {
    widthIn: Number(c.widthIn.toFixed(3)),
    heightIn: Number(c.heightIn.toFixed(3)),
    spineIn: Number(c.spineIn.toFixed(4)),
    dpi: c.dpi,
  };
  if (Math.abs(c.widthIn - expectedW) > 0.01) {
    f.push({
      severity: 'error',
      code: 'WRAP_WIDTH',
      message: `wrap is ${c.widthIn.toFixed(3)}in wide; two trims plus spine plus bleed is ${expectedW.toFixed(3)}in`,
    });
  }
  if (Math.abs(c.heightIn - expectedH) > 0.01) {
    f.push({
      severity: 'error',
      code: 'WRAP_HEIGHT',
      message: `wrap is ${c.heightIn.toFixed(3)}in tall; trim plus bleed is ${expectedH.toFixed(3)}in`,
    });
  }
  if (c.dpi < 300) {
    f.push({
      severity: 'error',
      code: 'WRAP_DPI',
      message: `${c.dpi}dpi; KDP requires 300 for print`,
    });
  }
  if (c.bleedIn < 0.125) {
    f.push({
      severity: 'error',
      code: 'WRAP_BLEED',
      message: `bleed is ${c.bleedIn}in; KDP requires 0.125in on every outside edge`,
    });
  }
  return result(f, facts);
}

/** One readable block, for a terminal or a log. */
export function formatFindings(label: string, r: ValidationResult): string {
  const lines = [`${label}: ${r.ok ? 'PASS' : 'FAIL'}`];
  for (const [k, v] of Object.entries(r.facts)) lines.push(`    ${k}: ${v}`);
  for (const f of r.findings) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
    if (f.fix) lines.push(`      -> ${f.fix}`);
  }
  return lines.join('\n');
}
