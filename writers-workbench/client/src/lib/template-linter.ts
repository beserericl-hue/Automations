/**
 * Newsletter template linter.
 *
 * Extracts every Handlebars placeholder from a template's HTML and classifies
 * each token against the canonical schema the Compose Newsletter render
 * pipeline supplies (see migration 014's seeded `sample_data` and the
 * server's `lib/newsletter-render.ts`).
 *
 * Tokens are surfaced into three buckets:
 *   - `recognized` — present in the canonical schema; safe to use.
 *   - `unknown`    — not in the schema; will render empty unless the n8n
 *                    workflow happens to send it.
 *   - `missing`    — required by the canonical schema but NOT present in
 *                    the template; safe but the layout omits a field
 *                    every send.
 *
 * The linter is intentionally light: it doesn't parse Handlebars; it just
 * matches `{{ ... }}` / `{{{ ... }}}` and strips helpers/blocks. A token
 * inside a `{{#if x}}` becomes `x`. A `{{{markdown_to_html body_md}}}`
 * becomes `body_md`.
 */

// Canonical placeholders. Mirrors migration 014's seeded sample_data + the
// `body_md` zone from migration 015. "required" = the runtime data shape
// always sends this; "optional" = only sent when populated.
export const REQUIRED_TOKENS = [
  'title',
  'preheader',
  'issue.number',
  'issue.date',
  'issue.view_url',
  'stamp_url',
  'footer.reason',
  'footer.preferences_url',
  'footer.unsubscribe_url',
  'footer.address',
  'signoff.signature_name',
  'signoff.role',
] as const;

export const OPTIONAL_TOKENS = [
  // Bare paragraph-html intro
  'intro_html',
  // Lead story
  'lead', 'lead.eyebrow', 'lead.headline', 'lead.body_html', 'lead.read_more_url', 'lead.read_more_label',
  // Sponsor
  'sponsor', 'sponsor.name', 'sponsor.headline', 'sponsor.body_html', 'sponsor.cta_url', 'sponsor.cta_label',
  // Pull quote
  'pull_quote', 'pull_quote.quote', 'pull_quote.attribution',
  // Trending list
  'trending', 'trending.eyebrow', 'trending.headline', 'trending.items',
  // The fields used inside #each trending.items
  'title', 'url', 'source', 'read_time',
  // From the Workbench
  'workbench_section', 'workbench_section.eyebrow', 'workbench_section.headline', 'workbench_section.body_html',
  // Markdown-body fallback (migration 015)
  'body_md',
  // Signoff body html
  'signoff.body_html',
] as const;

export type TokenStatus = 'recognized' | 'unknown' | 'missing';

export interface FoundToken {
  raw: string;          // The whole `{{...}}` or `{{{...}}}` match
  identifier: string;   // The cleaned identifier path, e.g. `lead.headline`
  triple: boolean;      // True if `{{{...}}}` (raw HTML)
  helper?: string;      // Helper name if the form was `{{helper x}}`
  block?: 'if' | 'unless' | 'each' | 'else' | 'comment' | 'partial';
}

export interface LintResult {
  recognized: FoundToken[];
  unknown: FoundToken[];
  missing: string[];
  totalTokens: number;
  hasBodyMdFallback: boolean;
}

const HANDLEBARS_RE = /\{\{(?<triple>\{)?\s*(?<inner>[^{}]+?)\s*\}?\}\}/g;

/**
 * Extract every Handlebars token from `html`. Tokens that are pure
 * comments (`{{!-- ... --}}`) or block-closing (`{{/if}}`) are ignored.
 */
export function extractTokens(html: string): FoundToken[] {
  const tokens: FoundToken[] = [];
  for (const m of html.matchAll(HANDLEBARS_RE)) {
    const inner = (m.groups?.inner ?? '').trim();
    if (!inner) continue;
    if (inner.startsWith('!')) continue;          // {{!-- comment --}}
    if (inner.startsWith('/')) continue;          // {{/if}} {{/each}}
    if (inner.startsWith('@')) continue;          // built-in: @index, @last
    if (inner === 'else') continue;               // {{else}}
    const triple = !!m.groups?.triple;

    let body = inner;
    let block: FoundToken['block'] | undefined;
    if (body.startsWith('#')) {
      const space = body.indexOf(' ');
      const head = body.slice(1, space === -1 ? undefined : space);
      block = head as FoundToken['block'];
      body = space === -1 ? '' : body.slice(space + 1).trim();
    }
    if (body.startsWith('>')) { block = 'partial'; body = body.slice(1).trim(); }

    if (!body) continue;

    // If body has multiple parts, treat first as helper, last as identifier.
    // E.g. `markdown_to_html body_md` -> helper=markdown_to_html, identifier=body_md
    //      `lead.headline`            -> helper=undefined,        identifier=lead.headline
    //      `eq foo "bar"`            -> helper=eq,                identifier=foo
    const parts = body.split(/\s+/).filter(Boolean);
    let helper: string | undefined;
    let identifier: string;
    if (parts.length > 1) {
      helper = parts[0];
      identifier = parts[1];
      // Strip surrounding quotes if literal
      if (/^['"].*['"]$/.test(identifier)) continue;
    } else {
      identifier = parts[0];
    }
    if (!identifier) continue;
    // Drop literal numbers / strings
    if (/^['"].*['"]$/.test(identifier)) continue;
    if (/^\d+(\.\d+)?$/.test(identifier)) continue;

    tokens.push({
      raw: m[0],
      identifier,
      triple,
      helper,
      block,
    });
  }
  return tokens;
}

/**
 * Run the linter against an HTML template. The result is purely advisory —
 * the editor surfaces it as a panel; nothing blocks save.
 */
export function lintTemplate(html: string): LintResult {
  const tokens = extractTokens(html);
  const recognizedSet = new Set<string>([...REQUIRED_TOKENS, ...OPTIONAL_TOKENS]);

  const recognized: FoundToken[] = [];
  const unknown: FoundToken[] = [];
  const seenIds = new Set<string>();

  for (const t of tokens) {
    const id = t.identifier;
    seenIds.add(id);
    // Permit any path whose head is in the recognized set or whose full
    // path is recognized. e.g. `trending.items.0.title` -> head trending.
    const head = id.split('.')[0];
    if (recognizedSet.has(id) || recognizedSet.has(head)) {
      recognized.push(t);
    } else {
      unknown.push(t);
    }
  }

  const missing: string[] = [];
  for (const req of REQUIRED_TOKENS) {
    const head = req.split('.')[0];
    const matched = Array.from(seenIds).some((id) => id === req || id.split('.')[0] === head);
    if (!matched) missing.push(req);
  }

  const hasBodyMdFallback = tokens.some((t) => t.identifier === 'body_md');

  return {
    recognized,
    unknown,
    missing,
    totalTokens: tokens.length,
    hasBodyMdFallback,
  };
}

/**
 * Strip dangerous things from imported HTML before letting the user save it.
 * Removes:
 *   - <script>...</script>
 *   - on* event-handler attributes
 *   - href / src starting with javascript: (case-insensitive, ignoring whitespace)
 *
 * Returns the sanitized html and a list of human-readable removals so the
 * UI can show "we removed these for safety."
 */
export interface SanitizeResult { html: string; removed: string[] }

export function sanitizeImportedHtml(input: string): SanitizeResult {
  const removed: string[] = [];
  let html = input;

  // Remove <script>...</script> blocks (with or without attrs).
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => {
    removed.push('<script> block');
    return '';
  });
  // Remove standalone <script ... /> self-closing too.
  html = html.replace(/<script\b[^>]*\/>/gi, () => {
    removed.push('<script /> tag');
    return '';
  });
  // Remove on* event handlers — onclick="..." onload="..." etc.
  html = html.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, () => {
    removed.push('on* handler');
    return '';
  });
  html = html.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, () => {
    removed.push('on* handler');
    return '';
  });
  // Remove javascript: URLs in href / src.
  html = html.replace(/(\bhref\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, (_m, p1, p2) => {
    removed.push('javascript: href');
    return `${p1}#${p2}`;
  });
  html = html.replace(/(\bsrc\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, (_m, p1, p2) => {
    removed.push('javascript: src');
    return `${p1}${p2}`;
  });

  return { html, removed };
}
