import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked once — synchronous, no breaks on single newlines
marked.setOptions({
  async: false,
  breaks: false,
  gfm: true,
});

/**
 * Sanitize HTML to prevent XSS attacks.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr', 'div', 'span',
      'sub', 'sup',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title', 'class'],
  });
}

/**
 * Detect if content is markdown vs. HTML vs. plain text, and convert to HTML for TipTap.
 * All output is sanitized through DOMPurify.
 */
export function contentToHtml(text: string | null): string {
  if (!text) return '';

  // Already HTML — has block-level tags
  if (/<(h[1-6]|p|div|ul|ol|blockquote|table)\b/i.test(text)) {
    return sanitizeHtml(text);
  }

  // Markdown detection: has headers, bold, lists, or double newlines
  const hasMarkdown =
    /^#{1,6}\s/m.test(text) ||
    /\*\*.+\*\*/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    text.includes('\n\n');

  if (hasMarkdown) {
    return sanitizeHtml(marked.parse(text) as string);
  }

  // Plain text — wrap in paragraphs by splitting on double newlines
  const html = text
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return sanitizeHtml(html);
}
