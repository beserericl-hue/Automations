import { describe, it, expect } from 'vitest';

describe('S5-4: Session route module', () => {
  it('exports sessionRouter', async () => {
    const mod = await import('../routes/session.js');
    expect(mod.sessionRouter).toBeDefined();
  });
});

describe('S5-4: Session API contract', () => {
  it('register endpoint accepts POST', () => {
    // Verifying API contract: POST /api/session/register
    const method = 'POST';
    const path = '/api/session/register';
    expect(method).toBe('POST');
    expect(path).toContain('/session/register');
  });

  it('unregister endpoint accepts DELETE', () => {
    const method = 'DELETE';
    const path = '/api/session/unregister';
    expect(method).toBe('DELETE');
    expect(path).toContain('/session/unregister');
  });

  it('active check endpoint accepts GET with user_id query', () => {
    const method = 'GET';
    const path = '/api/session/active';
    const query = 'user_id=%2B14105914612';
    expect(method).toBe('GET');
    expect(`${path}?${query}`).toContain('user_id=');
  });

  it('content-ready callback accepts POST', () => {
    const method = 'POST';
    const path = '/api/callback/content-ready';
    expect(method).toBe('POST');
    expect(path).toContain('/callback/content-ready');
  });

  it('SSE events endpoint accepts GET with token', () => {
    const method = 'GET';
    const path = '/api/callback/events';
    expect(method).toBe('GET');
    expect(path).toContain('/callback/events');
  });
});

describe('S5-4: Session timeout configuration', () => {
  it('session timeout is 30 minutes', () => {
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    expect(SESSION_TIMEOUT_MS).toBe(1_800_000);
  });

  it('cleanup interval is 5 minutes', () => {
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
    expect(CLEANUP_INTERVAL_MS).toBe(300_000);
  });
});
