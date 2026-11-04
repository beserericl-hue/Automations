/**
 * Where in the chapter a drift finding points.
 *
 * A drift finding is a sentence of prose from the engine, not a located span: "the chapter also
 * introduces 'Taka-Maka' in the opening sentence ('Taka-Maka was still the one people came to')".
 * The passages it quotes are the only anchors it carries, so they are what the chapter is searched
 * for — longest first, because a long quote is a sentence and a short one is a name that may occur
 * forty times. The leading "Name:" label is a candidate too, last, for findings that quote nothing.
 */

// An opening quote mark follows a space or a bracket, never a letter: the apostrophe in
// "character's name" is not one.
const QUOTED = /(?<![\w'’])['‘"“]([^'’"”]{3,}?)['’"”](?![\w])/g;

export function driftQuotes(finding: string): string[] {
  const out: string[] = [];
  for (const m of finding.matchAll(QUOTED)) {
    const q = m[1].trim();
    if (!out.includes(q)) out.push(q);
  }
  const label = finding.match(/^([A-Z][\w'’-]*(?: [A-Z][\w'’-]*)*):\s/);
  if (label && !out.includes(label[1])) out.push(label[1]);
  return out.sort((a, b) => b.length - a.length);
}
