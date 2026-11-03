/**
 * The studio assistant — the n8n studio chat, on the engine hub (studio surface). "generate 1-5 and 8",
 * "revise #3 to be shorter", "schedule all approved", "list the queue", "cancel 4",
 * "put 1-6 in this week's newsletter". It acts on the same data the page shows, so the page refreshes
 * after every answer; queued work (drafting, revising) is tracked like the page's own buttons.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { studioApi } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

const EXAMPLES = ['show the slate', 'generate 1-3', 'list my drafts', 'approve all', 'schedule all approved', 'list the queue', 'put 1-6 in the newsletter', 'help'];

export default function StudioAssistant({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');

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
    setText('');
    send.mutate(msg);
  };

  return (
    <aside className="flex max-h-[80vh] flex-col rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900" data-testid="studio-assistant">
      <h2 className="border-b border-gray-200 px-3 py-2 text-sm font-semibold text-gray-800 dark:border-gray-700 dark:text-gray-100">Assistant</h2>
      <div className="flex-1 space-y-2 overflow-auto p-3 text-sm" aria-live="polite" data-testid="assistant-log">
        {!turns.length && (
          <div className="space-y-2 text-gray-500">
            <p>Tell me what to do with this edition. Plain numbers after “generate” are slate ranks; #N is a post.</p>
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
