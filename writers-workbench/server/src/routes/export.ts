import { Router } from 'express';

export const exportRouter = Router();

// POST /api/export/docx — compile project chapters into KDP-formatted .docx
exportRouter.post('/docx', async (_req, res) => {
  // TODO: Phase 8 — implement docx generation
  // 1. Authenticate via Supabase JWT
  // 2. Fetch all chapters for project_id, ordered by chapter_number
  // 3. Download .docx template from Supabase Storage
  // 4. Build .docx with docx npm library
  // 5. Return binary .docx response
  res.status(501).json({ error: 'Not implemented yet — coming in Phase 8' });
});
