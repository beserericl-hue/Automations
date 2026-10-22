/**
 * Build the complete KDP package for a project: per-volume interiors and cover wraps, the ebook,
 * and the metadata sheet — validating every artifact as it is produced.
 *
 * The order is forced by the physics: the interior must exist before its page count is known, and
 * the page count sets the spine width, so no cover can be made first.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { bookMatter, volumeTitle } from './src/lib/bookmatter.js';
import { buildPrintPdf, TRIM_SIZES } from './src/lib/print-pdf.js';
import { buildEpub, epubFilename } from './src/lib/epub.js';
import { composeCover, composeCoverWrap, spineWidthInches, BLEED_IN } from './src/lib/cover.js';
import {
  formatFindings, validateCoverWrap, validateEbookCover, validateEpub, validatePrintPdf,
} from './src/lib/kdp-validate.js';

const S = '/private/tmp/claude-501/-Users-ericbeser-Documents-GitHub-Automations/7520bba9-2b2f-4646-9618-998f850a9ad2/scratchpad';
const OUT = `${process.env.HOME}/Desktop/Ossuary-KDP`;
const PROJECT = 'a1bfb2cf-2949-4d29-80d2-e8b785c6bdae';
const AUTHOR = 'Eric L Beser';
const TRIM = '6x9';

const env: Record<string, string> = {};
for (const line of readFileSync('../engine/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

mkdirSync(OUT, { recursive: true });
const plan = JSON.parse(readFileSync(`${S}/volume_plan_6x9.json`, 'utf8'));
const marketing = JSON.parse(readFileSync(`${S}/marketing.json`, 'utf8'));
const art = readFileSync(`${S}/cover.png`);

const { data: rows } = await db
  .from('published_content_v2')
  .select('chapter_number,title,content_text')
  .eq('project_id', PROJECT).eq('content_type', 'chapter')
  .order('chapter_number');
const chapters = (rows ?? []).filter((r: any) => (r.content_text || '').trim());
console.log(`loaded ${chapters.length} chapters\n`);

const trim = TRIM_SIZES[TRIM];
const report: string[] = [];
const note = (s: string) => { console.log(s); report.push(s); };

const AUTHORS_NOTE =
  'The four ossuaries on the terrace above the Potomac are real, as is the 1930s excavation that ' +
  'emptied them and the deed of gift that moved more than a thousand individuals into a museum. ' +
  'The Piscataway people are real and are still here.\n\n' +
  'Every named character in this book is invented. Where the record is silent — which is almost ' +
  'everywhere, and for almost everyone — I have imagined, and the imagining is mine and not theirs.';

for (const v of plan.volumes) {
  const mk = marketing[`v${v.index}`] ?? {};
  const vInfo = { index: v.index, total: plan.volumes.length };
  const vt = volumeTitle('The Ossuary', vInfo);
  const vChapters = chapters.filter(
    (c: any) => c.chapter_number >= v.first_chapter && c.chapter_number <= v.last_chapter,
  );
  note(`\n${'='.repeat(78)}\nVOLUME ${v.index}: ${vt}  (chapters ${v.first_chapter}-${v.last_chapter})\n${'='.repeat(78)}`);

  const m = bookMatter({
    title: 'The Ossuary', author: AUTHOR, volume: vInfo, fiction: true,
    publisher: 'Independently published',
    dedication: 'For the ones who were not asked.',
    epigraph: { text: 'The dead are still here.', attribution: 'Marcus Tayac' },
    authorsNote: AUTHORS_NOTE,
    aboutTheAuthor: mk.author_bio || `${AUTHOR} writes from Maryland.`,
  });

  // 1. Interior — its page count is the input to everything else.
  const interior = await buildPrintPdf({
    title: vt, author: AUTHOR, trim: TRIM,
    chapters: vChapters.map((c: any) => ({ number: c.chapter_number, title: c.title, text: c.content_text })),
    front: m.front, back: m.back, estimatedPages: v.estimated_pages,
  });
  writeFileSync(`${OUT}/Vol${v.index}-interior-${TRIM}.pdf`, interior.pdf);
  note(`  interior: ${interior.pageCount} pages (planner estimated ${v.estimated_pages}), gutter ${interior.gutterInches}"`);
  note(formatFindings('  interior validation', validatePrintPdf({
    pdf: interior.pdf, pageCount: interior.pageCount, trimWidthIn: trim.w, trimHeightIn: trim.h,
  })));

  // 2. Cover wrap — spine from the REAL count.
  const wrap = await composeCoverWrap({
    art, title: 'The Ossuary', author: AUTHOR, pageCount: interior.pageCount,
    trimWidthIn: trim.w, trimHeightIn: trim.h,
    volumeLabel: `Volume ${['', 'One', 'Two', 'Three'][v.index]}`,
    blurb: mk.back_cover, authorBio: `${AUTHOR} writes from Maryland.`,
  });
  if (!wrap) { note('  COVER WRAP FAILED'); continue; }
  writeFileSync(`${OUT}/Vol${v.index}-cover-wrap.png`, wrap.png);
  note(`  wrap: ${wrap.widthIn.toFixed(3)} x ${wrap.heightIn.toFixed(3)} in, spine ${wrap.spineIn.toFixed(3)} in`);
  note(formatFindings('  wrap validation', validateCoverWrap({
    widthIn: wrap.widthIn, heightIn: wrap.heightIn, pageCount: interior.pageCount,
    trimWidthIn: trim.w, trimHeightIn: trim.h, spineIn: wrap.spineIn, bleedIn: BLEED_IN, dpi: wrap.dpi,
  })));
}

// 3. The ebook: ONE file, all 96 chapters — Kindle has no page ceiling.
console.log(`\n${'='.repeat(78)}\nEBOOK (single file, all ${chapters.length} chapters)\n${'='.repeat(78)}`);
const seriesMk = marketing.series ?? {};
const em = bookMatter({
  title: 'The Ossuary', author: AUTHOR, fiction: true, publisher: 'Independently published',
  dedication: 'For the ones who were not asked.',
  epigraph: { text: 'The dead are still here.', attribution: 'Marcus Tayac' },
  authorsNote: AUTHORS_NOTE, aboutTheAuthor: seriesMk.author_bio || `${AUTHOR} writes from Maryland.`,
});
const jacket = await composeCover({ art, title: 'The Ossuary', author: AUTHOR });
const epub = await buildEpub({
  title: 'The Ossuary', author: AUTHOR, markDrafts: false,
  chapters: chapters.map((c: any) => ({
    chapter_number: c.chapter_number, title: c.title, content_text: c.content_text, status: 'approved',
  })),
  cover: jacket ? { data: jacket, ext: 'jpg' } : null,
  frontMatter: em.front, backMatter: em.back,
});
writeFileSync(`${OUT}/${epubFilename('The Ossuary')}`, epub);
note(formatFindings('  epub validation', await validateEpub(epub)));
note(formatFindings('  ebook cover', validateEbookCover(1600, 2560)));

writeFileSync(`${OUT}/validation-report.txt`, report.join('\n'));
console.log(`\nwritten to ${OUT}`);
