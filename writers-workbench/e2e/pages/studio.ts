/**
 * Content Studio fixtures (migration 050), scoped to one run:
 *   - a disposable edition `e2e-studio-<RUN_TAG>` owned by the demo user, fed by the demo user's Dev
 *     Radar through a `radar://dev` source (so it is a studio edition; the real ai-mvp /
 *     ai-dev-roundup editions are never touched);
 *   - three Dev Radar topics in a fake week far in the past (a random 1990s Monday), so they never mix
 *     with a real slate and every studio read for that week sees only them;
 *   - optional seeded drafts / posted posts tagged `e2e-<RUN_TAG>-…`;
 *   - a throwaway second user (auth user + users_v2 row) for the non-owner checks.
 * Teardown deletes exactly those rows.
 */
import { DEMO_USER_ID, RUN_TAG, getToken, hardDeleteEdition, seedEdition, seedFeed, supaDelete, supaGet, supaInsert, supaRemoveObject } from './api';

const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const SUPA_SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';
const BASE = (process.env.E2E_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

export const STUDIO_EDITION = `e2e-studio-${RUN_TAG}`.toLowerCase();

/** A Monday in the 1990s, different per run. */
export function fakeWeek(): string {
  const d = new Date(Date.UTC(1990, 0, 1) + 7 * 86_400_000 * Math.floor(Math.random() * 500));
  return d.toISOString().slice(0, 10);
}

export interface StudioFixture {
  edition: string;
  week: string;
  topics: Array<{ id: string; rank: number; title: string; url: string }>;
}

/** Real, public sources for Trend Radar topics: the blog prompt grounds the post in them. */
const TREND_TOPICS = [
  {
    title: 'Anthropic makes prompt caching generally available for Claude',
    url: 'https://www.anthropic.com/news/prompt-caching',
    angle: 'Cheaper, faster long-context apps for MVP builders',
    summary: 'Prompt caching is generally available on the Claude API: repeated long prompt prefixes are cached, '
      + 'cutting cost by up to 90% and latency by up to 85% for long prompts.',
  },
];

export async function seedStudio(
  edition = STUDIO_EDITION,
  opts: { radar?: 'dev' | 'trend'; viaApi?: boolean } = {},
): Promise<StudioFixture> {
  const radar = opts.radar ?? 'dev';
  if (opts.viaApi) {
    // The real create route: it also seeds the edition's default template, which rendering an issue needs.
    const made = await apiAs(await getToken(), 'POST', '/api/newsletter/editions', {
      id: edition, display_name: `E2E Studio ${RUN_TAG}`, newsletter_name: `E2E Studio ${RUN_TAG}`,
      genre: 'ai-marketing', subheader: 'Disposable regression edition',
    });
    if (made.status !== 201) throw new Error(`create edition ${made.status}: ${made.text.slice(0, 200)}`);
  } else {
    await seedEdition(edition, `E2E Studio ${RUN_TAG}`);
  }
  await seedFeed({ edition_id: edition, name: radar === 'trend' ? 'Trend Radar' : 'Dev Radar', url: `radar://${radar}`, url_type: 'radar' });
  const week = fakeWeek();
  const topics = [];
  if (radar === 'trend') {
    for (const [i, t] of TREND_TOPICS.entries()) {
      const title = `E2E ${RUN_TAG}: ${t.title}`;
      const row = await supaInsert<{ id: string }>('radar_topics_v2', {
        user_id: DEMO_USER_ID, radar: 'trend', week_of: week, rank: i + 1, title, url: t.url,
        source: 'E2E', item_type: 'article', angle: t.angle, category: 'AI', summary: t.summary,
      });
      topics.push({ id: row.id, rank: i + 1, title, url: t.url });
    }
    return { edition, week, topics };
  }
  for (const [rank, kind] of [[1, 'article'], [2, 'video'], [3, 'article']] as Array<[number, string]>) {
    const url = kind === 'video' ? `https://www.youtube.com/watch?v=e2e${RUN_TAG}${rank}` : `https://example.com/e2e-${RUN_TAG}/${rank}`;
    const row = await supaInsert<{ id: string }>('radar_topics_v2', {
      user_id: DEMO_USER_ID, radar: 'dev', week_of: week, rank, title: `E2E ${RUN_TAG} topic ${rank}`, url,
      source: 'E2E', item_type: kind, angle: `Angle ${rank}: why developers care`, category: 'AI',
      summary: `A short summary of E2E topic ${rank} for the studio test.`,
    });
    topics.push({ id: row.id, rank, title: `E2E ${RUN_TAG} topic ${rank}`, url });
  }
  return { edition, week, topics };
}

/** The next Thursday in US Eastern after today (what "Thursday" means to the studio). */
export function nextThursdayEt(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  const ahead = ((4 - d.getUTCDay() + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}

export async function seedStudioPost(fx: StudioFixture, fields: {
  title: string;
  state: 'draft' | 'approved' | 'posted' | 'pending';
  topicId?: string;
  linkedin?: string;
  scheduledAt?: string;
  imageUrl?: string;
  channels?: string[];
}): Promise<{ id: string; display_number: number }> {
  const dated = fields.state === 'posted' || fields.state === 'pending';
  const at = fields.scheduledAt ?? new Date(Date.now() - 3600_000).toISOString();
  return supaInsert('social_schedule_v2', {
    user_id: DEMO_USER_ID, external_id: `e2e-${RUN_TAG}-${Math.random().toString(36).slice(2, 7)}`,
    edition_id: fx.edition, title: fields.title, body_md: '',
    linkedin_content: fields.linkedin ?? `${fields.title}\n🔗 Read: https://example.com/e2e\n💬 Want these every week? Comment 'newsletter' and we'll add you.\n#AI #E2E`,
    channels: fields.channels ?? ['li_personal'], state: fields.state, source: 'studio', item_type: 'article',
    include_image: Boolean(fields.imageUrl), image_url: fields.imageUrl ?? null,
    radar_topic_id: fields.topicId ?? null, source_url: 'https://example.com/e2e',
    scheduled_date: dated ? at.slice(0, 10) : null, slot: 'morning', scheduled_at: dated ? at : null,
    post_at: dated ? at : null, posted_at: fields.state === 'posted' ? at : null,
  });
}

export async function cleanupStudio(fx: StudioFixture | null): Promise<void> {
  if (!fx) return;
  const ed = encodeURIComponent(fx.edition);
  // Stories the newsletter run wrote for this edition (keys end ".<edition>"), with their blobs.
  const stories = await supaGet<{ id: string; storage_path_md: string; storage_path_html: string }>(
    'content_ingestion_v2', `key=like.*.${ed}&select=id,storage_path_md,storage_path_html`).catch(() => []);
  for (const s of stories) {
    if (s.storage_path_md) await supaRemoveObject('newsletter-ingestion', s.storage_path_md).catch(() => undefined);
    if (s.storage_path_html) await supaRemoveObject('newsletter-ingestion', s.storage_path_html).catch(() => undefined);
    await supaDelete('content_ingestion_v2', `id=eq.${s.id}`);
  }
  await supaDelete('social_schedule_v2', `edition_id=eq.${ed}`);
  await supaDelete('social_schedule_v2', `external_id=like.e2e-${RUN_TAG}-*`);
  for (const t of fx.topics) await supaDelete('radar_topics_v2', `id=eq.${t.id}`);
  await supaDelete('newsletter_edition_feeds_v2', `edition_id=eq.${ed}`);
  await supaDelete('newsletter_issue_selections_v2', `edition_id=eq.${ed}`);
  await hardDeleteEdition(fx.edition);
}

// --------------------------------------------------------------------------- a second, non-owner user

export interface OtherUser {
  userId: string;
  authId: string;
  token: string;
}

function svc() {
  return { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json' };
}

/** A throwaway Workbench user with no editions and no radar, signed in (minted session, no email sent). */
export async function createOtherUser(): Promise<OtherUser> {
  const email = `e2e-studio-${RUN_TAG}@example.invalid`;
  const made = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: svc(), body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!made.ok) throw new Error(`create auth user ${made.status}: ${(await made.text()).slice(0, 200)}`);
  const authId = ((await made.json()) as { id: string }).id;
  const userId = `e2e-studio-${RUN_TAG}`;
  const existing = await supaGet<{ user_id: string }>('users_v2', `supabase_auth_uid=eq.${authId}&select=user_id`);
  const realId = existing[0]?.user_id ?? (await supaInsert<{ user_id: string }>('users_v2', {
    user_id: userId, supabase_auth_uid: authId, email,
  })).user_id;
  const link = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc(), body: JSON.stringify({ type: 'magiclink', email }) });
  const { hashed_token } = (await link.json()) as { hashed_token: string };
  const verify = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed_token }),
  });
  if (!verify.ok) throw new Error(`verify other user ${verify.status}`);
  const token = ((await verify.json()) as { access_token: string }).access_token;
  return { userId: realId, authId, token };
}

export async function deleteOtherUser(u: OtherUser | null): Promise<void> {
  if (!u) return;
  await supaDelete('users_v2', `user_id=eq.${encodeURIComponent(u.userId)}`);
  await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.authId}`, { method: 'DELETE', headers: svc() });
}

/** Call the DEV Workbench API as `token`. */
export async function apiAs(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

export { BASE as STUDIO_BASE };
