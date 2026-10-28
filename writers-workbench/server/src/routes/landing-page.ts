/**
 * The book's sales landing page, as a script for GoHighLevel's "Build with AI".
 *
 * WHAT IT MAKES. GHL's builder takes a prompt, so the product here is the prompt: every section in
 * order, the project's own copy marked to be used verbatim, the image URLs, the pre-order form, and
 * the rules about what the page may not claim. Beside it, a preview of the page as intended.
 *
 * WHERE THE WORDS COME FROM. Nowhere new. The hook, blurb and back cover are the stored listing
 * copy; the bio is the approved one; the images are the project's. The one thing a model writes is
 * a handful of history facts, picked from the project's research, and each is verified in code
 * against the exact sentence it rests on before it is allowed on the page.
 *
 * THE SAMPLE PAGE. The author pastes a sales page they like. Its tracking is stripped, its sections
 * are sorted into kinds (hero, proof, offer...), and this page follows that order. Its words are
 * never reused, and anything it does that this book has no data for (reviews, a price ladder, a
 * guarantee) is listed as skipped rather than imitated.
 *
 * WHERE IT IS STORED. On the project outline, like the listing copy: `_landing_page` is the current
 * script, `_landing_page_history` what it replaced.
 *
 * THE PAGE ITSELF. The same copy can instead be published as a page on the Workbench, at
 * /books/<slug> (book-pages.ts), with a working pre-order form. Publishing records the slug under
 * `_landing_page_public`; the page always shows the current script, so regenerating updates it.
 * Reservations are rows in `landing_page_reservations_v2` (migration 035).
 *
 * Routes:
 *   GET    /api/landing-page/project/:projectId                   — the saved script, its preview, the inputs
 *   POST   /api/landing-page/project/:projectId                   — generate and save a new script
 *   POST   /api/landing-page/project/:projectId/check             — compare a published page with the script
 *   POST   /api/landing-page/project/:projectId/publish           — publish it at /books/<slug>
 *   DELETE /api/landing-page/project/:projectId/publish           — take it down
 *   GET    /api/landing-page/project/:projectId/reservations.csv  — everyone who reserved a copy
 */

import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { parseWith } from '../lib/claude-structured.js';
import { seriesName, storedSeries } from '../lib/series.js';
import { renderMailing } from '../lib/landing-mail.js';
import { sendEmail } from '../lib/email.js';
import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { loadProject, saveOutline, marketingKey } from './publishing.js';
import { authorPhotoUrl } from './author.js';
import { composeCover } from '../lib/cover.js';
import type { ValidationResult } from '../lib/kdp-validate.js';
import { coverChoice } from '../lib/book-cover.js';
import {
  SECTION_KINDS,
  UNAVAILABLE_MECHANICS,
  buildGhlPrompt,
  checkPublishedPage,
  creditFor,
  researchTerms,
  factPrompt,
  htmlToText,
  isFetchableUrl,
  planSections,
  rankResearch,
  renderPreviewHtml,
  safeBuyUrl,
  samplePrompt,
  selectFacts,
  skippedMechanics,
  slugify,
  csvCell,
  stripTracking,
  validateCopy,
  type BuyLink,
  type LandingCopy,
  type PageImage,
  type ResearchReport,
  type SampleStructure,
  type SectionPlan,
  type SourcedFact,
} from '../lib/landing-page.js';

export const landingPageRouter = Router();
landingPageRouter.use(requireAuth);

const HISTORY_LIMIT = 10;
/** Enough research for the model to choose from; the ranking puts the relevant reports first. */
const RESEARCH_BUDGET_CHARS = 60_000;
const FACTS_WANTED = 4;
const FACTS_MINIMUM = 3;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

type Outline = Record<string, unknown>;
type Marketing = { hook?: string; blurb?: string; back_cover?: string; keywords?: string[] };

export interface SavedLandingPage {
  id: string;
  created_at: string;
  sample_url: string | null;
  sample: SampleStructure | null;
  plan: SectionPlan[];
  /** What the sample does that this page does not, and why. */
  skipped: string[];
  warnings: string[];
  copy: LandingCopy;
  /** The script: what is pasted into GHL. */
  prompt: string;
  /** Each fact with the sentence and report it came from. */
  facts_audit: (SourcedFact & { report_topic: string })[];
  rejected_facts: { text: string; reasons: string[] }[];
  validation: ValidationResult;
  last_check?: { url: string; checked_at: string; result: ValidationResult };
}

const GenerateSchema = z.object({
  sample_url: z.string().max(4000).nullable().optional(),
  /** Reference photographs to include. None by default: a real person's face on a sales page is
   *  the author's decision, not a default. */
  reference_photo_ids: z.array(z.string().uuid()).max(6).optional(),
});

const CheckSchema = z.object({ url: z.string().url().max(4000) });

// ------------------------------------------------------------------------------------------------
// Fetching other people's pages, safely
// ------------------------------------------------------------------------------------------------

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/**
 * GET a public web page. Every hop of a redirect is re-checked, and the host must resolve to a
 * public address: the URL comes from a form, and a server that fetches whatever it is told can be
 * pointed at its own network.
 */
async function fetchPublicPage(raw: string): Promise<string> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    if (!isFetchableUrl(url)) throw new Error('That address is not a public web page.');
    const { hostname } = new URL(url);
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error('That address is not a public web page.');
    }
    const resp = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'WritersWorkbench/1.0 (landing page layout reference)', accept: 'text/html' },
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      url = new URL(resp.headers.get('location')!, url).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`The page answered ${resp.status}.`);
    if (Number(resp.headers.get('content-length') ?? 0) > MAX_PAGE_BYTES) throw new Error('The page is too large.');
    const body = Buffer.from(await resp.arrayBuffer());
    if (body.length > MAX_PAGE_BYTES) throw new Error('The page is too large.');
    return body.toString('utf8');
  }
  throw new Error('Too many redirects.');
}

// ------------------------------------------------------------------------------------------------
// The two model calls
// ------------------------------------------------------------------------------------------------

const SampleOutput = z.object({
  sections: z.array(
    z.object({
      kind: z.enum(SECTION_KINDS),
      heading: z.string(),
      uses: z.array(z.enum(UNAVAILABLE_MECHANICS)),
    }),
  ),
  cta_count: z.number().int(),
});

const FactsOutput = z.object({
  facts: z.array(z.object({ text: z.string(), quote: z.string(), report_id: z.string() })),
});

async function analyseSample(url: string): Promise<SampleStructure> {
  const text = htmlToText(await fetchPublicPage(url));
  if (text.length < 300) {
    throw new Error('The sample page has almost no text in its HTML; it is probably drawn in the browser.');
  }
  const out = await parseWith(SampleOutput, samplePrompt(text));
  return { url, sections: out.sections, cta_count: out.cta_count };
}

/**
 * Facts for the proof section. A prompt cannot make a model quote accurately, so every fact is
 * checked against its report, and the rejects go back once with the reason they failed.
 */
async function pickFacts(
  book: { title: string; author: string },
  reports: ResearchReport[],
): Promise<{ kept: SourcedFact[]; rejected: { text: string; reasons: string[] }[] }> {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const base = factPrompt(book, reports);
  const first = selectFacts((await parseWith(FactsOutput, base)).facts, byId);
  let kept = first.kept.slice(0, FACTS_WANTED);
  const rejected = first.rejected.map((r) => ({ text: r.fact.text, reasons: r.findings.map((f) => f.message) }));

  if (kept.length < FACTS_MINIMUM && first.rejected.length) {
    const feedback = [
      base,
      '',
      'An earlier answer had facts that failed verification:',
      ...first.rejected.map((r) => `- "${r.fact.text}": ${r.findings.map((f) => f.message).join('; ')}`),
      `Give ${FACTS_WANTED - kept.length} replacement facts, different from these, that pass.`,
    ].join('\n');
    const second = selectFacts((await parseWith(FactsOutput, feedback)).facts, byId);
    const seen = new Set(kept.map((f) => f.text));
    kept = [...kept, ...second.kept.filter((f) => !seen.has(f.text))].slice(0, FACTS_WANTED);
    rejected.push(...second.rejected.map((r) => ({ text: r.fact.text, reasons: r.findings.map((f) => f.message) })));
  }
  return { kept, rejected };
}

// ------------------------------------------------------------------------------------------------
// Gathering the project
// ------------------------------------------------------------------------------------------------

interface ReferencePhoto {
  id: string;
  title: string;
  creator: string;
  license: string;
  source_page_url: string;
  url: string;
}

function publicUrl(path: string): string {
  return getSupabaseAdmin().storage.from('cover-images').getPublicUrl(path).data.publicUrl;
}

interface Inputs {
  missing: string[];
  marketing: Marketing;
  volumes: { index: number; hook: string; title?: string }[];
  series?: LandingCopy['series'];
  author: string;
  bio: string;
  cover: PageImage | null;
  coverPath: string | null;
  authorPhoto: string | null;
  referencePhotos: ReferencePhoto[];
  reports: ResearchReport[];
}

async function gatherInputs(userId: string, project: { id: string; title: string; outline: Outline | null }): Promise<Inputs> {
  const supabase = getSupabaseAdmin();
  const outline = project.outline ?? {};
  const marketing = (outline[marketingKey(1)] as Marketing | undefined) ?? {};
  const plan = outline._volume_plan as { volumes?: { index: number }[] } | undefined;
  const indexes = plan?.volumes?.map((v) => v.index) ?? [1];
  const stored = storedSeries(outline);
  const volumes = indexes
    .map((index) => ({
      index,
      hook: String((outline[marketingKey(index)] as Marketing | undefined)?.hook ?? '').trim(),
      ...(stored.books?.[String(index)]?.title ? { title: stored.books[String(index)].title } : {}),
    }))
    .filter((v) => v.hook);
  // The series pitch is used once it has been written; until then the lineup is the volumes.
  const series =
    indexes.length > 1 && stored.description?.text?.trim()
      ? { name: seriesName(outline, project.title), description: stored.description.text.trim(), tagline: stored.description.tagline }
      : undefined;

  const [{ data: profile }, { data: images }, { data: reports }, authorPhoto] = await Promise.all([
    supabase.from('author_profiles_v2').select('pen_name, bio, bio_source').eq('user_id', userId).maybeSingle(),
    supabase
      .from('generated_images_v2')
      .select('id, image_type, storage_path, metadata, created_at')
      .eq('user_id', userId)
      .eq('project_id', project.id)
      .in('image_type', ['cover_art', 'reference_photo'])
      .order('created_at', { ascending: false }),
    supabase
      .from('research_reports_v2')
      .select('id, topic, content')
      .eq('user_id', userId)
      .like('topic', `${project.title.replace(/[%_]/g, '')}%`)
      .is('deleted_at', null),
    authorPhotoUrl(userId),
  ]);

  // The author's chosen cover when it is still there; otherwise the newest cover art.
  const chosenCover = coverChoice(outline).default;
  const coverRow =
    (images ?? []).find((i) => chosenCover && i.id === chosenCover) ??
    (images ?? []).find((i) => i.image_type === 'cover_art');
  const referencePhotos: ReferencePhoto[] = (images ?? [])
    .filter((i) => i.image_type === 'reference_photo')
    .map((i) => {
      const m = (i.metadata ?? {}) as Record<string, string>;
      return {
        id: i.id,
        title: m.title ?? '',
        creator: m.creator ?? '',
        license: m.license ?? '',
        source_page_url: m.source_page_url ?? '',
        url: publicUrl(i.storage_path),
      };
    });

  const missing: string[] = [];
  if (!marketing.hook?.trim()) missing.push('the hook (Publish tab, listing copy)');
  if (!marketing.blurb?.trim()) missing.push('the blurb (Publish tab, listing copy)');
  if (!marketing.back_cover?.trim()) missing.push('the back-cover copy (Publish tab, listing copy)');
  if (!profile?.pen_name?.trim()) missing.push('a pen name (Settings, Author Profile)');
  if (!profile?.bio?.trim() || !profile?.bio_source) missing.push('an approved bio (Settings, Author Profile)');
  if (!coverRow) missing.push('cover art (Art tab)');
  if (!(reports ?? []).length) missing.push('research reports for this book');

  return {
    missing,
    marketing,
    volumes,
    series,
    author: String(profile?.pen_name ?? '').trim(),
    bio: String(profile?.bio ?? '').trim(),
    cover: coverRow
      ? { role: 'cover', url: publicUrl(coverRow.storage_path), alt: `Cover art for ${project.title}` }
      : null,
    coverPath: coverRow?.storage_path ?? null,
    authorPhoto,
    referencePhotos,
    reports: (reports ?? []) as ResearchReport[],
  };
}

/**
 * The book's front cover — title and author set on the cover art, the same composition as the
 * ebook cover in the KDP package — stored where the page can show it. The page shows a book, so it
 * shows the cover a reader would see, not the painting underneath it. Null when it cannot be
 * built; the caller falls back to the art and says so.
 */
async function bookCoverImage(
  userId: string,
  project: { id: string; title: string },
  author: string,
  artPath: string,
): Promise<PageImage | null> {
  const storage = getSupabaseAdmin().storage.from('cover-images');
  const dl = await storage.download(artPath);
  if (!dl.data) return null;
  const composed = await composeCover({ art: Buffer.from(await dl.data.arrayBuffer()), title: project.title, author });
  if (!composed) return null;
  // A new name per build, so a regenerated cover is never served from a CDN cache under the old URL.
  const path = `${userId}/${project.id}/landing/book-cover-${Date.now()}.jpg`;
  const up = await storage.upload(path, composed, { contentType: 'image/jpeg', upsert: false });
  if (up.error) throw new Error(`could not store the book cover: ${up.error.message}`);
  return { role: 'cover', url: publicUrl(path), alt: `${project.title} by ${author}, front cover` };
}

function shrink(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, s.lastIndexOf(' ', max - 1))}…`;
}

function currentOf(outline: Outline | null): SavedLandingPage | null {
  return (outline?._landing_page as SavedLandingPage | undefined) ?? null;
}

export interface PublicState {
  slug: string;
  published_at: string;
}

/** Where to buy the book, once it is on sale. Kept apart from publishing, so unpublishing keeps it. */
export function buyOf(outline: Outline | null): BuyLink | null {
  const b = outline?._landing_page_buy as BuyLink | undefined;
  return b?.url ? { url: b.url, label: b.label || 'Buy the book' } : null;
}

function publicOf(outline: Outline | null): PublicState | null {
  return (outline?._landing_page_public as PublicState | undefined) ?? null;
}

/** The public address, on whichever host the author is using the Workbench from. */
function pageUrl(req: { protocol: string; get(name: string): string | undefined }, slug: string): string {
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  return `${proto}://${host}/books/${slug}`;
}

/** Is this slug already another project's page? */
async function slugTaken(slug: string, projectId: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('id')
    .eq('outline->_landing_page_public->>slug', slug)
    .neq('id', projectId)
    .is('deleted_at', null)
    .limit(1);
  return (data ?? []).length > 0;
}

interface ReservationRow {
  first_name: string;
  email: string;
  created_at: string;
  unsubscribed_at?: string | null;
  last_emailed_at?: string | null;
}

async function reservationsFor(userId: string, projectId: string): Promise<{ rows: ReservationRow[]; count: number }> {
  const { data, count } = await getSupabaseAdmin()
    .from('landing_page_reservations_v2')
    .select('first_name, email, created_at, unsubscribed_at, last_emailed_at', { count: 'exact' })
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(500);
  return { rows: (data ?? []) as ReservationRow[], count: count ?? 0 };
}



// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

/**
 * @openapi
 * /landing-page/project/{projectId}:
 *   get:
 *     tags: [Publishing]
 *     summary: The saved landing-page script, its preview, and what it is built from
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.get('/project/:projectId', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const inputs = await gatherInputs(req.userId!, project);
    const current = currentOf(project.outline);
    const history = ((project.outline?._landing_page_history as SavedLandingPage[] | undefined) ?? []).map((h) => ({
      id: h.id,
      created_at: h.created_at,
      sample_url: h.sample_url,
      prompt: h.prompt,
    }));
    const pub = publicOf(project.outline);
    const reservations = await reservationsFor(req.userId!, project.id);
    const { data: mailings } = await getSupabaseAdmin()
      .from('landing_page_mailings_v2')
      .select('id, subject, recipients, sent, failed, buy_url, created_at, finished_at')
      .eq('user_id', req.userId!)
      .eq('project_id', project.id)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json({
      success: true,
      data: {
        current: current ? { ...current, preview_html: renderPreviewHtml(current.copy, current.plan) } : null,
        public: pub ? { ...pub, url: pageUrl(req, pub.slug) } : null,
        reservations,
        subscribed: reservations.rows.filter((r) => !r.unsubscribed_at).length,
        buy: buyOf(project.outline),
        mailings: mailings ?? [],
        history,
        inputs: {
          missing: inputs.missing,
          author_photo_url: inputs.authorPhoto,
          cover_url: inputs.cover?.url ?? null,
          volumes: inputs.volumes.length,
          research_reports: inputs.reports.length,
          reference_photos: inputs.referencePhotos.map((p) => ({ ...p, credit: creditFor(p) })),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /landing-page/project/{projectId}:
 *   post:
 *     tags: [Publishing]
 *     summary: Generate and save the landing-page script
 *     description: |
 *       Builds the GHL "Build with AI" prompt from the project's stored copy, approved bio, images
 *       and research. With a sample URL, follows that page's section order. Takes up to a minute.
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.post('/project/:projectId', validateBody(GenerateSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof GenerateSchema>;
  const userId = req.userId!;

  let sampleUrl: string | null = null;
  if (body.sample_url?.trim()) {
    try {
      sampleUrl = stripTracking(body.sample_url.trim());
    } catch {
      res.status(400).json({ success: false, error: { code: 'BAD_URL', message: 'That sample URL is not a web address.' } });
      return;
    }
    if (!isFetchableUrl(sampleUrl)) {
      res.status(400).json({ success: false, error: { code: 'BAD_URL', message: 'The sample must be a public web page.' } });
      return;
    }
  }

  try {
    const inputs = await gatherInputs(userId, project);
    if (inputs.missing.length) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_INPUTS', message: `Still needed: ${inputs.missing.join('; ')}.`, missing: inputs.missing },
      });
      return;
    }

    const warnings: string[] = [];
    const ranked = rankResearch(inputs.reports, researchTerms(inputs.marketing), RESEARCH_BUDGET_CHARS);
    const [sampleResult, facts] = await Promise.all([
      sampleUrl
        ? analyseSample(sampleUrl).catch((err: Error) => {
            warnings.push(`Sample page not used: ${err.message} The default section order was used.`);
            return null;
          })
        : Promise.resolve(null),
      pickFacts({ title: project.title, author: inputs.author }, ranked),
    ]);

    const chosen = inputs.referencePhotos.filter((p) => body.reference_photo_ids?.includes(p.id));
    const bookCover = inputs.coverPath
      ? await bookCoverImage(userId, project, inputs.author, inputs.coverPath).catch((err: Error) => {
          logger.warn({ err, projectId: project.id }, 'landing-page: book cover not composed');
          return null;
        })
      : null;
    if (!bookCover) warnings.push('The front cover could not be built, so the cover art is shown without its title.');
    const images: PageImage[] = [bookCover ?? inputs.cover!];
    if (inputs.authorPhoto) images.push({ role: 'author', url: inputs.authorPhoto, alt: `${inputs.author}, author` });
    else warnings.push('No author photo. Add one in Settings, Author Profile, and generate again.');
    for (const p of chosen) images.push({ role: 'reference', url: p.url, alt: p.title, credit: creditFor(p) });

    const copy: LandingCopy = {
      title: project.title,
      author: inputs.author,
      hook: inputs.marketing.hook!.trim(),
      blurb: inputs.marketing.blurb!.trim(),
      backCover: inputs.marketing.back_cover!.trim(),
      volumes: inputs.volumes,
      ...(inputs.series ? { series: inputs.series } : {}),
      bio: inputs.bio,
      facts: facts.kept,
      images,
      form: {
        heading: 'Reserve your copy',
        lede: `Leave your name and email to reserve your copy of ${project.title}. We will write to you when it is released.`,
        button: 'Reserve my copy',
        fields: ['First name', 'Email'],
      },
      seo: {
        title: `${project.title}: a novel by ${inputs.author}`,
        description: shrink(inputs.marketing.hook!.trim(), 160),
        keywords: inputs.marketing.keywords ?? [],
      },
    };

    const validation = validateCopy(copy);
    if (!validation.ok) {
      res.status(422).json({
        success: false,
        error: {
          code: 'COPY_FAILED_CHECKS',
          message: validation.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '),
          rejected_facts: facts.rejected,
        },
      });
      return;
    }

    const plan = planSections(sampleResult);
    const reportsById = new Map(inputs.reports.map((r) => [r.id, r]));
    const entry: SavedLandingPage = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      sample_url: sampleUrl,
      sample: sampleResult,
      plan,
      skipped: skippedMechanics(sampleResult),
      warnings,
      copy,
      prompt: buildGhlPrompt(copy, plan, sampleResult ? sampleUrl : null),
      facts_audit: facts.kept.map((f) => ({ ...f, report_topic: reportsById.get(f.report_id)?.topic ?? '' })),
      rejected_facts: facts.rejected,
      validation,
    };

    // Re-read before writing: generation takes most of a minute, and the engine may have written
    // the outline meanwhile. Writing back the copy loaded at the start would undo that.
    const fresh = await loadProject(req, res);
    if (!fresh) return;
    const outline = { ...(fresh.outline ?? {}) };
    const previous = currentOf(outline);
    const history = (outline._landing_page_history as SavedLandingPage[] | undefined) ?? [];
    outline._landing_page = entry;
    outline._landing_page_history = previous ? [previous, ...history].slice(0, HISTORY_LIMIT) : history;
    await saveOutline(project.id, userId, outline);

    logger.info(
      { userId, projectId: project.id, facts: facts.kept.length, rejected: facts.rejected.length, sample: !!sampleResult },
      'landing-page: script generated',
    );
    res.status(201).json({ success: true, data: { ...entry, preview_html: renderPreviewHtml(copy, plan) } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'landing-page: generation failed');
    res.status(502).json({
      success: false,
      error: { code: 'GENERATION_FAILED', message: err instanceof Error ? err.message : 'Generation failed' },
    });
  }
});

/**
 * @openapi
 * /landing-page/project/{projectId}/check:
 *   post:
 *     tags: [Publishing]
 *     summary: Check the page GHL published against the saved script
 *     description: |
 *       Build with AI may reword the copy it is given. This reads the published page and reports
 *       every passage that changed, every forbidden claim, and every number the script did not give.
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.post('/project/:projectId/check', validateBody(CheckSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const current = currentOf(project.outline);
  if (!current) {
    res.status(400).json({ success: false, error: { code: 'NO_SCRIPT', message: 'Generate the landing page script first.' } });
    return;
  }
  const { url } = req.body as z.infer<typeof CheckSchema>;
  let html: string;
  try {
    html = await fetchPublicPage(url);
  } catch (err) {
    res.status(502).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : 'Could not read the page' },
    });
    return;
  }
  const result = checkPublishedPage(html, current.copy);
  const outline = { ...(project.outline ?? {}) };
  outline._landing_page = { ...current, last_check: { url, checked_at: new Date().toISOString(), result } };
  await saveOutline(project.id, req.userId!, outline);
  logger.info({ userId: req.userId, projectId: project.id, ok: result.ok, findings: result.findings.length }, 'landing-page: checked');
  res.json({ success: true, data: result });
});

/**
 * @openapi
 * /landing-page/project/{projectId}/publish:
 *   post:
 *     tags: [Publishing]
 *     summary: Publish the landing page at /books/<slug>, with no login needed to read it
 *     description: |
 *       The slug comes from the project title and is kept once chosen, so the address does not
 *       move if the title is edited. The page always shows the current script.
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.post('/project/:projectId/publish', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  if (!currentOf(project.outline)) {
    res.status(400).json({ success: false, error: { code: 'NO_SCRIPT', message: 'Generate the landing page first.' } });
    return;
  }
  try {
    let pub = publicOf(project.outline);
    if (!pub) {
      let slug = slugify(project.title);
      if (await slugTaken(slug, project.id)) slug = `${slug}-${project.id.slice(0, 6)}`;
      pub = { slug, published_at: new Date().toISOString() };
      const outline = { ...(project.outline ?? {}), _landing_page_public: pub };
      await saveOutline(project.id, req.userId!, outline);
      logger.info({ userId: req.userId, projectId: project.id, slug }, 'landing-page: published');
    }
    res.json({ success: true, data: { ...pub, url: pageUrl(req, pub.slug) } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'landing-page: publish failed');
    res.status(500).json({ success: false, error: { code: 'PUBLISH_FAILED', message: err instanceof Error ? err.message : 'Could not publish' } });
  }
});

landingPageRouter.delete('/project/:projectId/publish', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline = { ...(project.outline ?? {}) };
  delete outline._landing_page_public;
  await saveOutline(project.id, req.userId!, outline);
  logger.info({ userId: req.userId, projectId: project.id }, 'landing-page: unpublished');
  res.json({ success: true, data: null });
});

/**
 * @openapi
 * /landing-page/project/{projectId}/reservations.csv:
 *   get:
 *     tags: [Publishing]
 *     summary: Everyone who reserved a copy through the public page, as CSV
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.get('/project/:projectId/reservations.csv', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const { rows } = await reservationsFor(req.userId!, project.id);
  const lines = ['first_name,email,reserved_at', ...rows.map((r) => [r.first_name, r.email, r.created_at].map(csvCell).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(project.title)}-reservations.csv"`);
  res.send(`${lines.join('\r\n')}\r\n`);
});

// ------------------------------------------------------------------------------------------------
// Buy link, and writing to the people who reserved a copy
// ------------------------------------------------------------------------------------------------

const BuySchema = z.object({
  url: z.string().trim().max(2000).nullable(),
  label: z.string().trim().max(60).optional(),
});

/**
 * @openapi
 * /landing-page/project/{projectId}/buy-link:
 *   put:
 *     tags: [Publishing]
 *     summary: Set (or clear, with url null) where readers buy the book
 *     description: Once set, the page's calls to action go there, and the form becomes "hear about the next book".
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.put('/project/:projectId/buy-link', validateBody(BuySchema), async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const { url, label } = req.body as z.infer<typeof BuySchema>;
    const outline = { ...(project.outline ?? {}) };
    if (!url) {
      delete outline._landing_page_buy;
    } else {
      const safe = safeBuyUrl(url);
      if (!safe) {
        res.status(400).json({ success: false, error: { code: 'BAD_URL', message: 'The buy link must be a full https:// address.' } });
        return;
      }
      outline._landing_page_buy = { url: safe, label: label || 'Buy the book', updated_at: new Date().toISOString() };
    }
    await saveOutline(project.id, req.userId!, outline);
    res.json({ success: true, data: { buy: buyOf(outline) } });
  } catch (err) {
    next(err);
  }
});

const MailingSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  /** A test goes to the author alone, and is not recorded as a mailing. */
  test: z.boolean().optional().default(false),
});

/** Addresses in the links a reader gets: the public page and their unsubscribe link. */
function publicBase(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  return `${proto}://${host}`;
}

/**
 * @openapi
 * /landing-page/project/{projectId}/mailings:
 *   post:
 *     tags: [Publishing]
 *     summary: Email everyone who reserved a copy (or, with test, only the author)
 *     description: |
 *       One email per reader, addressed by first name, with their own unsubscribe link and a line
 *       saying why they are getting it. Unsubscribed addresses are skipped. Replies go to the author.
 *     security: [{ bearerAuth: [] }]
 */
landingPageRouter.post('/project/:projectId/mailings', validateBody(MailingSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const pub = publicOf(project.outline);
  if (!pub) {
    res.status(400).json({ success: false, error: { code: 'NOT_PUBLISHED', message: 'Publish the page first: the email links to it.' } });
    return;
  }
  const { subject, body, test } = req.body as z.infer<typeof MailingSchema>;
  const supabase = getSupabaseAdmin();
  const buy = buyOf(project.outline) ?? undefined;
  const base = publicBase(req);
  const pageUrl_ = `${base}/books/${pub.slug}`;
  const [{ data: profile }, { data: account }] = await Promise.all([
    supabase.from('author_profiles_v2').select('pen_name').eq('user_id', req.userId!).maybeSingle(),
    supabase.from('users_v2').select('email, display_name').eq('user_id', req.userId!).maybeSingle(),
  ]);
  const author = String(profile?.pen_name || account?.display_name || '').trim();
  const authorEmail = String(account?.email ?? '').trim();
  const mail = (to: { first_name?: string; email: string; unsubscribe_token?: string }, subj: string) => {
    const { html, text } = renderMailing({
      title: project.title,
      author,
      subject: subj,
      body,
      firstName: to.first_name,
      buy,
      pageUrl: pageUrl_,
      unsubscribeUrl: to.unsubscribe_token ? `${pageUrl_}/unsubscribe?t=${to.unsubscribe_token}` : pageUrl_,
    });
    return sendEmail({ to: to.email, subject: subj, html, text, replyTo: authorEmail || undefined });
  };

  try {
    if (test) {
      if (!authorEmail) {
        res.status(400).json({ success: false, error: { code: 'NO_AUTHOR_EMAIL', message: 'Your account has no email address to send the test to.' } });
        return;
      }
      const r = await mail({ first_name: author.split(' ')[0], email: authorEmail }, `[Test] ${subject}`);
      res.json({ success: true, data: { test: true, to: authorEmail, ok: r.ok, mode: r.mode, error: r.error ?? null } });
      return;
    }

    const recipients: { id: string; first_name: string; email: string; unsubscribe_token: string }[] = [];
    for (let page = 0; ; page += 1) {
      const { data, error } = await supabase
        .from('landing_page_reservations_v2')
        .select('id, first_name, email, unsubscribe_token')
        .eq('user_id', req.userId!)
        .eq('project_id', project.id)
        .is('unsubscribed_at', null)
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(error.message);
      recipients.push(...((data ?? []) as typeof recipients));
      if ((data ?? []).length < 1000) break;
    }
    if (!recipients.length) {
      res.status(400).json({ success: false, error: { code: 'NO_RECIPIENTS', message: 'Nobody on the list to write to yet.' } });
      return;
    }

    const id = crypto.randomUUID();
    await supabase.from('landing_page_mailings_v2').insert({
      id, project_id: project.id, user_id: req.userId!, subject, body, buy_url: buy?.url ?? null, recipients: recipients.length,
    });
    let sent = 0;
    let failed = 0;
    // A few at a time: fast enough for a list of hundreds, gentle enough on the mail server.
    for (let i = 0; i < recipients.length; i += 4) {
      const batch = recipients.slice(i, i + 4);
      const results = await Promise.all(batch.map((r) => mail(r, subject).catch(() => ({ ok: false }))));
      const ok = batch.filter((_, k) => results[k].ok);
      sent += ok.length;
      failed += batch.length - ok.length;
      if (ok.length) {
        await supabase
          .from('landing_page_reservations_v2')
          .update({ last_emailed_at: new Date().toISOString() })
          .in('id', ok.map((r) => r.id));
      }
    }
    await supabase.from('landing_page_mailings_v2').update({ sent, failed, finished_at: new Date().toISOString() }).eq('id', id);
    logger.info({ userId: req.userId, projectId: project.id, mailingId: id, sent, failed }, 'landing-page: mailing sent');
    res.json({ success: true, data: { id, recipients: recipients.length, sent, failed } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'landing-page: mailing failed');
    res.status(500).json({ success: false, error: { code: 'MAILING_FAILED', message: err instanceof Error ? err.message : 'Could not send' } });
  }
});
