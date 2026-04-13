import { describe, it, expect } from 'vitest';
import express from 'express';
import { brainstormRouter } from '../routes/brainstorm.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/brainstorm', brainstormRouter);
  return app;
}

describe('Brainstorm endpoints', () => {
  it('POST /api/brainstorm/parse returns 401 without auth', async () => {
    const app = createApp();
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/api/brainstorm/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_text: 'test book concept' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('POST /api/brainstorm/submit returns 401 without auth', async () => {
    const app = createApp();
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/api/brainstorm/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content_text: 'test concept',
          title: 'Test Book',
          genre_slug: 'political-scifi',
          story_arc: 'Fichtean Curve',
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
