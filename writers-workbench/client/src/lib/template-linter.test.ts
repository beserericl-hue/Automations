import { describe, it, expect } from 'vitest';
import { lintTemplate, sanitizeImportedHtml, extractTokens } from './template-linter';

describe('template-linter', () => {
  it('extracts simple tokens', () => {
    const tokens = extractTokens('<p>{{title}}</p><p>{{{lead.body_html}}}</p>');
    expect(tokens.map(t => t.identifier).sort()).toEqual(['lead.body_html', 'title']);
    expect(tokens.find(t => t.identifier === 'lead.body_html')!.triple).toBe(true);
  });
  it('handles helpers and blocks', () => {
    const tokens = extractTokens('{{#if lead}}{{lead.headline}}{{/if}} {{{markdown_to_html body_md}}}');
    const ids = tokens.map(t => t.identifier);
    expect(ids).toContain('lead');
    expect(ids).toContain('lead.headline');
    expect(ids).toContain('body_md');
  });
  it('lintTemplate flags missing required + unknown', () => {
    const r = lintTemplate('<p>{{title}} {{my_unknown_token}}</p>');
    expect(r.unknown.map(t => t.identifier)).toContain('my_unknown_token');
    expect(r.missing).toContain('issue.number'); // not in template
  });
  it('sanitizeImportedHtml strips script + on* + javascript:', () => {
    const r = sanitizeImportedHtml('<p onclick="alert(1)">x</p><script>danger()</script><a href="javascript:alert(2)">x</a>');
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/onclick/i);
    expect(r.html).not.toMatch(/javascript:/i);
    expect(r.removed.length).toBeGreaterThan(0);
  });
});
