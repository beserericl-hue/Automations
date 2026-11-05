/**
 * The studio assistant — the n8n studio chat, on the engine hub (studio surface). "generate 1-5 and 8",
 * "revise #3 to be shorter", "schedule all approved", "list the queue", "cancel 4",
 * "put 1-6 in this week's newsletter", "write about <your own topic>". It acts on the same data the page
 * shows, so the page refreshes after every answer; queued work (drafting, revising) is tracked like the
 * page's own buttons.
 *
 * "Commands" opens the full list, grouped (Eric, 2026-11-05: "command help? seeing all the commands?");
 * the conversation is kept per edition in this browser so a reload does not lose it.
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { studioApi } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

const EXAMPLES = ['show the slate', 'generate 1-3', 'write about …', 'list my drafts', 'approve all', 'schedule all approved', 'list the queue', 'put 1-6 in the newsletter', 'help'];

/** Every command the studio understands, as the n8n studio prompts listed them. Plain numbers after
 *  "generate" / "put" are slate ranks; #N is a post number. */
export const COMMAND_GROUPS: Array<{ title: string; commands: Array<[string, string]> }> = [
  { title: 'The slate', commands: [
    ['show the slate', 'this week’s ranked topics (or “slate for 2026-10-26”)'],
    ['generate 1-5, 8', 'draft those topics into Review'],
    ['generate the whole slate', 'draft every topic not yet drafted'],
    ['write about <topic>', 'draft your own topic — or paste a link'],
  ] },
  { title: 'Drafts (Review)', commands: [
    ['list my drafts', 'what is waiting for review'],
    ['show #3', 'the full text of a post'],
    ['revise #3 to be shorter', 'rewrite with an instruction (edit / tighten / punch up …)'],
    ['regenerate #3', 'draft it again from the topic'],
    ['undo #3', 'put back the previous text'],
    ['image on #3 / no image on #3', 'sketchnote image on or off'],
    ['approve #3 / approve all', 'mark ready to go out'],
    ['unapprove #3', 'back to draft'],
    ['discard #3', 'drop a draft (kept in History)'],
    ['email #3', 'email me the draft'],
  ] },
  { title: 'Scheduling', commands: [
    ['schedule #3', 'next free slot'],
    ['schedule #3 tuesday afternoon', 'a day and slot (morning 9 AM / afternoon 2 PM ET)'],
    ['schedule #3 2026-11-10 at 11:30am', 'an exact time'],
    ['schedule all approved', 'send everything approved to the scheduler'],
    ['schedule 3, 4 to linkedin', 'choose channels: website, linkedin, both, personal'],
    ['publish #3 now / publish all approved now', 'post straight away'],
  ] },
  { title: 'The queue', commands: [
    ['list the queue', 'what is scheduled, failed or partly posted'],
    ['cancel #4', 'take it off the calendar'],
    ['requeue #4', 'retry a failed post, or restore a cancelled one'],
    ['unschedule #4', 'back to approved, no date'],
  ] },
  { title: 'The newsletter', commands: [
    ['put 1-6 in the newsletter', 'choose slate topics (ranks) and posts (#N) for the next issue'],
    ['add #3 to the newsletter / remove #3 from the newsletter', 'adjust the selection'],
    ['show the newsletter', 'the current selection'],
    ['start a new issue', 'empty selection'],
    ['email the digest', 'email me this week’s slate'],
  ] },
];

function storageKey(ed: string): string {
  return `studio-assistant:${ed}`;
}

function loadTurns(ed: string): Turn[] {
  try {
    const raw = localStorage.getItem(storageKey(ed));
    const parsed = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-60) : [];
  } catch {
    return [];
  }
}

export default function StudioAssistant({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(ed));
  const [text, setText] = useState('');
  const [showCommands, setShowCommands] = useState(false);

  useEffect(() => {
    setTurns(loadTurns(ed));
  }, [ed]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(ed), JSON.stringify(turns.slice(-60)));
    } catch {
      /* a private window: the chat just does not survive a reload */
    }
  }, [ed, turns]);

  const send = useMutation({
    mutationFn: (message: string) => studioApi.assistant(ed, message, ctx.week),
    onMutate: (message) => setTurns((t) => [...t, { role: 'user', text: message }]),
    onSuccess: (r) => {
      const d = r.data;
      const body = d.error || String(d.result?.message ?? '') || d.message || 'Done.';
      const reply = d.kind === 'queued' && d.message && !d.error ? d.message : body;
      setTurns((t) => [...t, { role: 'assistant', text: reply + (d.creditsCharged ? ` (${d.creditsCharged} credits)` : '') }]);
      if (d.jobId) ctx.track(d.jobId, `Assistant: ${d.op ?? 'working'}`);
      ctx.refresh();
    },
    onError: (e) => setTurns((t) => [...t, { role: 'assistant', text: e instanceof ApiError ? e.message : 'The assistant could not answer.' }]),
  });

  const submit = (m: string) => {
    const msg = m.trim();
    if (!msg || send.isPending) return;
    if (msg === 'help') {
      setShowCommands(true);
      return;
    }
    if (msg === 'write about …') {
      setText('write about ');
      return;
    }
    setText('');
    send.mutate(msg);
  };

  return (
    <aside className="flex max-h-[80vh] flex-col rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900" data-testid="studio-assistant">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Assistant</h2>
        <div className="flex gap-1">
          <button type="button" onClick={() => setShowCommands((v) => !v)} data-testid="assistant-commands-toggle" aria-expanded={showCommands}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs dark:border-gray-600">{showCommands ? 'Hide commands' : 'Commands'}</button>
          {turns.length > 0 && (
            <button type="button" onClick={() => setTurns([])} data-testid="assistant-clear" className="rounded px-2 py-0.5 text-xs text-gray-500">Clear</button>
          )}
        </div>
      </div>
      {showCommands && (
        <div className="max-h-72 overflow-auto border-b border-gray-200 p-3 text-xs dark:border-gray-700" data-testid="assistant-commands">
          <p className="mb-2 text-gray-500">Type any of these. Plain numbers after “generate” and “put” are slate ranks; <code>#N</code> is a post. Click one to put it in the box.</p>
          {COMMAND_GROUPS.map((g) => (
            <div key={g.title} className="mb-2">
              <h3 className="font-semibold text-gray-700 dark:text-gray-200">{g.title}</h3>
              <ul className="mt-0.5 space-y-0.5">
                {g.commands.map(([cmd, what]) => (
                  <li key={cmd} className="flex gap-2">
                    <button type="button" onClick={() => { setText(cmd.replace(/<[^>]+>/, '').trim()); }} className="shrink-0 text-left font-mono text-brand-700 hover:underline dark:text-brand-300">{cmd}</button>
                    <span className="text-gray-500">{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="flex-1 space-y-2 overflow-auto p-3 text-sm" aria-live="polite" data-testid="assistant-log">
        {!turns.length && (
          <div className="space-y-2 text-gray-500">
            <p>Tell me what to do with this edition. Plain numbers after “generate” are slate ranks; #N is a post. “Commands” above lists everything.</p>
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" onClick={() => submit(e)} className="rounded-full border border-gray-300 px-2 py-0.5 text-xs dark:border-gray-600">{e}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <p key={i} className={`whitespace-pre-wrap rounded px-2 py-1 ${t.role === 'user' ? 'ml-6 bg-brand-50 text-gray-900 dark:bg-brand-900/30 dark:text-gray-100' : 'mr-6 bg-gray-50 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}`}
            data-testid={t.role === 'assistant' ? 'assistant-reply' : 'assistant-said'}>
            {t.text}
          </p>
        ))}
        {send.isPending && <p className="text-gray-400">…</p>}
      </div>
      <form className="flex gap-2 border-t border-gray-200 p-2 dark:border-gray-700" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. generate 1-5 and 8" aria-label="Message the assistant"
          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" data-testid="assistant-input" />
        <button type="submit" disabled={!text.trim() || send.isPending} className="rounded bg-brand-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50" data-testid="assistant-send">Send</button>
      </form>
    </aside>
  );
}
