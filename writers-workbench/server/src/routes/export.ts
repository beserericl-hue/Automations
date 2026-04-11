import { Router } from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { ExportRequestSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';

export const exportRouter = Router();

const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  '5x8': { width: 7200, height: 11520 },
  '5.06x7.81': { width: 7286, height: 11246 },
  '5.25x8': { width: 7560, height: 11520 },
  '5.5x8.5': { width: 7920, height: 12240 },
  '6x9': { width: 8640, height: 12960 },
  '6.14x9.21': { width: 8842, height: 13262 },
  '6.69x9.61': { width: 9634, height: 13838 },
  '7x10': { width: 10080, height: 14400 },
  '7.44x9.69': { width: 10714, height: 13953 },
  '7.5x9.25': { width: 10800, height: 13320 },
  '8x10': { width: 11520, height: 14400 },
  '8.25x11': { width: 11880, height: 15840 },
  '8.25x6': { width: 11880, height: 8640 },
  '8.25x8.25': { width: 11880, height: 11880 },
  '8.27x11.69': { width: 11909, height: 16833 },
  '8.5x11': { width: 12240, height: 15840 },
  '8.5x8.5': { width: 12240, height: 12240 },
};

exportRouter.post('/docx', requireAuth, validateBody(ExportRequestSchema), async (req, res) => {
  try {
    const { project_id, page_size } = req.body;
    const user_id = req.userId!; // From JWT, not request body

    // Fetch project
    const { data: project, error: projError } = await getSupabaseAdmin()
      .from('writing_projects_v2')
      .select('title, genre_slug, outline')
      .eq('id', project_id)
      .eq('user_id', user_id)
      .single();

    if (projError || !project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Fetch all chapters ordered
    const { data: chapters, error: chapError } = await getSupabaseAdmin()
      .from('published_content_v2')
      .select('title, chapter_number, content_text')
      .eq('project_id', project_id)
      .eq('user_id', user_id)
      .eq('content_type', 'chapter')
      .order('chapter_number', { ascending: true });

    if (chapError) {
      res.status(500).json({ error: 'Failed to fetch chapters' });
      return;
    }

    if (!chapters || chapters.length === 0) {
      res.status(400).json({ error: 'No chapters found for this project' });
      return;
    }

    const size = PAGE_SIZES[page_size] || PAGE_SIZES['6x9'];

    // Build sections — each chapter is a section with odd-page break
    const sections = chapters.map((chapter, index) => {
      const paragraphs: Paragraph[] = [];

      // Chapter title
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: chapter.title, bold: true, size: 32, font: 'Garamond' })],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 300 },
        ...(index > 0 ? { pageBreakBefore: true } : {}),
      }));

      // Chapter content — split by paragraphs
      if (chapter.content_text) {
        // Strip HTML tags if present, split on double newlines or <p> tags
        const cleanText = chapter.content_text
          .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

        const contentParagraphs = cleanText.split(/\n{2,}/).filter((p: string) => p.trim());

        for (const para of contentParagraphs) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: para.trim(), size: 24, font: 'Garamond' })],
            spacing: { after: 120 },
            alignment: AlignmentType.JUSTIFIED,
          }));
        }
      }

      return {
        properties: {
          page: {
            size: { width: size.width, height: size.height },
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        children: paragraphs,
      };
    });

    // Title page
    const titleSection = {
      properties: {
        page: {
          size: { width: size.width, height: size.height },
          margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
        },
      },
      children: [
        new Paragraph({ spacing: { before: 4000 } }),
        new Paragraph({
          children: [new TextRun({ text: project.title, bold: true, size: 48, font: 'Garamond' })],
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          children: [new TextRun({ text: '\n', size: 24 })],
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Genre: ${(project.genre_slug || '').replace(/-/g, ' ')}`,
            size: 24, font: 'Garamond', italics: true,
          })],
          alignment: AlignmentType.CENTER,
        }),
      ],
    };

    const doc = new Document({
      sections: [titleSection, ...sections],
    });

    const buffer = await Packer.toBuffer(doc);

    const filename = `${project.title.replace(/[^a-zA-Z0-9]/g, '_')}_KDP.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    logger.error({ err: error }, 'Export error');
    res.status(500).json({ error: 'Failed to generate document' });
  }
});
