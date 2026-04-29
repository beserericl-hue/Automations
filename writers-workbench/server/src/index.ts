import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { exportRouter } from './routes/export.js';
import { adminRouter } from './routes/admin.js';
import { brainstormRouter } from './routes/brainstorm.js';
import { accountRouter } from './routes/account.js';
import { sessionRouter, pushSseEvent } from './routes/session.js';
import { imagesRouter } from './routes/images.js';
import { emailRouter } from './routes/email.js';
import { ingestionRouter } from './routes/ingestion.js';
import { approvalsApiRouter, approvalsPublicRouter } from './routes/approvals.js';
import { newsletterSendsRouter } from './routes/newsletter-sends.js';
import { newsletterRouter, newsletterCallbackRouter } from './routes/newsletter.js';
import { feedsRouter, feedsCronRouter } from './routes/newsletter-feeds.js';
import { editionExtrasRouter } from './routes/newsletter-edition-extras.js';
import { genresRouter, adminGenreUrlsRouter } from './routes/genres.js';
import { jobsRouter } from './routes/jobs.js';
import { contentActionsRouter } from './routes/content-actions.js';
import { creditsRouter } from './routes/credits.js';
import { superuserRouter } from './routes/superuser.js';
import { tiersRouter } from './routes/tiers.js';
import { cronRouter } from './routes/cron.js';
import { impersonateDataRouter } from './routes/impersonate-data.js';
import { impersonateWriteRouter } from './routes/impersonate-write.js';
import type { JobInfrastructure } from './lib/jobs/boot.js';
import { swaggerSpec } from './swagger.js';
import swaggerUi from 'swagger-ui-express';

// Load .env from workspace root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Request logging with request ID
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  autoLogging: {
    ignore: (req) => req.url === '/api/health',
  },
}));

// Expose request ID in response headers
app.use((req, res, next) => {
  const requestId = String(req.id || crypto.randomUUID());
  res.setHeader('X-Request-Id', requestId);
  next();
});

// Security headers
app.use(helmet());

// CORS with origin whitelist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Rate limiters
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests, please try again later' },
});

const exportLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many export requests, please try again later' },
});

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const brainstormLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many brainstorm requests, please try again later' },
});

// Apply rate limits
app.use('/api/chat', chatLimiter);
app.use('/api/export', exportLimiter);
app.use('/api/brainstorm', brainstormLimiter);
app.use('/api/admin', generalLimiter);

// 30 MB: newsletter ingestion uploads can carry markdown up to 10 MB + html up
// to 10 MB (see IngestionUploadSchema) plus metadata, plus any future headroom.
app.use(express.json({ limit: '30mb' }));

// API documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Writers Workbench API',
  customCss: '.swagger-ui .topbar { display: none }',
}));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

// API routes
app.use('/api/health', healthRouter);
app.use('/api/chat', chatRouter);
app.use('/api/export', exportRouter);
app.use('/api/admin', adminRouter);
app.use('/api/brainstorm', brainstormRouter);
app.use('/api/account', generalLimiter);
app.use('/api/account', accountRouter);
app.use('/api/session', generalLimiter);
app.use('/api/session', sessionRouter);
app.use('/api/images', generalLimiter);
app.use('/api/images', imagesRouter);
app.use('/api/email', generalLimiter);
app.use('/api/email', emailRouter);
app.use('/api/ingestion', generalLimiter);
app.use('/api/ingestion', ingestionRouter);
app.use('/api/approvals', generalLimiter);
app.use('/api/approvals', approvalsApiRouter);
// Public-facing approval form (no /api prefix — users click this from an email).
// Mount express.urlencoded() first so POST /approvals/:token/resolve can parse
// the standard HTML form submission.
app.use('/approvals', express.urlencoded({ extended: true }));
app.use('/approvals', generalLimiter);
app.use('/approvals', approvalsPublicRouter);
app.use('/api/newsletter-sends', generalLimiter);
app.use('/api/newsletter-sends', newsletterSendsRouter);
app.use('/api/newsletter', generalLimiter);
app.use('/api/newsletter', newsletterRouter);
// Multi-User Newsletters Sprint — feed sources CRUD (mounted under same
// /api/newsletter prefix; routes start with /editions/:id/feeds and /feeds/:id).
app.use('/api/newsletter', feedsRouter);
// Newsletter Flow Fixes — logo upload + subscribers CRUD (mounted under
// /api/newsletter; routes are /editions/:id/logo, /editions/:id/subscribers,
// /subscribers/:id).
app.use('/api/newsletter', editionExtrasRouter);
// Cron worker callbacks. Distinct prefix because requests are auth'd by
// X-Ingestion-Secret rather than session JWT — keeps the access pattern obvious.
app.use('/api/newsletter/cron', feedsCronRouter);
app.use('/api/callback', generalLimiter);
app.use('/api/callback', sessionRouter);
// Newsletter stage-emit callback (S3) — POST /api/callback/newsletter-stage.
// Auth via X-Callback-Secret header (NEWSLETTER_CALLBACK_SECRET env). The
// router is mounted on the same /api/callback prefix as sessionRouter; no
// path conflicts because session.ts has /content-ready / /eve-knowledge etc.
app.use('/api/callback', newsletterCallbackRouter);
// Migration 013 — per-genre user ingestion URLs. The base /api/genres
// route is user-callable (requireAuth inside); admin-only cross-user view
// nests under /api/admin/genre-urls (requireAuth + requireAdmin inside).
app.use('/api/genres', generalLimiter);
app.use('/api/genres', genresRouter);
app.use('/api/admin/genre-urls', generalLimiter);
app.use('/api/admin/genre-urls', adminGenreUrlsRouter);

app.use('/api/jobs', generalLimiter);
app.use('/api/jobs', jobsRouter);
app.use('/api/content', generalLimiter);
app.use('/api/content', contentActionsRouter);
app.use('/api/credits', generalLimiter);
app.use('/api/credits', creditsRouter);
app.use('/api/superuser', generalLimiter);
app.use('/api/superuser', superuserRouter);
app.use('/api/tiers', generalLimiter);
app.use('/api/tiers', tiersRouter);
app.use('/api/cron', generalLimiter);
app.use('/api/cron', cronRouter);
app.use('/api/impersonate/data', generalLimiter);
app.use('/api/impersonate/data', impersonateDataRouter);
app.use('/api/impersonate/write', generalLimiter);
app.use('/api/impersonate/write', impersonateWriteRouter);

// Test-only fixture endpoint (Compose Newsletter 2a — S9). Mounts only when
// NODE_ENV === 'test' so production never exposes the canonical-run replay.
if (process.env.NODE_ENV === 'test') {
  // Dynamic import keeps the route file out of the production bundle's
  // import graph when this branch is dead.
  void import('./routes/test-newsletter.js').then((m) => {
    app.use('/api/test/newsletter', generalLimiter);
    app.use('/api/test/newsletter', m.testNewsletterRouter);
    logger.info('Test-only fixture endpoint mounted at /api/test/newsletter');
  });
}

// Centralized error handler (must be after routes)
app.use(errorHandler);

// In production, serve the React build
const publicPath = path.resolve(__dirname, '../public');

// Static assets (JS/CSS chunks) are immutable — cache aggressively
app.use('/assets', express.static(path.join(publicPath, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Everything else (non-asset static files)
app.use(express.static(publicPath, { maxAge: '1h' }));

// SPA fallback — index.html must never be cached to prevent stale chunk errors after deploys
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicPath, 'index.html'));
});

const server = app.listen(PORT, () => {
  logger.info(`The Writers Workbench API running on http://localhost:${PORT}`);
});

// Start BullMQ workers + queue-event listeners (tracker + SSE forwarder)
// if Redis is configured. The chat proxy enqueues async jobs onto these
// queues; without workers, jobs would pile up forever.
let jobInfra: JobInfrastructure | null = null;
if (process.env.REDIS_URL) {
  void (async () => {
    try {
      const { startJobInfrastructure } = await import('./lib/jobs/boot.js');
      jobInfra = startJobInfrastructure(pushSseEvent);
    } catch (err) {
      logger.error({ err }, 'Failed to start job infrastructure');
    }
  })();
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down gracefully`);

  // Stop accepting new HTTP connections first
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  // Drain BullMQ queues and close Redis — only if the module has been
  // loaded and REDIS_URL was set (otherwise we never opened a connection)
  const queuesClosed = (async () => {
    if (!process.env.REDIS_URL) return;
    try {
      if (jobInfra) {
        const { stopJobInfrastructure } = await import('./lib/jobs/boot.js');
        await stopJobInfrastructure(jobInfra);
      }
      const { closeAllQueues } = await import('./lib/queue.js');
      const { closeRedis } = await import('./lib/redis.js');
      const { closeSsePubsub } = await import('./lib/sse-pubsub.js');
      await closeAllQueues();
      await closeSsePubsub();
      await closeRedis();
    } catch (err) {
      logger.error({ err }, 'shutdown: queue/redis close failed');
    }
  })();

  try {
    await Promise.all([httpClosed, queuesClosed]);
    logger.info('All connections closed. Exiting.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown: error during drain');
    process.exit(1);
  }
}

// Force exit after 10 seconds if graceful shutdown stalls
function armShutdownTimer() {
  setTimeout(() => {
    logger.error('Could not close connections in time. Forcing shutdown.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => {
  armShutdownTimer();
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  armShutdownTimer();
  void shutdown('SIGINT');
});

export { app };
