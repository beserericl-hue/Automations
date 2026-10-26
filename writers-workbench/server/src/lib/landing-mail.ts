/**
 * The email an author sends to the people who reserved a copy on the book's page.
 *
 * Each reader gets their own message, for three reasons: it is addressed to them by name, it carries
 * their own unsubscribe link, and nobody sees anybody else's address. It says why they are getting
 * it (they reserved a copy, at this page), because mail from a stranger that does not say so reads
 * as spam and gets marked as spam.
 *
 * The author writes plain text. Blank lines separate paragraphs; nothing in it is treated as HTML.
 */

import type { BuyLink } from './landing-page.js';

export interface MailingInput {
  title: string;
  author: string;
  subject: string;
  body: string;
  firstName?: string;
  buy?: BuyLink;
  pageUrl: string;
  unsubscribeUrl: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function paragraphsOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function renderMailing(m: MailingInput): { html: string; text: string } {
  const hello = m.firstName?.trim() ? `Hi ${m.firstName.trim()},` : 'Hello,';
  const paras = paragraphsOf(m.body);
  const why = `You are getting this because you reserved a copy of ${m.title} at ${m.pageUrl}.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f0e6">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font:17px/1.6 Georgia,serif;color:#2b211b">
<p>${esc(hello)}</p>
${paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
${m.buy ? `<p style="margin:28px 0"><a href="${esc(m.buy.url)}" style="background:#5b3a29;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">${esc(m.buy.label)}</a></p>` : ''}
<p>${esc(m.author)}</p>
<hr style="border:none;border-top:1px solid #d9cbb6;margin:32px 0 16px">
<p style="font-size:13px;color:#6b5a4c">${esc(why)} <a href="${esc(m.unsubscribeUrl)}" style="color:#6b5a4c">Stop these emails</a>.</p>
</div></body></html>`;
  const text = [
    hello,
    '',
    ...paras.flatMap((p) => [p, '']),
    ...(m.buy ? [`${m.buy.label}: ${m.buy.url}`, ''] : []),
    m.author,
    '',
    '--',
    why,
    `Stop these emails: ${m.unsubscribeUrl}`,
  ].join('\n');
  return { html, text };
}
