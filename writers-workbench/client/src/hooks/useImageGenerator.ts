import { useState, useCallback } from 'react';
import { supabase } from '../config/supabase';

/**
 * Shared image generator — runs the proven /api/images pipeline (generate → poll → save) so the result
 * is stored in generated_images_v2 WITH its project_id and image_type, which is what makes it appear in
 * the project's Art gallery. Used by the book "Generate Cover Art" button and the per-chapter
 * "Generate Art" buttons. Keyed by a caller-supplied string so many chapters can generate concurrently,
 * each with its own status.
 */
export type GenState = 'idle' | 'submitting' | 'polling' | 'saving' | 'done' | 'error';

export interface GenerateOpts {
  prompt: string;
  projectId?: string;
  genreSlug?: string;
  title?: string;
  imageType?: string; // 'cover_art' (default) | 'chapter_art' | …
  metadata?: Record<string, unknown>;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export function useImageGenerator() {
  const [states, setStates] = useState<Record<string, GenState>>({});

  const stateOf = useCallback((key: string): GenState => states[key] ?? 'idle', [states]);

  const generate = useCallback(async (key: string, opts: GenerateOpts): Promise<boolean> => {
    const set = (s: GenState) => setStates((p) => ({ ...p, [key]: s }));
    try {
      set('submitting');
      const headers = await authHeaders();
      const sub = await fetch('/api/images/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: opts.prompt, project_id: opts.projectId, genre_slug: opts.genreSlug }),
      });
      const subJson = (await sub.json()) as { taskId?: string };
      if (!subJson.taskId) throw new Error('no task id');

      set('polling');
      let imageUrl: string | null = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await fetch(`/api/images/status/${subJson.taskId}`, { headers });
        const stj = (await st.json()) as { state?: string; imageUrl?: string; error?: string };
        if (stj.state === 'success') { imageUrl = stj.imageUrl ?? null; break; }
        if (stj.state === 'failed') throw new Error(stj.error || 'generation failed');
      }
      if (!imageUrl) throw new Error('generation timed out');

      set('saving');
      const sv = await fetch('/api/images/save', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          image_url: imageUrl,
          prompt: opts.prompt,
          project_id: opts.projectId,
          genre_slug: opts.genreSlug,
          title: opts.title,
          image_type: opts.imageType,
          metadata: opts.metadata,
        }),
      });
      const svj = (await sv.json()) as { success?: boolean };
      if (!svj.success) throw new Error('save failed');
      set('done');
      return true;
    } catch {
      set('error');
      return false;
    }
  }, []);

  return { generate, stateOf, states };
}
