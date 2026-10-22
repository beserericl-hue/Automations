import { Router } from 'express';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, SectionType } from 'docx';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireTierFeature } from '../middleware/auth.js';
import { ExportRequestSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';
import { z } from 'zod';
import { buildEpub, epubFilename, type EpubChapter } from '../lib/epub.js';
import { composeCover } from '../lib/cover.js';
import { buildKdpPackage, type PackageChapter, type PackageSettings } from '../lib/kdp-package.js';
import { marketingKey, publishingOf } from './publishing.js';

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
exportRouter.post('/docx', requireAuth, requireTierFeature('kdp_export'), validateBody(ExportRequestSchema), async (req, res) => {
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

// =====================================================================
// EPUB — the pre-publish read
// =====================================================================
// Different purpose from /docx, and therefore a different rule about what goes in it.
//
// /docx is the KDP print deliverable, so it exports only approved or published chapters: shipping a
// draft to a printer is a mistake. The EPUB exists so an author can read the manuscript as a reader
// will — on a Kindle, in Books — BEFORE deciding whether to approve it. Restricting it to approved
// chapters would make it useless for exactly the moment it is for: today The Ossuary has 96 chapters
// and zero approved, so an approved-only EPUB is an empty file and a confusing error.
//
// So it defaults to everything and marks unapproved chapters in the text, which keeps the draft
// read honest without making it impossible. `only_approved: true` gives the /docx behaviour for
// anyone who wants the final article.

const EpubRequestSchema = z.object({
  project_id: z.string().uuid('project_id must be a valid UUID'),
  /** Byline, and dc:creator — without it Books files the book under "Unknown Author". */
  author: z.string().max(120).optional(),
  only_approved: z.boolean().optional().default(false),
  /** Default true: an unmarked draft read is how a draft gets mistaken for the final book. */
  mark_drafts: z.boolean().optional().default(true),
});

/**
 * @openapi
 * /export/epub:
 *   post:
 *     tags: [Export]
 *     summary: Export a project as an EPUB for pre-publish reading
 *     description: |
 *       Builds an EPUB 3 of the project's chapters in order. Unlike `/export/docx` this includes
 *       draft chapters by default — the point is to read the manuscript before approving it — and
 *       marks them in the text unless `mark_drafts` is false.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: EPUB file download }
 *       400: { description: No chapters with text }
 *       404: { description: Project not found }
 */
exportRouter.post(
  '/epub',
  requireAuth,
  requireTierFeature('kdp_export'),
  validateBody(EpubRequestSchema),
  async (req, res) => {
    const { project_id, only_approved, mark_drafts, author } = req.body as z.infer<
      typeof EpubRequestSchema
    >;
    const user_id = req.userId!;
    try {
      const { data: project, error: projError } = await getSupabaseAdmin()
        .from('writing_projects_v2')
        .select('title, genre_slug')
        .eq('id', project_id)
        .eq('user_id', user_id)
        .single();
      if (projError || !project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      // Fall back to the account's own name so a book is never filed under "Unknown Author".
      let author_name = (author || '').trim();
      if (!author_name) {
        const { data: profile } = await getSupabaseAdmin()
          .from('users_v2')
          .select('name')
          .eq('user_id', user_id)
          .maybeSingle();
        author_name = ((profile?.name as string) || '').trim();
      }

      // Paged: PostgREST caps a response at 1000 rows, and a book can exceed that in theory. More
      // importantly `data.length` is a page size, not a count — a trap this codebase has hit before.
      const chapters: EpubChapter[] = [];
      for (let page = 0; ; page += 1) {
        let q = getSupabaseAdmin()
          .from('published_content_v2')
          .select('title, chapter_number, content_text, status')
          .eq('project_id', project_id)
          .eq('user_id', user_id)
          .eq('content_type', 'chapter')
          .is('deleted_at', null)
          .order('chapter_number', { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (only_approved) q = q.in('status', ['approved', 'published']);
        const { data, error } = await q;
        if (error) {
          res.status(500).json({ error: 'Failed to fetch chapters' });
          return;
        }
        chapters.push(...((data || []) as unknown as EpubChapter[]));
        if ((data || []).length < 1000) break;
      }

      if (chapters.length === 0) {
        res.status(400).json({
          error: only_approved
            ? 'No approved or published chapters found for this project'
            : 'This project has no chapters yet',
        });
        return;
      }

      // Cover: the project's selected art, composed into a portrait jacket with the title and
      // author set on it. Raw square art is letterboxed by readers into the shelf tile with grey
      // bars, and carries no words, so the shelf shows a picture rather than a book.
      let cover: { data: Buffer; ext: 'jpg' | 'png' } | null = null;
      try {
        const { data: art } = await getSupabaseAdmin()
          .from('generated_images_v2')
          .select('storage_path')
          .eq('project_id', project_id)
          .eq('image_type', 'cover_art')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (art?.storage_path) {
          const dl = await getSupabaseAdmin()
            .storage.from('cover-images')
            .download(art.storage_path as string);
          if (dl.data) {
            const raw = Buffer.from(await dl.data.arrayBuffer());
            const composed = await composeCover({
              art: raw,
              title: project.title as string,
              author: author_name,
            });
            // Falling back to the raw art is still better than no cover at all.
            cover = composed ? { data: composed, ext: 'jpg' } : { data: raw, ext: 'png' };
          }
        }
      } catch (err) {
        logger.warn({ err, project_id }, 'epub: cover unavailable, exporting without one');
      }

      const buffer = await buildEpub({
        title: project.title as string,
        chapters,
        markDrafts: mark_drafts,
        author: author_name,
        cover,
      });

      const filename = epubFilename(project.title as string);
      logger.info(
        { userId: user_id, project_id, chapters: chapters.length, bytes: buffer.length },
        'epub export',
      );
      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      if (err instanceof Error && err.message === 'NO_CHAPTERS') {
        res.status(400).json({ error: 'No chapters with text to export' });
        return;
      }
      logger.error({ err, userId: user_id, project_id }, 'epub export failed');
      res.status(500).json({ error: 'Failed to generate EPUB' });
    }
  },
);

const KdpPackageSchema = z.object({
  project_id: z.string().uuid('project_id must be a valid UUID'),
  /** One volume, or every planned volume when absent. A three-volume build is three interiors. */
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
  /**
   * Default false: the package is for uploading, and a book missing its unapproved chapters is a
   * worse failure than one shipping a chapter that still had a Q/A flag. The author chooses.
   */
  only_approved: z.boolean().optional().default(false),
});

/**
 * @openapi
 * /export/kdp-package:
 *   post:
 *     tags: [Export]
 *     summary: Every file KDP asks for, as one zip
 *     description: |
 *       Builds the paperback interior at the project's trim size, the full cover wrap with the spine
 *       measured from that interior's real page count, the Kindle EPUB and its cover, the listing
 *       copy laid out field by field for the KDP form, and a pre-flight report. One zip per volume
 *       folder.
 *
 *       There is no KDP API — the upload is a person filling in a web form — so this is the whole
 *       deliverable, and the `X-Kdp-Blocking` response header says how many problems would stop it.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: zip download }
 *       400: { description: Nothing to build (no chapters, or no such volume) }
 *       404: { description: Project not found }
 */
exportRouter.post(
  '/kdp-package',
  requireAuth,
  requireTierFeature('kdp_export'),
  validateBody(KdpPackageSchema),
  async (req, res) => {
    const { project_id, volume_index, only_approved } = req.body as z.infer<typeof KdpPackageSchema>;
    const user_id = req.userId!;
    try {
      const supabase = getSupabaseAdmin();
      const { data: project, error: projError } = await supabase
        .from('writing_projects_v2')
        .select('id, title, outline')
        .eq('id', project_id)
        .eq('user_id', user_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (projError || !project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const outline = (project.outline as Record<string, unknown> | null) ?? {};
      const settings = publishingOf(outline) as unknown as PackageSettings;

      // Paged. PostgREST caps a response at 1000 rows and `data.length` is a page size, not a
      // count — reading it as one is a mistake this codebase has already paid for.
      const chapters: PackageChapter[] = [];
      for (let page = 0; ; page += 1) {
        const { data, error } = await supabase
          .from('published_content_v2')
          .select('title, chapter_number, content_text, status')
          .eq('project_id', project_id)
          .eq('user_id', user_id)
          .eq('content_type', 'chapter')
          .is('deleted_at', null)
          .order('chapter_number', { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (error) {
          res.status(500).json({ error: 'Failed to fetch chapters' });
          return;
        }
        chapters.push(...((data || []) as unknown as PackageChapter[]));
        if ((data || []).length < 1000) break;
      }

      const { data: authorProfile } = await supabase
        .from('author_profiles_v2')
        .select('pen_name, bio')
        .eq('user_id', user_id)
        .maybeSingle();
      let authorName = String(authorProfile?.pen_name ?? '').trim();
      if (!authorName) {
        const { data: account } = await supabase
          .from('users_v2')
          .select('name')
          .eq('user_id', user_id)
          .maybeSingle();
        authorName = String(account?.name ?? '').trim();
      }

      let art: Buffer | null = null;
      try {
        const { data: coverArt } = await supabase
          .from('generated_images_v2')
          .select('storage_path')
          .eq('project_id', project_id)
          .eq('image_type', 'cover_art')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (coverArt?.storage_path) {
          const dl = await supabase.storage
            .from('cover-images')
            .download(coverArt.storage_path as string);
          if (dl.data) art = Buffer.from(await dl.data.arrayBuffer());
        }
      } catch (err) {
        logger.warn({ err, project_id }, 'kdp package: cover art unavailable');
      }

      const plan = outline._volume_plan as
        | { volumes?: { index: number; first_chapter: number; last_chapter: number }[] }
        | undefined;
      const volumeCount = Math.max(1, plan?.volumes?.length ?? 1);
      const marketing: Record<string, ReturnType<typeof Object> | null> = {};
      for (let i = 1; i <= volumeCount; i += 1) {
        marketing[String(i)] = (outline[marketingKey(i)] as never) ?? null;
      }

      const pkg = await buildKdpPackage({
        title: String(project.title ?? ''),
        author: authorName,
        authorBio: String(authorProfile?.bio ?? ''),
        chapters,
        settings,
        volumes: plan?.volumes,
        onlyVolume: volume_index ?? null,
        art,
        marketing: marketing as never,
        onlyApproved: only_approved,
      });

      logger.info(
        {
          userId: user_id,
          project_id,
          volumes: pkg.volumes.length,
          bytes: pkg.zip.length,
          blocking: pkg.errors.length,
        },
        'kdp package export',
      );
      // The findings travel in headers so the download itself is the whole response — the client
      // reads them to show what would be refused without a second round trip.
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
      res.setHeader('X-Kdp-Blocking', String(pkg.errors.length));
      res.setHeader('X-Kdp-Warnings', String(pkg.warnings.length));
      res.setHeader('X-Kdp-Volumes', String(pkg.volumes.length));
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Disposition, X-Kdp-Blocking, X-Kdp-Warnings, X-Kdp-Volumes',
      );
      res.send(pkg.zip);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'NO_CHAPTERS') {
        res.status(400).json({ error: 'This project has no chapters with text yet' });
        return;
      }
      if (message === 'NO_SUCH_VOLUME') {
        res.status(400).json({ error: 'That volume is not in the current plan. Re-run the planner.' });
        return;
      }
      logger.error({ err, userId: user_id, project_id }, 'kdp package export failed');
      res.status(500).json({ error: 'Failed to build the KDP package' });
    }
  },
);
