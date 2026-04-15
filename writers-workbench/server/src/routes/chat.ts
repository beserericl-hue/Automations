import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { ChatProxySchema } from '../schemas.js';
import { logger } from '../lib/logger.js';

export const chatRouter = Router();

/**
 * @openapi
 * /chat/proxy:
 *   post:
 *     tags: [Chat]
 *     summary: Proxy chat message to n8n webhook
 *     description: CORS proxy for the n8n author_request_v2 webhook. Forwards the user message and returns the workflow response.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatProxyRequest'
 *     responses:
 *       200:
 *         description: Webhook response (sync or async acknowledgement)
 *       401:
 *         description: Missing or invalid auth token
 *       502:
 *         description: Failed to reach n8n webhook
 */
chatRouter.post('/proxy', requireAuth, validateBody(ChatProxySchema), async (req, res) => {
  const webhookUrl = process.env.N8N_API_URL
    ? `${process.env.N8N_API_URL}/webhook/author_request_v2`
    : '';

  if (!webhookUrl) {
    res.status(500).json({ error: 'N8N_API_URL not configured' });
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, 'Chat proxy error');
    res.status(502).json({ error: 'Failed to reach n8n webhook' });
  }
});
