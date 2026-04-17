import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import { useEffect, useRef, useCallback, useState } from 'react';
import { UNSAFE_DataRouterContext } from 'react-router-dom';
import { useContext } from 'react';
import EditorToolbar from './EditorToolbar';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
}

export default function RichTextEditor({ content, onChange, editable = true, placeholder = 'Start writing...' }: RichTextEditorProps) {
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
}
