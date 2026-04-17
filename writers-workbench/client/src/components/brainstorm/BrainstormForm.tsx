import { useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { GenreConfig, StoryArc } from '../../types/database';

interface ParsedFields {
  title: string;
  genre_suggestion: string;
  story_arc: string;
  themes: string[];
  summary: string;
  raw_text: string;
}

export default function BrainstormForm() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const fileRef = useRef<HTMLInputElement>(null);

  // Form state
  const [contentText, setContentText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [genreSlug, setGenreSlug] = useState('');
  const [storyArc, setStoryArc] = useState('');
  const [chapterCount, setChapterCount] = useState('');
  const [themes, setThemes] = useState<string[]>([]);
  const [newTheme, setNewTheme] = useState('');

  // UI state
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Fetch genres and story arcs
  const { data: genres } = useQuery({
    queryKey: ['genres-for-brainstorm', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('genre_config_v2')
        .select('*')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .eq('active', true)
        .order('genre_name');
      if (error) throw error;
      return data as GenreConfig[];
    },
    enabled: !!userId,
  });

  const { data: arcs } = useQuery({
    queryKey: ['arcs-for-brainstorm', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('story_arcs_v2')
        .select('*')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order('name');
      if (error) throw error;
      return data as StoryArc[];
    },
    enabled: !!userId,
  });

  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  };

  // Match genre suggestion against available genres (fuzzy)
  const matchGenre = useCallback(
    (suggestion: string) => {
      if (!genres?.length || !suggestion) return '';
      const lower = suggestion.toLowerCase();
      const exact = genres.find(
        (g) => g.genre_slug === lower || g.genre_name.toLowerCase() === lower
      );
      if (exact) return exact.genre_slug;
      const partial = genres.find(
        (g) =>
          g.genre_name.toLowerCase().includes(lower) ||
          lower.includes(g.genre_name.toLowerCase())
      );
      return partial?.genre_slug || '';
    },
    [genres]
  );

  // Match story arc name
  const matchArc = useCallback(
    (name: string) => {
      if (!arcs?.length || !name) return '';
      const lower = name.toLowerCase();
      const exact = arcs.find((a) => a.name.toLowerCase() === lower);
      if (exact) return exact.name;
      const partial = arcs.find(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          lower.includes(a.name.toLowerCase())
      );
      return partial?.name || '';
    },
    [arcs]
  );

  // Parse content with AI
  const handleParse = async () => {
    setParsing(true);
    setResult(null);
    try {
      const token = await getToken();
      let res: Response;

      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        if (contentText) formData.append('content_text', contentText);
        res = await fetch('/api/brainstorm/parse', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
      } else {
        res = await fetch('/api/brainstorm/parse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content_text: contentText }),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Parse failed');
      }

      const data: ParsedFields = await res.json();
      setTitle(data.title || '');
      setGenreSlug(matchGenre(data.genre_suggestion));
      setStoryArc(matchArc(data.story_arc));
      setThemes(data.themes || []);
      if (data.raw_text && !contentText) setContentText(data.raw_text);
      setParsed(true);
    } catch (err) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to analyze content',
      });
    } finally {
      setParsing(false);
    }
  };

  // Submit brainstorm
  const handleSubmit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const token = await getToken();
      let res: Response;

      const fields = {
        content_text: contentText,
        title,
        genre_slug: genreSlug,
        story_arc: storyArc,
        target_chapter_count: chapterCount ? parseInt(chapterCount, 10) : undefined,
        themes: themes.join(', '),
      };

      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        Object.entries(fields).forEach(([key, val]) => {
          if (val !== undefined) formData.append(key, String(val));
        });
        res = await fetch('/api/brainstorm/submit', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
      } else {
        res = await fetch('/api/brainstorm/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(fields),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Submit failed');
      }

      setResult({
        type: 'success',
        message:
          'Brainstorm submitted! Your outline will appear in Projects and be emailed to you.',
      });
    } catch (err) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to submit brainstorm',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    // Auto-trigger parse on file upload
    if (f) {
      setTimeout(() => handleParse(), 100);
    }
  };

  const removeTheme = (index: number) => {
    setThemes((prev) => prev.filter((_, i) => i !== index));
  };

  const addTheme = () => {
    const trimmed = newTheme.trim();
    if (trimmed && !themes.includes(trimmed)) {
      setThemes((prev) => [...prev, trimmed]);
      setNewTheme('');
    }
  };

  const canSubmit =
    (contentText.length >= 10 || !!file) && title && genreSlug && storyArc && !submitting;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Brainstorm a Book</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Paste your book concept, character backstories, or upload a document. We'll extract the
          key details and generate a structured outline.
        </p>
      </div>

      {/* Step 1: Content Input */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Step 1: Provide Your Book Concept
        </h2>

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Book Concept Text
          </label>
          <textarea
            value={contentText}
            onChange={(e) => setContentText(e.target.value)}
            rows={12}
            maxLength={50000}
            placeholder="Paste your book idea, premise, character descriptions, chapter structure, or any notes here..."
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white resize-y"
          />
          <div className="flex justify-between mt-1">
            <span className="text-xs text-gray-400">
              {contentText.length.toLocaleString()} / 50,000 characters
            </span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Or Upload a Document
          </label>
          <div
            className="rounded-lg border-2 border-dashed border-gray-300 px-4 py-6 text-center hover:border-brand-400 transition-colors cursor-pointer dark:border-gray-600"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) {
                setFile(f);
                setTimeout(() => handleParse(), 100);
              }
            }}
          >
            {file ? (
              <div className="flex items-center justify-center gap-2">
                <svg
                  className="h-5 w-5 text-green-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {file.name} ({(file.size / 1024).toFixed(0)} KB)
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                    if (fileRef.current) fileRef.current.value = '';
                  }}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div>
                <svg
                  className="mx-auto h-8 w-8 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                  />
                </svg>
                <p className="mt-1 text-sm text-gray-500">
                  Drop a .docx or .pdf here, or click to browse
                </p>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <button
          onClick={handleParse}
          disabled={parsing || (contentText.length < 10 && !file)}
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {parsing ? 'Analyzing...' : 'Analyze Content'}
        </button>
      </div>

      {/* Step 2: Review Extracted Fields */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            Step 2: Review & Adjust
          </h2>
          {parsed && (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:bg-green-950 dark:text-green-400">
              Extracted from your text
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Book title"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Target Chapter Count
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={chapterCount}
              onChange={(e) => setChapterCount(e.target.value)}
              placeholder="e.g. 15"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Genre <span className="text-red-500">*</span>
            </label>
            <select
              value={genreSlug}
              onChange={(e) => setGenreSlug(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="">Select a genre...</option>
              {genres?.map((g) => (
                <option key={g.id} value={g.genre_slug}>
                  {g.genre_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Story Arc <span className="text-red-500">*</span>
            </label>
            <select
              value={storyArc}
              onChange={(e) => setStoryArc(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="">Select a story arc...</option>
              {arcs?.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Themes */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Themes
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {themes.map((theme, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
              >
                {theme}
                <button onClick={() => removeTheme(i)} className="text-brand-500 hover:text-brand-700">
                  &times;
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTheme}
              onChange={(e) => setNewTheme(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTheme())}
              placeholder="Add a theme..."
              className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <button
              onClick={addTheme}
              disabled={!newTheme.trim()}
              className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-400"
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Step 3: Submit */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Step 3: Submit Brainstorm
        </h2>

        {result && (
          <div
            className={`rounded-lg p-3 text-sm ${
              result.type === 'success'
                ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
            }`}
          >
            {result.message}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Submitting...' : 'Submit Brainstorm'}
        </button>

        {!canSubmit && !submitting && (
          <p className="text-xs text-gray-400">
            {!contentText && !file
              ? 'Add content text or upload a file to get started.'
              : !title
                ? 'A title is required.'
                : !genreSlug
                  ? 'Select a genre.'
                  : !storyArc
                    ? 'Select a story arc.'
                    : ''}
          </p>
        )}
      </div>
    </div>
  );
}
