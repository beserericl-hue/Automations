/**
 * The words of a chapter or quote, without markup — the client twin of the server's `plainText` in
 * routes/content-actions.ts. A chapter is plain text until the editor saves it and HTML after, so a
 * review quote is matched on its words, not its bytes.
 */
export function plainText(s: string): string {
  return s
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|blockquote|br|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
