import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { UNSAFE_DataRouterContext } from 'react-router-dom';
import { useContext } from 'react';
import EditorToolbar from './EditorToolbar';
import { findInDoc, RevealHighlight, revealPluginKey, REVEAL_CLASS } from './RevealHighlight';

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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const text = editor.getText();
        setWordCount(text.split(/\s+/).filter(Boolean).length);
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
      <div className="flex-1 overflow-y-auto border border-gray-200 rounded-b-lg bg-white dark:border-gray-700 dark:bg-gray-900">
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
