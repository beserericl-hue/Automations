/**
 * Audiobooks (migration 056): narrate a book — or one book of a series — one recording per chapter.
 *
 *   GET  /api/audiobook/options                        the voices, the styles, the price
 *   GET  /api/audiobook/project/:id?volume=1           the audiobook: settings, every recording and
 *                                                      where it stands, signed links, the cover
 *   PUT  /api/audiobook/project/:id/settings           voice, style, spoken credits
 *   POST /api/audiobook/project/:id/preview            hear the voice and style on your own opening
 *   POST /api/audiobook/project/:id/build              narrate what is missing, changed or failed
 *                                                      (engine jobs, one per recording, charged)
 *   POST /api/audiobook/project/:id/sample             cut the retail sample from the first chapter
 *   POST /api/audiobook/project/:id/cover              (re)make the square cover from the book cover
 *
 * Every route resolves the project as the caller's own first (404 otherwise). A recording is an
 * `audiobook_chapters_v2` row the engine job fills in: the screen polls this GET, which reports a
 * recording whose job stopped answering as interrupted instead of building forever.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool, callEngineWriteToolSync } from '../lib/engine-hub.js';
import { loadBookSource } from '../lib/book-source.js';
import { downloadCover, findCover } from '../lib/book-cover.js';
import { chargeable, refuseIfInsufficient } from '../lib/credit-charge.js';
import { userSecret } from './integrations.js';
import { rateKey } from '../lib/rate-key.js';
import { getCreditCost } from '../services/credit-costs.js';
import { deductCredits } from '../services/credits.js';
import { logger } from '../lib/logger.js';
import {
  BUCKET,
  CREDIT_WORDS,
  MAX_CUSTOM_STYLE,
  MAX_PRONUNCIATIONS,
  SAMPLE_POSITION,
  STYLES,
  VOICES,
  DEFAULT_EXPORT_QUALITY,
  EXPORT_QUALITIES,
  exportFileName,
  exportFingerprint,
  filenameFor,
  hashItem,
  narrationUnits,
  normalizeQuality,
  styleHash,
  normalizeSettings,
  planAudiobook,
  squareCover,
  suggestNames,
  type AudioSettings,
  type PlannedItem,
} from '../lib/audiobook.js';

export const audiobookRouter = Router();
audiobookRouter.use(requireAuth);

/** A queued recording whose job never started, and a building one whose job stopped answering. */
const QUEUED_STALE_MS = 4 * 3600_000;
const BUILDING_STALE_MS = 40 * 60_000;
const SIGNED_URL_SECONDS = 3600;

const previewLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => rateKey(req),
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many previews — wait a few minutes.' } },
});

const UUID = z.string().uuid();
const VolumeQuery = z.coerce.number().int().min(1).max(12).default(1);

const SettingsBody = z.object({
  volume: z.number().int().min(1).max(12).default(1),
  provider: z.enum(['openai', 'elevenlabs']).optional(),
  voice: z.string().max(40).optional(),
  style: z.string().max(40).optional(),
  custom_style: z.string().max(MAX_CUSTOM_STYLE * 2).optional(),
  credits: z.boolean().optional(),
  pronunciations: z.array(z.object({ word: z.string().max(120), say: z.string().max(160) })).max(MAX_PRONUNCIATIONS * 2).optional(),
  /** Preview only: say this instead of the book's opening (one word or phrase of the guide). */
  say: z.string().max(120).optional(),
});
const BuildBody = z.object({
  volume: z.number().int().min(1).max(12).default(1),
  /** Only these recordings (by id), rebuilt even when nothing changed. Omit for "everything that needs it". */
  item_ids: z.array(z.string().uuid()).max(500).optional(),
});
const VolumeBody = z.object({ volume: z.number().int().min(1).max(12).default(1) });
const ExportBody = z.object({ volume: z.number().int().min(1).max(12).default(1), quality: z.string().max(20).optional() });

/** A signed link people paste into a player: long enough to be used from a phone later, not forever. */
const EXPORT_LINK_SECONDS = 7 * 24 * 3600;

/** The :projectId of the route (express types a param as string or string[]). */
function pid(req: Request): string {
  return String(req.params.projectId);
}

function bad(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

interface BookRow {
  id: string;
  provider: string;
  voice: string;
  style: string;
  custom_style: string;
  credits: boolean;
  pronunciations: unknown;
}

interface ItemRow {
  id: string;
  kind: PlannedItem['kind'];
  chapter_number: number;
  position: number;
  title: string;
  text_hash: string;
  voice: string;
  status: 'queued' | 'building' | 'ready' | 'failed';
  error: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  rms_db: number | null;
  peak_db: number | null;
  spec_ok: boolean | null;
  built_at: string | null;
  updated_at: string;
}

const ITEM_COLUMNS =
  'id, kind, chapter_number, position, title, text_hash, voice, status, error, storage_path, size_bytes, duration_s, rms_db, peak_db, spec_ok, built_at, updated_at';

async function findBook(userId: string, projectId: string, volume: number): Promise<BookRow | null> {
  const { data } = await getSupabaseAdmin()
    .from('audiobooks_v2')
    .select('id, provider, voice, style, custom_style, credits, pronunciations')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('volume_index', volume)
    .maybeSingle();
  return (data as BookRow | null) ?? null;
}

/** The audiobook row for this book, made with the given (or default) settings if it does not exist. */
async function ensureBook(userId: string, projectId: string, volume: number, settings?: AudioSettings): Promise<BookRow> {
  const sb = getSupabaseAdmin();
  const existing = await findBook(userId, projectId, volume);
  if (existing && !settings) return existing;
  const s = settings ?? normalizeSettings(null);
  if (existing) {
    const { error } = await sb.from('audiobooks_v2').update({ ...s, updated_at: new Date().toISOString() }).eq('id', existing.id);
    if (error) throw new Error(error.message);
    return { ...existing, ...s };
  }
  const { data, error } = await sb
    .from('audiobooks_v2')
    .insert({ user_id: userId, project_id: projectId, volume_index: volume, ...s })
    .select('id, provider, voice, style, custom_style, credits, pronunciations')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'audiobook not created');
  return data as BookRow;
}

function settingsOf(book: BookRow | null): AudioSettings {
  return normalizeSettings(book);
}

interface ExportRow {
  export_status: 'queued' | 'building' | 'ready' | 'failed' | null;
  export_error: string | null;
  export_path: string | null;
  export_bytes: number | null;
  export_duration_s: number | null;
  export_chapters: number | null;
  export_quality: string | null;
  export_hash: string | null;
  export_updated_at: string | null;
}

const EXPORT_COLUMNS =
  'export_status, export_error, export_path, export_bytes, export_duration_s, export_chapters, export_quality, export_hash, export_updated_at';

async function findExport(bookId: string): Promise<ExportRow | null> {
  const { data } = await getSupabaseAdmin().from('audiobooks_v2').select(EXPORT_COLUMNS).eq('id', bookId).maybeSingle();
  return (data as ExportRow | null) ?? null;
}

/** The row as the screen should read it: a job that stopped answering is interrupted, not "building". */
function effectiveStatus(row: ItemRow, now = Date.now()): { status: ItemRow['status']; error: string | null } {
  const age = now - new Date(row.updated_at).getTime();
  if (row.status === 'building' && age > BUILDING_STALE_MS) {
    return { status: 'failed', error: 'The build stopped before it finished — build it again.' };
  }
  if (row.status === 'queued' && age > QUEUED_STALE_MS) {
    return { status: 'failed', error: 'The build never started — build it again.' };
  }
  return { status: row.status, error: row.error };
}

async function ownedSource(req: Request, res: Response, projectId: string) {
  if (!UUID.safeParse(projectId).success) {
    bad(res, 404, 'NOT_FOUND', 'Project not found');
    return null;
  }
  let source;
  try {
    source = await loadBookSource(projectId, req.userId!, { withArt: false });
  } catch (err) {
    logger.error({ err, projectId }, 'audiobook: book unreadable');
    bad(res, 500, 'BOOK_UNREADABLE', 'Could not read the book.');
    return null;
  }
  if (!source) {
    bad(res, 404, 'NOT_FOUND', 'Project not found');
    return null;
  }
  return source;
}

async function signedUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const { data } = await getSupabaseAdmin().storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  for (const r of data ?? []) if (r.signedUrl && r.path) out.set(r.path, r.signedUrl);
  return out;
}

/** The project's outline (where the chosen cover is recorded). */
async function outlineOf(userId: string, projectId: string): Promise<Record<string, unknown> | null> {
  const { data } = await getSupabaseAdmin().from('writing_projects_v2').select('outline').eq('id', projectId).eq('user_id', userId).maybeSingle();
  return (data?.outline as Record<string, unknown> | null) ?? null;
}

function coverPath(userId: string, bookId: string): string {
  return `${userId}/${bookId}/cover.jpg`;
}

// ---------------------------------------------------------------------------- reads

audiobookRouter.get('/options', async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      voices: VOICES,
      styles: STYLES,
      max_custom_style: MAX_CUSTOM_STYLE,
      credits_per_unit: await getCreditCost('audiobook_narration'),
      unit_words: CREDIT_WORDS,
    },
  });
});

interface ElevenVoice {
  id: string;
  name: string;
  category: string;
  /** "Your voice" for a clone the author made; the library's own voices are "ElevenLabs". */
  yours: boolean;
  labels: Record<string, string>;
}

/** The voices in the caller's own ElevenLabs account (their clones first). Needs their saved key. */
audiobookRouter.get('/elevenlabs/voices', async (req: Request, res: Response) => {
  let key: string | null = null;
  try {
    key = await userSecret(req.userId!, 'elevenlabs');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'audiobook: elevenlabs key unreadable');
    return bad(res, 500, 'KEY_UNREADABLE', 'Could not read your saved ElevenLabs key — reconnect it.');
  }
  if (!key) return res.json({ success: true, data: { connected: false, voices: [] } });
  const voices: ElevenVoice[] = [];
  let token = '';
  for (let page = 0; page < 5; page += 1) {
    let r: globalThis.Response;
    try {
      r = await fetch(`${(process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '')}/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`, {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return bad(res, 502, 'ELEVENLABS_UNREACHABLE', 'ElevenLabs could not be reached.');
    }
    if (r.status === 401 || r.status === 403) {
      return res.json({ success: true, data: { connected: false, rejected: true, voices: [] } });
    }
    if (!r.ok) return bad(res, 502, 'ELEVENLABS_ERROR', `ElevenLabs answered ${r.status}.`);
    const body = (await r.json()) as { voices?: Record<string, unknown>[]; has_more?: boolean; next_page_token?: string };
    for (const v of body.voices ?? []) {
      const category = String(v.category ?? '');
      voices.push({
        id: String(v.voice_id ?? ''),
        name: String(v.name ?? ''),
        category,
        yours: ['cloned', 'professional', 'generated'].includes(category),
        labels: Object.fromEntries(Object.entries((v.labels as Record<string, unknown>) ?? {}).map(([k, x]) => [k, String(x)])),
      });
    }
    if (!body.has_more || !body.next_page_token) break;
    token = body.next_page_token;
  }
  voices.sort((a, b) => Number(b.yours) - Number(a.yours) || a.name.localeCompare(b.name));
  res.json({ success: true, data: { connected: true, voices: voices.filter((v) => v.id) } });
});

audiobookRouter.get('/project/:projectId', async (req: Request, res: Response) => {
  const volume = VolumeQuery.safeParse(req.query.volume);
  if (!volume.success) return bad(res, 400, 'VALIDATION', 'volume must be 1-12');
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;

  const book = await findBook(req.userId!, pid(req), volume.data);
  const settings = settingsOf(book);
  const plan = planAudiobook(source, volume.data, settings);
  const ownAccount = settings.provider === 'elevenlabs';
  // Through the author's own ElevenLabs account the characters are billed by ElevenLabs, not us.
  const unitCost = ownAccount ? 0 : await getCreditCost('audiobook_narration');

  const rows: ItemRow[] = [];
  if (book) {
    const { data, error } = await getSupabaseAdmin().from('audiobook_chapters_v2').select(ITEM_COLUMNS).eq('audiobook_id', book.id);
    if (error) return bad(res, 500, 'DB_ERROR', error.message);
    rows.push(...((data ?? []) as unknown as ItemRow[]));
  }
  const rowOf = (kind: string, n: number) => rows.find((r) => r.kind === kind && Number(r.chapter_number) === n);

  const planned = plan?.items ?? [];
  const sampleRow = rowOf('sample', 0);
  const urls = await signedUrls(rows.filter((r) => r.status === 'ready' && r.storage_path).map((r) => r.storage_path!));
  const now = Date.now();

  let ordinal = 0;
  const items = planned.map((p) => {
    const row = rowOf(p.kind, p.chapter_number);
    const filename = filenameFor(p, ordinal);
    ordinal += 1;
    const eff = row ? effectiveStatus(row, now) : null;
    const url = row?.status === 'ready' && row.storage_path ? (urls.get(row.storage_path) ?? null) : null;
    return {
      id: row?.id ?? null,
      kind: p.kind,
      chapter_number: p.chapter_number,
      position: p.position,
      title: p.title,
      words: p.words,
      status: eff?.status ?? 'none',
      error: eff?.error ?? null,
      // Ready, but the words, the voice or the direction are not what it was recorded from.
      stale: Boolean(row && row.status === 'ready' && row.text_hash !== hashItem(p, settings)),
      duration_s: row?.duration_s != null ? Number(row.duration_s) : null,
      size_bytes: row?.size_bytes != null ? Number(row.size_bytes) : null,
      rms_db: row?.rms_db != null ? Number(row.rms_db) : null,
      peak_db: row?.peak_db != null ? Number(row.peak_db) : null,
      spec_ok: row?.spec_ok ?? null,
      url,
      download_url: url ? `${url}&download=${encodeURIComponent(filename)}` : null,
      filename,
    };
  });

  const firstChapter = items.find((i) => i.kind === 'chapter');
  const sampleUrl = sampleRow?.status === 'ready' && sampleRow.storage_path ? (urls.get(sampleRow.storage_path) ?? null) : null;
  const sampleEff = sampleRow ? effectiveStatus(sampleRow, now) : null;
  const sample = {
    id: sampleRow?.id ?? null,
    status: sampleEff?.status ?? 'none',
    error: sampleEff?.error ?? null,
    duration_s: sampleRow?.duration_s != null ? Number(sampleRow.duration_s) : null,
    size_bytes: sampleRow?.size_bytes != null ? Number(sampleRow.size_bytes) : null,
    spec_ok: sampleRow?.spec_ok ?? null,
    url: sampleUrl,
    download_url: sampleUrl ? `${sampleUrl}&download=${encodeURIComponent('Retail Sample.mp3')}` : null,
    can_build: firstChapter?.status === 'ready',
  };

  const needs = (i: (typeof items)[number]) => i.status === 'none' || i.status === 'failed' || i.stale;
  const toBuild = items.filter(needs);
  const summary = {
    total: items.length,
    ready: items.filter((i) => i.status === 'ready' && !i.stale).length,
    building: items.filter((i) => i.status === 'building' || i.status === 'queued').length,
    failed: items.filter((i) => i.status === 'failed').length,
    stale: items.filter((i) => i.stale).length,
    missing: items.filter((i) => i.status === 'none').length,
    duration_s: items.reduce((n, i) => n + (i.status === 'ready' ? (i.duration_s ?? 0) : 0), 0),
    size_bytes: items.reduce((n, i) => n + (i.status === 'ready' ? (i.size_bytes ?? 0) : 0), 0),
    out_of_spec: items.filter((i) => i.status === 'ready' && i.spec_ok === false).length,
  };

  // The single-file audiobook (.m4b): what it is, whether it still matches the recordings.
  const ex = book ? await findExport(book.id) : null;
  const exQuality = normalizeQuality(ex?.export_quality);
  const planKeys = new Set(planned.map((p) => `${p.kind}:${p.chapter_number}`));
  const forExport = rows.filter((r) => planKeys.has(`${r.kind}:${r.chapter_number}`) && r.status === 'ready' && r.kind !== 'sample');
  const allReady = planned.length > 0 && items.every((i) => i.status === 'ready' && !i.stale);
  const exAge = ex?.export_updated_at ? now - new Date(ex.export_updated_at).getTime() : 0;
  const exStatus =
    ex?.export_status === 'building' && exAge > BUILDING_STALE_MS ? 'failed'
      : ex?.export_status === 'queued' && exAge > QUEUED_STALE_MS ? 'failed'
        : (ex?.export_status ?? 'none');
  const singleFile = {
    status: exStatus,
    error: exStatus === 'failed' && ex?.export_status !== 'failed' ? 'The build stopped before it finished — make the file again.' : (ex?.export_error ?? null),
    bytes: ex?.export_bytes != null ? Number(ex.export_bytes) : null,
    duration_s: ex?.export_duration_s != null ? Number(ex.export_duration_s) : null,
    chapters: ex?.export_chapters ?? null,
    quality: exQuality,
    filename: exportFileName(plan?.title ?? source.title),
    // Made from recordings that have since been re-narrated (or a different size was asked for).
    stale: Boolean(ex?.export_status === 'ready' && ex.export_hash !== exportFingerprint(forExport, exQuality)),
    can_build: allReady,
    qualities: EXPORT_QUALITIES,
    default_quality: DEFAULT_EXPORT_QUALITY,
  };

  // The book's cover (chosen or newest) and the square one already made from it.
  const cover = await findCover(getSupabaseAdmin(), pid(req), await outlineOf(req.userId!, pid(req)), volume.data).catch(() => null);
  const coverSigned = book ? (await signedUrls([coverPath(req.userId!, book.id)])).get(coverPath(req.userId!, book.id)) : undefined;

  res.json({
    success: true,
    data: {
      volume: volume.data,
      volumes: plan?.volumes ?? 1,
      title: plan?.title ?? source.title,
      author: plan?.author ?? source.author,
      buildable: Boolean(plan),
      settings,
      items,
      sample,
      summary,
      single_file: singleFile,
      cost: {
        own_account: ownAccount,
        credits_per_unit: unitCost,
        unit_words: CREDIT_WORDS,
        to_build_credits: narrationUnits(planned.filter((p) => toBuild.some((i) => i.kind === p.kind && i.chapter_number === p.chapter_number))) * unitCost,
        total_credits: narrationUnits(planned) * unitCost,
      },
      cover: { available: Boolean(cover), url: coverSigned ?? null },
    },
  });
});

// ---------------------------------------------------------------------------- writes

audiobookRouter.put('/project/:projectId/settings', validateBody(SettingsBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const body = req.body as z.infer<typeof SettingsBody>;
  const current = settingsOf(await findBook(req.userId!, pid(req), body.volume));
  const next = normalizeSettings({ ...current, ...stripUndefined(body) });
  const book = await ensureBook(req.userId!, pid(req), body.volume, next);
  res.json({ success: true, data: { id: book.id, settings: next } });
});

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

audiobookRouter.post('/project/:projectId/preview', previewLimiter, validateBody(SettingsBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const body = req.body as z.infer<typeof SettingsBody>;
  const book = await findBook(req.userId!, pid(req), body.volume);
  const s = normalizeSettings({ ...settingsOf(book), ...stripUndefined(body) });
  const plan = planAudiobook(source, body.volume, s);
  // The author hears their own book: the opening of the first chapter.
  const first = plan?.items.find((i) => i.kind === 'chapter');
  if (!first) return bad(res, 422, 'NO_CHAPTERS', 'This book has no chapter text to read yet.');
  try {
    const out = await callEngineWriteToolSync<{ audio_b64: string; content_type: string }>('media', {
      op: 'audiobook-preview',
      user_id: req.userId!,
      voice: s.voice,
      style: s.style,
      custom_style: s.custom_style,
      text: body.say?.trim() || first.source_text.slice(0, 1200),
      pronunciations: s.pronunciations,
      provider: s.provider,
    });
    res.json({ success: true, data: { audio_b64: out.audio_b64, content_type: out.content_type ?? 'audio/mpeg' } });
  } catch (err) {
    logger.error({ err }, 'audiobook: preview failed');
    bad(res, 502, 'PREVIEW_FAILED', err instanceof Error ? err.message : 'Could not make the preview.');
  }
});

/** Queue the engine job for one recording row. Returns false when the engine could not be reached. */
async function queueItem(userId: string, row: { id: string }, tags: Record<string, string>): Promise<boolean> {
  const sb = getSupabaseAdmin();
  try {
    const job = await callEngineWriteTool('media', { op: 'audiobook-chapter', item_id: row.id, user_id: userId, tags, async: true });
    await sb.from('audiobook_chapters_v2').update({ engine_job_id: job.job_id ?? null, updated_at: new Date().toISOString() }).eq('id', row.id);
    return true;
  } catch (err) {
    logger.error({ err, item: row.id }, 'audiobook: could not queue recording');
    await sb
      .from('audiobook_chapters_v2')
      .update({ status: 'failed', error: 'The narration service could not be reached — try again.', updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return false;
  }
}

function tagsFor(plan: { title: string; author: string }, p: PlannedItem, ordinal: number): Record<string, string> {
  return { album: plan.title, artist: plan.author, album_artist: plan.author, track: String(ordinal + 1), title: p.title };
}

audiobookRouter.post('/project/:projectId/build', validateBody(BuildBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const body = req.body as z.infer<typeof BuildBody>;
  const userId = req.userId!;
  const book = await ensureBook(userId, pid(req), body.volume);
  const settings = settingsOf(book);
  const plan = planAudiobook(source, body.volume, settings);
  if (!plan) return bad(res, 422, 'NO_CHAPTERS', 'This book has no chapter text to narrate yet.');

  const sb = getSupabaseAdmin();
  const { data: existingRows, error: readErr } = await sb.from('audiobook_chapters_v2').select(ITEM_COLUMNS).eq('audiobook_id', book.id);
  if (readErr) return bad(res, 500, 'DB_ERROR', readErr.message);
  const rows = (existingRows ?? []) as unknown as ItemRow[];
  const now = Date.now();

  const picked = body.item_ids?.length ? new Set(body.item_ids) : null;
  const todo: { item: PlannedItem; ordinal: number; hash: string }[] = [];
  let skippedBusy = 0;
  plan.items.forEach((item, ordinal) => {
    const row = rows.find((r) => r.kind === item.kind && Number(r.chapter_number) === item.chapter_number);
    const hash = hashItem(item, settings);
    if (picked && (!row || !picked.has(row.id))) return;
    // Already on its way: building it twice would be paid for twice.
    const state = row ? effectiveStatus(row, now).status : null;
    if (state === 'queued' || state === 'building') {
      skippedBusy += 1;
      return;
    }
    if (!picked && row && row.status === 'ready' && row.text_hash === hash) return;
    todo.push({ item, ordinal, hash });
  });

  if (!todo.length) {
    return res.json({ success: true, data: { queued: 0, skipped_in_progress: skippedBusy, credits_charged: 0 } });
  }

  const unitCost = settings.provider === 'elevenlabs' ? 0 : await getCreditCost('audiobook_narration');
  const cost = narrationUnits(todo.map((t) => t.item)) * unitCost;
  if (refuseIfInsufficient(req, res, cost)) return;

  // Square cover first (cheap, and the screen shows it), never a reason not to narrate.
  await makeCover(req, book.id, body.volume).catch((err) => logger.warn({ err }, 'audiobook: cover not made'));

  let queued = 0;
  let queuedUnits = 0;
  for (const { item, ordinal, hash } of todo) {
    const { data: saved, error } = await sb
      .from('audiobook_chapters_v2')
      .upsert(
        {
          audiobook_id: book.id,
          kind: item.kind,
          chapter_number: item.chapter_number,
          position: item.position,
          title: item.title,
          source_text: item.source_text,
          text_hash: hash,
          voice: settings.voice,
          style_hash: styleHash(settings),
          status: 'queued',
          error: null,
          chars: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'audiobook_id,kind,chapter_number' },
      )
      .select('id')
      .single();
    if (error || !saved) {
      logger.error({ err: error }, 'audiobook: could not write recording row');
      continue;
    }
    if (await queueItem(userId, saved as { id: string }, tagsFor(plan, item, ordinal))) {
      queued += 1;
      queuedUnits += narrationUnits([item]);
    }
  }

  // Charged for what was actually started: a recording the engine could not take costs nothing.
  const charged = chargeable(req) && queuedUnits > 0 ? queuedUnits * unitCost : 0;
  if (charged > 0) await deductCredits(userId, charged, `audiobook.narrate:${pid(req)}`);
  res.status(202).json({ success: true, data: { queued, skipped_in_progress: skippedBusy, credits_charged: charged } });
});

/** Names that appear often in the chapters and are not in the guide yet — where mispronunciations hide. */
audiobookRouter.get('/project/:projectId/names', async (req: Request, res: Response) => {
  const volume = VolumeQuery.safeParse(req.query.volume);
  if (!volume.success) return bad(res, 400, 'VALIDATION', 'volume must be 1-12');
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const book = await findBook(req.userId!, pid(req), volume.data);
  const s = settingsOf(book);
  const plan = planAudiobook(source, volume.data, s);
  const names = suggestNames(
    (plan?.items ?? []).filter((i) => i.kind === 'chapter').map((i) => `${i.title}.\n${i.source_text}`),
    s.pronunciations.map((p) => p.word),
  );
  res.json({ success: true, data: { names } });
});

/** Join the finished recordings into ONE .m4b (chapters, cover and title inside) for a player's link import. */
audiobookRouter.post('/project/:projectId/export', validateBody(ExportBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const body = req.body as z.infer<typeof ExportBody>;
  const book = await findBook(req.userId!, pid(req), body.volume);
  if (!book) return bad(res, 422, 'NOT_BUILT', 'Build the audiobook first.');
  const settings = settingsOf(book);
  const plan = planAudiobook(source, body.volume, settings);
  if (!plan) return bad(res, 422, 'NO_CHAPTERS', 'This book has no chapter text to narrate yet.');
  const sb = getSupabaseAdmin();
  const { data: rowData, error } = await sb.from('audiobook_chapters_v2').select(ITEM_COLUMNS).eq('audiobook_id', book.id);
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  const rows = (rowData ?? []) as unknown as ItemRow[];
  const used: ItemRow[] = [];
  for (const item of plan.items) {
    const row = rows.find((r) => r.kind === item.kind && Number(r.chapter_number) === item.chapter_number);
    if (!row || row.status !== 'ready' || row.text_hash !== hashItem(item, settings)) {
      return bad(res, 422, 'NOT_READY', `“${item.title}” is not built (or has changed since it was recorded). Build every recording first.`);
    }
    used.push(row);
  }
  const cur = await findExport(book.id);
  if (cur && (cur.export_status === 'queued' || cur.export_status === 'building')) {
    const age = Date.now() - new Date(cur.export_updated_at ?? 0).getTime();
    if (age < (cur.export_status === 'building' ? BUILDING_STALE_MS : QUEUED_STALE_MS)) {
      return res.json({ success: true, data: { queued: false, already_running: true } });
    }
  }
  const quality = normalizeQuality(body.quality);
  const fingerprint = exportFingerprint(used, quality);
  await sb.from('audiobooks_v2').update({ export_status: 'queued', export_error: null, export_quality: quality, export_updated_at: new Date().toISOString() }).eq('id', book.id);
  try {
    await callEngineWriteTool('media', {
      op: 'audiobook-export', audiobook_id: book.id, user_id: req.userId!, fingerprint, quality,
      tags: { album: plan.title, artist: plan.author }, async: true,
    });
  } catch (err) {
    logger.error({ err }, 'audiobook: could not queue export');
    await sb.from('audiobooks_v2').update({ export_status: 'failed', export_error: 'The narration service could not be reached — try again.', export_updated_at: new Date().toISOString() }).eq('id', book.id);
    return bad(res, 502, 'ENGINE_UNREACHABLE', 'The narration service could not be reached — try again.');
  }
  res.status(202).json({ success: true, data: { queued: true, quality } });
});

/** A fresh link to the stored .m4b, valid for a week, that a player can import from. */
audiobookRouter.post('/project/:projectId/export/link', validateBody(VolumeBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const { volume } = req.body as z.infer<typeof VolumeBody>;
  const book = await findBook(req.userId!, pid(req), volume);
  const ex = book ? await findExport(book.id) : null;
  if (!book || !ex || ex.export_status !== 'ready' || !ex.export_path) {
    return bad(res, 422, 'NO_EXPORT', 'Make the single-file audiobook first.');
  }
  const filename = ex.export_path.split('/').pop() ?? exportFileName(source.title);
  const { data, error } = await getSupabaseAdmin().storage.from(BUCKET).createSignedUrl(ex.export_path, EXPORT_LINK_SECONDS, { download: filename });
  if (error || !data?.signedUrl) return bad(res, 500, 'LINK_FAILED', 'Could not make the link.');
  res.json({ success: true, data: { url: data.signedUrl, filename, expires_at: new Date(Date.now() + EXPORT_LINK_SECONDS * 1000).toISOString() } });
});

audiobookRouter.post('/project/:projectId/sample', validateBody(VolumeBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const { volume } = req.body as z.infer<typeof VolumeBody>;
  const book = await findBook(req.userId!, pid(req), volume);
  if (!book) return bad(res, 422, 'NOT_BUILT', 'Build the first chapter before the retail sample.');
  const plan = planAudiobook(source, volume, settingsOf(book));
  if (!plan) return bad(res, 422, 'NO_CHAPTERS', 'This book has no chapter text to narrate yet.');
  const sb = getSupabaseAdmin();
  const { data: first } = await sb
    .from('audiobook_chapters_v2')
    .select('id')
    .eq('audiobook_id', book.id)
    .eq('kind', 'chapter')
    .eq('status', 'ready')
    .order('position')
    .limit(1)
    .maybeSingle();
  if (!first) return bad(res, 422, 'NOT_BUILT', 'Build the first chapter before the retail sample.');
  const { data: saved, error } = await sb
    .from('audiobook_chapters_v2')
    .upsert(
      {
        audiobook_id: book.id,
        kind: 'sample',
        chapter_number: 0,
        position: SAMPLE_POSITION,
        title: 'Retail sample',
        source_text: '',
        text_hash: '',
        voice: book.voice,
        status: 'queued',
        error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'audiobook_id,kind,chapter_number' },
    )
    .select('id')
    .single();
  if (error || !saved) return bad(res, 500, 'DB_ERROR', error?.message ?? 'Could not queue the sample.');
  const ok = await queueItem(req.userId!, saved as { id: string }, { album: plan.title, artist: plan.author, album_artist: plan.author, title: 'Retail sample' });
  if (!ok) return bad(res, 502, 'ENGINE_UNREACHABLE', 'The narration service could not be reached — try again.');
  res.status(202).json({ success: true, data: { queued: 1 } });
});

/** Make the square cover from the book's chosen cover and store it. Returns false when there is no cover. */
async function makeCover(req: Request, bookId: string, volume: number): Promise<boolean> {
  const sb = getSupabaseAdmin();
  const row = await findCover(sb, pid(req), await outlineOf(req.userId!, pid(req)), volume);
  const art = await downloadCover(sb, row);
  if (!art?.length) return false;
  const jpeg = await squareCover(art);
  const { error } = await sb.storage.from(BUCKET).upload(coverPath(req.userId!, bookId), jpeg, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(error.message);
  return true;
}

audiobookRouter.post('/project/:projectId/cover', validateBody(VolumeBody), async (req: Request, res: Response) => {
  const source = await ownedSource(req, res, pid(req));
  if (!source) return;
  const { volume } = req.body as z.infer<typeof VolumeBody>;
  const book = await ensureBook(req.userId!, pid(req), volume);
  try {
    if (!(await makeCover(req, book.id, volume))) {
      return bad(res, 422, 'NO_COVER_ART', 'Choose cover art for the project first — the audiobook cover is made from it.');
    }
  } catch (err) {
    logger.error({ err }, 'audiobook: cover failed');
    return bad(res, 500, 'COVER_FAILED', 'Could not make the cover.');
  }
  const url = (await signedUrls([coverPath(req.userId!, book.id)])).get(coverPath(req.userId!, book.id)) ?? null;
  res.json({ success: true, data: { url } });
});
