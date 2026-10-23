/**
 * Finding real photographs in real archives.
 *
 * WHAT THIS IS NOT. It is not image generation. Everything else in this system that produces a
 * picture invents one; this searches catalogues for photographs that were actually taken of actual
 * people and places, and it is useless unless every result can be traced back to the institution
 * holding the original. A picture captioned "Piscataway elder, 1940s" with no catalogue number is
 * worth less than nothing in a book that is about who gets to be documented.
 *
 * SO EVERY RESULT CARRIES ITS PROVENANCE: which archive, which collection or catalogue id, who took
 * it, when, under what licence, and the page where a human can check all of that. Where the rights
 * are unclear the result says so rather than being quietly dropped or quietly presented as usable —
 * "rights unknown" is a finding, not a failure.
 *
 * WHY NOT THE ENGINE. This is three JSON APIs and a normaliser. No model is involved and nothing
 * here benefits from a queue, so putting it behind one would only add a poll loop to a search box.
 *
 * SOURCES, and why these:
 *   - Wikimedia Commons — no key, and its `extmetadata` carries licence, author, date and credit
 *     per file, which is exactly the shape this needs.
 *   - Library of Congress — no key, and holds the American documentary photography collections.
 *   - Smithsonian Open Access — needs a free api.data.gov key, and is narrower than it sounds.
 *     Its search index serves MUSEUM OBJECT and SPECIMEN records. The Smithsonian's archives are
 *     not in it: unit_code:NAA, EEPA, HSFA and AAA all return zero, while NMAI returns 237,752 and
 *     NMNHANTHRO 529,665. So the National Anthropological Archives photo lots — which is where the
 *     photographs of Turkey Tayac actually are — cannot be reached this way at all. They are
 *     catalogued on SOVA, which blocks automated requests. What the key does buy is the museum
 *     collections, and those are not a consolation prize: the same search returns the eel skin
 *     Turkey Tayac made and used around 1960, NMAI catalogue 26/2957.
 */

import { logger } from './logger.js';

export type ArchiveId = 'wikimedia' | 'loc' | 'smithsonian';

export interface ArchiveImage {
  source: ArchiveId;
  /** Stable id within that archive — a filename, a LoC item id, a Smithsonian record id. */
  source_id: string;
  title: string;
  description: string;
  /** Photographer or creating body, verbatim from the catalogue. Empty when the record has none. */
  creator: string;
  /** As the catalogue states it: "1935", "circa 1946", "1978-10-29". Never normalised into a guess. */
  date_taken: string;
  institution: string;
  /** Collection, photo lot or catalogue reference — how a human asks for the original. */
  collection_ref: string;
  license: string;
  license_url: string;
  /** The catalogue page. The only link that is guaranteed to still be meaningful in ten years. */
  source_page_url: string;
  /** Direct file, when the archive publishes one. */
  image_url: string;
  thumb_url: string;
  width: number | null;
  height: number | null;
  /**
   * Whether this may be reproduced without asking. Deliberately conservative: anything not clearly
   * public domain or an open Creative Commons licence is 'check' — including records that say
   * nothing, which is most of an archive.
   */
  reuse: 'open' | 'check';
}

export interface ArchiveSearchResult {
  images: ArchiveImage[];
  /** Per archive: how it went. A source that failed must not look like a source with no results. */
  sources: { source: ArchiveId; searched: boolean; found: number; note?: string }[];
}

const UA = 'WritersWorkbench/1.0 (archival image research; +https://writersworkbench.app)';

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Catalogue prose is full of markup and entities; a caption is not the place for either. */
function plain(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Open enough to reproduce without asking anyone.
 *
 * The list is short on purpose. "No known restrictions" is not a licence, CC-BY-NC is not usable in
 * a book that is for sale, and a blank rights field means nobody has checked. All of those come
 * back as 'check', which costs the author an email and saves them a rights claim.
 */
function classifyLicense(license: string): 'open' | 'check' {
  const l = license.toLowerCase();
  if (!l) return 'check';
  if (l.includes('public domain') || l === 'pd' || l.startsWith('pd-')) return 'open';
  if (/\bcc0\b/.test(l)) return 'open';
  if (/\bcc[ -]?by(?![ -]?n)/.test(l)) return 'open'; // CC-BY and CC-BY-SA; excludes any NC
  return 'check';
}

// ------------------------------------------------------------------------------------------------
// Wikimedia Commons
// ------------------------------------------------------------------------------------------------

interface CommonsPage {
  title?: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    extmetadata?: Record<string, { value?: unknown }>;
  }[];
}

async function searchCommons(query: string, limit: number): Promise<ArchiveImage[]> {
  // generator=search in namespace 6 (File:) gets the files and their metadata in one call, rather
  // than a search followed by a fetch per result.
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}` +
    '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=400';
  const body = (await getJson(url)) as { query?: { pages?: Record<string, CommonsPage> } };
  const pages = Object.values(body.query?.pages ?? {});
  const out: ArchiveImage[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata ?? {};
    const field = (key: string): string => plain(meta[key]?.value);
    const license = field('LicenseShortName') || field('UsageTerms');
    out.push({
      source: 'wikimedia',
      source_id: plain(page.title),
      title: plain(page.title).replace(/^File:/, '').replace(/\.(jpe?g|png|tiff?|gif)$/i, ''),
      description: field('ImageDescription').slice(0, 600),
      creator: field('Artist'),
      date_taken: field('DateTimeOriginal') || field('DateTime'),
      institution: field('Credit') || 'Wikimedia Commons',
      collection_ref: '',
      license,
      license_url: plain(meta.LicenseUrl?.value),
      source_page_url: info.descriptionurl ?? '',
      image_url: info.url,
      thumb_url: info.thumburl ?? info.url,
      width: info.width ?? null,
      height: info.height ?? null,
      reuse: classifyLicense(license),
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Library of Congress
// ------------------------------------------------------------------------------------------------

interface LocResult {
  id?: string;
  title?: string;
  description?: unknown;
  date?: string;
  contributor?: string[];
  rights?: string;
  rights_advisory?: string[];
  url?: string;
  image_url?: string[];
  partof?: string[];
}

async function searchLoc(query: string, limit: number): Promise<ArchiveImage[]> {
  const url =
    `https://www.loc.gov/photos/?q=${encodeURIComponent(query)}&fo=json&c=${limit}&at=results`;
  const body = (await getJson(url)) as { results?: LocResult[] };
  const out: ArchiveImage[] = [];
  for (const r of body.results ?? []) {
    const images = r.image_url ?? [];
    if (!images.length) continue;
    const rights = plain(r.rights ?? (r.rights_advisory ?? []).join('; '));
    const description = Array.isArray(r.description)
      ? plain((r.description as unknown[]).join(' '))
      : plain(r.description);
    out.push({
      source: 'loc',
      source_id: plain(r.id ?? r.url),
      title: plain(r.title),
      description: description.slice(0, 600),
      creator: plain((r.contributor ?? []).join('; ')),
      date_taken: plain(r.date),
      institution: 'Library of Congress',
      collection_ref: plain((r.partof ?? []).slice(0, 2).join('; ')),
      license: rights,
      license_url: '',
      source_page_url: plain(r.url),
      // LoC lists its derivatives smallest-first; the last is the largest available.
      image_url: plain(images[images.length - 1]),
      thumb_url: plain(images[0]),
      width: null,
      height: null,
      reuse: classifyLicense(rights),
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Smithsonian Open Access
// ------------------------------------------------------------------------------------------------

interface SiRow {
  id?: string;
  title?: string;
  content?: {
    descriptiveNonRepeating?: {
      unit_code?: string;
      record_link?: string;
      online_media?: { media?: { content?: string; thumbnail?: string }[] };
      data_source?: string;
    };
    freetext?: {
      name?: { content?: string }[];
      date?: { content?: string }[];
      notes?: { content?: string }[];
      setName?: { content?: string }[];
    };
    indexedStructured?: { usage_flag?: string[] };
  };
}

/**
 * Natural-history divisions, excluded from an image search about people and places.
 *
 * They match on PLACE NAMES and swamp everything else: "Piscataway" returns 684 records of which
 * entomology, herpetology, botany and birds account for the largest share — beetles and sedges
 * collected at Piscataway Creek, not anything to do with the Piscataway people. A specimen record
 * is a real record; it is just never the answer to "is there a photograph of these people".
 */
const SPECIMEN_UNITS = new Set([
  'NMNHBIRDS',
  'NMNHBOTANY',
  'NMNHENTO',
  'NMNHFISHES',
  'NMNHHERPS',
  'NMNHINV',
  'NMNHMAMMALS',
  'NMNHMINSCI',
  'NMNHPALEO',
]);

async function searchSmithsonian(query: string, limit: number, apiKey: string): Promise<ArchiveImage[]> {
  // `AND online_media_type:"Images"` is honoured and halves the noise — on "Piscataway" it takes
  // 684 records down to 188, all of them with a picture attached. Verified against the live API;
  // the neighbouring `online_visual_material:true` is NOT the same filter and returns specimens.
  const q = `${query} AND online_media_type:"Images"`;
  const url =
    'https://api.si.edu/openaccess/api/v1.0/search?' +
    `q=${encodeURIComponent(q)}&rows=${limit}&api_key=${encodeURIComponent(apiKey)}`;
  const body = (await getJson(url, 25_000)) as { response?: { rows?: SiRow[] } };
  const out: ArchiveImage[] = [];
  for (const row of body.response?.rows ?? []) {
    const d = row.content?.descriptiveNonRepeating;
    const f = row.content?.freetext;
    if (SPECIMEN_UNITS.has(String(d?.unit_code ?? ''))) continue;
    const media = d?.online_media?.media?.[0];
    // CC0 is the Smithsonian's own flag for its open-access material. Everything else — which is
    // most of the National Anthropological Archives — is a catalogue reference, not a usable file.
    const cc0 = (row.content?.indexedStructured?.usage_flag ?? []).includes('CC0');
    out.push({
      source: 'smithsonian',
      source_id: plain(row.id),
      title: plain(row.title),
      description: plain((f?.notes ?? []).map((n) => n.content).join(' ')).slice(0, 600),
      creator: plain((f?.name ?? []).map((n) => n.content).join('; ')),
      date_taken: plain((f?.date ?? []).map((n) => n.content).join('; ')),
      institution: plain(d?.data_source || d?.unit_code || 'Smithsonian Institution'),
      collection_ref: plain((f?.setName ?? []).map((n) => n.content).join('; ')),
      license: cc0 ? 'CC0' : 'Rights not stated in the open-access record',
      license_url: cc0 ? 'https://creativecommons.org/publicdomain/zero/1.0/' : '',
      source_page_url: plain(d?.record_link),
      image_url: plain(media?.content),
      thumb_url: plain(media?.thumbnail || media?.content),
      width: null,
      height: null,
      reuse: cc0 ? 'open' : 'check',
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  /** Which archives to ask. Defaults to all that are configured. */
  sources?: ArchiveId[];
  perSource?: number;
}

/**
 * Search the archives.
 *
 * Every source is asked independently and a failure in one is reported rather than thrown: an
 * archive being down is a fact about that archive, and returning nothing at all because the
 * Smithsonian timed out would hide the forty results Commons had.
 */
export async function searchArchives(opts: SearchOptions): Promise<ArchiveSearchResult> {
  const query = opts.query.trim();
  const perSource = Math.min(Math.max(opts.perSource ?? 12, 1), 40);
  const siKey = process.env.SMITHSONIAN_API_KEY || '';
  const requested = opts.sources?.length ? opts.sources : (['wikimedia', 'loc', 'smithsonian'] as ArchiveId[]);

  const sources: ArchiveSearchResult['sources'] = [];
  const images: ArchiveImage[] = [];

  const run = async (
    id: ArchiveId,
    fn: () => Promise<ArchiveImage[]>,
    skip?: string,
  ): Promise<void> => {
    if (!requested.includes(id)) return;
    if (skip) {
      sources.push({ source: id, searched: false, found: 0, note: skip });
      return;
    }
    try {
      const found = await fn();
      images.push(...found);
      sources.push({ source: id, searched: true, found: found.length });
    } catch (err) {
      const note = err instanceof Error ? err.message : 'failed';
      logger.warn({ err, source: id, query }, 'image-archives: source failed');
      sources.push({ source: id, searched: true, found: 0, note: `could not be reached (${note})` });
    }
  };

  await Promise.all([
    run('wikimedia', () => searchCommons(query, perSource)),
    run('loc', () => searchLoc(query, perSource)),
    run(
      'smithsonian',
      () => searchSmithsonian(query, perSource, siKey),
      siKey
        ? undefined
        : 'no SMITHSONIAN_API_KEY set — museum collections cannot be searched without one ' +
          '(free at api.data.gov/signup). Note that the Smithsonian ARCHIVES, including the ' +
          'National Anthropological Archives photo lots, are not in this API at all and have to ' +
          'be searched by hand at sova.si.edu.',
    ),
  ]);

  // Openly licensed first: those are the ones usable today. Within that, the archive order above.
  images.sort((a, b) => (a.reuse === b.reuse ? 0 : a.reuse === 'open' ? -1 : 1));
  logger.info({ query, total: images.length, sources }, 'image-archives: searched');
  return { images, sources };
}
