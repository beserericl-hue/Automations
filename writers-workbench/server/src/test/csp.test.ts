/**
 * The Content-Security-Policy lets the page do what the page does. Each line here is something that
 * silently broke in a browser while every API test stayed green.
 */
import { describe, it, expect } from 'vitest';
import { CSP_DIRECTIVES } from '../lib/csp.js';

describe('CSP directives', () => {
  it('audiobook recordings (signed Supabase Storage URLs) and the voice preview (a data: clip) can be played', () => {
    expect(CSP_DIRECTIVES['media-src']).toContain('https://*.supabase.co');
    expect(CSP_DIRECTIVES['media-src']).toContain('data:');
  });

  it('keeps what the voice widget and sign-in already needed', () => {
    expect(CSP_DIRECTIVES['connect-src']).toEqual(expect.arrayContaining(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'wss://*.elevenlabs.io']));
    expect(CSP_DIRECTIVES['script-src']).toEqual(expect.arrayContaining(['blob:', "'wasm-unsafe-eval'"]));
    expect(CSP_DIRECTIVES['img-src']).toContain('https:');
  });
});
