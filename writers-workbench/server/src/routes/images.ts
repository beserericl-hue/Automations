import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const imagesRouter = Router();

const KIEAI_BASE = 'https://api.kie.ai/api/v1/playground';

function getKieApiKey(): string {
  const key = process.env.KIEAI_API_KEY;
  if (!key) throw new Error('KIEAI_API_KEY not configured');
  return key;
}

/**
 * @openapi
 * /images/generate:
 *   post:
 *     tags: [Images]
 *     summary: Submit image generation to KIE.AI
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ImageGenerateRequest'
 *     responses:
 *       200:
 *         description: Generation task created
 *       400:
 *         description: Missing prompt
 *       401:
 *         description: Missing or invalid auth token
 * /images/status/{taskId}:
 *   get:
 *     tags: [Images]
 *     summary: Poll image generation status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Generation status (pending/success/failed)
 *       401:
 *         description: Missing or invalid auth token
 * /images/save:
 *   post:
 *     tags: [Images]
 *     summary: Save generated image to Supabase Storage
 *     description: Downloads from KIE.AI temp URL, uploads to Supabase Storage, inserts database record.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ImageSaveRequest'
 *     responses:
 *       200:
 *         description: Image saved
 *       400:
 *         description: Missing image_url or prompt
 *       401:
 *         description: Missing or invalid auth token
 * /images/upload-reference:
 *   post:
 *     tags: [Images]
 *     summary: Upload reference image for KIE.AI
 *     description: Uploads a base64-encoded reference image to Supabase Storage.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reference image uploaded
 *       401:
 *         description: Missing or invalid auth token
 */
imagesRouter.post('/generate', requireAuth, async (req: Request, res: Response) => {
  const { prompt, reference_image_url, project_id, genre_slug } = req.body;

  if (!prompt) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'prompt is required' } });
    return;
  }

  try {
    const imageUrls = reference_image_url ? [reference_image_url] : [];

    const response = await fetch(`${KIEAI_BASE}/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getKieApiKey()}`,
      },
      body: JSON.stringify({
        model: 'google/nano-banana',
        callBackUrl: '',
        input: { prompt, image_urls: imageUrls },
      }),
    });

    const data = await response.json() as Record<string, unknown>;
    const taskData = data.data as Record<string, unknown> | undefined;

    if (!taskData?.taskId) {
      logger.error({ data }, 'KIE.AI createTask failed');
      res.status(502).json({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'Failed to create image task' } });
      return;
    }

    // Return task ID for polling
    res.json({
      success: true,
      taskId: taskData.taskId,
      context: { prompt, reference_image_url, project_id, genre_slug },
    });
  } catch (err) {
    logger.error({ err }, 'KIE.AI generate error');
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Image generation failed' } });
  }
});

/**
 * GET /api/images/status/:taskId
 * Poll KIE.AI for task completion.
 */
imagesRouter.get('/status/:taskId', requireAuth, async (req: Request, res: Response) => {
  const { taskId } = req.params;

  try {
    const response = await fetch(`${KIEAI_BASE}/recordInfo?taskId=${taskId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getKieApiKey()}`,
      },
    });

    const data = await response.json() as Record<string, unknown>;
    const statusData = data.data as Record<string, unknown> | undefined;
    const state = (statusData?.state as string) || 'unknown';

    if (state === 'success') {
      const resultJson = JSON.parse((statusData?.resultJson as string) || '{}');
      const imageUrl = resultJson.resultUrls?.[0] || null;
      res.json({ success: true, state: 'success', imageUrl });
    } else if (state === 'failed') {
      res.json({ success: true, state: 'failed', error: (statusData?.failMsg as string) || 'Generation failed' });
    } else {
      res.json({ success: true, state: 'pending' });
    }
  } catch (err) {
    logger.error({ err }, 'KIE.AI status check error');
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Status check failed' } });
  }
});

/**
 * POST /api/images/save
 * Download generated image from KIE.AI temp URL, upload to Supabase Storage,
 * and insert generated_images_v2 record.
 * Body: { image_url, prompt, project_id?, genre_slug?, title? }
 */
imagesRouter.post('/save', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { image_url, prompt, project_id, genre_slug, title } = req.body;

  if (!image_url) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'image_url is required' } });
    return;
  }

  try {
    // Download image from KIE.AI temp URL
    const imgResponse = await fetch(image_url);
    if (!imgResponse.ok) {
      res.status(502).json({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'Failed to download image' } });
      return;
    }
    const imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

    // Build storage path
    const slug = (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const storagePath = `${userId}/${ts}_${slug}.png`;

    const supabase = getSupabaseAdmin();

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('cover-images')
      .upload(storagePath, imageBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      logger.error({ uploadError }, 'Supabase storage upload failed');
    }

    // Insert DB record
    const { data: record, error: dbError } = await supabase
      .from('generated_images_v2')
      .insert({
        user_id: userId,
        project_id: project_id || null,
        image_type: 'cover_art',
        storage_path: storagePath,
        original_prompt: (prompt || '').substring(0, 10000),
        genre_slug: genre_slug || null,
        image_format: 'png',
        generation_model: 'nano-banana-pro',
        metadata: { title: title || 'Untitled' },
      })
      .select()
      .single();

    if (dbError) {
      logger.error({ dbError }, 'generated_images_v2 insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: 'Failed to save image record' } });
      return;
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from('cover-images').getPublicUrl(storagePath);

    res.json({
      success: true,
      image: record,
      publicUrl: urlData.publicUrl,
    });
  } catch (err) {
    logger.error({ err }, 'Image save error');
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to save image' } });
  }
});

/**
 * POST /api/images/upload-reference
 * Upload a reference image to Supabase Storage for use with KIE.AI.
 * Expects multipart form data with file field "image".
 */
imagesRouter.post('/upload-reference', requireAuth, async (req: Request, res: Response) => {
  // For now, accept base64 JSON upload (simpler than multipart)
  const { base64, filename, content_type } = req.body;

  if (!base64) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'base64 image data required' } });
    return;
  }

  try {
    const userId = req.userId!;
    const buffer = Buffer.from(base64, 'base64');
    const ext = (filename || 'ref.png').split('.').pop() || 'png';
    const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const storagePath = `${userId}/references/${ts}_ref.${ext}`;

    const supabase = getSupabaseAdmin();

    const { error: uploadError } = await supabase.storage
      .from('cover-images')
      .upload(storagePath, buffer, {
        contentType: content_type || 'image/png',
        upsert: true,
      });

    if (uploadError) {
      logger.error({ uploadError }, 'Reference upload failed');
      res.status(500).json({ success: false, error: { code: 'UPLOAD_ERROR', message: uploadError.message } });
      return;
    }

    const { data: urlData } = supabase.storage.from('cover-images').getPublicUrl(storagePath);

    res.json({ success: true, publicUrl: urlData.publicUrl, storagePath });
  } catch (err) {
    logger.error({ err }, 'Reference upload error');
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Upload failed' } });
  }
});
