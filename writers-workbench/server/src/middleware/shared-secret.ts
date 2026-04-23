import { Request, Response, NextFunction } from 'express';

/**
 * Middleware factory: require a shared-secret header.
 *
 * Used by the newsletter-sprint n8n-facing endpoints
 * (/api/ingestion/*, /api/approvals/*, /api/email/*, /api/newsletter-sends/*).
 * These aren't user-authenticated calls — n8n has no user JWT — so
 * instead each endpoint gates on a header that matches an env var.
 *
 * Returns 500 if the env var is unset (misconfigured deploy), 401 if
 * the request header is missing or doesn't match. Always responds with
 * the shared {success, error:{code, message}} shape.
 */
export function requireSharedSecret(headerName: string, envVarName: string) {
  const headerLower = headerName.toLowerCase();
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env[envVarName];
    if (!expected) {
      res.status(500).json({
        success: false,
        error: { code: 'MISCONFIGURED', message: `${envVarName} not set on server` },
      });
      return;
    }

    const provided = req.get(headerLower);
    if (!provided || provided !== expected) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: `Missing or invalid ${headerName}` },
      });
      return;
    }

    next();
  };
}
