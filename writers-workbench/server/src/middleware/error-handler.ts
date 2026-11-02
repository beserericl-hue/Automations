import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { OutlineValidationError, outlineErrorBody } from '../lib/outline-schema.js';

/**
 * Centralized Express error handler.
 * Must be registered after all routes.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.headers['x-request-id'] || 'unknown';

  // Item 7: an outline the schema rejects is the caller's mistake, not a server fault — say exactly
  // what is wrong with it.
  if (err instanceof OutlineValidationError) {
    logger.warn({ requestId, url: req.originalUrl, problems: err.problems }, 'outline rejected');
    res.status(422).json({ ...outlineErrorBody(err), requestId });
    return;
  }

  logger.error({
    err,
    requestId,
    method: req.method,
    url: req.originalUrl,
  }, 'Unhandled error');

  // Don't leak stack traces in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message },
    requestId,
  });
}
