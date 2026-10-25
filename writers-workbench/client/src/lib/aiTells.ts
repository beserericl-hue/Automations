/**
 * Marks of machine-written prose, counted rather than guessed.
 *
 * Every suggested replacement in the review rail is written by a model, and some read like it: the
 * em dash is the commonest tell, and the book's own writing rules ban it. This does not decide
 * whether a passage is "AI" — it lists what a reader would notice, so the author can see why a
 * suggestion feels off and choose to rewrite it or run it through the humanizer.
 */

export interface Tell {
  kind: string;
  count: number;
  examples: string[];
}

const PHRASES = [
  'a testament to', 'tapestry', 'palpable', 'delve', 'in the quiet of', 'a sense of', 'couldn\'t help but',
  'it was as if', 'the weight of', 'something shifted', 'a reminder that', 'echoed through', 'hung in the air',
  'and yet', 'not just', 'in that moment', 'the silence stretched',
];

function excerpt(text: string, index: number, len: number): string {
  const a = Math.max(0, index - 30);
  const b = Math.min(text.length, index + len + 30);
  return `${a > 0 ? '…' : ''}${text.slice(a, b).replace(/\s+/g, ' ').trim()}${b < text.length ? '…' : ''}`;
}

export function aiTells(text: string): Tell[] {
  const tells: Tell[] = [];
  const dash = [...text.matchAll(/—|–(?=\s)|\s--\s/g)];
  if (dash.length) {
    tells.push({ kind: 'em dash', count: dash.length, examples: dash.slice(0, 2).map((m) => excerpt(text, m.index ?? 0, m[0].length)) });
  }
  for (const p of PHRASES) {
    const hits = [...text.toLowerCase().matchAll(new RegExp(`\\b${p.replace(/'/g, "['’]")}\\b`, 'g'))];
    if (hits.length) tells.push({ kind: `“${p}”`, count: hits.length, examples: hits.slice(0, 1).map((m) => excerpt(text, m.index ?? 0, p.length)) });
  }
  return tells;
}

/** "2 em dashes, “and yet”" — or '' when there is nothing to report. */
export function summarizeTells(tells: Tell[]): string {
  return tells
    .map((t) => (t.kind === 'em dash' ? `${t.count} em dash${t.count === 1 ? '' : 'es'}` : t.count > 1 ? `${t.kind} ×${t.count}` : t.kind))
    .join(', ');
}
