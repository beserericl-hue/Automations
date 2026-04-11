import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AdminUserSchema } from '../schemas.js';

export const adminRouter = Router();

// All admin routes require JWT + admin role
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/users', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.post('/users', validateBody(AdminUserSchema), (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.get('/metrics', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.get('/workflows', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});
