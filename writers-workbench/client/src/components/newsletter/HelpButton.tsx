/**
 * HelpButton — small "?" icon that opens an inline drawer with the
 * relevant section of the user guide. Keeps users oriented without a
 * separate docs site.
 *
 * Each section maps to a slug in NEWSLETTER_HELP. Adding a new screen?
 * Add a slug + body here, then drop <HelpButton section="…" /> into the
 * page header.
 */
import { useState } from 'react';

type HelpSection =
  | 'home'
  | 'editions'
  | 'feeds'
  | 'templates'
  | 'generate'
  | 'approvals'
  | 'sends'
  | 'ingestion';

interface HelpDoc {
  title: string;
  body: React.ReactNode;
}

const NEWSLETTER_HELP: Record<HelpSection, HelpDoc> = {
  home: {
    title: 'Newsletter home',
    body: (
      <>
        <p>This is the dashboard for your newsletter pipeline.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><strong>In-flight</strong> — the currently running n8n execution (if any). Click to see its progress.</li>
          <li><strong>Pending approvals</strong> — drafts waiting for your green-light. Stories first, then subject line.</li>
          <li><strong>Next scheduled send</strong> — the next cadence-driven send (Phase 2b).</li>
          <li><strong>Recent runs</strong> — your last 10 newsletter executions, click any row for the rendered HTML.</li>
        </ul>
      </>
    ),
  },
  editions: {
    title: 'Newsletters (editions)',
    body: (
      <>
        <p>Each "edition" is one branded newsletter. <strong>Identity</strong> sets the masthead; <strong>Branding</strong> sets the colors and the logo image used at the bottom of every send; <strong>Signoff</strong> is the name + role under the signature; <strong>Schedule</strong> is the cadence the cron picks up.</p>
        <p className="mt-2">After creating, you'll be walked through three setup steps: <em>Add feeds</em>, <em>Confirm template</em>, <em>Add first subscriber</em>. Skip any step and come back later — none of them block sending.</p>
        <p className="mt-2 text-xs text-gray-500">Slug is permanent because sends, approvals, feeds, and subscribers all reference it.</p>
      </>
    ),
  },
  feeds: {
    title: 'Feeds',
    body: (
      <>
        <p>Feeds are RSS / Reddit / source URLs that the cron worker polls every 30 minutes. Each newsletter has its own list — adding the OpenAI blog to your "AI News" newsletter does not also add it to your "Indie Authors" newsletter.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><strong>Type</strong> — pick <code>rss</code> for most feeds, <code>reddit</code> for r/* JSON feeds, <code>source</code> for plain HTML pages, <code>firecrawl_scrape</code> for sites that need full-page scraping.</li>
          <li><strong>Interval</strong> — minutes between polls. Defaults to 240 (4h). Don't go below 60 unless you really need to.</li>
          <li><strong>Pause/Resume</strong> doesn't lose history. <strong>Delete</strong> removes the feed and its run history.</li>
        </ul>
      </>
    ),
  },
  templates: {
    title: 'Templates',
    body: (
      <>
        <p>Templates are Handlebars HTML used to render the email at send time. Exactly one is the <em>default</em> per edition.</p>
        <p className="mt-2"><strong>Import HTML</strong> accepts pasted HTML from claude.ai/design or any external designer. We strip <code>&lt;script&gt;</code>, <code>on*</code> handlers, and <code>javascript:</code> URLs before saving.</p>
        <p className="mt-2">The <strong>Placeholders</strong> panel lints your HTML against the canonical schema (everything the AI pipeline sends). Tokens marked <em>unknown</em> won't render at send time.</p>
      </>
    ),
  },
  generate: {
    title: 'Generate a newsletter',
    body: (
      <>
        <p>Pick the edition and a send date. The AI pipeline:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Reads ingested articles for that date from <em>your</em> content pool.</li>
          <li>Drafts a story list and pauses for approval.</li>
          <li>After you approve, drafts a subject line and pauses again.</li>
          <li>After you approve, renders the email through the edition's default template and saves it to <em>Sends</em>.</li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">"Previous content" is auto-filled from your last send so the model can avoid duplicate coverage.</p>
      </>
    ),
  },
  approvals: {
    title: 'Approvals',
    body: (
      <>
        <p>Two checkpoints per generation: stories list, then subject line. Click a row to see the draft, the source URL chips, and a free-form feedback box.</p>
        <p className="mt-2">Choose <strong>Approve</strong> to advance the workflow or <strong>Revise</strong> to send your feedback back into the AI loop. Approvals expire after 48 hours by default.</p>
      </>
    ),
  },
  sends: {
    title: 'Sends history',
    body: (
      <>
        <p>Every newsletter run lands here once it's persisted. Click a row for the rendered HTML, the markdown source, edition + execution lineage, and recipient/provider info.</p>
        <p className="mt-2">Filters: status (draft/scheduled/sent/failed) and edition.</p>
      </>
    ),
  },
  ingestion: {
    title: 'Ingestion browser',
    body: (
      <>
        <p>Inspect the raw articles the cron worker has scraped into <code>content_ingestion_v2</code>. Use the date picker to scan a specific day; click any row to see the markdown + HTML the AI pipeline will read at generation time.</p>
        <p className="mt-2">Empty days mean either no feeds were active, every feed errored, or the cron hasn't fired yet for that day. Check <em>Feeds</em> for last-fetch + last-error.</p>
      </>
    ),
  },
};

interface HelpButtonProps {
  section: HelpSection;
}

export default function HelpButton({ section }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const doc = NEWSLETTER_HELP[section];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Help: ${doc.title}`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        ?
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close help"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <div className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{doc.title}</h2>
              <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400">Close</button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 text-sm leading-relaxed text-gray-700 dark:text-gray-200">
              {doc.body}
            </div>
            <footer className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              Full guide:{' '}
              <a href="/docs/newsletter-user-guide.html" target="_blank" rel="noreferrer" className="underline">
                writers-workbench/docs/newsletter-user-guide.md
              </a>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
