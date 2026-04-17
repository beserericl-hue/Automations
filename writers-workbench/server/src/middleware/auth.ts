import { Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../services/supabase-admin.js';

// Extend Express Request to include authenticated user info
declare global {
  namespace Express {
    interface Request {
      userId?: string;      // phone number from users_v2
      authUid?: string;     // Supabase Auth UUID
      userRole?: string;    // role from users_v2
    }
  }
}

/**
 * Middleware that verifies the Supabase JWT from the Authorization header,
 * looks up the user in users_v2, and attaches userId (phone) to req.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const supabase = getSupabaseAdmin();

    // Verify the JWT and get the auth user
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authUser) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    // Look up the user in users_v2 by supabase_auth_uid
    const { data: userRecord, error: userError } = await supabase
      .from('users_v2')
      .select('user_id, role')
      .eq('supabase_auth_uid', authUser.id)
      .single();

    if (userError || !userRecord) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User profile not found' } });
      return;
    }

    // Attach to request for downstream use
    req.authUid = authUser.id;
    req.userId = userRecord.user_id;
    req.userRole = userRecord.role || 'user';

    next();
  } catch {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } });
  }
}

/**
 * Middleware that requires admin role. Must be used AFTER requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    return;
  }
  next();
}
