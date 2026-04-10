import { marked } from 'marked';

/**
 * Detect if content is markdown vs. HTML vs. plain text, and convert to HTML for TipTap.
 *
 * Content in the database can be:
 * 1. Markdown (from Claude LLM output) — has # headers, **bold**, \n\n paragraphs
 * 2. HTML (from previous editor saves) — has <h1>, <p> tags
 * 3. Plain text (rare) — no formatting at all
 */
export function contentToHtml(text: string | null): string {
  if (!text) return '';

  // Already HTML — has block-level tags
  if (/<(h[1-6]|p|div|ul|ol|blockquote|table)\b/i.test(text)) {
    return text;
  }

  // Markdown detection: has headers, bold, lists, or double newlines
  const hasMarkdown =
    /^#{1,6}\s/m.test(text) ||      // # headers
    /\*\*.+\*\*/m.test(text) ||     // **bold**
    /^\s*[-*+]\s/m.test(text) ||    // - list items
    /^\s*\d+\.\s/m.test(text) ||    // 1. numbered lists
    text.includes('\n\n');           // paragraph breaks

  if (hasMarkdown) {
    // Configure marked for clean output
    marked.setOptions({
      breaks: false,     // don't convert single \n to <br>
      gfm: true,         // GitHub Flavored Markdown
    });
    return marked.parse(text) as string;
  }

  // Plain text — wrap in paragraphs by splitting on newlines
  return text
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Convert HTML back to markdown for storage.
 * For now, we store as HTML since TipTap works natively with HTML.
 * The content will be HTML after first editor save.
 */
export function htmlToStorageFormat(html: string): string {
  return html;
}
