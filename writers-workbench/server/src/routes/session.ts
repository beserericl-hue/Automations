import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const router = Router();

// In-memory session store (keyed by user_id)
// In production, use Redis or database — fine for single-instance Railway deploy
interface WebSession {
  userId: string;
  channel: 'web';
  registeredAt: number;
  lastActivity: number;
}

const activeSessions = new Map<string, WebSession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// SSE clients (keyed by user_id, multiple clients per user possible)
interface SSEClient {
  res: Response;
  userId: string;
  connectedAt: number;
}

const sseClients: SSEClient[] = [];

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of activeSessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      activeSessions.delete(userId);
      logger.info({ userId }, 'Session expired due to inactivity');
    }
  }
}, 5 * 60 * 1000);

/**
 * @openapi
 * /session/register:
 *   post:
 *     tags: [Session]
 *     summary: Register active web session
 *     description: Called when the Eve widget opens. Tells n8n to use web callback instead of phone.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Session registered
 *       401:
 *         description: Missing or invalid auth token
 */
router.post('/register', requireAuth, (req: Request, res: Response) => {
  const userId = req.userId!;
  const now = Date.now();

  activeSessions.set(userId, {
    userId,
    channel: 'web',
    registeredAt: now,
    lastActivity: now,
  });

  logger.info({ userId }, 'Web session registered');
  res.json({ success: true, channel: 'web' });
});

/**
 * @openapi
 * /session/unregister:
 *   delete:
 *     tags: [Session]
 *     summary: Unregister web session
 *     description: Called when the Eve widget closes.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Session removed
 *       401:
 *         description: Missing or invalid auth token
 */
router.delete('/unregister', requireAuth, (req: Request, res: Response) => {
  const userId = req.userId!;
  activeSessions.delete(userId);
  logger.info({ userId }, 'Web session unregistered');
  res.json({ success: true });
});

/**
 * @openapi
 * /session/active:
 *   get:
 *     tags: [Session]
 *     summary: Check if user has active web session
 *     description: Called by n8n eve_knowledge_callback to decide phone vs web callback. No auth required (server-to-server).
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Phone number (E.164)
 *     responses:
 *       200:
 *         description: Session status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SessionActiveResponse'
 *       400:
 *         description: Missing user_id parameter
 */
router.get('/active', (req: Request, res: Response) => {
  const userId = req.query.user_id as string;
  if (!userId) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'user_id query parameter required' } });
    return;
  }

  const session = activeSessions.get(userId);
  const now = Date.now();

  if (session && now - session.lastActivity <= SESSION_TIMEOUT_MS) {
    // Refresh activity timestamp
    session.lastActivity = now;
    res.json({ active: true, channel: session.channel });
  } else {
    // Clean up expired session if present
    if (session) activeSessions.delete(userId);
    res.json({ active: false, channel: null });
  }
});

/**
 * @openapi
 * /callback/content-ready:
 *   post:
 *     tags: [Callback]
 *     summary: Push content-ready notification from n8n
 *     description: Called by n8n when Eve has loaded content for a web user. Pushes to SSE stream. No auth (server-to-server).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContentReadyRequest'
 *     responses:
 *       200:
 *         description: Event pushed to SSE clients
 *       400:
 *         description: Missing user_id
 */
router.post('/content-ready', (req: Request, res: Response) => {
  const { user_id, content_title, content_type, content_id } = req.body;

  if (!user_id) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'user_id is required' } });
    return;
  }

  const event = {
    type: 'content-ready',
    content_title: content_title || 'New content',
    content_type: content_type || 'unknown',
    content_id: content_id || null,
    timestamp: new Date().toISOString(),
  };

  // Push to all SSE clients for this user
  let delivered = 0;
  for (const client of sseClients) {
    if (client.userId === user_id) {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      delivered++;
    }
  }

  logger.info({ user_id, content_title, delivered }, 'Content-ready callback received');
  res.json({ success: true, delivered });
});

/**
 * @openapi
 * /callback/events:
 *   get:
 *     tags: [Callback]
 *     summary: SSE stream for real-time push notifications
 *     description: EventSource endpoint. Uses token query param for auth (EventSource cannot send headers).
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Supabase Auth access token
 *     responses:
 *       200:
 *         description: SSE event stream (text/event-stream)
 *       401:
 *         description: Invalid or missing token
 */
router.get('/events', async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Token required' } });
    return;
  }

  // Verify token manually since EventSource can't send Authorization header
  try {
    const { getSupabaseAdmin } = await import('../services/supabase-admin.js');
    const supabase = getSupabaseAdmin();
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
      return;
    }
    const { data: userRecord } = await supabase
      .from('users_v2')
      .select('user_id')
      .eq('supabase_auth_uid', authUser.id)
      .single();
    if (!userRecord) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }
    req.userId = userRecord.user_id;
  } catch {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Auth failed' } });
    return;
  }

  const userId = req.userId!;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  const client: SSEClient = {
    res,
    userId,
    connectedAt: Date.now(),
  };
  sseClients.push(client);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30_000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
    logger.info({ userId }, 'SSE client disconnected');
  });
});

export { router as sessionRouter };
