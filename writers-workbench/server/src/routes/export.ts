import { Router } from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, SectionType } from 'docx';
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

/**
 * @openapi
 * /export/docx:
 *   post:
 *     tags: [Export]
 *     summary: Export project to .docx
 *     description: Generates a Word document with all approved/published chapters ordered Prologue → Ch1-N → Epilogue.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ExportDocxRequest'
 *     responses:
 *       200:
 *         description: .docx file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.wordprocessingml.document:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid project_id or page_size
 *       401:
 *         description: Missing or invalid auth token
 *       404:
 *         description: Project not found or no exportable chapters
 */
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
      .in('status', ['approved', 'published'])
      .order('chapter_number', { ascending: true });

    if (chapError) {
      res.status(500).json({ error: 'Failed to fetch chapters' });
      return;
    }

    if (!chapters || chapters.length === 0) {
      res.status(400).json({ error: 'No approved or published chapters found for this project' });
      return;
    }

    const size = PAGE_SIZES[page_size] || PAGE_SIZES['6x9'];
    const pageProps = {
      page: {
        size: { width: size.width, height: size.height },
        margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
      },
    };

    // Title page section
    const titleSection = {
      properties: {
        ...pageProps,
        type: SectionType.ODD_PAGE,
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

    // Build chapter sections — each starts on an odd (right-hand) page
    const chapterSections = chapters.map((chapter) => {
      const paragraphs: Paragraph[] = [];

      // Determine chapter label: Prologue, Epilogue, or Chapter N
      const chapterLabel = getChapterLabel(chapter.chapter_number, chapter.title);

      // Chapter title — large, centered
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: chapterLabel, bold: true, size: 32, font: 'Garamond' })],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 300 },
      }));

      // Chapter content — parse HTML/markdown to paragraphs
      if (chapter.content_text) {
        const contentParagraphs = parseContentToParagraphs(chapter.content_text);
        paragraphs.push(...contentParagraphs);
      }

      return {
        properties: {
          ...pageProps,
          type: SectionType.ODD_PAGE, // Always start on right-hand (odd) page
        },
        children: paragraphs,
      };
    });

    const doc = new Document({
      sections: [titleSection, ...chapterSections],
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

/**
 * Build the chapter heading label:
 * - chapter_number 0 → "Prologue — {title}"
 * - chapter_number 999 → "Epilogue — {title}"
 * - otherwise → "Chapter {N} — {title}"
 */
function getChapterLabel(chapterNumber: number | null, title: string): string {
  if (chapterNumber === 0) return `Prologue — ${title}`;
  if (chapterNumber === 999) return `Epilogue — ${title}`;
  if (chapterNumber != null) return `Chapter ${chapterNumber} — ${title}`;
  return title;
}

/**
 * Parse content (HTML or markdown) into docx Paragraph objects.
 * Handles:
 * - Markdown headers (# ## ###) → Heading paragraphs
 * - HTML tags → stripped, structure preserved
 * - Plain text paragraphs → body text
 */
function parseContentToParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // First, convert HTML to plain text with structure markers
  let text = content
    // Convert HTML headings to markdown-style for uniform processing
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n\n#### $1\n\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n\n##### $1\n\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n\n###### $1\n\n')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Paragraphs
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    // Bold/italic
    .replace(/<\/?strong>/gi, '')
    .replace(/<\/?b>/gi, '')
    .replace(/<\/?em>/gi, '')
    .replace(/<\/?i>/gi, '')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…');

  // Split into blocks on double newlines
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  for (const block of blocks) {
    // Check if this block is a markdown heading
    const headingMatch = block.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();

      // Map markdown levels to docx heading levels
      const headingLevel = level === 1 ? HeadingLevel.HEADING_1
        : level === 2 ? HeadingLevel.HEADING_2
        : level === 3 ? HeadingLevel.HEADING_3
        : HeadingLevel.HEADING_4;

      const fontSize = level === 1 ? 32 : level === 2 ? 28 : level === 3 ? 26 : 24;

      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: headingText, bold: true, size: fontSize, font: 'Garamond' })],
        heading: headingLevel,
        spacing: { before: 240, after: 120 },
      }));
    } else {
      // Regular paragraph — handle single line breaks within the block as continuous text
      const cleanText = block.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: cleanText, size: 24, font: 'Garamond' })],
          spacing: { after: 120 },
          alignment: AlignmentType.JUSTIFIED,
        }));
      }
    }
  }

  return paragraphs;
}
