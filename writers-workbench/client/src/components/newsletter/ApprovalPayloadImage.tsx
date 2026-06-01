/**
 * Renders the `image` approval payload — the engine's cover-image gate (F2-7).
 * Shows the candidate images per story so the operator can review before approving.
 *
 * Engine payload shape (newsletter_saga proposing_images):
 *   { image_options_by_story: [{ story_title, options: string[], auto_pick? }],
 *     segments: [{ story_title, ... }] }
 */

interface ImageOptionsForStory {
  story_title?: string;
  options?: string[];
  auto_pick?: string | null;
}

interface ImagePayload {
  image_options_by_story?: ImageOptionsForStory[];
}

interface Props {
  payload: Record<string, unknown>;
}

export default function ApprovalPayloadImage({ payload }: Props) {
  const p = payload as ImagePayload;
  const stories: ImageOptionsForStory[] = Array.isArray(p.image_options_by_story)
    ? p.image_options_by_story
    : [];

  if (stories.length === 0) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900">
        No image options in payload.
      </section>
    );
  }

  return (
    <div className="space-y-3">
      {stories.map((s, i) => {
        const options = (s.options ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0);
        return (
          <section
            key={i}
            className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Story</div>
            <h3 className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {s.story_title || <span className="text-gray-400">Untitled story</span>}
            </h3>
            {options.length > 0 ? (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {options.map((url, j) => (
                  <figure key={j} className="overflow-hidden rounded border border-gray-200 dark:border-gray-700">
                    <img
                      src={url}
                      alt={`${s.story_title ?? 'story'} option ${j + 1}`}
                      className="h-28 w-full object-cover"
                      loading="lazy"
                    />
                    {s.auto_pick === url && (
                      <figcaption className="bg-brand-50 px-1 py-0.5 text-center text-[10px] font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                        suggested
                      </figcaption>
                    )}
                  </figure>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-400">No image candidates for this story.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
