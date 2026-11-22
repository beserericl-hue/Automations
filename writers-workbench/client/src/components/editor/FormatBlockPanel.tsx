/**
 * The formatting-block controls: choose a font, size, alignment, indent and spacing for the selected
 * paragraphs and see it as you go, save the look as a preset, and reuse it anywhere in any book.
 *
 * With the cursor outside a block the controls describe the look to give the selection, previewed on
 * the selected words, and "Make this a block" applies it. With the cursor inside a block they edit that
 * block live, so the chapter shows each change as it is made. Only the selected paragraphs change.
 */
import { useEffect, useReducer, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { BLOCK_DEFAULTS, BLOCK_FONTS, BLOCK_LIMITS, blockCss, cleanBlockStyle, type BlockStyle } from '../../lib/blockStyle';
import { useToast } from '../../contexts/ToastContext';

interface Preset {
  name: string;
  style: BlockStyle;
}

const field = 'block text-[11px] font-medium text-gray-600 dark:text-gray-400';
const input =
  'mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white';
const btn =
  'rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';

export default function FormatBlockPanel({ editor }: { editor: Editor }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [draft, setDraft] = useState<BlockStyle>(BLOCK_DEFAULTS);
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const { addToast } = useToast();

  // The panel follows the cursor: which block it is in changes what the controls mean.
  useEffect(() => {
    editor.on('transaction', tick);
    return () => {
      editor.off('transaction', tick);
    };
  }, [editor]);

  const inBlock = editor.isActive('formatBlock');
  const current: BlockStyle = inBlock ? cleanBlockStyle(editor.getAttributes('formatBlock')) : draft;

  const { data: presets = [], isSuccess: presetsLoaded } = useQuery({
    queryKey: ['format-presets'],
    queryFn: async () => (await apiFetch<ApiEnvelope<{ presets: Preset[] }>>('/api/format-presets')).data!.presets,
  });
  const save = useMutation({
    mutationFn: async (next: Preset[]) => (await apiFetch<ApiEnvelope<{ presets: Preset[] }>>('/api/format-presets', { method: 'PUT', body: JSON.stringify({ presets: next }) })).data!.presets,
    onSuccess: (p) => qc.setQueryData(['format-presets'], p),
    onError: () => addToast('Could not save your looks. Try again.', 'error'),
  });

  const change = (patch: Partial<BlockStyle>) => {
    if (inBlock) editor.chain().focus().updateFormatBlock(patch).run();
    else setDraft((d) => cleanBlockStyle({ ...d, ...patch }));
  };

  const { from, to } = editor.state.selection;
  const selected = from === to ? '' : editor.state.doc.textBetween(from, to, '\n\n').trim();
  const sample = (inBlock ? editor.state.selection.$from.parent.textContent : selected) || 'Dear Marcus, I am writing about the box.';
  const preview = sample.length > 140 ? `${sample.slice(0, 140)}…` : sample;

  const apply = () => {
    const ok = editor.chain().focus().setFormatBlock({ ...draft, ...(name && presets.some((p) => p.name === name) ? { preset: name } : {}) }).run();
    if (!ok) addToast('Select the paragraphs to set apart first.', 'info');
  };

  const pickPreset = (n: string) => {
    const p = presets.find((x) => x.name === n);
    if (!p) return;
    setName(p.name);
    const style = { ...p.style, preset: p.name };
    if (inBlock) editor.chain().focus().updateFormatBlock(style).run();
    else setDraft(style);
  };

  const savePreset = () => {
    const n = name.trim();
    if (!n) return;
    const next = [...presets.filter((p) => p.name.toLowerCase() !== n.toLowerCase()), { name: n, style: { ...current, preset: n } }];
    save.mutate(next, { onSuccess: () => addToast(`Saved "${n}". It is in your list for every book.`, 'success') });
  };

  return (
    <div data-testid="format-block-panel" className="space-y-2 border border-t-0 border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {inBlock ? 'Editing the block your cursor is in. Changes show in the chapter as you make them.' : 'Select the paragraphs to set apart, choose a look, then make them a block.'}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className={field}>
          Font
          <select aria-label="Block font" className={input} value={current.font} onChange={(e) => change({ font: e.target.value as BlockStyle['font'] })}>
            {BLOCK_FONTS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className={field}>
          Size ({current.size}%)
          <input aria-label="Block size" type="range" min={BLOCK_LIMITS.size[0]} max={BLOCK_LIMITS.size[1]} step={5} value={current.size} onChange={(e) => change({ size: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
        <label className={field}>
          Alignment
          <select aria-label="Block alignment" className={input} value={current.align} onChange={(e) => change({ align: e.target.value as BlockStyle['align'] })}>
            <option value="left">Left</option>
            <option value="center">Centered</option>
            <option value="right">Right</option>
            <option value="justify">Justified</option>
          </select>
        </label>
        <label className={field}>
          Indent ({current.indent} em)
          <input aria-label="Block indent" type="range" min={BLOCK_LIMITS.indent[0]} max={BLOCK_LIMITS.indent[1]} step={0.5} value={current.indent} onChange={(e) => change({ indent: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
        <label className={field}>
          Line spacing ({current.spacing})
          <input aria-label="Block line spacing" type="range" min={BLOCK_LIMITS.spacing[0]} max={BLOCK_LIMITS.spacing[1]} step={0.1} value={current.spacing} onChange={(e) => change({ spacing: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-gray-700 dark:text-gray-300">
          <input aria-label="Block italic" type="checkbox" checked={current.italic} onChange={(e) => change({ italic: e.target.checked })} />
          Italic
        </label>
      </div>

      <div data-testid="format-block-preview" className="max-h-24 overflow-y-auto rounded border border-dashed border-gray-300 bg-gray-50 px-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
        <div style={Object.fromEntries(blockCss(current).split(';').map((d) => { const [k, ...v] = d.split(':'); return [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v.join(':')]; }))}>{preview}</div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className={`${field} min-w-40 flex-1`}>
          Saved looks
          <select aria-label="Saved looks" className={input} value={presets.some((p) => p.name === name) ? name : ''} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">{presets.length ? 'Choose a saved look…' : 'None saved yet'}</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className={`${field} min-w-40 flex-1`}>
          Name this look
          <input aria-label="Preset name" className={input} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Letter, Epigraph, Poem…" />
        </label>
        <button type="button" className={btn} onClick={savePreset} disabled={!name.trim() || save.isPending || !presetsLoaded}
          title={presetsLoaded ? undefined : 'Your saved looks are still loading'}>
          Save this look
        </button>
        {presets.some((p) => p.name === name) ? (
          <button type="button" className={btn} onClick={() => save.mutate(presets.filter((p) => p.name !== name))} disabled={save.isPending || !presetsLoaded}>
            Delete saved look
          </button>
        ) : null}
      </div>

      <div className="flex gap-2">
        {inBlock ? (
          <button type="button" data-testid="unset-format-block" className={btn} onClick={() => editor.chain().focus().unsetFormatBlock().run()}>
            Remove the block (keep the text)
          </button>
        ) : (
          <button type="button" data-testid="set-format-block" className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700" onClick={apply}>
            Make this a block
          </button>
        )}
      </div>
    </div>
  );
}
