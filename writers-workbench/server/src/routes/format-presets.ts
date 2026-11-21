/**
 * The author's saved formatting-block looks ("Letter", "Epigraph", "Poem"), one list per account.
 *
 *   GET /api/format-presets   the list
 *   PUT /api/format-presets   replace the list
 *
 * Kept as one JSON value under `app_config_v2` key `format_presets`, the per-user settings table, so
 * a look saved in one book is there in every book and no schema change is needed. Every style is
 * cleaned on the way in: a font name or number the editor and the exports do not know is replaced,
 * so a preset cannot carry anything but a style.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { cleanBlockStyle, type BlockStyle } from '../lib/html-prose.js';
import { logger } from '../lib/logger.js';

export const formatPresetsRouter = Router();
formatPresetsRouter.use(requireAuth);

const KEY = 'format_presets';
const MAX_PRESETS = 40;

export interface FormatPreset {
  name: string;
  style: BlockStyle;
}

const Body = z.object({
  presets: z
    .array(z.object({ name: z.string().trim().min(1).max(60), style: z.record(z.string(), z.unknown()) }))
    .max(MAX_PRESETS),
});

/** A stored list, tolerant of anything unexpected in it. */
export function readPresets(value: unknown): FormatPreset[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: FormatPreset[] = [];
  const seen = new Set<string>();
  for (const p of raw as { name?: unknown; style?: unknown }[]) {
    const name = String(p?.name ?? '').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, style: cleanBlockStyle({ ...((p.style as Record<string, unknown>) ?? {}), preset: name }) });
  }
  return out.slice(0, MAX_PRESETS);
}

formatPresetsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { data, error } = await getSupabaseAdmin().from('app_config_v2').select('value').eq('user_id', req.userId!).eq('key', KEY).maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ success: true, data: { presets: readPresets(data?.value) } });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'format-presets: read failed');
    res.status(500).json({ success: false, error: { code: 'PRESETS_UNREADABLE', message: 'Could not read your saved looks.' } });
  }
});

formatPresetsRouter.put('/', validateBody(Body), async (req: Request, res: Response) => {
  try {
    const presets = readPresets((req.body as z.infer<typeof Body>).presets);
    const { error } = await getSupabaseAdmin()
      .from('app_config_v2')
      .upsert({ user_id: req.userId!, key: KEY, value: JSON.stringify(presets) }, { onConflict: 'user_id,key' });
    if (error) throw new Error(error.message);
    res.json({ success: true, data: { presets } });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'format-presets: save failed');
    res.status(500).json({ success: false, error: { code: 'PRESETS_NOT_SAVED', message: 'Could not save your looks.' } });
  }
});
