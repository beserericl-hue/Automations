import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getSessionStore } from '../lib/session-store.js';
import { publishSseEvent, subscribeSseEvents } from '../lib/sse-pubsub.js';

const router = Router();

/**
 * Public helper for internal code paths (BullMQ queue-event listeners
 * in particular) that need to push an event onto the user's SSE stream.
 *
 * Under Redis: the event is PUBLISHed to `sse:{userId}` and fans out to
 * every instance that currently has an SSE subscriber for this user.
 * Without Redis: the event is delivered via the in-process EventEmitter.
 * Either way callers do not have to know which backend is in use.
 */
export async function pushSseEvent(
  userId: string,
  event: Record<string, unknown>,
): Promise<number> {
  try {
    return await publishSseEvent(userId, event);
  } catch (err) {
    logger.error({ err, userId }, 'pushSseEvent: publish failed');
    return 0;
  }
}

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
router.post('/register', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    await getSessionStore().register(userId);
    logger.info({ userId }, 'Web session registered');
    res.json({ success: true, channel: 'web' });
  } catch (err) {
    logger.error({ err, userId }, 'session register: store failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to register session' } });
  }
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
router.delete('/unregister', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    await getSessionStore().unregister(userId);
    logger.info({ userId }, 'Web session unregistered');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, userId }, 'session unregister: store failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to unregister session' } });
  }
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
router.get('/active', async (req: Request, res: Response) => {
  const userId = req.query.user_id as string;
  if (!userId) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'user_id query parameter required' } });
    return;
  }
  try {
    const active = await getSessionStore().isActive(userId);
    res.json({ active, channel: active ? 'web' : null });
  } catch (err) {
    logger.error({ err, userId }, 'session active: store failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to check session' } });
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
router.post('/content-ready', async (req: Request, res: Response) => {
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

  const delivered = await pushSseEvent(user_id, event);
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

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  // Subscribe this connection to the user's pub/sub channel. Events
  // published elsewhere (same instance or another one via Redis) are
  // forwarded to this response stream.
  const unsubscribe = await subscribeSseEvents(userId, (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.error({ err, userId }, 'sse write failed');
    }
  });

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    void unsubscribe();
    logger.info({ userId }, 'SSE client disconnected');
  });
});

export { router as sessionRouter };
