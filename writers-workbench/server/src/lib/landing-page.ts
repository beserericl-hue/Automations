/**
 * Sales landing page for a book, built with GoHighLevel's "Build with AI".
 *
 * GHL's builder takes a prompt, not a page. It writes its own layout and, left to itself, its own
 * copy, so a rule in the prompt ("use this text verbatim") is a request, not a guarantee. This
 * module therefore does three things, and only the second involves a model:
 *
 *   1. assembles the page from what the project already holds (stored marketing copy, the approved
 *      bio, the project's images) word for word;
 *   2. verifies the history facts a model picked from the project's research: each must quote its
 *      report exactly, and every number it states must be in that quote;
 *   3. after GHL has built the page, checks the published page against the copy it was given.
 */
import type { Finding, ValidationResult } from './kdp-validate.js';

export interface ResearchReport {
  id: string;
  topic: string;
  content: string;
}

/** One sentence for the page, the exact sentence it rests on, and the report that holds it. */
export interface SourcedFact {
  text: string;
  quote: string;
  report_id: string;
}

export interface PageImage {
  role: 'cover' | 'author' | 'reference';
  url: string;
  alt: string;
  /** Required on the page when the licence is CC BY: "Photo: <creator>, <licence>". */
  credit?: string;
}

export interface LandingCopy {
  title: string;
  author: string;
  hook: string;
  blurb: string;
  backCover: string;
  /** Each book of the series, with its own title once the author has chosen one. */
  volumes: { index: number; hook: string; title?: string }[];
  /** The series pitch, when the book is a series and the pitch has been written. */
  series?: { name: string; description: string; tagline?: string };
  bio: string;
  facts: SourcedFact[];
  images: PageImage[];
  form: { heading: string; lede: string; button: string; fields: string[] };
  seo: { title: string; description: string; keywords: string[] };
}

function result(findings: Finding[], facts: Record<string, string | number | boolean> = {}): ValidationResult {
  return { ok: !findings.some((f) => f.severity === 'error'), findings, facts };
}

/** Compare text the way a reader would: case, curly quotes, dashes and spacing do not count. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

/**
 * Claims the page may not make, whoever wrote the sentence. Each one is either untrue or has no
 * source yet; the reference page this layout borrows from makes most of them.
 */
export const FORBIDDEN_CLAIMS: { code: string; re: RegExp; message: string }[] = [
  {
    code: 'reviews',
    re: /\b(reviews?|reviewers?|testimonials?|five[- ]star|[1-5](\.\d)?[- ]stars?)\b|★/i,
    message: 'no reader reviews exist for this book',
  },
  {
    code: 'accolade',
    re: /\bbest[- ]?sell(er|ers|ing)\b|\baward[- ]winning\b|\bcritically acclaimed\b/i,
    message: 'no sales figures or awards are recorded',
  },
  {
    code: 'urgency',
    re: /\blimited time\b|\bonly \d+ (left|remaining)\b|\bhurry\b|\boffer ends\b|\bends (soon|tonight)\b/i,
    message: 'there is no deadline',
  },
  { code: 'guarantee', re: /\bmoney[- ]back\b|\bguarantee(s|d)?\b/i, message: 'no guarantee has been offered' },
  {
    code: 'price',
    re: /[$£€]\s?\d|\b\d+\s?% off\b|\bsave \d+\s?%/i,
    message: 'no price or discount has been set',
  },
  { code: 'debut', re: /\bdebut\b/i, message: 'the author profile does not say this is a first book' },
  {
    code: 'federal_recognition_2012',
    re: /federal(ly)?\s+recogni\w*[^.]{0,100}\b2012\b|\b2012\b[^.]{0,100}federal(ly)?\s+recogni/i,
    message: 'the 2012 recognition was by the State of Maryland, not federal',
  },
];

export function forbiddenClaims(text: string): Finding[] {
  return FORBIDDEN_CLAIMS.filter((c) => c.re.test(text)).map((c) => ({
    severity: 'error' as const,
    code: `forbidden_${c.code}`,
    message: `${c.message}: "${excerpt(text, c.re)}"`,
  }));
}

function excerpt(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return '';
  const start = Math.max(0, m.index - 40);
  return text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Research facts
// ---------------------------------------------------------------------------------------------

export const FACT_MAX_CHARS = 240;
export const QUOTE_MIN_CHARS = 40;

/** Why a fact cannot go on the page. An empty list means it can. */
export function verifyFact(fact: SourcedFact, reports: Map<string, ResearchReport>): Finding[] {
  const findings: Finding[] = [];
  const report = reports.get(fact.report_id);
  if (!report) {
    return [{ severity: 'error', code: 'unknown_report', message: `no research report ${fact.report_id}` }];
  }
  if (fact.text.length > FACT_MAX_CHARS) {
    findings.push({ severity: 'error', code: 'fact_too_long', message: `${fact.text.length} chars > ${FACT_MAX_CHARS}` });
  }
  if (fact.quote.trim().length < QUOTE_MIN_CHARS) {
    findings.push({ severity: 'error', code: 'quote_too_short', message: `quote under ${QUOTE_MIN_CHARS} chars` });
  } else if (!normalize(report.content).includes(normalize(fact.quote))) {
    findings.push({
      severity: 'error',
      code: 'quote_not_in_report',
      message: `the quote is not in "${report.topic}": "${fact.quote.slice(0, 80)}"`,
    });
  }
  const quoted = new Set(numbersIn(fact.quote));
  for (const n of numbersIn(fact.text)) {
    if (!quoted.has(n)) {
      findings.push({ severity: 'error', code: 'number_not_in_quote', message: `${n} is not in the quote` });
    }
  }
  findings.push(...forbiddenClaims(fact.text));
  return findings;
}

export function selectFacts(
  facts: SourcedFact[],
  reports: Map<string, ResearchReport>,
): { kept: SourcedFact[]; rejected: { fact: SourcedFact; findings: Finding[] }[] } {
  const kept: SourcedFact[] = [];
  const rejected: { fact: SourcedFact; findings: Finding[] }[] = [];
  for (const fact of facts) {
    const findings = verifyFact(fact, reports);
    if (findings.length) rejected.push({ fact, findings });
    else kept.push(fact);
  }
  return { kept, rejected };
}

/**
 * The reports most worth showing the model: one per topic (re-runs of a topic are near copies),
 * ranked by how many of the page's subjects each covers, until the character budget is spent.
 */
export function rankResearch(reports: ResearchReport[], terms: string[], budgetChars: number): ResearchReport[] {
  const byTopic = new Map<string, ResearchReport>();
  for (const r of reports) {
    const prev = byTopic.get(r.topic);
    if (!prev || r.content.length > prev.content.length) byTopic.set(r.topic, r);
  }
  const lowered = terms.map((t) => t.toLowerCase());
  const scored = [...byTopic.values()].map((r) => {
    const text = r.content.toLowerCase();
    return { r, score: lowered.filter((t) => text.includes(t)).length };
  });
  scored.sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
  const picked: ResearchReport[] = [];
  let used = 0;
  for (const { r, score } of scored) {
    if (score === 0 || used + r.content.length > budgetChars) continue;
    picked.push(r);
    used += r.content.length;
  }
  return picked;
}

/**
 * Capitalised words and site codes from the book's own copy, to rank its research by. Sentence
 * openers are dropped; what remains is mostly places, peoples and names.
 */
export function researchTerms(m: { hook?: string; blurb?: string; back_cover?: string; keywords?: string[] }): string[] {
  const text = [m.hook, m.blurb, m.back_cover, ...(m.keywords ?? [])].join(' ');
  const found = text.match(/\b[A-Z][a-zA-Z'-]{3,}\b|\b\d+[A-Z]+\d+\b/g) ?? [];
  const openers = new Set(['The', 'This', 'That', 'There', 'These', 'When', 'What', 'Where', 'Who', 'While', 'Four', 'More', 'Three', 'Twenty-six']);
  return [...new Set(found.filter((w) => !openers.has(w)))].slice(0, 30);
}

/** A credit good enough for CC BY: title, creator, licence, and where the photo came from. */
export function creditFor(p: { title: string; creator: string; license: string; source_page_url: string }): string {
  return [`Photo: ${p.title}`, p.creator ? `by ${p.creator}` : '', p.license, p.source_page_url]
    .filter(Boolean)
    .join('. ');
}

export function factPrompt(book: { title: string; author: string }, reports: ResearchReport[]): string {
  const docs = reports
    .map((r) => `<report id="${r.id}" topic="${r.topic.replace(/"/g, "'")}">\n${r.content}\n</report>`)
    .join('\n\n');
  return [
    `${book.title} is a novel by ${book.author}, set at a real archaeological site on the Potomac`,
    'in Maryland, where Piscataway ossuaries were excavated in the 1930s and the remains moved to a',
    'museum. Below is the research the author wrote the novel from.',
    '',
    'Pick four facts for the book\'s sales page that would make a stranger believe the history in',
    'the novel is real: the site, the excavation, the people, the law. Facts about history only;',
    'say nothing about the novel itself.',
    '',
    'For each fact give:',
    `- text: one plain sentence for the page, at most ${FACT_MAX_CHARS} characters. It may claim`,
    '  only what the quote says. Use a number only if the quote contains that exact number.',
    `- quote: the sentence from the report the fact rests on, copied exactly (at least ${QUOTE_MIN_CHARS}`,
    '  characters, one contiguous passage, no ellipses).',
    '- report_id: the id of the report the quote is in.',
    '',
    'Maryland recognized the Piscataway in 2012. That was state recognition, not federal; do not',
    'call it federal.',
    '',
    docs,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The sample page: its structure, never its copy
// ---------------------------------------------------------------------------------------------

/** What a section of a sales page is for. The model sorts the sample's sections into these. */
export const SECTION_KINDS = ['hero', 'story', 'proof', 'lineup', 'offer', 'author', 'closing'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Mechanics a sample may use that this page has no data for. Each is reported, never faked. */
export const UNAVAILABLE_MECHANICS = [
  'reviews', 'price', 'discount', 'bundle', 'guarantee', 'urgency', 'countdown', 'press', 'awards', 'video',
] as const;
export type UnavailableMechanic = (typeof UNAVAILABLE_MECHANICS)[number];

const MECHANIC_NOTES: Record<UnavailableMechanic, string> = {
  reviews: 'reader reviews: none exist; the proof slot carries sourced history instead',
  price: 'price display: no price has been set',
  discount: 'discount or price ladder: no prices to compute one from',
  bundle: 'bundle offer: the volumes are not on sale as a set',
  guarantee: 'money-back guarantee: none has been offered',
  urgency: '"limited time" urgency: there is no deadline',
  countdown: 'countdown timer: there is no deadline',
  press: 'press mentions: none recorded',
  awards: 'awards: none recorded',
  video: 'video: none in the project',
};

export interface SampleSection {
  kind: SectionKind;
  heading: string;
  uses: UnavailableMechanic[];
}

export interface SampleStructure {
  url: string;
  sections: SampleSection[];
  cta_count: number;
}

export const DEFAULT_ORDER: SectionKind[] = ['hero', 'story', 'proof', 'lineup', 'offer', 'author', 'closing'];

/** Query parameters that identify an ad click rather than a page. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|fbadid|gclid|gbraid|wbraid|msclkid|ttclid|twclid|li_fat_id|mc_[ce]id|_hs\w+|ad_id|adset_id|campaign_id|ad_name|adset_name|campaign_name|igshid)$/i;

/**
 * The sample's address without its ad-tracking. Fetching the tracked URL would count as a click on
 * someone else's paid campaign, and storing it would keep their ad ids in this project.
 */
export function stripTracking(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hash = '';
  return url.toString();
}

/** Only public web pages: a server that fetches what it is told must not be pointed inward. */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return true;
}

export const SAMPLE_TEXT_LIMIT = 40_000;

export function samplePrompt(pageText: string): string {
  return [
    'Below is the visible text of a sales landing page. Describe its STRUCTURE only. Its words will',
    'not be reused.',
    '',
    'List its sections top to bottom. For each give:',
    '- kind: what the section is for. One of:',
    '    hero (opening banner with the main headline and first call to action),',
    '    story (what the product is about),',
    '    proof (why to believe it is good: reviews, testimonials, facts, credentials, press),',
    '    lineup (the individual items, volumes or editions on offer),',
    '    offer (where the reader buys or signs up: price table, order form),',
    '    author (about the creator),',
    '    closing (the final appeal).',
    '- heading: the section heading as written, or a three-word description if it has none.',
    '- uses: which of these the section relies on, if any: reviews, price, discount, bundle,',
    '  guarantee, urgency, countdown, press, awards, video.',
    '',
    'Also give cta_count: how many separate call-to-action buttons the page shows.',
    '',
    '<page>',
    pageText.slice(0, SAMPLE_TEXT_LIMIT),
    '</page>',
  ].join('\n');
}

export interface SectionPlan {
  kind: SectionKind;
  cta: boolean;
}

/** CTA buttons the page gets when there is no sample to count them from. */
export const DEFAULT_CTA_COUNT = 4;

/** Sections that may carry a button, in the order they earn one. The form section is the target. */
const CTA_PRIORITY: SectionKind[] = ['hero', 'closing', 'proof', 'story', 'lineup', 'author'];

/**
 * The page's sections in the sample's order. The hero leads whatever the sample does, and every
 * section this page has is kept: a sample without an author section does not delete the author.
 */
export function planSections(sample?: SampleStructure | null): SectionPlan[] {
  const order: SectionKind[] = ['hero'];
  for (const s of sample?.sections ?? []) if (!order.includes(s.kind)) order.push(s.kind);
  for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);

  const wanted = Math.min(Math.max(sample?.cta_count ?? DEFAULT_CTA_COUNT, 2), CTA_PRIORITY.length);
  const withCta = new Set(CTA_PRIORITY.slice(0, wanted));
  return order.map((kind) => ({ kind, cta: withCta.has(kind) }));
}

/** What the sample does that this page will not, and why. */
export function skippedMechanics(sample?: SampleStructure | null): string[] {
  const seen = new Set<UnavailableMechanic>();
  for (const s of sample?.sections ?? []) for (const u of s.uses) seen.add(u);
  return UNAVAILABLE_MECHANICS.filter((m) => seen.has(m)).map((m) => MECHANIC_NOTES[m]);
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

export function paragraphs(s: string): string[] {
  return s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Every passage the published page must carry unchanged, labelled for the report. */
export function verbatimBlocks(copy: LandingCopy): { label: string; text: string }[] {
  const blocks: { label: string; text: string }[] = [
    { label: 'title', text: copy.title },
    { label: 'tagline (hook)', text: copy.hook },
  ];
  paragraphs(copy.blurb).forEach((text, i) => blocks.push({ label: `blurb paragraph ${i + 1}`, text }));
  copy.facts.forEach((f, i) => blocks.push({ label: `history fact ${i + 1}`, text: f.text }));
  paragraphs(copy.series?.description ?? '').forEach((text, i) => blocks.push({ label: `series description paragraph ${i + 1}`, text }));
  for (const v of copy.volumes) {
    if (v.title) blocks.push({ label: `book ${v.index} title`, text: v.title });
    blocks.push({ label: `${copy.series ? 'book' : 'volume'} ${v.index} hook`, text: v.hook });
  }
  blocks.push({ label: 'form lede', text: copy.form.lede });
  paragraphs(copy.bio).forEach((text, i) => blocks.push({ label: `author bio paragraph ${i + 1}`, text }));
  paragraphs(copy.backCover).forEach((text, i) => blocks.push({ label: `closing paragraph ${i + 1}`, text }));
  for (const img of copy.images) if (img.credit) blocks.push({ label: `credit for ${img.role} image`, text: img.credit });
  return blocks;
}

/** The copy itself must pass before it goes anywhere. */
export function validateCopy(copy: LandingCopy): ValidationResult {
  const findings: Finding[] = [];
  for (const b of verbatimBlocks(copy)) {
    for (const f of forbiddenClaims(b.text)) findings.push({ ...f, message: `${b.label}: ${f.message}` });
  }
  if (copy.facts.length < 3) {
    findings.push({ severity: 'error', code: 'too_few_facts', message: `${copy.facts.length} verified facts; need 3` });
  }
  if (!copy.images.some((i) => i.role === 'cover')) {
    findings.push({ severity: 'error', code: 'no_cover', message: 'no cover art for the hero' });
  }
  if (copy.seo.description.length > 160) {
    findings.push({ severity: 'warning', code: 'meta_description_long', message: `${copy.seo.description.length} chars > 160` });
  }
  return result(findings, { blocks: verbatimBlocks(copy).length, facts: copy.facts.length, images: copy.images.length });
}

function imageLines(img: PageImage | undefined): string[] {
  return img ? [`   Image: ${img.url}`, `   Alt text: ${img.alt}`] : [];
}

function verbatim(text: string): string {
  return `<<<VERBATIM\n${text}\nVERBATIM>>>`;
}

export const CTA_LABEL = 'Reserve your copy';

const numeral = (n: number) => ['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1] ?? String(n);

/**
 * "The Ossuary in three volumes", or for a series "The Ossuary series". Never "The The Ossuary":
 * most titles already start with "The".
 */
export function lineupHeading(copy: Pick<LandingCopy, 'title' | 'volumes'> & { series?: LandingCopy['series'] }): string {
  const n = copy.volumes.length;
  if (copy.series?.name) return /^the\s/i.test(copy.series.name) ? `${copy.series.name} series` : `The ${copy.series.name} series`;
  if (n < 2) return copy.title;
  return `${copy.title} in ${['two', 'three', 'four', 'five', 'six'][n - 2] ?? n} volumes`;
}

/** One section of the GHL prompt: its heading line, then its content. */
function promptSection(kind: SectionKind, copy: LandingCopy): { title: string; lines: string[] } {
  const cover = copy.images.find((i) => i.role === 'cover');
  const author = copy.images.find((i) => i.role === 'author');
  const references = copy.images.filter((i) => i.role === 'reference');
  switch (kind) {
    case 'hero':
      return {
        title: 'Hero',
        lines: [
          `   Heading (the book's title): ${copy.title}`,
          '   Tagline, under the heading:',
          verbatim(copy.hook),
          `   Byline: A novel by ${copy.author}`,
          ...imageLines(cover),
        ],
      };
    case 'story':
      return { title: 'The novel', lines: ['   Heading: The novel', verbatim(copy.blurb)] };
    case 'proof':
      return {
        title: 'The history beneath the novel',
        lines: [
          '   Heading: The history beneath the novel',
          '   Show each fact below as its own short item (a list or cards), in this order:',
          ...copy.facts.map((f) => verbatim(f.text)),
          ...references.flatMap((r) => [...imageLines(r), ...(r.credit ? ['   Credit, shown under the image:', verbatim(r.credit)] : [])]),
        ],
      };
    case 'lineup':
      return {
        title: lineupHeading(copy),
        lines: [
          `   Heading: ${lineupHeading(copy)}`,
          ...(copy.series?.description ? ['   Under the heading, the series description:', verbatim(copy.series.description)] : []),
          `   One card per ${copy.series ? 'book' : 'volume'}. Only the first has cover art${cover ? ` (${cover.url})` : ''}; show the`,
          '   others as text cards and do not create cover images for them.',
          ...copy.volumes.flatMap((v) => [
            copy.series ? `   Book ${numeral(v.index)}${v.title ? `: ${v.title}` : ''}` : `   Volume ${numeral(v.index)}:`,
            verbatim(v.hook),
          ]),
        ],
      };
    case 'offer':
      return {
        title: 'Pre-order form',
        lines: [
          `   Heading: ${copy.form.heading}`,
          verbatim(copy.form.lede),
          `   Form fields: ${copy.form.fields.join(', ')}`,
          `   Submit button: "${copy.form.button}"`,
          '   Give this section the anchor id "reserve"; every other button scrolls here.',
        ],
      };
    case 'author':
      return { title: 'About the author', lines: ['   Heading: About the author', ...imageLines(author), verbatim(copy.bio)] };
    case 'closing':
      return { title: 'Closing', lines: [verbatim(copy.backCover)] };
  }
}

/** The prompt pasted into GHL's Build with AI. */
export function buildGhlPrompt(
  copy: LandingCopy,
  plan: SectionPlan[] = planSections(),
  sampleUrl?: string | null,
): string {
  const s: string[] = [
    `Build a one-page sales landing page for ${copy.title.toUpperCase()}, a novel by ${copy.author}.`,
    "The page's one job: get readers to pre-order by filling in the form on this page.",
    '',
    'Audience: readers of literary and historical fiction who have never heard of the book or the',
    'author.',
    '',
    'Style: literary, grave and unhurried. Take the palette from the cover art. Serif headings,',
    'generous white space, mobile first. No exclamation marks.',
  ];
  if (sampleUrl) {
    s.push('', `Layout reference: ${sampleUrl}`, 'Follow its section rhythm and button placement. Take none of its words.');
  }
  s.push(
    '',
    'RULES FOR THE COPY (these matter more than anything else here):',
    '- Text between <<<VERBATIM and VERBATIM>>> goes on the page exactly as written: same words, same',
    '  order, every paragraph. Choose its font, size and layout freely. Do not shorten, paraphrase,',
    '  merge or "improve" it. Leave out the VERBATIM markers themselves.',
    '- Use the headings and button labels given. Do not write any other sentence that states a fact',
    '  about the book, the author or history.',
    '- Do not add reviews, testimonials, star ratings, "bestseller", awards, prices, discounts, a',
    '  guarantee, a countdown, or "limited time". None of these exist.',
    '- Use only the images listed. Do not add stock photos or generate pictures of people.',
    '',
    'SECTIONS, in this order:',
  );
  plan.forEach((p, i) => {
    const section = promptSection(p.kind, copy);
    s.push('', `${i + 1}. ${section.title}`, ...section.lines);
    if (p.cta) s.push(`   Button: "${CTA_LABEL}" (scrolls to the form)`);
  });
  s.push('', `${plan.length + 1}. Footer: ${copy.author}`);
  s.push(
    '',
    'SEO:',
    `   Page title: ${copy.seo.title}`,
    `   Meta description: ${copy.seo.description}`,
    `   Keywords: ${copy.seo.keywords.join(', ')}`,
  );
  return s.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Preview, and the check against what GHL published
// ---------------------------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paras(s: string): string {
  return paragraphs(s).map((p) => `<p>${esc(p)}</p>`).join('\n');
}

/**
 * The page as intended. It is what the GHL build is compared with by eye, and it can be pasted
 * into GHL's Custom HTML element unchanged if Build with AI will not keep the copy.
 */
/** Set when the page is served publicly rather than shown as a preview. */
export interface PublicPageOptions {
  /** Where the form posts. Without it the form is inert, as in the preview. */
  formAction: string;
  /** The page's own address, for the canonical link and the share card. */
  canonicalUrl: string;
  /** Shown above the form after a reservation. */
  notice?: string;
}

/** The form field each label posts as. Anything else is not a field the server reads. */
const FIELD_NAMES: Record<string, { name: string; type: string; required: boolean }> = {
  'First name': { name: 'first_name', type: 'text', required: false },
  Email: { name: 'email', type: 'email', required: true },
};

/** "The Ossuary" -> "the-ossuary". The public address of a book's page. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'book';
}

/** One CSV cell, RFC 4180, and a leading = + - @ is quoted with a ' so a spreadsheet does not run it. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function formHtml(copy: LandingCopy, pub?: PublicPageOptions): string {
  const fields = copy.form.fields.map((label) => {
    const f = FIELD_NAMES[label] ?? { name: slugify(label).replace(/-/g, '_'), type: 'text', required: false };
    return `<input name="${f.name}" type="${f.type}" placeholder="${esc(label)}" aria-label="${esc(label)}"${f.required ? ' required' : ''} maxlength="${f.type === 'email' ? 320 : 100}">`;
  });
  if (!pub) {
    return `<form onsubmit="return false">
    ${fields.join('\n    ')}
    <button type="submit">${esc(copy.form.button)}</button>
  </form>`;
  }
  // The hidden "website" field is for bots: a person never sees it, so a value in it means the
  // submission is discarded.
  return `${pub.notice ? `<p class="notice" role="status">${esc(pub.notice)}</p>` : ''}
  <form method="post" action="${esc(pub.formAction)}">
    ${fields.join('\n    ')}
    <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">${esc(copy.form.button)}</button>
  </form>`;
}

export function renderPreviewHtml(copy: LandingCopy, plan: SectionPlan[] = planSections(), pub?: PublicPageOptions): string {
  const cover = copy.images.find((i) => i.role === 'cover');
  const author = copy.images.find((i) => i.role === 'author');
  const references = copy.images.filter((i) => i.role === 'reference');
  const cta = `<p class="cta"><a href="#reserve">${esc(CTA_LABEL)}</a></p>`;
  const body: Record<SectionKind, string> = {
    hero: `<section class="hero">
  <h1>${esc(copy.title)}</h1>
  <p class="tagline">${esc(copy.hook)}</p>
  <p class="byline">A novel by ${esc(copy.author)}</p>
  ${cover ? `<img src="${esc(cover.url)}" alt="${esc(cover.alt)}">` : ''}`,
    story: `<section>
  <h2>The novel</h2>
  ${paras(copy.blurb)}`,
    proof: `<section>
  <h2>The history beneath the novel</h2>
  <ul class="facts">
    ${copy.facts.map((f) => `<li>${esc(f.text)}</li>`).join('\n    ')}
  </ul>
  ${references
    .map((r) => `<figure><img src="${esc(r.url)}" alt="${esc(r.alt)}">${r.credit ? `<figcaption>${esc(r.credit)}</figcaption>` : ''}</figure>`)
    .join('\n  ')}`,
    lineup: `<section>
  <h2>${esc(lineupHeading(copy))}</h2>
  ${paragraphs(copy.series?.description ?? '').map((t) => `<p>${esc(t)}</p>`).join('\n  ')}
  <div class="volumes">
    ${copy.volumes
      .map(
        (v) =>
          `<div class="volume">${v.index === 1 && cover ? `<img src="${esc(cover.url)}" alt="${esc(cover.alt)}">` : ''}<h3>${
            copy.series ? `Book ${numeral(v.index)}${v.title ? `: ${esc(v.title)}` : ''}` : `Volume ${numeral(v.index)}`
          }</h3><p>${esc(v.hook)}</p></div>`,
      )
      .join('\n    ')}
  </div>`,
    offer: `<section id="reserve">
  <h2>${esc(copy.form.heading)}</h2>
  <p>${esc(copy.form.lede)}</p>
  ${formHtml(copy, pub)}`,
    author: `<section class="author">
  <h2>About the author</h2>
  ${author ? `<img src="${esc(author.url)}" alt="${esc(author.alt)}">` : ''}
  ${paras(copy.bio)}`,
    closing: `<section>
  ${paras(copy.backCover)}`,
  };
  const sections = plan.map((p) => `${body[p.kind]}\n  ${p.cta ? cta : ''}\n</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(copy.seo.title)}</title>
<meta name="description" content="${esc(copy.seo.description)}">
<meta name="keywords" content="${esc(copy.seo.keywords.join(', '))}">
${
  pub
    ? `<link rel="canonical" href="${esc(pub.canonicalUrl)}">
<meta property="og:type" content="book">
<meta property="og:title" content="${esc(copy.seo.title)}">
<meta property="og:description" content="${esc(copy.seo.description)}">
<meta property="og:url" content="${esc(pub.canonicalUrl)}">
${cover ? `<meta property="og:image" content="${esc(cover.url)}">\n<meta name="twitter:card" content="summary_large_image">` : ''}`
    : ''
}
<style>
  :root { --ink:#2b211b; --paper:#f6f0e6; --dusk:#8e2f1f; --river:#2f4a5e; --rule:#d9ccb8; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:18px/1.65 Georgia, 'Times New Roman', serif; }
  section { max-width:760px; margin:0 auto; padding:56px 16px; border-bottom:1px solid var(--rule); }
  h1, h2 { font-weight:normal; line-height:1.25; }
  h1 { font-size:clamp(40px, 8vw, 64px); margin:0 0 12px; letter-spacing:.01em; }
  h2 { font-size:28px; color:var(--river); }
  .hero { text-align:center; }
  .hero img { width:100%; max-width:340px; border-radius:2px; margin:24px 0; box-shadow:0 10px 30px rgba(43,33,27,.35); }
  .tagline { font-size:clamp(19px, 3vw, 24px); line-height:1.4; margin:0 auto 12px; max-width:620px; }
  .byline { font-style:italic; color:var(--river); }
  .cta a { display:inline-block; background:var(--dusk); color:#fff; text-decoration:none; padding:14px 28px; border-radius:3px; font-family:system-ui, sans-serif; font-size:16px; }
  .facts { list-style:none; padding:0; }
  .facts li { border-left:3px solid var(--dusk); padding:4px 0 4px 16px; margin:20px 0; }
  .volumes { display:grid; gap:16px; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); }
  .volume { border:1px solid var(--rule); padding:20px; background:#fffaf2; }
  .volume img { width:100%; margin-bottom:12px; }
  .volume h3 { margin:0 0 8px; font-weight:normal; color:var(--dusk); }
  form { display:grid; gap:12px; max-width:420px; }
  input { font:inherit; padding:10px; border:1px solid var(--rule); }
  button { font:16px system-ui, sans-serif; background:var(--dusk); color:#fff; border:0; padding:14px; }
  .author img { width:180px; height:180px; object-fit:cover; border-radius:50%; float:left; margin:0 24px 12px 0; }
  .author::after { content:''; display:block; clear:both; }
  .hp { position:absolute; left:-10000px; width:1px; height:1px; overflow:hidden; }
  .notice { background:#e7efe4; border-left:3px solid #4d7a45; padding:10px 14px; }
  figure { margin:24px 0; } figure img { max-width:100%; } figcaption { font-size:14px; color:var(--river); }
  footer { max-width:760px; margin:0 auto; padding:32px 16px; font-size:14px; }
</style>
</head>
<body>
${sections}
<footer>
  <p>${esc(copy.author)}</p>
</footer>
</body>
</html>
`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Below this much visible text the page was not read: wrong URL, or rendered in the browser. */
export const MIN_PAGE_TEXT = 500;

/** Compare the page GHL published with the copy it was given. */
export function checkPublishedPage(html: string, copy: LandingCopy): ValidationResult {
  const text = htmlToText(html);
  const page = normalize(text);
  const findings: Finding[] = [];
  if (text.length < MIN_PAGE_TEXT) {
    findings.push({
      severity: 'error',
      code: 'page_text_missing',
      message: `only ${text.length} characters of text in the HTML`,
      fix: 'check the URL is the published page; if GHL renders it in the browser, save the page from the browser and check the file',
    });
    return result(findings, { page_chars: text.length });
  }

  const blocks = verbatimBlocks(copy);
  let kept = 0;
  for (const b of blocks) {
    if (page.includes(normalize(b.text))) kept++;
    else {
      findings.push({
        severity: 'error',
        code: 'copy_changed',
        message: `${b.label} is missing or reworded: "${b.text.slice(0, 70)}${b.text.length > 70 ? '...' : ''}"`,
        fix: 'restore the stored wording in the GHL editor',
      });
    }
  }

  findings.push(...forbiddenClaims(text));

  const source = new Set(numbersIn([...blocks.map((b) => b.text), copy.title, copy.author, copy.form.heading, copy.form.button].join(' ')));
  for (const n of new Set(numbersIn(text))) {
    if (!source.has(n)) {
      findings.push({
        severity: 'warning',
        code: 'number_not_in_source',
        message: `the page says "${n}", which is not in the copy it was given`,
        fix: 'a footer year is harmless; any other number was invented by the builder',
      });
    }
  }

  for (const img of copy.images) {
    const file = img.url.split('/').pop() ?? img.url;
    if (!html.includes(img.url) && !html.includes(file)) {
      findings.push({
        severity: 'warning',
        code: 'image_not_found',
        message: `the ${img.role} image is not referenced by its URL`,
        fix: 'GHL may have copied it to its own media library; confirm by eye that it is the right picture',
      });
    }
  }

  return result(findings, { verbatim_blocks: `${kept}/${blocks.length}`, page_chars: text.length });
}
