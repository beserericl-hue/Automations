import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { UNSAFE_DataRouterContext } from 'react-router-dom';
import { useContext } from 'react';
import EditorToolbar from './EditorToolbar';
import {
  findInDoc,
  findAllInDoc,
  FindHighlight,
  findPluginKey,
  RevealHighlight,
  revealPluginKey,
  REVEAL_CLASS,
} from './RevealHighlight';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
}

/** What a review panel can ask the editor to do: show me this passage. */
export interface RichTextEditorHandle {
  /**
   * Scroll a quoted passage into view and mark it. Returns 'exact' when the quote was found
   * character for character, 'approximate' when only its opening matched — the chapter has been
   * edited since the quote was taken — and 'missing' when it is not there at all.
   */
  reveal: (quote: string) => 'exact' | 'approximate' | 'missing';
  clearReveal: () => void;
  /** The text the author has selected, paragraphs separated by a blank line; '' when none. */
  getSelectedText: () => string;
}

const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { content, onChange, editable = true, placeholder = 'Start writing...' },
  ref,
) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  // Typing not yet handed to onChange. A ref, not state, because the content effect below must see
  // it the moment a refetch lands, not on the next render.
  const typingRef = useRef(false);
  // The find box: the phrase, how many places it is, and which one is showing.
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findIndex, setFindIndex] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-brand-600 underline hover:text-brand-700' },
      }),
      RevealHighlight,
      FindHighlight,
    ],
    content,
    editable,
    onCreate: ({ editor }) => {
      // Count words once on load
      const text = editor.getText();
      setWordCount(text.split(/\s+/).filter(Boolean).length);
    },
    onUpdate: ({ editor }) => {
      setIsDirty(true);
      typingRef.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const text = editor.getText();
        setWordCount(text.split(/\s+/).filter(Boolean).length);
        typingRef.current = false;
        onChange(editor.getHTML());
        setIsDirty(false);
      }, 2000);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[400px] px-6 py-4',
      },
    },
  });

  // Update content when prop changes (e.g., loading new item)
  const prevContentRef = useRef(content);
  useEffect(() => {
    if (editor && content !== prevContentRef.current) {
      prevContentRef.current = content;
      // A save refetches the chapter, and the refetched copy used to replace the document, taking
      // with it whatever had been typed since the save: "VHMARK2" typed, "RK2" kept. While there is
      // unsaved typing, the typing wins; it is saved in its turn.
      if (typingRef.current) return;
      editor.commands.setContent(content, { emitUpdate: false });
      const text = editor.getText();
      setWordCount(text.split(/\s+/).filter(Boolean).length);
      setIsDirty(false);
    }
  }, [content, editor]);

  // Warn on browser tab close with unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Warn on in-app navigation with unsaved changes
  // useBlocker requires a data router — fall back to beforeunload-only if unavailable
  const dataRouterContext = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!isDirty || !dataRouterContext) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a[href]');
      if (anchor && isDirty) {
        const leave = window.confirm('You have unsaved changes. Are you sure you want to leave?');
        if (!leave) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [isDirty, dataRouterContext]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /**
   * Show a passage.
   *
   * The transaction carries only decoration metadata, so `docChanged` stays false: the chapter does
   * not go dirty and the two-second auto-save is not armed by looking at something.
   *
   * The scroll waits a frame because the decoration's element does not exist until ProseMirror has
   * rendered the new decoration set.
   */
  const reveal = useCallback(
    (quote: string): 'exact' | 'approximate' | 'missing' => {
      if (!editor || !quote.trim()) return 'missing';
      const hit = findInDoc(editor.state.doc, quote);
      if (!hit) {
        editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, null));
        return 'missing';
      }
      editor.view.dispatch(
        editor.state.tr.setMeta(revealPluginKey, { from: hit.from, to: hit.to }),
      );
      requestAnimationFrame(() => {
        const el = editor.view.dom.querySelector(`.${REVEAL_CLASS}`);
        // `center` rather than `start`: the whole point is reading the sentence against the ones
        // around it, and a passage pinned to the top of the pane has no "before" to read.
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return hit.exact ? 'exact' : 'approximate';
    },
    [editor],
  );

  const clearReveal = useCallback(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, null));
  }, [editor]);

  const getSelectedText = useCallback((): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return from === to ? '' : editor.state.doc.textBetween(from, to, '\n\n').trim();
  }, [editor]);

  useImperativeHandle(ref, () => ({ reveal, clearReveal, getSelectedText }), [reveal, clearReveal, getSelectedText]);

  // Find box. Marks every match and scrolls to the current one. The marks are decorations, so the
  // chapter does not go dirty and nothing is saved by looking.
  const showFind = useCallback(
    (query: string, wanted: number, scroll: boolean) => {
      if (!editor) return;
      const ranges = findAllInDoc(editor.state.doc, query);
      const current = ranges.length ? ((wanted % ranges.length) + ranges.length) % ranges.length : 0;
      editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, ranges.length ? { ranges, current } : null));
      setFindCount(ranges.length);
      setFindIndex(current);
      if (scroll && ranges.length) {
        requestAnimationFrame(() => {
          editor.view.dom.querySelector('.find-current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    },
    [editor],
  );

  useEffect(() => {
    showFind(findQuery, 0, true);
  }, [findQuery, showFind]);

  // Edits move the text under the marks: recount, keeping the position, without scrolling.
  useEffect(() => {
    if (!editor || !findQuery) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => showFind(findQuery, findIndex, false), 400);
    };
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor, findQuery, findIndex, showFind]);

  const saveNow = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (editor) {
      onChange(editor.getHTML());
      setIsDirty(false);
    }
  }, [editor, onChange]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full">
      {editable && <EditorToolbar editor={editor} onSave={saveNow} />}
      <div
        className={`flex flex-wrap items-center gap-2 border border-gray-200 bg-white px-3 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900 ${
          editable ? 'border-t-0' : 'rounded-t-lg'
        }`}
        role="search"
      >
        <input
          id="chapter-find"
          type="search"
          value={findQuery}
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              showFind(findQuery, findIndex + (e.shiftKey ? -1 : 1), true);
            } else if (e.key === 'Escape') {
              setFindQuery('');
            }
          }}
          placeholder="Find a phrase in this chapter (paste it here)"
          aria-label="Find a phrase in this chapter"
          className="min-w-0 flex-1 basis-56 rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        />
        {findQuery.trim().length >= 2 && (
          <>
            <span
              data-testid="find-count"
              className={findCount ? 'text-gray-600 dark:text-gray-300' : 'text-red-600 dark:text-red-400'}
            >
              {findCount ? `${findIndex + 1} of ${findCount}` : 'not found'}
            </span>
            <button
              type="button"
              onClick={() => showFind(findQuery, findIndex - 1, true)}
              disabled={findCount < 2}
              aria-label="Previous match"
              className="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => showFind(findQuery, findIndex + 1, true)}
              disabled={findCount < 2}
              aria-label="Next match"
              className="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => setFindQuery('')}
              className="rounded px-2 py-0.5 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
            >
              Clear
            </button>
          </>
        )}
      </div>
      <div className="flex-1 overflow-y-auto border border-t-0 border-gray-200 rounded-b-lg bg-white dark:border-gray-700 dark:bg-gray-900">
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700">
        <span>{wordCount.toLocaleString()} words</span>
        {editable && <span>Auto-saves after 2s of inactivity</span>}
      </div>
    </div>
  );
});

export default RichTextEditor;
