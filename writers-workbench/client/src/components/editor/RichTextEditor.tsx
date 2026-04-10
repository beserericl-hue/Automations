import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Link from '@tiptap/extension-link';
import { useEffect, useRef, useCallback } from 'react';
import EditorToolbar from './EditorToolbar';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
}

export default function RichTextEditor({ content, onChange, editable = true, placeholder = 'Start writing...' }: RichTextEditorProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder }),
      CharacterCount,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-brand-600 underline hover:text-brand-700' },
      }),
    ],
    content,
    editable,
    onUpdate: ({ editor }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onChange(editor.getHTML());
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
    }
  }, [content, editor]);

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
    }
  }, [editor, onChange]);

  if (!editor) return null;

  const wordCount = editor.storage.characterCount.words();
  const charCount = editor.storage.characterCount.characters();

  return (
    <div className="flex flex-col h-full">
      {editable && <EditorToolbar editor={editor} onSave={saveNow} />}
      <div className="flex-1 overflow-y-auto border border-gray-200 rounded-b-lg bg-white dark:border-gray-700 dark:bg-gray-900">
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700">
        <span>{wordCount.toLocaleString()} words &middot; {charCount.toLocaleString()} characters</span>
        {editable && <span>Auto-saves after 2s of inactivity</span>}
      </div>
    </div>
  );
}
