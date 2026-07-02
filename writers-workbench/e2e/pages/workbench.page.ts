import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Page object for the core Writer's Workbench surfaces the marketing B-roll script visits
 * (marketing-copy.md §4 filming plan). Reusable building blocks for the broader UI regression suite:
 * navigation + "screen displays and returns correct results" assertions per screen.
 *
 * Routes covered: `/` Dashboard, `/projects` + `/projects/:id` (9 tabs), `/content/:id` ContentDetail
 * (AnnotationsPanel / QAReportPanel / RewriteWithResearchModal / ImageGallery), `/story-arcs`,
 * `/genres`, `/newsletter/editions`, `/newsletter/approvals`, `/onboarding` PricingCards.
 */
export class WorkbenchPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  /** Navigate + wait for the SPA route to render past "Loading…" (SSE streams keep networkidle open). */
  async gotoAndSettle(path: string) {
    await this.page.goto(path);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.locator('header, aside').first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const text = (await this.page.locator('main').textContent().catch(() => null)) ?? '';
          return text.trim().length > 0 && !/^\s*Loading\.{0,3}\s*$/i.test(text.trim());
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
  }

  // --------------------------------------------------------------------------- Dashboard
  async gotoDashboard() {
    await this.gotoAndSettle('/');
  }

  /** The four stat cards the script's Scene 1 shows: Projects / Drafts / Published / Research. */
  statCard(label: string): Locator {
    // StatCard renders the label text and a numeric count near it.
    return this.page.locator('main').locator(`text=/^${label}$/i`).first();
  }

  // --------------------------------------------------------------------------- Projects
  async gotoProjects() {
    await this.gotoAndSettle('/projects');
  }

  /**
   * Open a project by (partial) title from the project list, preferring an exact-ish title match and
   * falling back to the FIRST project so a screen-validation test still runs even if the named demo
   * project isn't present/ready. Project rows render as `role="button"` with
   * `aria-label="Open project <title>"`. Returns the project id from the URL, or null if no projects.
   */
  async openProjectByTitle(title: string): Promise<string | null> {
    await this.gotoProjects();
    const rows = this.page.getByRole('button', { name: /^Open project / });
    await rows.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    if ((await rows.count().catch(() => 0)) === 0) return null;
    let target = this.page.getByRole('button', { name: new RegExp(`Open project .*${title}`, 'i') }).first();
    if (!(await target.isVisible().catch(() => false))) target = rows.first(); // fallback: first project
    await target.click();
    await this.page.waitForURL(/\/projects\/[0-9a-f-]{8,}/, { timeout: 15_000 }).catch(() => {});
    const m = this.page.url().match(/\/projects\/([0-9a-f-]{8,})/);
    return m ? m[1] : null;
  }

  async gotoProject(id: string) {
    await this.gotoAndSettle(`/projects/${id}`);
  }

  /** The 9 tabs ProjectDetail renders (marketing Scene 2). */
  static readonly PROJECT_TABS = [
    'Overview',
    'Outline',
    'Chapters',
    'Story Bible',
    'Art',
    'Social',
    'Research',
    'Cost',
    'Export',
  ];

  projectTab(name: string): Locator {
    // Tab buttons render a count suffix, e.g. "Chapters (0)", "Story Bible (1)". Match the label plus
    // an optional " (N)" so we don't accidentally match the sidebar "Outlines" link etc.
    return this.page.getByRole('button', { name: new RegExp(`^${name}( \\(\\d+\\))?$`, 'i') }).first();
  }

  async openProjectTab(name: string) {
    const tab = this.projectTab(name);
    await tab.waitFor({ state: 'visible', timeout: 10_000 });
    await tab.click();
  }

  // --------------------------------------------------------------------------- Content / chapter
  /** Open a chapter row from the project's Chapters tab. Returns the content id (from URL) or null. */
  async openChapterFromProject(preferredNumber?: number): Promise<string | null> {
    await this.openProjectTab('Chapters');
    const rows = this.page.locator('main table tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const count = await rows.count().catch(() => 0);
    if (!count) return null;
    let target = rows.first();
    if (preferredNumber != null) {
      const byNum = rows.filter({ hasText: new RegExp(`\\b${preferredNumber}\\b`) }).first();
      if (await byNum.isVisible().catch(() => false)) target = byNum;
    }
    await target.click();
    await this.page.waitForURL(/\/content\/[0-9a-f-]{8,}/, { timeout: 15_000 }).catch(() => {});
    const m = this.page.url().match(/\/content\/([0-9a-f-]{8,})/);
    return m ? m[1] : null;
  }

  async gotoContent(id: string) {
    await this.gotoAndSettle(`/content/${id}`);
  }

  /**
   * Open a genuine chapter (content_type=chapter) by finding the first project whose Chapters tab has a
   * non-zero count and opening its first chapter row. More reliable than the Content Library while
   * background jobs churn "most recent" ordering. Returns the content id, or null if none found.
   */
  /**
   * Resolve a real chapter content id + open its ContentDetail screen. Deterministic and fast: when the
   * DEV Supabase env is available (E2E_SUPA_URL / E2E_SUPA_SERVICE_KEY) it queries a chapter id and
   * navigates straight to /content/:id; otherwise it falls back to walking projects' Chapters tabs.
   */
  async openAChapter(): Promise<string | null> {
    const url = process.env.E2E_SUPA_URL;
    const key = process.env.E2E_SUPA_SERVICE_KEY;
    const uid = process.env.E2E_USER_ID;
    if (url && key) {
      try {
        const q =
          `${url}/rest/v1/published_content_v2?select=id&content_type=eq.chapter` +
          (uid ? `&user_id=eq.${encodeURIComponent(uid)}` : '') +
          `&order=created_at.desc&limit=1`;
        const res = await fetch(q, { headers: { apikey: key, authorization: `Bearer ${key}` } });
        const rows = (await res.json()) as Array<{ id: string }>;
        if (Array.isArray(rows) && rows[0]?.id) {
          await this.gotoContent(rows[0].id);
          return rows[0].id;
        }
      } catch {
        /* fall through to UI walk */
      }
    }
    return this.openFirstChapter();
  }

  async openFirstChapter(maxProjects = 12): Promise<string | null> {
    await this.gotoProjects();
    await this.page
      .getByRole('button', { name: /^Open project / })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
    const projectCount = Math.min(
      await this.page.getByRole('button', { name: /^Open project / }).count().catch(() => 0),
      maxProjects,
    );
    for (let i = 0; i < projectCount; i++) {
      await this.gotoProjects();
      const row = this.page.getByRole('button', { name: /^Open project / }).nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      await row.click();
      await this.page.waitForURL(/\/projects\/[0-9a-f-]{8,}/, { timeout: 15_000 }).catch(() => {});
      await this.openProjectTab('Chapters');
      // Ground truth: does the Chapters tab list any chapter content links? (Avoids racing the async
      // count in the tab label.) Chapter rows link to /content/:id.
      const chapterLink = this.page.locator('a[href^="/content/"]').first();
      await chapterLink.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {});
      if (!(await chapterLink.isVisible().catch(() => false))) continue; // no written chapters → next project
      await chapterLink.click();
      await this.page.waitForURL(/\/content\/[0-9a-f-]{8,}/, { timeout: 15_000 }).catch(() => {});
      const m = this.page.url().match(/\/content\/([0-9a-f-]{8,})/);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Open any existing chapter from the Content Library (rows navigate to /content/:id on cell click).
   * Used by the ContentDetail/AnnotationsPanel/Q&A/Rewrite screen validations so they run against real
   * chapters regardless of which project is seeded. Prefers a row typed "chapter". Returns content id.
   */
  async openAnyChapter(): Promise<string | null> {
    await this.gotoAndSettle('/library');
    const rows = this.page.locator('main table tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
    if ((await rows.count().catch(() => 0)) === 0) return null;
    let target = rows.filter({ hasText: /chapter/i }).first();
    if (!(await target.isVisible().catch(() => false))) target = rows.first();
    // click a title cell (not the checkbox cell) to navigate
    await target.locator('td').nth(1).click();
    await this.page.waitForURL(/\/content\/[0-9a-f-]{8,}/, { timeout: 15_000 }).catch(() => {});
    const m = this.page.url().match(/\/content\/([0-9a-f-]{8,})/);
    return m ? m[1] : null;
  }

  // --------------------------------------------------------------------------- Reference screens
  async gotoStoryArcs() {
    await this.gotoAndSettle('/story-arcs');
  }
  async gotoGenres() {
    await this.gotoAndSettle('/genres');
  }
  async gotoEditions() {
    await this.gotoAndSettle('/newsletter/editions');
  }
  async gotoApprovals() {
    await this.gotoAndSettle('/newsletter/approvals');
  }
  async gotoOnboarding() {
    await this.gotoAndSettle('/onboarding');
  }
}
