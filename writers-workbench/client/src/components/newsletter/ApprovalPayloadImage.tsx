/**
 * Renders the `image` approval payload — the engine's cover-image gate (F2-7).
 * Shows the candidate images per story; with `onChange` the operator picks one per story (or none),
 * and the parent sends the picks with the approval as `chosen_images` (story title -> URL, "" = none).
 * Until 2026-11-03 this only displayed the options and nothing was sent, so the email always carried
 * whatever image the section writer had picked.
 *
 * Engine payload shape (newsletter_saga proposing_images):
 *   { image_options_by_story: [{ story_title, options: string[], auto_pick? }],
 *     segments: [{ story_title, chosen_image_url?, ... }] }
 */

interface ImageOptionsForStory {
  story_title?: string;
  options?: string[];
  auto_pick?: string | null;
}

interface ImagePayload {
  image_options_by_story?: ImageOptionsForStory[];
  segments?: Array<{ story_title?: string; chosen_image_url?: string | null }>;
}

interface Props {
  payload: Record<string, unknown>;
  /** story title -> chosen URL ("" = no image). Omitted = read-only display. */
  selected?: Record<string, string>;
  onChange?: (next: Record<string, string>) => void;
}

/** What the email will carry if nobody changes anything: each section's own image (or none). */
export function defaultImageChoices(payload: Record<string, unknown>): Record<string, string> {
  const p = payload as ImagePayload;
  const out: Record<string, string> = {};
  // Options and sections pair by POSITION (the engine builds them in one loop); the section writer
  // rewrites story_title, so matching by title showed "no image" for a section that had one.
  for (const [i, s] of (p.image_options_by_story ?? []).entries()) {
    if (!s.story_title) continue;
    const seg = (p.segments ?? [])[i] ?? (p.segments ?? []).find((x) => x.story_title === s.story_title);
    out[s.story_title] = seg?.chosen_image_url ?? '';
  }
  return out;
}

export default function ApprovalPayloadImage({ payload, selected, onChange }: Props) {
  const p = payload as ImagePayload;
  const stories: ImageOptionsForStory[] = Array.isArray(p.image_options_by_story)
    ? p.image_options_by_story
    : [];
  const picks = selected ?? defaultImageChoices(payload);

  if (stories.length === 0) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900">
        No image options in payload.
      </section>
    );
  }

  const choose = (title: string, url: string) => {
    if (onChange) onChange({ ...picks, [title]: url });
  };

  return (
    <div className="space-y-3">
      {onChange && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Pick the image each story carries in the email, or none.</p>
      )}
      {stories.map((s, i) => {
        const title = s.story_title ?? '';
        const options = (s.options ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0);
        const current = picks[title] ?? '';
        return (
          <section
            key={i}
            data-testid={`image-story-${i}`}
            className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Story</div>
            <h3 className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {s.story_title || <span className="text-gray-400">Untitled story</span>}
            </h3>
            {options.length > 0 ? (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {options.map((url, j) => {
                  const on = current === url;
                  const figure = (
                    <figure className={`overflow-hidden rounded border ${on ? 'border-brand-600 ring-2 ring-brand-500' : 'border-gray-200 dark:border-gray-700'}`}>
                      <img
                        src={url}
                        alt={`${s.story_title ?? 'story'} option ${j + 1}`}
                        className="h-28 w-full object-cover"
                        loading="lazy"
                      />
                      {(on || s.auto_pick === url) && (
                        <figcaption className="bg-brand-50 px-1 py-0.5 text-center text-[10px] font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                          {on ? 'chosen' : 'suggested'}
                        </figcaption>
                      )}
                    </figure>
                  );
                  return onChange ? (
                    <button
                      key={j}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Use option ${j + 1} for ${s.story_title ?? 'story'}`}
                      data-testid={`image-option-${i}-${j}`}
                      onClick={() => choose(title, url)}
                      className="text-left"
                    >
                      {figure}
                    </button>
                  ) : (
                    <div key={j}>{figure}</div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-400">No image candidates for this story.</p>
            )}
            {onChange && (
              <button
                type="button"
                aria-pressed={current === ''}
                data-testid={`image-none-${i}`}
                onClick={() => choose(title, '')}
                className={`mt-2 rounded border px-2 py-1 text-xs ${current === '' ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}
              >
                No image for this story
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
