import { describe, it, expect } from 'vitest';
import express from 'express';
import { chatRouter } from '../routes/chat.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  return app;
}

describe('Chat proxy endpoint', () => {
  it('returns 401 when no auth token is provided', async () => {
    const app = createApp();
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_message_request: 'test', user_id: '+1234' }),
      });
      expect(res.status).toBe(401);

      const body = (await res.json()) as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    } finally {
      server.close();
    }
  });
});
