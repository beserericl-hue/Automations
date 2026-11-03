/**
 * The copy assistant: "Draft with AI" and "Revise with AI" for every field an author writes by hand
 * before a book is released — the listing copy, the inside flap, the front and back matter, the
 * series description, the bio, the announcement email.
 *
 * WHAT IT IS NOT. It never saves. A draft goes back to the screen, into the field, where the author
 * reads it, edits it and saves it with the same button as before (or undoes it). Nothing written here
 * can overwrite text the author already has.
 *
 * WHERE THE WORDS COME FROM. The book's own material only: title, genre, premise, themes, the chapter
 * plan, the story bible, an excerpt of the opening, the series, the copy already saved, and the author
 * profile. The same rule as the bio and the blog (a prompt instruction is not a guarantee), so every
 * draft is MEASURED after it comes back:
 *
 *   - length: each platform's limit (KDP description 4,000 characters; 7 keywords of 50; ...). An
 *     over-limit draft gets one corrective pass; if it is still over, the screen says so in red.
 *   - claims: reviews, quotes, awards, "bestselling", ratings, sales figures. None of them can be true
 *     of an unpublished book, so a draft containing one gets one corrective pass naming the phrase;
 *     anything that survives is reported as a warning above the draft. A claim the author's own
 *     profile makes (a real award in their credentials) is allowed in the bio.
 *   - names: a capitalised name in the draft that appears nowhere in the book's material is reported
 *     ("check: Halvorsen is not in the book"). Not rewritten — it may be a real place — but never
 *     silent.
 *   - an epigraph must be a line copied verbatim from the excerpts it was shown.
 *   - a bio uses a pronoun only if the profile gives one.
 *
 * Missing facts (who to thank, the author's town) become [placeholders] for the author to fill, never
 * invented. Server-side, through the same structured-output call (`parseWith`) the landing page and
 * the review tools use, so every call is recorded in token_usage_v2 under `copy-assist.<field>`.
 */

import { z } from 'zod';
import type { CallContext } from './claude-structured.js';

// ------------------------------------------------------------------------------------------------
// The fields
// ------------------------------------------------------------------------------------------------

/** Where a field is saved — by the author, through the route that already saves it. */
export type FieldStore = 'marketing' | 'matter' | 'series' | 'copy' | 'bio' | 'email';

export interface FieldSpec {
  label: string;
  store: FieldStore;
  kind: 'text' | 'list';
  /** Text: the whole field. List: each item. */
  maxChars: number;
  /** List fields only. */
  maxItems?: number;
  /** What the field is for, and what good looks like. Goes straight into the prompt. */
  purpose: string;
  /** Part of "Draft all missing" (the promotion package). */
  packageField?: boolean;
  /** Check names against the book (off for fields that legitimately name other books or Amazon). */
  checkNames?: boolean;
  /** No LLM: filled from the author's own records. Free. */
  deterministic?: boolean;
}

export const FIELD_SPECS = {
  blurb: {
    label: 'Description',
    store: 'marketing',
    kind: 'text',
    maxChars: 4000,
    packageField: true,
    checkNames: true,
    purpose:
      'The Amazon book description a buyer reads on the product page. 150 to 300 words: open on the protagonist and the problem, raise the stakes, end on the question the book answers, without giving the answer. Short paragraphs separated by blank lines. Plain text, no HTML.',
  },
  back_cover: {
    label: 'Back cover',
    store: 'marketing',
    kind: 'text',
    maxChars: 1000,
    packageField: true,
    checkNames: true,
    purpose:
      'The copy printed on the back cover of the paperback. Shorter and harder than the description, 80 to 140 words, read standing up in a shop.',
  },
  hook: {
    label: 'Hook',
    store: 'marketing',
    kind: 'text',
    maxChars: 200,
    packageField: true,
    checkNames: true,
    purpose: 'One sentence that sells the book: the tagline used on ads, social posts and the landing page.',
  },
  keywords: {
    label: 'Keywords',
    store: 'marketing',
    kind: 'list',
    maxChars: 50,
    maxItems: 7,
    packageField: true,
    purpose:
      'Exactly seven KDP keyword phrases, the words a reader who would love this book types into Amazon search: subgenre, setting, period, tropes, themes. Do not repeat words from the title. No author names or other books\' titles.',
  },
  categories: {
    label: 'Categories',
    store: 'marketing',
    kind: 'list',
    maxChars: 150,
    maxItems: 3,
    packageField: true,
    purpose:
      'Up to three Amazon book categories as Amazon words them, as a path, e.g. "Fiction > Science Fiction > Post-Apocalyptic". The most specific category that honestly fits.',
  },
  comparable_titles: {
    label: 'Comparable titles',
    store: 'marketing',
    kind: 'list',
    maxChars: 200,
    maxItems: 6,
    packageField: true,
    purpose:
      'Three to six well-known published books whose readers would enjoy this one, for choosing categories and ads. Each item is exactly "Title by Author" and nothing else. Only books you are certain exist, with the correct author; never invent a title.',
  },
  subtitle: {
    label: 'Subtitle',
    store: 'copy',
    kind: 'text',
    maxChars: 120,
    packageField: true,
    checkNames: true,
    purpose:
      'An optional subtitle for the title page and the KDP listing (for fiction, often "A Novel" or a short genre line). Title plus subtitle must stay under 200 characters. No keyword stuffing: KDP rejects subtitles that are lists of keywords.',
  },
  inside_flap: {
    label: 'Inside flap',
    store: 'copy',
    kind: 'text',
    maxChars: 1800,
    packageField: true,
    checkNames: true,
    purpose:
      'The inside front flap of a hardcover dust jacket: 200 to 300 words, fuller than the back cover, setting up the world, the protagonist and what is at stake, ending on an invitation to read. Plain text, short paragraphs.',
  },
  series_description: {
    label: 'Series description',
    store: 'series',
    kind: 'text',
    maxChars: 3000,
    checkNames: true,
    purpose:
      'The description of the whole series for the series page: what the series is about across all its books, with Book 1 as the way in. 120 to 250 words. Name only people and places the books\' own copy names.',
  },
  series_tagline: {
    label: 'Series tagline',
    store: 'series',
    kind: 'text',
    maxChars: 200,
    checkNames: true,
    purpose: 'One line that sells the whole series.',
  },
  dedication: {
    label: 'Dedication',
    store: 'matter',
    kind: 'text',
    maxChars: 300,
    purpose:
      'A short dedication for the front of the book, one or two lines. You do not know who the author wants to dedicate it to: use a [placeholder] for the person ("For [name]"), optionally with a line that echoes the book\'s themes.',
  },
  epigraph: {
    label: 'Epigraph',
    store: 'matter',
    kind: 'text',
    maxChars: 400,
    purpose:
      'An epigraph: one or two sentences COPIED WORD FOR WORD from the excerpts of this book in <book>, chosen because they capture the book\'s theme. Put who says it (the character, or the book\'s title if it is narration) in "attribution". Never quote a real person or another book.',
  },
  authors_note: {
    label: "Author's note",
    store: 'matter',
    kind: 'text',
    maxChars: 6000,
    checkNames: true,
    purpose:
      "The author's note at the back of the book, in the author's first person, 250 to 500 words: what in the book is drawn from the historical or scientific record and what is invented. State a real-world fact only if the research notes in <book> state it; otherwise write a [placeholder: what to check]. Do not cite sources that are not in the research notes.",
  },
  acknowledgements: {
    label: 'Acknowledgements',
    store: 'matter',
    kind: 'text',
    maxChars: 3000,
    purpose:
      'Acknowledgements, in the author\'s first person, 80 to 200 words. You do not know anyone the author wants to thank: use [placeholders] for every person and organisation ("[editor\'s name]", "[early readers]"). Never invent a name.',
  },
  why_this_book: {
    label: 'Why this book',
    store: 'matter',
    kind: 'text',
    maxChars: 1500,
    purpose:
      "Two to four sentences in the author's first person on what drew them to write this book, used by the bio. Use only what the author profile says about them; where it is silent, write a [placeholder] instead of inventing a motive or a life event.",
  },
  author_bio: {
    label: 'About the author',
    store: 'bio',
    kind: 'text',
    maxChars: 1500,
    purpose:
      'The about-the-author paragraph for the back of the book and Author Central, in the third person, 60 to 150 words. Use ONLY the facts in <author>. Where a bio would usually say something the profile does not give (where they live, their background), write a [placeholder] instead of inventing it. Refer to the author by name; use a pronoun only if the profile gives pronouns.',
  },
  also_by: {
    label: 'Also by',
    store: 'copy',
    kind: 'list',
    maxChars: 200,
    maxItems: 20,
    deterministic: true,
    purpose: "The author's other books, one per line, for the Also-by page.",
  },
  announcement_subject: {
    label: 'Email subject',
    store: 'email',
    kind: 'text',
    maxChars: 120,
    checkNames: true,
    purpose:
      'The subject line of an email to readers who reserved a copy of the book on its landing page. Specific, not clickbait. Say the book is out or available only if <landing> gives a place to buy it; otherwise it is an update.',
  },
  announcement_body: {
    label: 'Email',
    store: 'email',
    kind: 'text',
    maxChars: 3000,
    checkNames: true,
    purpose:
      'The body of that email, in the author\'s first person, 100 to 220 words, plain text with short paragraphs. Thank them for reserving, say what the book is in two sentences, and give the next step. Say the book is out or available only if <landing> gives a place to buy it (then link it). Do not write a greeting line (the email adds "Hi <first name>,") or a sign-off with the name (it adds the author\'s name). Do not invent a release date, price or offer: use a [placeholder] for any of these.',
  },
} as const satisfies Record<string, FieldSpec>;

export type FieldKey = keyof typeof FIELD_SPECS;
export const FIELD_KEYS = Object.keys(FIELD_SPECS) as FieldKey[];
export const PACKAGE_FIELDS = FIELD_KEYS.filter((k) => (FIELD_SPECS[k] as FieldSpec).packageField);

export function specOf(field: FieldKey): FieldSpec {
  return FIELD_SPECS[field] as FieldSpec;
}

/** The limit for this book: the subtitle shares 200 characters with the title. */
export function limitOf(field: FieldKey, title: string): number {
  const spec = specOf(field);
  if (field === 'subtitle') return Math.max(10, Math.min(spec.maxChars, 199 - title.trim().length));
  return spec.maxChars;
}

// ------------------------------------------------------------------------------------------------
// The book's material
// ------------------------------------------------------------------------------------------------

export interface AuthorFacts {
  pen_name: string;
  pronouns: string;
  lives: string;
  background: string;
  credentials: string[];
  prior_work: string[];
  why_this_book: string;
  personal: string;
  links: string[];
}

export interface BookFacts {
  title: string;
  genre: string;
  premise: string;
  themes: string[];
  /** The chapters of THIS book (a series book's own range), in order. */
  chapters: { number: number; title: string; beat: string }[];
  /** Cast and world from the story bible and the outline. */
  bible: { type: string; name: string; description: string }[];
  /** Passages copied from the manuscript (the opening, and a few more for an epigraph). */
  excerpts: { chapter: number; text: string }[];
  /** The copy already saved for this book, for consistency (and for "revise"). */
  saved: Record<string, string>;
  series: { name: string; index: number; total: number; bookTitle: string; books: { index: number; title: string; hook: string; blurb: string }[] } | null;
  author: AuthorFacts;
  /** Research notes: topic + an opening slice of each report. */
  research: { topic: string; excerpt: string }[];
  /** Landing page state, for the announcement email. */
  landing?: { url: string; buyUrl: string; buyLabel: string } | null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** The book as the model sees it. One string so it can be cached across the fields of one run. */
export function renderBook(f: BookFacts): string {
  const lines: string[] = ['<book>', `Title: ${f.title}`];
  if (f.genre) lines.push(`Genre: ${f.genre}`);
  if (f.premise) lines.push(`Premise: ${f.premise}`);
  if (f.themes.length) lines.push(`Themes: ${f.themes.join('; ')}`);
  if (f.series) {
    lines.push(
      `This is book ${f.series.index} of ${f.series.total} in the series "${f.series.name}"${f.series.bookTitle ? `, titled "${f.series.bookTitle}"` : ''}.`,
    );
    for (const b of f.series.books) {
      lines.push(`  Book ${b.index}${b.title ? `: ${b.title}` : ''}${b.hook ? ` — ${b.hook}` : ''}`);
      if (b.blurb) lines.push(`    ${clip(b.blurb, 900)}`);
    }
  }
  if (f.chapters.length) {
    const lateFrom = Math.floor(f.chapters.length * 0.67);
    lines.push('', 'Chapter plan (chapters marked LATE are for context only: never reveal them):');
    f.chapters.forEach((c, i) => {
      lines.push(`  ${i >= lateFrom ? 'LATE ' : ''}Ch ${c.number} "${c.title}": ${clip(c.beat, 320)}`);
    });
  }
  if (f.bible.length) {
    lines.push('', 'Story bible:');
    for (const e of f.bible) lines.push(`  [${e.type}] ${e.name}: ${clip(e.description, 260)}`);
  }
  if (f.excerpts.length) {
    lines.push('', 'Excerpts from the manuscript (verbatim):');
    for (const e of f.excerpts) lines.push(`<excerpt chapter="${e.chapter}">`, e.text, '</excerpt>');
  }
  const saved = Object.entries(f.saved).filter(([, v]) => v.trim());
  if (saved.length) {
    lines.push('', 'Copy the author has already saved for this book:');
    for (const [k, v] of saved) lines.push(`  ${k}: ${clip(v, 1500)}`);
  }
  if (f.research.length) {
    lines.push('', 'Research notes (the only real-world facts you may state):');
    for (const r of f.research) lines.push(`<research topic="${r.topic.replace(/"/g, "'")}">`, r.excerpt, '</research>');
  }
  lines.push('</book>', '', renderAuthor(f.author));
  if (f.landing) {
    lines.push('', `<landing>Book page: ${f.landing.url}${f.landing.buyUrl ? `\nWhere to buy: ${f.landing.buyLabel} ${f.landing.buyUrl}` : '\nNot on sale yet.'}</landing>`);
  }
  return lines.join('\n');
}

function renderAuthor(a: AuthorFacts): string {
  const facts: string[] = [];
  const add = (label: string, v: string | string[]) => {
    const s = Array.isArray(v) ? v.filter(Boolean).join('; ') : v.trim();
    if (s) facts.push(`${label}: ${s}`);
  };
  add('Name', a.pen_name);
  add('Pronouns', a.pronouns);
  add('Lives', a.lives);
  add('Background', a.background);
  add('Credentials', a.credentials);
  add('Prior work', a.prior_work);
  add('Why this book', a.why_this_book);
  add('Personal', a.personal);
  return ['<author>', ...(facts.length ? facts : ['(the profile is empty)']), '</author>'].join('\n');
}

// ------------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------------

/**
 * Claims that cannot be true of an unpublished book, or that only the author can make. Each is a
 * phrase a model reaches for in marketing copy.
 */
const CLAIM_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\bbest[- ]?sell(?:ing|ers?)\b|(?:^|\s)#\s?1\b|\bnumber[- ]one (?:bestseller|book|hit|novel)/i, what: 'a bestseller claim' },
  { re: /\baward[- ]winning\b|\bwinner of\b|\bprize[- ]winning\b|\bshortlisted\b|\blonglisted\b/i, what: 'an award claim' },
  { re: /\b(?:critically[- ])?acclaimed\b|\bpraised by\b|\brave reviews?\b|\breviewers? (?:call|say|hail)/i, what: 'a review claim' },
  { re: /\b(?:five|5|four|4)[- ]stars?\b|★/i, what: 'a rating' },
  { re: /\b\d[\d,.]*\s*(?:k|thousand|million)?\s*(?:copies|readers|downloads)\b/i, what: 'a sales or readership figure' },
  { re: /\bmillions of readers\b|\bbeloved by\b|\bfans of the (?:hit|bestselling)\b/i, what: 'a readership claim' },
  { re: /[“"][^”"]{6,200}[”"]\s*(?:—|–|-)\s*[A-Z][\w.' ]{2,60}/, what: 'an attributed quote (a review or endorsement)' },
];

/** Claims in `text`, except those the allowed material itself makes (a real award in a profile). */
export function claimProblems(text: string, allowed = ''): string[] {
  const out: string[] = [];
  for (const { re, what } of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (allowed && allowed.toLowerCase().includes(m[0].toLowerCase().replace(/[“”"]/g, '').slice(0, 40))) continue;
    out.push(`${what} ("${m[0].trim().slice(0, 80)}")`);
  }
  return out;
}

export interface Draft {
  value: string;
  items: string[];
  attribution: string;
}

/** Length problems, in the words the author would use. Empty when it fits. */
export function lengthProblems(field: FieldKey, d: Draft, limit: number): string[] {
  const spec = specOf(field);
  if (spec.kind === 'list') {
    const out: string[] = [];
    if (spec.maxItems && d.items.length > spec.maxItems) out.push(`${d.items.length} items; the limit is ${spec.maxItems}`);
    for (const it of d.items) {
      if (it.length > spec.maxChars) out.push(`"${it.slice(0, 60)}" is ${it.length} characters; each may be at most ${spec.maxChars}`);
    }
    return out;
  }
  return d.value.length > limit ? [`${d.value.length.toLocaleString('en-US')} characters; the limit is ${limit.toLocaleString('en-US')}`] : [];
}

const norm = (s: string): string =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** An epigraph must be a passage of the book, copied exactly. */
export function isVerbatim(passage: string, sources: string[]): boolean {
  const p = norm(passage).replace(/^["']|["']$/g, '');
  if (p.length < 12) return false;
  return sources.some((s) => norm(s).includes(p));
}

/** Words that start with a capital but are not names. Kept short: a miss only costs a warning. */
const COMMON = new Set(
  'The A An And But Or If When Where What Who Why How In On At To For From With Without By Of As Is It Its This That These Those There Their They He She His Her Him We Our You Your I My Me One Two Three Four Five Six Seven Eight Nine Ten First Second Third Last Book Books Series Chapter Part Volume Read Now Then Only Every Each Some All No Not Now Yet Still Even Before After Until While During Inside Outside Above Below Between Behind Beyond Across Through Into Under Over Thank Thanks Dear Hi Hello Yours Love For Join Get Find Discover Meet Fiction Novel Kindle Amazon English January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday God Lord Sir Lady Mr Mrs Ms Dr Miss Captain King Queen Prince Princess Professor Doctor Inspector Detective Sergeant Officer Constable Father Mother Aunt Uncle Brother Sister Saint'.split(
    ' ',
  ),
);

/**
 * Capitalised words in the draft that are not anywhere in the book's material — possible invented
 * names. Placeholders ([like this]) are ignored; so is the first word of a sentence.
 */
export function unknownNames(text: string, material: string): string[] {
  const hay = material.toLowerCase();
  const stripped = text.replace(/\[[^\]]*\]/g, ' ');
  const found = new Set<string>();
  // A capitalised word that does not open a sentence: preceded by a word character and a space.
  const re = /(?<=[^.!?:\n"“\s]\s+)([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const word = m[1];
    if (COMMON.has(word) || word.length < 3) continue;
    if (hay.includes(word.toLowerCase())) continue;
    found.add(word);
  }
  return [...found].slice(0, 8);
}

const PRONOUN_RE = /\b(he|she|him|his|her|hers|himself|herself)\b/i;

// ------------------------------------------------------------------------------------------------
// The prompt
// ------------------------------------------------------------------------------------------------

export const DraftOutput = z.object({
  /** Text fields: the text. List fields: empty. */
  value: z.string(),
  /** List fields: the items. Text fields: empty. */
  items: z.array(z.string()),
  /** Epigraph only: who says it. Otherwise empty. */
  attribution: z.string(),
});

export interface AssistRequest {
  field: FieldKey;
  mode: 'draft' | 'revise';
  /** Revise: what to change, in the author's words. */
  instruction?: string;
  /** Revise: the text in the field now (a list as one item per line). */
  current?: string;
}

const HONESTY = [
  'Rules, every one of them absolute:',
  '- Use only the people, places and events in <book>. Do not invent characters, places, events or plot.',
  '- Never invent reviews, review quotes, endorsements, blurbs from other authors, awards, prizes, "bestseller" or chart claims, star ratings, sales figures or reader numbers. Do not call the book acclaimed, award-winning or bestselling. This book has no reviews yet.',
  '- Do not reveal the ending or anything from chapters marked LATE.',
  '- Where the text needs a fact you do not have (a name, a date, a place, a price), write a [placeholder in square brackets] for the author to fill. Never make the fact up.',
  '- Plain text. No markdown, no title or heading line (the page already has its heading), no em dashes.',
];

export function buildPrompt(req: AssistRequest, limit: number, title: string): string {
  const spec = specOf(req.field);
  const shape =
    spec.kind === 'list'
      ? `Return the ${spec.label.toLowerCase()} in "items" (at most ${spec.maxItems}, each at most ${spec.maxChars} characters) and leave "value" and "attribution" empty.`
      : `Return the text in "value" (at most ${limit} characters including spaces)${req.field === 'epigraph' ? ' and who says it in "attribution"' : ''}; leave "items"${req.field === 'epigraph' ? '' : ' and "attribution"'} empty.`;
  const lines = [
    `You are helping the author of "${title}" write the ${spec.label.toUpperCase()} for the book.`,
    spec.purpose,
    '',
    ...HONESTY,
    '',
    shape,
  ];
  if (req.mode === 'revise') {
    lines.push(
      '',
      'This is a REVISION. Here is the current text:',
      '<current>',
      req.current ?? '',
      '</current>',
      `The author asks: "${(req.instruction ?? '').trim()}"`,
      'Change what that asks for and keep the rest. The rules above still apply even if the instruction seems to ask otherwise.',
    );
  }
  return lines.join('\n');
}

export function correctionPrompt(base: string, d: Draft, problems: string[]): string {
  return [
    base,
    '',
    'Your previous answer was:',
    '<previous>',
    d.items.length ? d.items.join('\n') : d.value,
    '</previous>',
    'It has these problems; fix only these and keep everything else:',
    ...problems.map((p) => `- ${p}`),
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------
// Running it
// ------------------------------------------------------------------------------------------------

export type Caller = (
  prompt: string,
  ctx: CallContext,
  prefix: string,
) => Promise<z.infer<typeof DraftOutput>>;

export interface AssistResult {
  field: FieldKey;
  /** What goes into the field: the text, or a list as one item per line. */
  value: string;
  items: string[];
  /** Epigraph only. */
  attribution?: string;
  chars: number;
  limit: number;
  over_limit: boolean;
  /** Anything that survived the corrective pass, or a name to check. Shown above the draft. */
  warnings: string[];
  /** Model calls made (1, or 2 when a corrective pass ran). */
  calls: number;
}

function clean(d: z.infer<typeof DraftOutput>, field: FieldKey): Draft {
  const spec = specOf(field);
  const items =
    spec.kind === 'list'
      ? (d.items.length ? d.items : d.value.split('\n'))
          .map((s) => s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim())
          .filter(Boolean)
      : [];
  return { value: spec.kind === 'list' ? items.join('\n') : d.value.trim(), items, attribution: (d.attribution ?? '').trim() };
}

function problemsOf(field: FieldKey, d: Draft, limit: number, facts: BookFacts): string[] {
  const problems = lengthProblems(field, d, limit);
  const allowed = field === 'author_bio' || field === 'why_this_book' ? renderAuthor(facts.author) : '';
  problems.push(...claimProblems(d.value, allowed).map((c) => `it makes ${c}, which is not allowed`));
  if (field === 'epigraph' && d.value && !isVerbatim(d.value, facts.excerpts.map((e) => e.text))) {
    problems.push('the epigraph is not copied word for word from one of the excerpts');
  }
  if ((field === 'author_bio') && !facts.author.pronouns.trim()) {
    const m = PRONOUN_RE.exec(d.value);
    if (m) problems.push(`it calls the author "${m[1]}", but the profile gives no pronouns: use the author's name instead`);
  }
  return problems;
}

/**
 * Draft or revise one field. Never saves. `call` is the model (parseWith in production); `material`
 * is the rendered book, sent as a cached prefix.
 */
export async function runAssist(
  req: AssistRequest,
  facts: BookFacts,
  ctx: Omit<CallContext, 'operation'>,
  call: Caller,
): Promise<AssistResult> {
  const field = req.field;
  const limit = limitOf(field, facts.title);
  const material = renderBook(facts);
  const base = buildPrompt(req, limit, facts.series?.bookTitle || facts.title);
  const operation = `copy-assist.${field}${req.mode === 'revise' ? '.revise' : ''}`;

  let d = clean(await call(base, { ...ctx, operation }, material), field);
  let calls = 1;
  let problems = problemsOf(field, d, limit, facts);
  if (problems.length) {
    d = clean(await call(correctionPrompt(base, d, problems), { ...ctx, operation: `${operation}.correct` }, material), field);
    calls += 1;
    problems = problemsOf(field, d, limit, facts);
  }

  const warnings = [...problems];
  if (specOf(field).checkNames) {
    const names = unknownNames(d.value, `${material}\n${req.current ?? ''}`);
    if (names.length) warnings.push(`not in the book's material, check them: ${names.join(', ')}`);
  }
  if (/\[[^\]]+\]/.test(d.value)) warnings.push('has [placeholders] for you to fill in before saving');
  if (!d.value.trim()) warnings.push('came back empty');

  const over = lengthProblems(field, d, limit).length > 0;
  return {
    field,
    value: d.value,
    items: d.items,
    ...(field === 'epigraph' ? { attribution: d.attribution } : {}),
    // A list's count is its longest item, against the per-item limit.
    chars: specOf(field).kind === 'list' ? Math.max(0, ...d.items.map((i) => i.length)) : d.value.length,
    limit,
    over_limit: over,
    warnings,
    calls,
  };
}
