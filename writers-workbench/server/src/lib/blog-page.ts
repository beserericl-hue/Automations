/**
 * A blog post as a public web page: /blog/<slug>.
 *
 * Server-rendered, no login and no script, like the book pages. The post is Markdown a model wrote,
 * so it is treated as untrusted on the way out: raw HTML in it is escaped rather than passed
 * through, and a link is kept only when it goes to http, https or mailto. A post that carried a
 * `<script>` or a `javascript:` link would otherwise run on the Workbench's own domain.
 */

import { Marked, type Tokens } from 'marked';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_LINK = /^(https?:|mailto:)/i;

const marked = new Marked({
  gfm: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return esc(token.text);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      if (!SAFE_LINK.test(token.href.trim())) return text;
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      return `<a href="${esc(token.href)}"${title} rel="noopener nofollow">${text}</a>`;
    },
    image(token: Tokens.Image) {
      if (!/^https:/i.test(token.href.trim())) return esc(token.text);
      return `<img src="${esc(token.href)}" alt="${esc(token.text)}" loading="lazy">`;
    },
  },
});

/** The post body as safe HTML. A leading "# <title>" is dropped: the page prints the title itself. */
export function postBodyHtml(markdown: string, title: string): string {
  let md = markdown.replace(/\r\n/g, '\n').trim();
  const first = /^#\s+(.+)\n/.exec(md);
  if (first && first[1].trim().replace(/[*_]/g, '').toLowerCase() === title.trim().toLowerCase()) {
    md = md.slice(first[0].length).trim();
  }
  return marked.parse(md, { async: false }) as string;
}

export interface PostPage {
  title: string;
  author: string;
  publishedAt: string;
  markdown: string;
  description?: string;
  coverUrl?: string;
  canonicalUrl: string;
  /** The book this post belongs to, when the book has a public page. */
  book?: { title: string; url: string };
}

export function renderPostPage(p: PostPage): string {
  const date = new Date(p.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const description = (p.description ?? '').slice(0, 300);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="canonical" href="${esc(p.canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(p.title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
${p.coverUrl ? `<meta property="og:image" content="${esc(p.coverUrl)}">` : ''}
<style>
  :root { --ink:#2b211b; --muted:#6b5a4c; --rule:#d9cbb6; --bg:#f6f0e6; --accent:#5b3a29; }
  body { margin:0; background:var(--bg); color:var(--ink); font:19px/1.7 Georgia, 'Times New Roman', serif; }
  main { max-width:680px; margin:0 auto; padding:48px 16px 80px; }
  h1 { font-size:2.1em; line-height:1.2; margin:0 0 12px; font-weight:normal; }
  .byline { color:var(--muted); font-size:.85em; margin:0 0 32px; }
  .cover { width:100%; border-radius:4px; margin:0 0 32px; }
  article h2, article h3 { line-height:1.3; margin-top:1.8em; font-weight:normal; }
  article img { max-width:100%; }
  article blockquote { border-left:3px solid var(--rule); margin:1.5em 0; padding:0 0 0 18px; color:var(--muted); }
  a { color:var(--accent); }
  .book { margin-top:56px; padding-top:24px; border-top:1px solid var(--rule); font-size:.9em; color:var(--muted); }
</style>
</head><body><main>
<h1>${esc(p.title)}</h1>
<p class="byline">${p.author ? `By ${esc(p.author)} · ` : ''}${esc(date)}</p>
${p.coverUrl ? `<img class="cover" src="${esc(p.coverUrl)}" alt="">` : ''}
<article>
${postBodyHtml(p.markdown, p.title)}
</article>
${p.book ? `<p class="book">From the author of <a href="${esc(p.book.url)}">${esc(p.book.title)}</a>.</p>` : ''}
</main></body></html>`;
}
