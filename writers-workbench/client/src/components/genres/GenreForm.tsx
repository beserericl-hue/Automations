import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { GenreConfig } from '../../types/database';

interface GenreFormProps {
  genre: GenreConfig | null; // null = creating new
  onClose: () => void;
}

export default function GenreForm({ genre, onClose }: GenreFormProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();

  const [name, setName] = useState(genre?.genre_name || '');
  const [slug, setSlug] = useState(genre?.genre_slug || '');
  const [description, setDescription] = useState(genre?.description || '');
  const [keywords, setKeywords] = useState(genre?.keywords.join(', ') || '');
  const [rssFeeds, setRssFeeds] = useState(genre?.rss_feed_urls || ['']);
  const [sourceUrls, setSourceUrls] = useState(genre?.source_urls || ['']);
  const [subreddits, setSubreddits] = useState(genre?.subreddit_names || ['']);
  const [goodreads, setGoodreads] = useState(genre?.goodreads_shelves || ['']);
  const [guidelines, setGuidelines] = useState(genre?.writing_guidelines || '');
  const [active, setActive] = useState(genre?.active ?? true);
  const [error, setError] = useState('');

  const autoSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const saveMutation = useMutation({
    mutationFn: async () => {
      const data = {
        user_id: userId!,
        genre_name: name.trim(),
        genre_slug: slug.trim() || autoSlug(name),
        description: description.trim(),
        keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
        rss_feed_urls: rssFeeds.filter(u => u.trim()),
        source_urls: sourceUrls.filter(u => u.trim()),
        subreddit_names: subreddits.filter(s => s.trim()),
        goodreads_shelves: goodreads.filter(g => g.trim()),
        writing_guidelines: guidelines.trim(),
        active,
      };

      if (genre) {
        const { error } = await supabase
          .from('genre_config_v2')
          .update(data)
          .eq('id', genre.id)
          .eq('user_id', userId!);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('genre_config_v2')
          .insert(data);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['genres'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to Genres</button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {genre ? 'Edit Genre' : 'New Genre'}
        </h1>
      </div>

      <div className="space-y-4">
        <Field label="Genre Name" required>
          <input value={name} onChange={e => { setName(e.target.value); if (!genre) setSlug(autoSlug(e.target.value)); }} className={inputClass} placeholder="Post-Apocalyptic Science Fiction" />
        </Field>

        <Field label="Slug">
          <input value={slug} onChange={e => setSlug(e.target.value)} className={inputClass} placeholder="post-apocalyptic" />
        </Field>

        <Field label="Description" required>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className={inputClass} placeholder="Stories set after civilization-ending events..." />
        </Field>

        <Field label="Keywords (comma-separated)">
          <input value={keywords} onChange={e => setKeywords(e.target.value)} className={inputClass} placeholder="post-apocalyptic, dystopian, survival" />
        </Field>

        <ArrayField label="RSS Feed URLs" values={rssFeeds} onChange={setRssFeeds} placeholder="https://medium.com/feed/tag/..." />
        <ArrayField label="Source URLs" values={sourceUrls} onChange={setSourceUrls} placeholder="https://www.reddit.com/r/..." />
        <ArrayField label="Subreddit Names" values={subreddits} onChange={setSubreddits} placeholder="PostApocalypticFiction" />
        <ArrayField label="Goodreads Shelves" values={goodreads} onChange={setGoodreads} placeholder="post-apocalyptic" />

        <Field label="Writing Guidelines" required>
          <textarea value={guidelines} onChange={e => setGuidelines(e.target.value)} rows={4} className={inputClass} placeholder="Tone: gritty, visceral, intimate..." />
        </Field>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded border-gray-300" />
          <span className="text-sm text-gray-700 dark:text-gray-300">Active</span>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !name.trim() || !description.trim() || !guidelines.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : genre ? 'Update Genre' : 'Create Genre'}
          </button>
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function ArrayField({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const addItem = () => onChange([...values, '']);
  const removeItem = (i: number) => onChange(values.filter((_, idx) => idx !== i));
  const updateItem = (i: number, val: string) => {
    const next = [...values];
    next[i] = val;
    onChange(next);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
      <div className="space-y-2">
        {values.map((val, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={val}
              onChange={e => updateItem(i, e.target.value)}
              className={inputClass + ' flex-1'}
              placeholder={placeholder}
            />
            <button onClick={() => removeItem(i)} className="text-xs text-red-500 hover:text-red-600 px-2" title="Remove">
              &times;
            </button>
          </div>
        ))}
        <button onClick={addItem} className="text-xs text-brand-600 hover:text-brand-700">+ Add</button>
      </div>
    </div>
  );
}
