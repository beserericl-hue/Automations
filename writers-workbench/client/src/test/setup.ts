import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

// Mock Supabase client — prevents real API calls during tests
// Uses a recursive proxy-based chain builder so any .method().method() chain resolves
vi.mock('../config/supabase', () => {
  const emptyResult = { data: [], error: null, count: 0 };
  const nullResult = { data: null, error: null };

  // Builds a chainable object: any method call returns the same chainable,
  // and .then() resolves to the default result (making it thenable/awaitable)
  const buildChain = (result: unknown = emptyResult): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const handler = (..._args: unknown[]) => buildChain(result);

    // All Supabase query builder methods
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
      'like', 'ilike', 'is', 'in', 'not',
      'or', 'and', 'filter', 'match',
      'order', 'limit', 'range', 'offset',
      'single', 'maybeSingle',
      'insert', 'update', 'upsert', 'delete',
      'contains', 'containedBy', 'overlaps',
      'textSearch',
    ];

    for (const method of methods) {
      chain[method] = handler;
    }

    // single/maybeSingle resolve to {data: null} not {data: []}
    chain.single = (..._args: unknown[]) => buildChain(nullResult);
    chain.maybeSingle = (..._args: unknown[]) => buildChain(nullResult);

    // Make the chain thenable (awaitable)
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);

    return chain;
  };

  return {
    supabase: {
      from: () => buildChain(),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        signInWithOAuth: vi.fn(),
        signOut: vi.fn(),
        resetPasswordForEmail: vi.fn(),
        updateUser: vi.fn(),
      },
    },
  };
});

// Mock import.meta.env
vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');
vi.stubEnv('VITE_N8N_WEBHOOK_URL', 'https://test.n8n.com/webhook/test');
vi.stubEnv('VITE_ELEVENLABS_AGENT_ID', 'test-agent-id');
