/**
 * One field the author writes, with an AI assistant beside it.
 *
 *   Draft with AI   — written from the book's own material (server: routes/copy-assist.ts).
 *   Revise with AI  — the author says what to change ("shorter, more suspense").
 *   Undo            — back to what the field said before the last AI change, as many steps as were made.
 *
 * NOTHING IS SAVED HERE. A draft lands in the editable field; the author edits it and saves with the
 * section's own Save button, as before. And nothing replaces what the author already wrote without
 * their say: when the field has text, the draft is shown beside it with "Use this" / "Discard".
 *
 * Every field shows its count against the platform's limit (KDP description 4,000 characters,
 * 7 keywords of 50...). The price is on the button; admins are not charged.
 */

import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

export interface FieldInfo {
  label: string;
  kind: 'text' | 'list';
  /** Text: the whole field. List: each item. */
  limit: number;
  max_items: number | null;
  free: boolean;
}

export interface AssistInfo {
  price: number;
  charged: boolean;
  fields: Record<string, FieldInfo>;
  package_fields: string[];
}

export interface SavedCopy {
  books: Record<string, { subtitle: string; inside_flap: string }>;
  also_by: string[];
  assist: AssistInfo;
}

export interface AssistResult {
  field: string;
  value: string;
  items: string[];
  attribution?: string;
  chars: number;
  limit: number;
  over_limit: boolean;
  warnings: string[];
  credits_charged: number;
  credits_remaining?: number;
}

/** The saved subtitle / inside flap / Also by, and the assistant's price and limits. */
export function useSavedCopy(projectId: string) {
  return useQuery({
    queryKey: ['copy-assist', projectId],
    queryFn: async () => (await apiFetch<ApiEnvelope<SavedCopy>>(`/api/copy-assist/project/${projectId}/copy`)).data!,
  });
}

/**
 * The undo history of every assisted field on a screen. Shared, so "Draft all missing" can be undone
 * field by field too. Each entry is what the field said before an AI change.
 */
export function useFieldHistory() {
  // A ref, so pop() can return the value synchronously; the counter re-renders the Undo buttons.
  const ref = useRef<Record<string, string[]>>({});
  const [, setVersion] = useState(0);
  const push = useCallback((field: string, previous: string) => {
    ref.current = { ...ref.current, [field]: [...(ref.current[field] ?? []), previous] };
    setVersion((v) => v + 1);
  }, []);
  const pop = useCallback((field: string): string | undefined => {
    const list = [...(ref.current[field] ?? [])];
    const out = list.pop();
    ref.current = { ...ref.current, [field]: list };
    setVersion((v) => v + 1);
    return out;
  }, []);
  return { stacks: ref.current, push, pop };
}
export type FieldHistory = ReturnType<typeof useFieldHistory>;

/** The message for a failed call, with the credit numbers when it was the balance. */
export function assistErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402) {
      const e = (err.body as { error?: { creditsRequired?: number; creditsRemaining?: number } } | null)?.error;
      return `Not enough credits: this needs ${e?.creditsRequired ?? '?'}, you have ${e?.creditsRemaining ?? '?'}. Buy credits on the Billing page.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'The assistant failed';
}

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';
const smallBtn =
  'rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50';

/** "1,234 / 4,000" for text; "5 of 7 · longest 43/50" for a list. Red when over. */
export function countOf(value: string, info: FieldInfo): { text: string; over: boolean } {
  if (info.kind === 'list') {
    const items = value.split('\n').map((s) => s.trim()).filter(Boolean);
    const longest = Math.max(0, ...items.map((s) => s.length));
    const tooMany = info.max_items !== null && items.length > info.max_items;
    const tooLong = longest > info.limit;
    return {
      text: `${items.length}${info.max_items ? ` of ${info.max_items}` : ''}${items.length ? ` · longest ${longest}/${info.limit}` : ''}`,
      over: tooMany || tooLong,
    };
  }
  return { text: `${value.length.toLocaleString()} / ${info.limit.toLocaleString()}`, over: value.length > info.limit };
}

interface Props {
  projectId: string;
  volumeIndex?: number | null;
  /** The assistant's field key (server FIELD_SPECS). */
  field: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  /** Called when an AI draft is put in the field (for "saved as generated", and the epigraph's attribution). */
  onApplied?: (result: AssistResult) => void;
  rows?: number;
  assist: AssistInfo | undefined;
  history: FieldHistory;
  placeholder?: string;
}

export default function AiField({ projectId, volumeIndex, field, label, hint, value, onChange, onApplied, rows = 3, assist, history, placeholder }: Props) {
  const { addToast } = useToast();
  const info = assist?.fields[field];
  const [busy, setBusy] = useState<'draft' | 'revise' | null>(null);
  const [revising, setRevising] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<AssistResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // The value when the request went out: a draft for an empty field must not land on text typed meanwhile.
  const sentWith = useRef('');

  const apply = (r: AssistResult) => {
    history.push(field, value);
    onChange(r.value);
    onApplied?.(r);
    setWarnings(r.warnings);
    setProposal(null);
  };

  const run = async (mode: 'draft' | 'revise') => {
    setBusy(mode);
    sentWith.current = value;
    try {
      const res = await apiFetch<ApiEnvelope<AssistResult>>(`/api/copy-assist/project/${projectId}/assist`, {
        method: 'POST',
        body: JSON.stringify({
          field,
          volume_index: volumeIndex ?? null,
          mode,
          ...(mode === 'revise' ? { instruction: instruction.trim(), current: value } : {}),
        }),
      });
      const r = res.data!;
      if (!r.value.trim()) {
        addToast('The assistant came back with nothing. You were not charged.', 'error');
        return;
      }
      if (r.credits_charged) addToast(`${r.credits_charged} credits used${r.credits_remaining !== undefined ? ` · ${r.credits_remaining} left` : ''}`, 'info');
      // An empty field is filled at once (undoable). Text the author has is never replaced unasked.
      if (mode === 'draft' && !sentWith.current.trim() && !value.trim()) apply(r);
      else setProposal(r);
      if (mode === 'revise') {
        setRevising(false);
        setInstruction('');
      }
    } catch (err) {
      addToast(assistErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const undo = () => {
    const previous = history.pop(field);
    if (previous !== undefined) {
      onChange(previous);
      setWarnings([]);
    }
  };

  const count = info ? countOf(value, info) : null;
  const priced = assist && assist.charged && !info?.free ? ` · ${assist.price} cr` : '';
  const canUndo = (history.stacks[field]?.length ?? 0) > 0;
  const Input = rows <= 1 ? 'input' : 'textarea';

  return (
    <div data-testid={`ai-field-${field}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={`f-${field}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        {count ? (
          <span data-testid={`count-${field}`} className={`text-[11px] ${count.over ? 'font-semibold text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
            {count.text}
            {count.over ? ' · over the limit' : ''}
          </span>
        ) : null}
      </div>
      {hint ? <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-1" />}
      <Input
        id={`f-${field}`}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value)}
        {...(Input === 'textarea' ? { rows } : {})}
        placeholder={placeholder}
        className={inputClass}
      />

      {info ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid={`ai-draft-${field}`}
            onClick={() => void run('draft')}
            disabled={busy !== null}
            className={`${smallBtn} border-brand-300 text-brand-700 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40`}
          >
            {busy === 'draft' ? 'Drafting…' : info.free ? 'Fill from my projects' : `Draft with AI${priced}`}
          </button>
          {!info.free && value.trim() ? (
            <button
              type="button"
              data-testid={`ai-revise-${field}`}
              onClick={() => setRevising((r) => !r)}
              disabled={busy !== null}
              className={`${smallBtn} border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800`}
            >
              Revise with AI
            </button>
          ) : null}
          {canUndo ? (
            <button
              type="button"
              data-testid={`ai-undo-${field}`}
              onClick={undo}
              className={`${smallBtn} border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800`}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}

      {revising ? (
        <div className="mt-1 flex gap-1.5">
          <input
            data-testid={`ai-instruction-${field}`}
            aria-label={`What to change in the ${label.toLowerCase()}`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && instruction.trim()) void run('revise');
            }}
            placeholder="e.g. shorter, more suspense"
            className={`${inputClass} py-1 text-xs`}
          />
          <button
            type="button"
            data-testid={`ai-revise-go-${field}`}
            onClick={() => void run('revise')}
            disabled={!instruction.trim() || busy !== null}
            className={`${smallBtn} whitespace-nowrap border-brand-300 text-brand-700 dark:border-brand-700 dark:text-brand-300`}
          >
            {busy === 'revise' ? 'Revising…' : `Revise${priced}`}
          </button>
        </div>
      ) : null}

      {proposal ? (
        <div data-testid={`ai-proposal-${field}`} className="mt-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2 text-sm dark:border-brand-800 dark:bg-brand-950/20">
          <p className="mb-1 text-[11px] font-medium text-brand-700 dark:text-brand-300">
            AI suggestion — your text is unchanged until you choose
            {info ? ` · ${countOf(proposal.value, info).text}` : ''}
          </p>
          <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">{proposal.value}</p>
          {proposal.attribution ? <p className="mt-1 text-xs italic text-gray-500">— {proposal.attribution}</p> : null}
          <Warnings items={proposal.warnings} />
          <div className="mt-2 flex gap-1.5">
            <button type="button" data-testid={`ai-accept-${field}`} onClick={() => apply(proposal)} className={`${smallBtn} border-brand-600 bg-brand-600 text-white hover:bg-brand-700`}>
              Use this
            </button>
            <button type="button" data-testid={`ai-discard-${field}`} onClick={() => setProposal(null)} className={`${smallBtn} border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400`}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <Warnings items={warnings} />
      )}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1 list-disc rounded bg-amber-50 py-1 pl-5 pr-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      {items.map((w) => (
        <li key={w}>Check: {w}</li>
      ))}
    </ul>
  );
}
