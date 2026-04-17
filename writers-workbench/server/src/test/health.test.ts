import { describe, it, expect } from 'vitest';
import express from 'express';
import { healthRouter } from '../routes/health.js';

function createApp() {
  const app = express();
  app.use('/api/health', healthRouter);
  return app;
}

describe('Health endpoint', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();

    // Use node's built-in test server
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; service: string; timestamp: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('writers-workbench');
      expect(body.timestamp).toBeDefined();
    } finally {
      server.close();
    }
  });
});
