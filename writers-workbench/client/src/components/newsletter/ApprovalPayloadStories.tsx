/**
 * Renders the `stories` approval payload as a stack of story cards. The
 * payload shape is what the n8n `pick_top_stories` chainLlm node emits
 * (per design doc §4.3) — top_selected_stories, where each entry has:
 *   { title, summary, identifiers: string[], external_source_urls: string[] }
 *
 * For Phase 2a we don't open the full ingestion drawer; the source-URL
 * chips link directly to the URL. The ingestion browser (Phase 2b)
 * upgrades this to a drawer that fetches the stored markdown.
 */

interface Story {
  title?: string;
  summary?: string;
  identifiers?: string[];
  external_source_urls?: string[];
  [key: string]: unknown;
}

interface Props {
  payload: { top_selected_stories?: Story[]; [key: string]: unknown } | Record<string, unknown>;
}

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function ApprovalPayloadStories({ payload }: Props) {
  const stories = (payload as { top_selected_stories?: Story[] }).top_selected_stories ?? [];

  if (stories.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        No stories in this approval payload.
      </div>
    );
  }

  return (
    <ol className="space-y-3" aria-label="Selected stories">
      {stories.map((s, idx) => {
        const sources = (s.external_source_urls ?? []).slice(0, 3);
        return (
          <li
            key={idx}
            className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {sources[0] ? tryHostname(sources[0]) : `Story ${idx + 1}`}
            </div>
            {s.title && (
              <h3 className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{s.title}</h3>
            )}
            {s.summary && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{s.summary}</p>
            )}
            {sources.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {sources.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:border-brand-400 hover:text-brand-700 dark:border-gray-700 dark:text-gray-300 dark:hover:text-brand-300"
                  >
                    {tryHostname(url)} ↗
                  </a>
                ))}
              </div>
            )}
            {(s.identifiers ?? []).length > 0 && (
              <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <summary className="cursor-pointer">Source identifiers ({(s.identifiers ?? []).length})</summary>
                <ul className="mt-1 space-y-0.5 break-all font-mono">
                  {(s.identifiers ?? []).map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
                <p className="mt-1 italic">Ingestion browser not yet available — Phase 2b.</p>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
