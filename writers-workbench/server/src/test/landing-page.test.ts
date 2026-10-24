/**
 * The landing-page script.
 *
 * What matters is that nothing reaches the page that the project does not hold: a fact must quote
 * its report, a number must be in the quote, the claims this book cannot make are refused wherever
 * they come from, and the page GHL publishes is checked against the copy it was given.
 */

import { describe, it, expect } from 'vitest';
import {
  buildGhlPrompt,
  checkPublishedPage,
  creditFor,
  csvCell,
  forbiddenClaims,
  isFetchableUrl,
  normalize,
  planSections,
  rankResearch,
  renderPreviewHtml,
  researchTerms,
  selectFacts,
  skippedMechanics,
  slugify,
  stripTracking,
  validateCopy,
  verbatimBlocks,
  verifyFact,
  type LandingCopy,
  type ResearchReport,
  type SampleStructure,
} from '../lib/landing-page.js';

const REPORT: ResearchReport = {
  id: 'r1',
  topic: 'The Ossuary — Chapter 3 research',
  content:
    'The Accokeek Creek Site (18PR8) lies on the east bank of the Potomac. Alice and Henry Ferguson ' +
    'excavated it between 1935 and 1940, recording 148 hearths and four ossuaries. Maryland recognized ' +
    'the Piscataway Indian Nation on January 9, 2012.',
};
const REPORTS = new Map([[REPORT.id, REPORT]]);

const FACT = {
  text: 'Alice and Henry Ferguson excavated the Accokeek Creek Site between 1935 and 1940.',
  quote: 'Alice and Henry Ferguson excavated it between 1935 and 1940, recording 148 hearths and four ossuaries.',
  report_id: 'r1',
};

function copy(over: Partial<LandingCopy> = {}): LandingCopy {
  return {
    title: 'The Ossuary',
    author: 'Eric L Beser',
    hook: 'A thousand people in four boxes. Twenty-six names.',
    blurb: 'Who speaks for the dead when no one wrote their names down?\n\nSylvia Runningwater arrives at a Maryland bluff before dawn.',
    backCover: 'Four ossuaries. More than a thousand individuals. No names.',
    volumes: [
      { index: 1, hook: 'A thousand people in four boxes. Twenty-six names.' },
      { index: 2, hook: 'The colony made her a criminal for burying her dead.' },
    ],
    bio: 'Eric Beser holds an MSW from the University of Maryland and lives in Owings Mills, Maryland.',
    facts: [
      FACT,
      { text: 'The Accokeek Creek Site lies on the east bank of the Potomac.', quote: 'The Accokeek Creek Site (18PR8) lies on the east bank of the Potomac.', report_id: 'r1' },
      { text: 'Maryland recognized the Piscataway Indian Nation on January 9, 2012.', quote: 'Maryland recognized the Piscataway Indian Nation on January 9, 2012.', report_id: 'r1' },
    ],
    images: [
      { role: 'cover', url: 'https://x.supabase.co/storage/v1/object/public/cover-images/u/cover.png', alt: 'Cover art' },
      { role: 'author', url: 'https://x.supabase.co/storage/v1/object/public/cover-images/u/author/headshot-1.png', alt: 'Eric L Beser' },
    ],
    form: { heading: 'Reserve your copy', lede: 'Leave your name and email to reserve your copy.', button: 'Reserve my copy', fields: ['First name', 'Email'] },
    seo: { title: 'The Ossuary: a novel by Eric L Beser', description: 'A thousand people in four boxes.', keywords: ['NAGPRA fiction'] },
    ...over,
  };
}

describe('normalize', () => {
  it('ignores case, curly quotes, dash style and spacing', () => {
    expect(normalize('Who speaks — for the “dead”?')).toBe(normalize('who speaks-for the "dead"?'));
    expect(normalize("Marcus’s  grandmother")).toBe("marcus's grandmother");
  });
});

describe('the sample URL', () => {
  it('loses its ad tracking, keeping the page', () => {
    const tracked =
      'https://offer.michaelreit.com/?utm_source=ig&utm_medium=paid&utm_campaign=GM&utm_term=US&utm_content=x' +
      '&fbadid=120250476050100505&campaign_id=120246014381610505&ad_id=120250476050100505&utm_id=120246014381610505';
    expect(stripTracking(tracked)).toBe('https://offer.michaelreit.com/');
    expect(stripTracking('https://a.com/p?page=2&utm_source=x#top')).toBe('https://a.com/p?page=2');
  });

  it('is refused unless it is a public web page', () => {
    expect(isFetchableUrl('https://offer.michaelreit.com/')).toBe(true);
    for (const bad of ['http://localhost:3000/', 'http://127.0.0.1/', 'file:///etc/passwd', 'https://[::1]/', 'http://redis.internal/', 'not a url']) {
      expect(isFetchableUrl(bad), bad).toBe(false);
    }
  });
});

describe('a history fact', () => {
  it('passes when it quotes its report exactly', () => {
    expect(verifyFact(FACT, REPORTS)).toEqual([]);
  });

  it('fails when the quote is not in the report', () => {
    const codes = verifyFact({ ...FACT, quote: 'The Fergusons excavated the site over five long summers in the 1930s.' }, REPORTS).map((f) => f.code);
    expect(codes).toContain('quote_not_in_report');
  });

  it('fails when it states a number its quote does not', () => {
    const f = verifyFact({ ...FACT, text: 'The Fergusons dug up 1,453 individuals between 1935 and 1940.' }, REPORTS);
    expect(f.map((x) => x.code)).toEqual(['number_not_in_quote']);
    expect(f[0].message).toContain('1453');
  });

  it('fails when it names a report that does not exist', () => {
    expect(verifyFact({ ...FACT, report_id: 'nope' }, REPORTS).map((f) => f.code)).toEqual(['unknown_report']);
  });

  it('fails when it is too long for the page', () => {
    expect(verifyFact({ ...FACT, text: `${FACT.text} ${'a'.repeat(200)}` }, REPORTS).map((f) => f.code)).toContain('fact_too_long');
  });

  it('is sorted into kept and rejected, with the reasons', () => {
    const { kept, rejected } = selectFacts([FACT, { ...FACT, report_id: 'nope' }], REPORTS);
    expect(kept).toEqual([FACT]);
    expect(rejected[0].findings[0].code).toBe('unknown_report');
  });
});

describe('claims the page may not make', () => {
  it('catches the federal-recognition error the blog post made', () => {
    const line = 'The 1990 law requires federal recognition, which the Piscataway didn\'t get until 2012.';
    expect(forbiddenClaims(line).map((f) => f.code)).toEqual(['forbidden_federal_recognition_2012']);
    expect(forbiddenClaims('Maryland recognized the Piscataway on January 9, 2012.')).toEqual([]);
  });

  it('catches the invented debut, reviews, prices and urgency', () => {
    const codes = (s: string) => forbiddenClaims(s).map((f) => f.code);
    expect(codes('This is his debut novel.')).toEqual(['forbidden_debut']);
    expect(codes('Readers give it 5 stars')).toEqual(['forbidden_reviews']);
    expect(codes('Now $12.99, save 45%')).toEqual(['forbidden_price']);
    expect(codes('For a limited time only')).toEqual(['forbidden_urgency']);
    expect(codes('30-day money-back guarantee')).toEqual(['forbidden_guarantee']);
    expect(codes('An Amazon bestseller')).toEqual(['forbidden_accolade']);
  });

  it('refuses copy that contains one, wherever it came from', () => {
    const r = validateCopy(copy({ bio: 'Eric L Beser is the author of The Ossuary. This is his debut novel.' }));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.message).join()).toContain('author bio');
  });

  it('refuses a page with fewer than three verified facts', () => {
    expect(validateCopy(copy({ facts: [FACT] })).findings.map((f) => f.code)).toContain('too_few_facts');
  });
});

describe('research ranking', () => {
  it('keeps one report per topic, the most relevant first, within budget', () => {
    const reports: ResearchReport[] = [
      { id: 'a', topic: 'T1', content: 'Accokeek Potomac' },
      { id: 'b', topic: 'T1', content: 'Accokeek Potomac Piscataway, the longer copy' },
      { id: 'c', topic: 'T2', content: 'Potomac only' },
      { id: 'd', topic: 'T3', content: 'nothing relevant' },
      { id: 'e', topic: 'T4', content: `Accokeek ${'x'.repeat(500)}` },
    ];
    const picked = rankResearch(reports, ['Accokeek', 'Potomac', 'Piscataway'], 100).map((r) => r.id);
    expect(picked).toEqual(['b', 'c']);
  });

  it('ranks by the book\'s own places and names', () => {
    const terms = researchTerms({ hook: 'The site is 18PR8.', blurb: 'Sylvia Runningwater arrives at a Maryland bluff above the Potomac.' });
    expect(terms).toEqual(expect.arrayContaining(['18PR8', 'Sylvia', 'Runningwater', 'Maryland', 'Potomac']));
    expect(terms).not.toContain('The');
  });
});

describe('the sample page sets the order', () => {
  // The reference page: hero, bundle image, reviews, the three books, a pitch, the price table,
  // the author, the series story. Four buttons.
  const sample: SampleStructure = {
    url: 'https://offer.michaelreit.com/',
    cta_count: 4,
    sections: [
      { kind: 'hero', heading: 'Three gripping WWII novels', uses: ['price', 'discount', 'urgency'] },
      { kind: 'lineup', heading: 'Three beloved bestsellers', uses: ['bundle'] },
      { kind: 'proof', heading: 'Why readers love them', uses: ['reviews'] },
      { kind: 'lineup', heading: 'Inside the Collection', uses: [] },
      { kind: 'offer', heading: 'Ebook Bundle', uses: ['price', 'discount', 'guarantee'] },
      { kind: 'author', heading: 'About the Author', uses: [] },
      { kind: 'story', heading: 'About the Series', uses: [] },
    ],
  };

  it('follows the sample, keeps every section the book has, and leads with the hero', () => {
    expect(planSections(sample).map((p) => p.kind)).toEqual(['hero', 'lineup', 'proof', 'offer', 'author', 'story', 'closing']);
    expect(planSections({ ...sample, sections: [{ kind: 'author', heading: 'x', uses: [] }] })[0].kind).toBe('hero');
    expect(planSections().map((p) => p.kind)).toEqual(['hero', 'story', 'proof', 'lineup', 'offer', 'author', 'closing']);
  });

  it('places as many buttons as the sample has, never on the form', () => {
    const plan = planSections(sample);
    expect(plan.filter((p) => p.cta).map((p) => p.kind).sort()).toEqual(['closing', 'hero', 'proof', 'story']);
    expect(plan.find((p) => p.kind === 'offer')!.cta).toBe(false);
    expect(planSections({ ...sample, cta_count: 0 }).filter((p) => p.cta)).toHaveLength(2);
  });

  it('lists what the sample does that this page will not', () => {
    const skipped = skippedMechanics(sample);
    expect(skipped).toHaveLength(6);
    expect(skipped[0]).toMatch(/^reader reviews: none exist/);
    expect(skippedMechanics(null)).toEqual([]);
  });
});

describe('the GHL prompt', () => {
  it('carries every verbatim passage, marked, in the planned order', () => {
    const c = copy();
    const prompt = buildGhlPrompt(c, planSections(), 'https://offer.michaelreit.com/');
    for (const b of verbatimBlocks(c)) expect(prompt, b.label).toContain(b.text);
    expect(prompt).toContain('<<<VERBATIM');
    expect(prompt).toContain('Layout reference: https://offer.michaelreit.com/');
    expect(prompt.indexOf('1. Hero')).toBeLessThan(prompt.indexOf('Pre-order form'));
    expect(prompt).toContain(c.images[1].url);
  });

  it('names the volumes without doubling a leading "The"', () => {
    const prompt = buildGhlPrompt(copy());
    expect(prompt).toContain('Heading: The Ossuary in two volumes');
    expect(prompt).not.toMatch(/The The/);
    expect(renderPreviewHtml(copy())).toContain('<h2>The Ossuary in two volumes</h2>');
  });

  it('puts the credit for a CC BY photograph on the page', () => {
    const credit = creditFor({ title: 'Billy Tayac', creator: 'Jay Baker', license: 'CC BY 2.0', source_page_url: 'https://commons.wikimedia.org/x' });
    expect(credit).toBe('Photo: Billy Tayac. by Jay Baker. CC BY 2.0. https://commons.wikimedia.org/x');
    const c = copy({ images: [...copy().images, { role: 'reference', url: 'https://x/p.jpg', alt: 'p', credit }] });
    expect(buildGhlPrompt(c)).toContain(credit);
    expect(renderPreviewHtml(c)).toContain('CC BY 2.0');
  });
});

describe('checking the page GHL published', () => {
  it('passes the page as intended', () => {
    const r = checkPublishedPage(renderPreviewHtml(copy()), copy());
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.facts.verbatim_blocks).toBe(`${verbatimBlocks(copy()).length}/${verbatimBlocks(copy()).length}`);
  });

  it('names the passage the builder reworded', () => {
    const html = renderPreviewHtml(copy()).replace('arrives at a Maryland bluff before dawn', 'reaches a windswept cliff at sunrise');
    const r = checkPublishedPage(html, copy());
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.message).join()).toContain('blurb paragraph 2');
  });

  it('catches an invented review and an invented number', () => {
    const html = renderPreviewHtml(copy()).replace('</footer>', '<p>Rated 5 stars by 2,317 readers</p></footer>');
    const r = checkPublishedPage(html, copy());
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['forbidden_reviews', 'number_not_in_source']));
  });

  it('does not pass a page it could not read', () => {
    const r = checkPublishedPage('<html><body><div id="app"></div><script>render()</script></body></html>', copy());
    expect(r.findings.map((f) => f.code)).toEqual(['page_text_missing']);
    expect(r.ok).toBe(false);
  });
});

describe('the public page', () => {
  const pub = { formAction: '/books/the-ossuary/reserve', canonicalUrl: 'https://ww.example/books/the-ossuary' };

  it('takes its address from the title', () => {
    expect(slugify('The Ossuary')).toBe('the-ossuary');
    expect(slugify("  Ōsaka & the Sea: Vol. 2!  ")).toBe('osaka-and-the-sea-vol-2');
    expect(slugify('!!!')).toBe('book');
    expect(slugify('a'.repeat(80)).length).toBe(60);
  });

  it('has a form that posts, with named fields, a required email and a bot trap', () => {
    const html = renderPreviewHtml(copy(), planSections(), pub);
    expect(html).toContain('<form method="post" action="/books/the-ossuary/reserve">');
    expect(html).toMatch(/<input name="email" type="email"[^>]* required/);
    expect(html).toContain('name="first_name"');
    expect(html).toContain('name="website" class="hp"');
    expect(html).not.toContain('<script');
  });

  it('carries a share card and its canonical address', () => {
    const html = renderPreviewHtml(copy(), planSections(), pub);
    expect(html).toContain('<link rel="canonical" href="https://ww.example/books/the-ossuary">');
    expect(html).toContain(`<meta property="og:image" content="${copy().images[0].url}">`);
  });

  it('shows the thank-you above the form', () => {
    const html = renderPreviewHtml(copy(), planSections(), { ...pub, notice: 'Thank you.' });
    expect(html.indexOf('Thank you.')).toBeLessThan(html.indexOf('<form method="post"'));
  });

  it('is the page the author approved: the same copy as the preview, passing the check', () => {
    const html = renderPreviewHtml(copy(), planSections(), pub);
    expect(checkPublishedPage(html, copy()).ok).toBe(true);
    const preview = renderPreviewHtml(copy());
    expect(preview).toContain('onsubmit="return false"');
    expect(preview).not.toContain('og:image');
  });

  it('writes reservations to CSV that a spreadsheet will not execute', () => {
    expect(csvCell('Eric')).toBe('Eric');
    expect(csvCell('Smith, Jr')).toBe('"Smith, Jr"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@me')).toBe("'@me");
  });
});
