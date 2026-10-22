/**
 * Author Profile — the facts a bio is written from, and the bio itself.
 *
 * This screen exists because the bio generator had no intake. The facts were being typed into a
 * script by hand, which is another way of saying the first bio this system produced was invented.
 * Nothing on this page is optional in the sense that matters: what is here is what the generator is
 * allowed to say, and what is not here it must leave out.
 *
 * The review loop is the point. Draft, read it, then either accept it or change a word of it — and
 * what is saved records which of those happened, because "a model wrote this" and "I signed this"
 * are different states for a paragraph that will be printed in a book.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope, type ApiError } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Profile {
  pen_name: string;
  lives: string;
  background: string;
  credentials: string[];
  prior_work: string[];
  why_this_book: string;
  personal: string;
  links: string[];
  bio: string;
  bio_source: 'generated' | 'edited' | null;
  bio_updated_at: string | null;
  gaps: string[];
}

const EMPTY: Profile = {
  pen_name: '',
  lives: '',
  background: '',
  credentials: [],
  prior_work: [],
  why_this_book: '',
  personal: '',
  links: [],
  bio: '',
  bio_source: null,
  bio_updated_at: null,
  gaps: [],
};

export default function AuthorProfile() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['author-profile'],
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<Profile>>('/api/author/profile');
      return res.data ?? EMPTY;
    },
    // Retrying a missing table just repeats the same answer slower.
    retry: (count, err) => (err as ApiError)?.code !== 'MIGRATION_PENDING' && count < 2,
  });

  const [form, setForm] = useState<Profile>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * The draft exactly as it was generated, so "did a human change this" is answered by comparison
   * rather than guessed at. null means the author started from a blank box, which is `edited` by
   * definition.
   */
  const [asGenerated, setAsGenerated] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  /** When the last save landed, so the confirmation can sit on the page rather than in a toast. */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load once. Re-syncing on every refetch would overwrite what the author is in the middle of
  // typing, which is the classic way a form throws away an edit.
  useEffect(() => {
    if (data && !loaded) {
      setForm(data);
      setLoaded(true);
    }
  }, [data, loaded]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Is there typing here that is not in the database?
   *
   * Compared against what the server last returned, not against a flag set on every keystroke, so
   * typing a word and deleting it again does not count as a change. These are paragraphs somebody
   * wrote by hand; losing them to a stray click is not a small failure.
   */
  const dirty = useMemo(() => {
    if (!data) return false;
    const same = (a: string, b: string): boolean => a.trim() === b.trim();
    const sameList = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((v, i) => same(v, b[i]));
    return !(
      same(form.pen_name, data.pen_name) &&
      same(form.lives, data.lives) &&
      same(form.background, data.background) &&
      same(form.why_this_book, data.why_this_book) &&
      same(form.personal, data.personal) &&
      sameList(form.credentials, data.credentials) &&
      sameList(form.prior_work, data.prior_work) &&
      sameList(form.links, data.links)
    );
  }, [form, data]);

  // The browser's own guard. Without it a stray cmd-W drops everything typed since the last save.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const saveFacts = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<ApiEnvelope<Profile>>('/api/author/profile', {
        method: 'PUT',
        body: JSON.stringify({
          pen_name: form.pen_name,
          lives: form.lives,
          background: form.background,
          credentials: form.credentials,
          prior_work: form.prior_work,
          why_this_book: form.why_this_book,
          personal: form.personal,
          links: form.links,
        }),
      });
      return res.data!;
    },
    onSuccess: (saved) => {
      setForm((f) => ({ ...saved, bio: f.bio || saved.bio }));
      void queryClient.invalidateQueries({ queryKey: ['author-profile'] });
      // Confirmed in place as well as in a toast. A toast is gone in four seconds and is easy to
      // miss while reading the form, which leaves the author unsure whether anything happened.
      setSavedAt(Date.now());
      addToast('Saved', 'success');
    },
    onError: (err: Error) => {
      setSaveError(err.message || 'Could not save');
      addToast(err.message || 'Could not save', 'error');
    },
  });

  const writeBio = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<ApiEnvelope<{ ok: boolean; bio: string; reason: string | null; gaps: string[] }>>(
        '/api/author/bio',
        { method: 'POST', body: JSON.stringify({ instructions: instructions.trim() || undefined }) },
      );
      return res.data!;
    },
    onSuccess: (result) => {
      if (!result.ok || !result.bio.trim()) {
        addToast(result.reason || 'No bio could be written from these facts', 'error');
        return;
      }
      setDraft(result.bio);
      setAsGenerated(result.bio);
      setInstructions('');
    },
    onError: (err: Error) => addToast(err.message || 'Could not write the bio', 'error'),
  });

  const approveBio = useMutation({
    mutationFn: async (vars: { bio: string; source: 'generated' | 'edited' }) => {
      const res = await apiFetch<ApiEnvelope<Profile>>('/api/author/bio', {
        method: 'PUT',
        body: JSON.stringify(vars),
      });
      return res.data!;
    },
    onSuccess: (saved) => {
      setForm(saved);
      setDraft(null);
      setAsGenerated(null);
      void queryClient.invalidateQueries({ queryKey: ['author-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['publishing'] });
      addToast('Bio saved', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not save the bio', 'error'),
  });

  if (isLoading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }
  // Say which migration is missing rather than showing a form that silently cannot save.
  if ((error as ApiError)?.code === 'MIGRATION_PENDING') {
    return (
      <div className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
        <h1 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Author Profile storage is not set up on this database
        </h1>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          Migration <code>032_author_profiles.sql</code> has not been applied here. Until it is,
          there is nowhere to keep these facts — so the form is hidden rather than shown and unable
          to save.
        </p>
      </div>
    );
  }

  // A name is not a fact — the same rule the server and the engine both apply. A bio written from
  // a name alone is a bio about nobody, and the gap gets filled with a career. So the button stays
  // disabled for the reason the request would be refused, rather than refusing after the click.
  const hasFacts = Boolean(
    form.lives.trim() ||
      form.background.trim() ||
      form.why_this_book.trim() ||
      form.personal.trim() ||
      form.credentials.length ||
      form.prior_work.length,
  );

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Author Profile</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your bio is written from these facts and from nothing else. Anything you leave blank is
          left out of the bio rather than guessed at.
        </p>
      </div>

      <Section title="The byline">
        <Field label="Name to publish under" hint="A pen name is fine. This is what goes on the cover, the copyright page and the KDP listing.">
          <input value={form.pen_name} onChange={(e) => set('pen_name', e.target.value)} className={inputClass} placeholder="Eric L Beser" />
        </Field>
        <Field label="Where you live" hint="Conventional in a bio, and optional.">
          <input value={form.lives} onChange={(e) => set('lives', e.target.value)} className={inputClass} placeholder="Baltimore, Maryland" />
        </Field>
      </Section>

      <Section title="What you bring to the work">
        <Field label="Background" hint="Career and expertise, especially where it touches what you write about.">
          <textarea value={form.background} onChange={(e) => set('background', e.target.value)} rows={4} className={inputClass} />
        </Field>
        <Field
          label="Why this book"
          hint="Your connection to the subject. This is the sentence a reader at the back cover actually wants, and the one the bio leads with. A project can override it with its own reason."
        >
          <textarea value={form.why_this_book} onChange={(e) => set('why_this_book', e.target.value)} rows={3} className={inputClass} />
        </Field>
        <ListField
          label="Credentials"
          hint="Degrees, awards, memberships — exactly as you would have them printed. Nothing is added to this list for you."
          values={form.credentials}
          onChange={(v) => set('credentials', v)}
          placeholder="MS Computer Science, Johns Hopkins"
        />
        <ListField
          label="Prior work"
          hint="Earlier books, articles, films."
          values={form.prior_work}
          onChange={(v) => set('prior_work', v)}
          placeholder="The Burial Mound (2024)"
        />
        <Field label="One human detail" hint="Optional, and the thing that stops a bio reading as a CV.">
          <textarea value={form.personal} onChange={(e) => set('personal', e.target.value)} rows={2} className={inputClass} />
        </Field>
        <ListField
          label="Links"
          hint="Site and socials. Amazon Author Central asks for these; the bio does not use them."
          values={form.links}
          onChange={(v) => set('links', v)}
          placeholder="https://…"
        />
      </Section>

      {/* NOTHING ON THIS PAGE IS REQUIRED, and the save button has to say so. An earlier version
          put a bare "1 field still empty" right here, which beside a Save button reads as the
          reason it will not save — so it was read as a validation error on a form that had in fact
          saved. The count stayed; what it means is now spelled out, and a successful save is
          confirmed in place rather than only in a toast that is gone in four seconds. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            setSaveError(null);
            saveFacts.mutate();
          }}
          disabled={saveFacts.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveFacts.isPending ? 'Saving…' : 'Save facts'}
        </button>
        {/* A live region: whether the work is stored is exactly the kind of change a screen reader
            has to be told about without the user going looking for it. */}
        <span role="status" aria-live="polite">
          {dirty && !saveFacts.isPending ? (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Unsaved changes
            </span>
          ) : null}
          {!dirty && savedAt && !saveFacts.isPending && !saveError ? (
            <span className="text-xs font-medium text-green-600 dark:text-green-400">
              Saved at {new Date(savedAt).toLocaleTimeString()}
            </span>
          ) : null}
          {saveError ? (
            <span className="text-xs font-medium text-red-600 dark:text-red-400">{saveError}</span>
          ) : null}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Every field is optional
          {data?.gaps?.length
            ? ` — ${data.gaps.length} still empty, which only means the bio will not mention ${
                data.gaps.length === 1 ? 'it' : 'them'
              }.`
            : '.'}
        </span>
      </div>

      {/* The bio: draft, read, accept or rewrite. */}
      <Section title="Author bio">
        {form.bio && !draft ? (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">
              {form.bio}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {form.bio_source === 'edited' ? 'In your own words' : 'Generated and accepted'}
              {form.bio_updated_at ? ` · ${new Date(form.bio_updated_at).toLocaleDateString()}` : ''}
            </p>
          </div>
        ) : null}

        {draft !== null ? (
          <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3 dark:border-brand-800 dark:bg-brand-950/20">
            <p className="text-xs font-medium text-brand-700 dark:text-brand-300">
              Draft — edit it here if you want, then save. Nothing is stored until you do.
            </p>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} className={inputClass} />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  approveBio.mutate({
                    bio: draft,
                    source: asGenerated !== null && draft === asGenerated ? 'generated' : 'edited',
                  })
                }
                disabled={approveBio.isPending || !draft.trim()}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Use this bio
              </button>
              <button
                onClick={() => {
                  setDraft(null);
                  setAsGenerated(null);
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}

        <Field
          label="Ask for a change"
          hint='Optional steer for the next draft — "shorter", "lead with the dig", "drop the degree".'
        >
          <input
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className={inputClass}
            placeholder="Mention that I grew up near the site"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => writeBio.mutate()}
            disabled={writeBio.isPending || !hasFacts}
            className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
          >
            {writeBio.isPending ? 'Writing…' : form.bio ? 'Write a new draft' : 'Write my bio'}
          </button>
          <button
            onClick={() => {
              setDraft(form.bio || '');
              setAsGenerated(null);
            }}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Write it myself
          </button>
          {!hasFacts ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Fill in your background or why this book first. A bio cannot be written from the
              manuscript, and a name on its own is not enough to write one from.
            </span>
          ) : null}
        </div>

        {/* Amber only while something is missing that would actually change the bio. Once all that
            is left is optional, the same list in a warning colour says "you have a problem" about a
            form that is finished. */}
        {data?.gaps?.length ? (
          (() => {
            const optionalOnly = data.gaps.every((g) => g.includes('(optional'));
            return (
              <div
                className={`rounded-lg p-3 ${
                  optionalOnly ? 'bg-gray-50 dark:bg-gray-800/50' : 'bg-amber-50 dark:bg-amber-950/20'
                }`}
              >
                <p
                  className={`text-xs font-medium ${
                    optionalOnly
                      ? 'text-gray-600 dark:text-gray-300'
                      : 'text-amber-800 dark:text-amber-300'
                  }`}
                >
                  {optionalOnly
                    ? 'You could still add, though the bio reads fine without:'
                    : 'The bio has no way of knowing:'}
                </p>
                <ul
                  className={`mt-1 list-disc pl-4 text-xs space-y-0.5 ${
                    optionalOnly
                      ? 'text-gray-600 dark:text-gray-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {data.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            );
          })()
        ) : null}
      </Section>
    </div>
  );
}

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {hint ? <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-1" />}
      {children}
    </div>
  );
}

/**
 * A list of short facts, one per row.
 *
 * Deliberately not a comma-separated text box: a credential can contain a comma, and splitting on
 * one turns "MS Computer Science, Johns Hopkins" into two half-facts the bio writer then has to
 * guess at.
 */
function ListField({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [adding, setAdding] = useState('');
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={`${v}-${i}`} className="flex gap-2">
            <input
              value={v}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              className={inputClass}
            />
            <button
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`Remove ${v || 'entry'}`}
              className="rounded-lg border border-gray-300 px-2 text-xs text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adding.trim()) {
                e.preventDefault();
                onChange([...values, adding.trim()]);
                setAdding('');
              }
            }}
            placeholder={placeholder}
            className={inputClass}
          />
          <button
            onClick={() => {
              if (!adding.trim()) return;
              onChange([...values, adding.trim()]);
              setAdding('');
            }}
            className="rounded-lg border border-gray-300 px-3 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Add
          </button>
        </div>
      </div>
    </Field>
  );
}
