import { marked } from 'marked';

// Configure marked once — synchronous, no breaks on single newlines
marked.setOptions({
  async: false,
  breaks: false,
  gfm: true,
});

/**
 * Detect if content is markdown vs. HTML vs. plain text, and convert to HTML for TipTap.
 */
export function contentToHtml(text: string | null): string {
  if (!text) return '';

  // Already HTML — has block-level tags
  if (/<(h[1-6]|p|div|ul|ol|blockquote|table)\b/i.test(text)) {
    return text;
  }

  // Markdown detection: has headers, bold, lists, or double newlines
  const hasMarkdown =
    /^#{1,6}\s/m.test(text) ||
    /\*\*.+\*\*/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    text.includes('\n\n');

  if (hasMarkdown) {
    return marked.parse(text) as string;
  }

  // Plain text — wrap in paragraphs by splitting on double newlines
  return text
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
