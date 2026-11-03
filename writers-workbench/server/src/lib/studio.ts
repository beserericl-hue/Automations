/**
 * Content Studio editions — the server's half of the ownership rule (the engine checks it again on
 * every op, writer_engine.studio.core.resolve_edition).
 *
 * A studio edition is a newsletter edition the caller OWNS whose radar the caller SUBSCRIBES to:
 * `radar_subscriptions_v2.settings.edition_id` names it, or the edition has an active `radar://<radar>`
 * feed source and the caller has that radar's subscription. Any other edition, including another
 * user's, is answered exactly like a missing one (404), so the API never says whether it exists.
 */
import { getSupabaseAdmin } from '../services/supabase-admin.js';

export interface StudioEdition {
  edition_id: string;
  name: string;
  radar: 'trend' | 'dev';
  channels: string[];
  cadence: string | null;
}

const DEFAULT_CHANNELS: Record<string, string[]> = {
  trend: ['website', 'li_techahir', 'li_agile', 'li_personal'],
  dev: ['li_techahir', 'li_agile', 'li_personal'],
};

export async function studioEditions(userId: string): Promise<StudioEdition[]> {
  if (!userId) return [];
  const sb = getSupabaseAdmin();
  const [{ data: editions }, { data: subs }, { data: feeds }] = await Promise.all([
    sb.from('newsletter_editions_v2').select('id, display_name, cadence, user_id').eq('user_id', userId),
    sb.from('radar_subscriptions_v2').select('radar, enabled, settings, user_id').eq('user_id', userId),
    sb.from('newsletter_feed_sources_v2').select('edition_id, url, url_type, active, user_id').eq('user_id', userId).eq('url_type', 'radar'),
  ]);
  const out: StudioEdition[] = [];
  for (const e of (editions ?? []) as Array<Record<string, unknown>>) {
    if (e.user_id !== userId) continue;
    const id = String(e.id);
    const radarUrls = new Set(
      ((feeds ?? []) as Array<Record<string, unknown>>)
        .filter((f) => f.user_id === userId && String(f.edition_id) === id && f.active !== false)
        .map((f) => String(f.url ?? '').toLowerCase()),
    );
    for (const s of (subs ?? []) as Array<Record<string, unknown>>) {
      if (s.user_id !== userId) continue;
      const radar = String(s.radar);
      if (radar !== 'trend' && radar !== 'dev') continue;
      const settings = (s.settings ?? {}) as { edition_id?: string; channels?: string[] };
      if (settings.edition_id === id || radarUrls.has(`radar://${radar}`)) {
        out.push({
          edition_id: id,
          name: String(e.display_name ?? id),
          radar,
          channels: Array.isArray(settings.channels) && settings.channels.length ? settings.channels : DEFAULT_CHANNELS[radar],
          cadence: (e.cadence as string | null) ?? null,
        });
        break;
      }
    }
  }
  return out;
}

export async function findStudioEdition(userId: string, editionId: string): Promise<StudioEdition | null> {
  return (await studioEditions(userId)).find((e) => e.edition_id === editionId) ?? null;
}
