import { useState } from 'react';

/** What the editor answers when asked to show a passage: found exactly, found near enough, or gone. */
export type RevealResult = 'exact' | 'approximate' | 'missing';
export type Reveal = (quote: string) => RevealResult;

/**
 * Scroll the editor to a passage a finding quotes and mark it there. A finding often quotes several
 * things — the name as the outline spells it, the name as the chapter spells it, the sentence it sits
 * in — and which one the author wants to see is theirs to choose, so each quote is its own button.
 * "Not found" means that quote is no longer in the chapter (rewritten, or it was quoting the outline),
 * and the author is told so rather than sent to the wrong line.
 */
export default function ShowInChapter({ quotes, onReveal, label }: { quotes: string[]; onReveal: Reveal; label?: string }) {
  const [results, setResults] = useState<Record<string, RevealResult>>({});
  if (quotes.length === 0) return <span className="ml-2 text-[11px] italic opacity-60">no passage quoted</span>;
  const shorten = (q: string) => (q.length > 48 ? `${q.slice(0, 45).trimEnd()}…` : q);
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
      <span className="text-[11px] opacity-60">{label ?? 'Show in chapter:'}</span>
      {quotes.map((q) => {
        const r = results[q];
        return (
          <button
            key={q}
            type="button"
            onClick={() => setResults((s) => ({ ...s, [q]: onReveal(q) }))}
            data-testid="show-in-chapter"
            title={r === 'missing' ? 'This passage is no longer in the chapter' : `Scroll to “${q}” and highlight it`}
            className={`rounded border px-1.5 py-px text-[11px] font-medium ${
              r === 'missing'
                ? 'border-rose-300 text-rose-600 line-through dark:border-rose-800 dark:text-rose-400'
                : 'border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950'
            }`}
          >
            {label ? label : `“${shorten(q.replace(/\s+/g, ' '))}”`}
            {r === 'missing' ? ' — not found in chapter' : r === 'approximate' ? ' — closest match' : ''}
          </button>
        );
      })}
    </span>
  );
}
