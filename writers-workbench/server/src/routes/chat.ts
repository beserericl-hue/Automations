import { Router } from 'express';

export const chatRouter = Router();

// CORS proxy for n8n webhook — used if direct browser calls are blocked
chatRouter.post('/proxy', async (req, res) => {
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
    console.error('[chat proxy] Error:', error);
    res.status(502).json({ error: 'Failed to reach n8n webhook' });
  }
});
