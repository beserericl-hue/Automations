import { Router } from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';
import { BrainstormSubmitSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';

export const brainstormRouter = Router();

// Multer config: memory storage, 20MB limit, .docx/.pdf only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only .docx and .pdf files are allowed'));
    }
  },
});

/** Extract text from an uploaded file buffer */
async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (mimetype === 'application/pdf') {
    // pdf-parse is CJS-only — dynamic import
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text;
  }
  throw new Error(`Unsupported file type: ${mimetype}`);
}

/** Call Claude Haiku to extract structured fields from book proposal text */
async function parseBookProposal(text: string): Promise<{
  title: string;
  genre_suggestion: string;
  story_arc: string;
  themes: string[];
  summary: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Extract structured fields from this book proposal text. Return ONLY valid JSON with these fields:
- "title": the book title (string)
- "genre_suggestion": the genre or tone described, e.g. "Satirical Comedy-Drama" (string)
- "story_arc": any story arc framework mentioned, e.g. "Fichtean Curve", "Save the Cat", "Three-Act Structure" (string, empty if none mentioned)
- "themes": array of themes identified (string[])
- "summary": a 2-3 sentence premise summary (string)

Do NOT guess the number of chapters. Only extract what is explicitly stated.

Book proposal text:
${text.substring(0, 40000)}`,
      },
    ],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse AI response');

  return JSON.parse(jsonMatch[0]);
}

// ---- Endpoint 1: Parse text/file to extract fields ----
brainstormRouter.post(
  '/parse',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      let contentText = req.body?.content_text || '';

      // If file uploaded, extract text from it
      if (req.file) {
        const extracted = await extractText(req.file.buffer, req.file.mimetype);
        contentText = contentText ? `${contentText}\n\n${extracted}` : extracted;
      }

      if (!contentText || contentText.trim().length < 10) {
        res.status(400).json({ error: 'Content text is required (minimum 10 characters)' });
        return;
      }

      const parsed = await parseBookProposal(contentText);

      res.json({
        ...parsed,
        raw_text: contentText,
      });
    } catch (error) {
      logger.error({ err: error }, 'Brainstorm parse error');
      const message = error instanceof Error ? error.message : 'Failed to parse content';
      res.status(500).json({ error: message });
    }
  }
);

// ---- Endpoint 2: Submit brainstorm to n8n workflow ----
brainstormRouter.post(
  '/submit',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      let contentText = req.body?.content_text || '';

      // If file uploaded, extract text and combine
      if (req.file) {
        const extracted = await extractText(req.file.buffer, req.file.mimetype);
        contentText = contentText ? `${contentText}\n\n${extracted}` : extracted;
      }

      // Validate required fields (after file extraction)
      const parsed = BrainstormSubmitSchema.safeParse({
        ...req.body,
        content_text: contentText,
      });
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(', ') });
        return;
      }

      const { title, genre_slug, story_arc, target_chapter_count } = parsed.data;

      const webhookUrl = process.env.N8N_BRAINSTORM_WEBHOOK_URL
        || (process.env.N8N_API_URL ? `${process.env.N8N_API_URL}/webhook/brainstorm_story_v2` : '');

      if (!webhookUrl) {
        res.status(500).json({ error: 'N8N_BRAINSTORM_WEBHOOK_URL not configured' });
        return;
      }

      // Forward to n8n brainstorm workflow
      const payload = {
        user_id: (req as any).userId || '',
        project_title: title,
        genre_slug,
        story_arc,
        initial_concept: contentText,
        themes: parsed.data.themes || '',
        target_chapter_count: String(target_chapter_count || '15'),
        user_prompt: `Brainstorm book: ${title}`,
        recipient_email: '',
        bcc_email: '',
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error({ status: response.status, body: errText }, 'n8n brainstorm webhook error');
        res.status(502).json({ error: 'Failed to submit brainstorm to workflow engine' });
        return;
      }

      const data = await response.json() as Record<string, unknown>;
      res.json({
        status: 'accepted',
        message: 'Brainstorm submitted. Your outline will appear in Projects and be emailed to you.',
        ...data,
      });
    } catch (error) {
      logger.error({ err: error }, 'Brainstorm submit error');
      const message = error instanceof Error ? error.message : 'Failed to submit brainstorm';
      res.status(500).json({ error: message });
    }
  }
);
