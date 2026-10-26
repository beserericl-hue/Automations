import pino from 'pino';

/**
 * Credentials that must never reach the logs. pino-http logs every request's headers, and the
 * Railway logs carried live session tokens (the Authorization header, and the `?token=` the
 * live-updates stream passes in its URL) and the shared service secrets.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-service-secret"]',
  'req.headers["x-approval-secret"]',
  'req.headers["x-callback-secret"]',
  'req.headers["x-cron-secret"]',
  'req.headers["x-email-secret"]',
  'req.headers["x-ingestion-secret"]',
  'req.headers["x-postal-webhook-secret"]',
  'req.headers["x-rpi-printapi-hmac-sha256"]',
  'req.query.token',
  'res.headers["set-cookie"]',
];

/** A URL with any token in its query string replaced, for the `url` the request log carries. */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&](?:token|access_token|t)=)[^&#]*/gi, '$1[Redacted]');
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});
