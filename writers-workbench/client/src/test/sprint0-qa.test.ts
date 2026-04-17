/**
 * Sprint 0 QA Tests — Client Side
 * Covers: S0-6 (XSS sanitization), S0-9 (error states)
 */
import { describe, it, expect } from 'vitest';
import { contentToHtml, sanitizeHtml } from '../lib/content-utils';

// =========================================
// S0-6: XSS Sanitization
// =========================================
describe('S0-6: XSS Sanitization', () => {
  it('QA: content with <script>alert("xss")</script> does not execute', () => {
    const input = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const result = contentToHtml(input);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>Hello</p>');
    expect(result).toContain('<p>World</p>');
  });

  it('QA: content with <img onerror="alert(\'xss\')"> does not execute', () => {
    const input = '<p>Test</p><img src="x" onerror="alert(\'xss\')">';
    const result = contentToHtml(input);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });

  it('QA: strips onclick attributes from all elements', () => {
    const input = '<p onclick="stealCookies()">Click me</p>';
    const result = contentToHtml(input);
    expect(result).not.toContain('onclick');
    expect(result).toContain('<p>Click me</p>');
  });

  it('QA: strips javascript: URLs from links', () => {
    const input = '<a href="javascript:alert(1)">Malicious link</a>';
    const result = contentToHtml(input);
    expect(result).not.toContain('javascript:');
  });

  it('QA: allows safe HTML tags through', () => {
    const input = '<h1>Title</h1><p><strong>Bold</strong> and <em>italic</em></p><ul><li>Item</li></ul>';
    const result = contentToHtml(input);
    expect(result).toContain('<h1>');
    expect(result).toContain('<strong>');
    expect(result).toContain('<em>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
  });

  it('QA: sanitizes markdown-converted HTML too', () => {
    const input = '# Title\n\n<script>alert("xss")</script>\n\nSafe paragraph';
    const result = contentToHtml(input);
    expect(result).not.toContain('<script');
    expect(result).toContain('<h1>');
  });

  it('QA: sanitizeHtml removes iframe and object tags', () => {
    const input = '<iframe src="http://evil.com"></iframe><object data="evil.swf"></object><p>Safe</p>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('<object');
    expect(result).toContain('<p>Safe</p>');
  });

  it('QA: handles null/empty input gracefully', () => {
    expect(contentToHtml(null)).toBe('');
    expect(contentToHtml('')).toBe('');
  });
});
