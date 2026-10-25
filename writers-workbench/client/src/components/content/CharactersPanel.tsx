/**
 * Characters — every place a name is used across the book, from this chapter's rail.
 *
 * A chapter is reviewed alone, but a character is not: whether "Seven" is a name or an age, whether
 * the boy is seven here and twelve two chapters on, can only be seen with every use side by side. So
 * this lists the uses, in context, chapter by chapter; checks them for contradictions and for a word
 * a reader could take two ways; suggests names the book's own research supports; and renames — at
 * only the uses the author ticks, because a word like "Seven" is also the number in "Seven days".
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { aiTells, summarizeTells } from '../../lib/aiTells';
import type { RevealResult } from './AnnotationsPanel';

interface Character { name: string; source: string; description: string; mentions_here: number }
interface Mention { id: string; offset: number; before: string; match: string; after: string }
interface Thread { content_id: string; chapter_number: number | null; title: string | null; mentions: Mention[] }
interface Threads { name: string; total: number; chapters_with_mentions: number; ambiguity: string | null; threads: Thread[] }
interface Finding { kind: 'contradiction' | 'ambiguity'; explanation: string; quotes: string[]; suggestion: string }
interface Suggestion { name: string; meaning: string; why: string; quote: string; report_topic: string }

const btn =
  'rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';

export default function CharactersPanel({
  contentId,
  onReveal,
}: {
  contentId: string;
  onReveal?: (quote: string) => RevealResult;
}) {
  const queryClient = useQueryClient();
  const [lookup, setLookup] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [updateRecords, setUpdateRecords] = useState(true);

  const characters = useQuery({
    queryKey: ['chapter-characters', contentId],
    queryFn: async () => (await apiFetch<ApiEnvelope<{ characters: Character[] }>>(`/api/content/${contentId}/characters`)).data!.characters,
  });

  const threads = useQuery({
    queryKey: ['character-threads', contentId, name],
    enabled: !!name,
    queryFn: async () =>
      (await apiFetch<ApiEnvelope<Threads>>(`/api/content/${contentId}/characters/threads?name=${encodeURIComponent(name!)}`)).data!,
  });

  const check = useMutation({
    mutationFn: async (n: string) =>
      (await apiFetch<ApiEnvelope<{ findings: Finding[]; dropped: number; passages: number }>>(`/api/content/${contentId}/characters/check`, {
        method: 'POST', body: JSON.stringify({ name: n }),
      })).data!,
  });

  const suggest = useMutation({
    mutationFn: async (n: string) =>
      (await apiFetch<ApiEnvelope<{ suggestions: Suggestion[]; note: string; dropped: number }>>(`/api/content/${contentId}/characters/suggest`, {
        method: 'POST', body: JSON.stringify({ name: n }),
      })).data!,
  });

  const rename = useMutation({
    mutationFn: async (args: { from: string; to: string; ids: string[] }) =>
      (await apiFetch<ApiEnvelope<{ applied: number; skipped: number; chapters: Array<{ applied: number }>; records_updated: number }>>(
        `/api/content/${contentId}/characters/rename`,
        { method: 'POST', body: JSON.stringify({ from: args.from, to: args.to, mention_ids: args.ids, update_records: updateRecords }) },
      )).data!,
    onSuccess: (_r, args) => {
      void queryClient.invalidateQueries({ queryKey: ['content-detail', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['content-versions', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['chapter-characters', contentId] });
      setRenaming(false);
      setName(args.to);
    },
  });

  const all = useMemo(() => threads.data?.threads.flatMap((t) => t.mentions.map((m) => m.id)) ?? [], [threads.data]);
  // A name that is also a word starts with nothing ticked: the author chooses each use.
  const chosen = picked ?? new Set(threads.data?.ambiguity ? [] : all);

  const open = (n: string) => {
    setName(n);
    setRenaming(false);
    setPicked(null);
    check.reset();
    suggest.reset();
    rename.reset();
  };

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (lookup.trim().length >= 2) open(lookup.trim());
        }}
      >
        <input
          id="character-lookup"
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          placeholder="Look up any name in the book"
          aria-label="Look up a name"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <button type="submit" className={btn}>Look up</button>
      </form>

      {!name ? (
        <div>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">In this chapter</p>
          {characters.isLoading ? <p className="text-xs text-gray-400">Loading…</p> : null}
          <ul className="flex flex-wrap gap-1.5">
            {(characters.data ?? []).map((c) => (
              <li key={c.name}>
                <button onClick={() => open(c.name)} className={btn} title={c.description || c.source}>
                  {c.name} <span className="text-gray-400">· {c.mentions_here}</span>
                </button>
              </li>
            ))}
          </ul>
          {characters.data && !characters.data.length ? <p className="text-xs text-gray-400">No names found in this chapter. Look one up above.</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">{name}</p>
              {threads.data ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {threads.data.total} use{threads.data.total === 1 ? '' : 's'} in {threads.data.chapters_with_mentions} chapter{threads.data.chapters_with_mentions === 1 ? '' : 's'}
                </p>
              ) : null}
            </div>
            <button onClick={() => setName(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">← All names</button>
          </div>
          {threads.data?.ambiguity ? (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{threads.data.ambiguity}</p>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            <button className={btn} disabled={check.isPending} onClick={() => check.mutate(name)}>
              {check.isPending ? 'Checking…' : 'Check consistency'}
            </button>
            <button className={btn} disabled={suggest.isPending} onClick={() => suggest.mutate(name)}>
              {suggest.isPending ? 'Searching the research…' : 'Suggest a name from the research'}
            </button>
            <button className={btn} onClick={() => { setRenaming((r) => !r); setPicked(null); }}>
              {renaming ? 'Cancel rename' : 'Rename…'}
            </button>
          </div>

          {check.isError ? <p className="text-xs text-red-600">{(check.error as Error).message}</p> : null}
          {check.data ? (
            <div className="space-y-2" data-testid="character-findings">
              {check.data.findings.length === 0 ? (
                <p className="text-xs text-gray-500">No contradictions or ambiguity found in {check.data.passages} passages.</p>
              ) : null}
              {check.data.findings.map((f, i) => (
                <div key={i} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${f.kind === 'contradiction' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}`}>
                    {f.kind}
                  </span>
                  <p className="mt-1 text-xs text-gray-800 dark:text-gray-200">{f.explanation}</p>
                  {f.quotes.map((q) => (
                    <blockquote
                      key={q}
                      onClick={onReveal ? () => onReveal(q) : undefined}
                      className={`mt-1 border-l-2 border-gray-300 pl-2 text-[11px] italic text-gray-600 dark:border-gray-600 dark:text-gray-400 ${onReveal ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800' : ''}`}
                      title={onReveal ? 'Show in manuscript (when it is in this chapter)' : undefined}
                    >
                      {q}
                    </blockquote>
                  ))}
                  {f.suggestion ? (
                    <p className="mt-1 rounded bg-green-50 px-2 py-1 text-[11px] text-green-800 dark:bg-green-900/30 dark:text-green-300">
                      Suggested: {f.suggestion}
                      <span className="ml-1 rounded bg-violet-100 px-1 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">AI-written</span>
                      {aiTells(f.suggestion).length ? <span className="ml-1 text-amber-700">{summarizeTells(aiTells(f.suggestion))}</span> : null}
                    </p>
                  ) : null}
                </div>
              ))}
              {check.data.dropped ? <p className="text-[11px] text-gray-400">{check.data.dropped} finding(s) dropped: their quotes were not in the chapters.</p> : null}
            </div>
          ) : null}

          {suggest.isError ? <p className="text-xs text-red-600">{(suggest.error as Error).message}</p> : null}
          {suggest.data ? (
            <div className="space-y-2" data-testid="name-suggestions">
              {suggest.data.note ? <p className="text-xs text-gray-600 dark:text-gray-400">{suggest.data.note}</p> : null}
              {suggest.data.suggestions.map((s) => (
                <div key={s.name} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900 dark:text-white">{s.name}</span>
                    <button className={btn} onClick={() => { setNewName(s.name); setRenaming(true); }}>Use this name</button>
                  </div>
                  {s.meaning ? <p className="text-[11px] text-gray-600 dark:text-gray-400">Meaning: {s.meaning}</p> : null}
                  <p className="text-[11px] text-gray-700 dark:text-gray-300">{s.why}</p>
                  <blockquote className="mt-1 border-l-2 border-gray-300 pl-2 text-[11px] italic text-gray-600 dark:border-gray-600 dark:text-gray-400">“{s.quote}”</blockquote>
                  <p className="text-[11px] text-gray-400">{s.report_topic}</p>
                </div>
              ))}
              {suggest.data.dropped ? <p className="text-[11px] text-gray-400">{suggest.data.dropped} suggestion(s) dropped: their quotes were not in the research.</p> : null}
            </div>
          ) : null}

          {renaming ? (
            <div className="space-y-2 rounded border border-brand-200 bg-brand-50/40 p-2 dark:border-brand-800 dark:bg-brand-950/20">
              <label htmlFor="character-new-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Rename “{name}” to</label>
              <input
                id="character-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button className={btn} onClick={() => setPicked(new Set(all))}>Tick all</button>
                <button className={btn} onClick={() => setPicked(new Set())}>Tick none</button>
                <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                  <input type="checkbox" checked={updateRecords} onChange={(e) => setUpdateRecords(e.target.checked)} />
                  also rename it in the cast list and story bible
                </label>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                Tick the uses that are this character. Each chapter that changes is saved as a version first, so it can be restored.
              </p>
            </div>
          ) : null}

          {threads.isLoading ? <p className="text-xs text-gray-400">Finding every use…</p> : null}
          <ol className="space-y-2" data-testid="character-threads">
            {(threads.data?.threads ?? []).map((t) => (
              <li key={t.content_id} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    {t.chapter_number != null ? `Ch ${t.chapter_number}` : ''} {t.title ? `· ${t.title.slice(0, 50)}` : ''}
                  </span>
                  {t.content_id !== contentId ? (
                    <Link to={`/content/${t.content_id}`} className="text-brand-600 underline dark:text-brand-400">Open</Link>
                  ) : (
                    <span className="text-gray-400">this chapter</span>
                  )}
                </div>
                <ul className="space-y-1">
                  {t.mentions.map((m) => (
                    <li key={m.id} className="flex items-start gap-1.5 text-[11px] leading-snug text-gray-600 dark:text-gray-400">
                      {renaming ? (
                        <input
                          type="checkbox"
                          aria-label={`Rename this use in chapter ${t.chapter_number ?? ''}`}
                          checked={chosen.has(m.id)}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.target.checked) next.add(m.id); else next.delete(m.id);
                            setPicked(next);
                          }}
                          className="mt-0.5"
                        />
                      ) : null}
                      <span
                        onClick={t.content_id === contentId && onReveal ? () => onReveal(`${m.match}${m.after}`.slice(0, 120)) : undefined}
                        className={t.content_id === contentId && onReveal ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800' : ''}
                      >
                        …{m.before}<mark className="bg-amber-100 px-0.5 font-semibold text-gray-900 dark:bg-amber-800/60 dark:text-white">{m.match}</mark>{m.after}…
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          {renaming ? (
            <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-gray-200 bg-white pt-2 dark:border-gray-700 dark:bg-gray-900">
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {chosen.size} of {all.length} uses ticked
              </span>
              <button
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                disabled={!newName.trim() || newName.trim() === name || chosen.size === 0 || rename.isPending}
                onClick={() => rename.mutate({ from: name, to: newName.trim(), ids: [...chosen] })}
              >
                {rename.isPending ? 'Renaming…' : `Rename ${chosen.size} use${chosen.size === 1 ? '' : 's'}`}
              </button>
            </div>
          ) : null}
          {rename.isError ? <p className="text-xs text-red-600">{(rename.error as Error).message}</p> : null}
          {rename.data ? (
            <p className="text-xs text-green-700 dark:text-green-400" role="status">
              Renamed {rename.data.applied} use{rename.data.applied === 1 ? '' : 's'} in {rename.data.chapters.filter((c) => c.applied).length} chapter(s)
              {rename.data.skipped ? `; ${rename.data.skipped} skipped because the text had changed` : ''}
              {rename.data.records_updated ? `; cast and story bible updated` : ''}.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
