/**
 * The two public RSS feeds of a Content Studio edition (Substack sync), rebuilt from the n8n webhooks
 * `uSFq6y6YombFzzfT` (per item, `/webhook/ai-dev-roundup.xml`) and `K6peMqAydbdr7Ldt` (weekly digest,
 * `/webhook/ai-dev-roundup-digest.xml`). Pure builders: the route reads the rows and calls these.
 *
 * Content rules kept from n8n:
 *   - per-item feed: one item per post that has gone out; the "comment 'newsletter'" subscribe CTA
 *     lines and the hashtag lines are removed (the n8n `stripCTA`), links are made clickable;
 *   - digest feed: ONE item per week holding the whole slate — articles, then videos with their
 *     YouTube thumbnail.
 * Fixed on the way: every item links to its own post (n8n's rows had no url column, so every link was
 * the site root), the digest's pubDate is the week's (n8n used "now", so every poll looked new), and
 * future / unposted posts are not published early (n8n listed pending rows too).
 */
import { marked } from 'marked';

export interface FeedPost {
  external_id: string;
  title: string;
  body_md: string | null;
  linkedin_content: string | null;
  category: string | null;
  scheduled_at: string | null;
  posted_at: string | null;
  source_url: string | null;
  website_url?: string | null;
}

export interface DigestTopic {
  rank: number;
  title: string;
  url: string;
  source: string | null;
  item_type: string | null;
  angle: string | null;
}

export interface DigestWeek {
  week_of: string;
  published_at: string | null;
  topics: DigestTopic[];
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA cannot contain "]]>"; split it across two sections. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function rfc822(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

/** n8n's stripCTA, verbatim in effect: drop the subscribe-CTA lines and any line that starts with a hashtag. */
export function stripCta(text: string): string {
  return String(text || '')
    .split('\n')
    .filter((l) => {
      const s = l.trim();
      if (/want these every week/i.test(s)) return false;
      if (/comment ['‘’"]?newsletter/i.test(s)) return false;
      if (/^#[A-Za-z0-9]/.test(s)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function linkify(s: string): string {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

/** A LinkedIn post as paragraphs; a blog post as rendered markdown. Both CTA-stripped. */
export function postHtml(p: FeedPost): string {
  const body = (p.body_md ?? '').trim();
  if (body) {
    // Markdown headings start with "#" too: strip hashtag lines only (a "#" followed by a letter/digit, no space).
    return marked.parse(stripCta(body), { async: false }) as string;
  }
  return stripCta(p.linkedin_content ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${linkify(esc(l))}</p>`)
    .join('');
}

function channel(args: { title: string; link: string; self: string; description: string; items: string[] }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">' +
    '<channel>' +
    `<title>${esc(args.title)}</title>` +
    `<link>${esc(args.link)}</link>` +
    `<atom:link href="${esc(args.self)}" rel="self" type="application/rss+xml"/>` +
    `<description>${esc(args.description)}</description>` +
    '<language>en-us</language>' +
    `<lastBuildDate>${rfc822(null)}</lastBuildDate>` +
    args.items.join('') +
    '</channel></rss>\n'
  );
}

export function itemsFeed(args: { name: string; siteUrl: string; selfUrl: string; posts: FeedPost[] }): string {
  const items = args.posts.map((p) => {
    const html = postHtml(p);
    const link = p.website_url || p.source_url || args.siteUrl;
    return (
      '<item>' +
      `<title>${esc(p.title)}</title>` +
      `<link>${esc(link)}</link>` +
      `<guid isPermaLink="false">${esc(p.external_id)}</guid>` +
      `<pubDate>${rfc822(p.posted_at || p.scheduled_at)}</pubDate>` +
      `<category>${esc((p.category || 'roundup').toLowerCase())}</category>` +
      `<description>${cdata(html)}</description>` +
      `<content:encoded>${cdata(html)}</content:encoded>` +
      '</item>'
    );
  });
  return channel({
    title: args.name,
    link: args.siteUrl,
    self: args.selfUrl,
    description: `${args.name} — curated summaries with links to the original sources.`,
    items,
  });
}

function youtubeId(url: string): string | null {
  const m = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&/]+)/);
  return m ? m[1] : null;
}

export function digestHtml(topics: DigestTopic[]): string {
  const arts = topics.filter((t) => t.item_type !== 'video' && t.url).sort((a, b) => a.rank - b.rank);
  const vids = topics.filter((t) => t.item_type === 'video' && t.url).sort((a, b) => a.rank - b.rank);
  let html = "<p>This week's best reads and videos, curated for you.</p>";
  if (arts.length) {
    html += '<h2>📰 Articles</h2>';
    for (const t of arts) {
      html += `<h3><a href="${esc(t.url)}">${esc(t.title)}</a></h3>`;
      if (t.angle) html += `<p>${esc(t.angle)}</p>`;
      html += `<p><a href="${esc(t.url)}">Read more →</a>${t.source ? ` — <em>${esc(t.source)}</em>` : ''}</p>`;
    }
  }
  if (vids.length) {
    html += '<h2>🎥 Videos</h2>';
    for (const t of vids) {
      const id = youtubeId(t.url);
      html += `<h3>${esc(t.title)}</h3>`;
      if (id) {
        html += `<p><a href="${esc(t.url)}"><img src="https://img.youtube.com/vi/${esc(id)}/hqdefault.jpg" alt="${esc(t.title)}" width="480" style="max-width:100%;border-radius:8px"/></a></p>`;
      }
      if (t.angle) html += `<p>${esc(t.angle)}</p>`;
      html += `<p><a href="${esc(t.url)}">▶ Watch →</a></p>`;
    }
  }
  return html;
}

function longDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function digestFeed(args: {
  editionId: string;
  name: string;
  siteUrl: string;
  selfUrl: string;
  weeks: DigestWeek[];
}): string {
  const items = args.weeks
    .filter((w) => w.topics.length)
    .map((w) => {
      const html = digestHtml(w.topics);
      return (
        '<item>' +
        `<title>${esc(`${args.name} — ${longDate(w.week_of)}`)}</title>` +
        `<link>${esc(args.siteUrl)}</link>` +
        `<guid isPermaLink="false">${esc(`${args.editionId}-${w.week_of}`)}</guid>` +
        `<pubDate>${rfc822(w.published_at || `${w.week_of}T11:00:00Z`)}</pubDate>` +
        `<description>${cdata(html)}</description>` +
        `<content:encoded>${cdata(html)}</content:encoded>` +
        '</item>'
      );
    });
  return channel({
    title: `${args.name} (Digest)`,
    link: args.siteUrl,
    self: args.selfUrl,
    description: `${args.name} — one complete issue per week.`,
    items,
  });
}
