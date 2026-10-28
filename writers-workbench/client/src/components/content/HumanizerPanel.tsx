/**
 * Humanizer — try a passage through StealthGPT and keep it only if it reads better.
 *
 * Select a passage in the editor (or send a suggested replacement here from Review), run it, and
 * read the two side by side: what each still shows of machine writing, and StealthGPT's own
 * detection score. Nothing changes until "Replace in manuscript", and then the chapter is saved as a
 * version first, so the original is one click away in the Versions tab.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { aiTells, summarizeTells } from '../../lib/aiTells';

interface HumanizeResult {
  original?: string;
  text?: string;
  changed?: boolean;
  words?: number;
  detectability?: number | string | null;
  charged_credits?: number;
  words_spent?: number;
  protected_terms?: string[];
  rejected?: Record<string, string>;
  failed_chunks?: number[];
  skipped?: string | null;
}

/** A passage to start from: `text` is what is humanized, `passage` is what it will replace. */
export interface HumanizerSeed {
  text: string;
  passage: string;
  nonce: number;
}

const MAX_WORDS = 1500;
const btn =
  'rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';

function Tells({ text }: { text: string }) {
  const tells = aiTells(text);
  return tells.length ? (
    <span className="text-amber-700 dark:text-amber-300">{summarizeTells(tells)}</span>
  ) : (
    <span className="text-gray-500 dark:text-gray-400">no common tells</span>
  );
}

export default function HumanizerPanel({
  contentId,
  getSelection,
  seed,
  onReplaced,
}: {
  contentId: string;
  getSelection: () => string;
  seed?: HumanizerSeed | null;
  /** Told the new text once it is in the manuscript, so the editor can mark where it went. */
  onReplaced?: (replacement: string) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [passage, setPassage] = useState('');
  const [fromSuggestion, setFromSuggestion] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    setPassage(seed.passage);
    setFromSuggestion(true);
    run.reset();
    apply.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  const run = useMutation({
    mutationFn: async (t: string) =>
      (await apiFetch<ApiEnvelope<HumanizeResult>>(`/api/content/${contentId}/humanize`, { method: 'POST', body: JSON.stringify({ text: t }) })).data!,
  });

  const apply = useMutation({
    mutationFn: async (args: { original: string; replacement: string }) =>
      apiFetch<ApiEnvelope<{ replaced: boolean }>>(`/api/content/${contentId}/humanize/apply`, { method: 'POST', body: JSON.stringify(args) }),
    onSuccess: (_data, args) => {
      // Before the refetch, so the reloaded chapter arrives with the passage already waiting to be shown.
      onReplaced?.(args.replacement);
      void queryClient.invalidateQueries({ queryKey: ['content-detail', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['content-versions', contentId] });
    },
  });

  const words = text.split(/\s+/).filter(Boolean).length;
  const result = run.data;

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={btn}
          onClick={() => {
            const sel = getSelection();
            if (!sel) {
              setNotice('Select a passage in the editor first.');
              return;
            }
            setNotice('');
            setText(sel);
            setPassage(sel);
            setFromSuggestion(false);
            run.reset();
            apply.reset();
          }}
        >
          Use the selected text
        </button>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">Up to {MAX_WORDS.toLocaleString()} words at a time. Billed per word.</span>
      </div>
      {notice ? <p className="text-xs text-amber-700 dark:text-amber-300">{notice}</p> : null}

      {text ? (
        <>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
              {fromSuggestion ? 'Suggested replacement, to humanize' : 'Selected passage'} · {words} words · <Tells text={text} />
            </p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200" data-testid="humanizer-before">
              {text}
            </p>
            {fromSuggestion ? (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Replacing will put the result in place of: “{passage.slice(0, 140)}{passage.length > 140 ? '…' : ''}”</p>
            ) : null}
          </div>
          <button
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            disabled={run.isPending || words > MAX_WORDS}
            onClick={() => run.mutate(text)}
          >
            {run.isPending ? 'Humanizing…' : 'Run through the humanizer'}
          </button>
          {words > MAX_WORDS ? <p className="text-xs text-red-600">That is {words} words; select up to {MAX_WORDS}.</p> : null}
        </>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Select a passage in the editor and press “Use the selected text”, or send a suggested replacement here from the Review tab.
        </p>
      )}

      {run.isError ? <p className="text-xs text-red-600">{(run.error as Error).message}</p> : null}
      {result?.skipped ? <p className="text-xs text-amber-700 dark:text-amber-300">{result.skipped}</p> : null}
      {result && !result.skipped && result.text ? (
        <div className="space-y-2" data-testid="humanizer-result">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Humanized · <Tells text={result.text} />
            {result.detectability != null ? (
              <span className="ml-1 text-gray-500" title="StealthGPT's howLikelyToBeDetected. Lower is better; on a short passage it means little.">
                · detection score {String(result.detectability)}
              </span>
            ) : null}
            {result.charged_credits ? <span className="ml-1 text-gray-500">· {result.charged_credits} credits</span> : null}
          </p>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-violet-50 p-2 text-xs text-gray-800 dark:bg-violet-950/30 dark:text-gray-200">{result.text}</p>
          {!result.changed ? <p className="text-xs text-gray-500">The humanizer returned the passage unchanged.</p> : null}
          {result.rejected && Object.keys(result.rejected).length ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Part of the rewrite was thrown away and kept as written ({Object.values(result.rejected).join(', ')}).
            </p>
          ) : null}
          {result.protected_terms?.length ? (
            <p className="text-[11px] text-gray-500">Names kept: {result.protected_terms.slice(0, 8).join(', ')}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              disabled={!result.changed || apply.isPending || apply.isSuccess}
              onClick={() => apply.mutate({ original: passage, replacement: result.text! })}
            >
              {apply.isPending ? 'Replacing…' : apply.isSuccess ? 'Replaced' : 'Replace in manuscript'}
            </button>
            <button className={btn} onClick={() => run.reset()}>Discard</button>
          </div>
          {apply.isError ? <p className="text-xs text-red-600">{(apply.error as Error).message}</p> : null}
          {apply.isSuccess ? <p className="text-xs text-green-700 dark:text-green-400" role="status">Replaced — the new text is highlighted in the editor. The previous text is in the Versions tab.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
