import { Router } from 'express';

export const adminRouter = Router();

// TODO: Phase 9 — implement admin routes
// All routes require JWT + admin role check

adminRouter.get('/users', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.post('/users', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.get('/metrics', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});

adminRouter.get('/workflows', (_req, res) => {
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 9' });
});
