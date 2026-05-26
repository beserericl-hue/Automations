import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Page object for the newsletter feature surface.
 *
 * Reflects routes:
 *   /newsletter                        NewsletterHome
 *   /newsletter/generate               NewsletterGenerate
 *   /newsletter/execution/:id          ExecutionStatus
 *   /newsletter/approvals              PendingApprovals
 *   /newsletter/approvals/:token       ApprovalDetail
 *   /newsletter/sends                  ScheduledSends
 *   /newsletter/sends/:id              NewsletterDetail
 *   /newsletter/ingestion              IngestionBrowser
 *   /newsletter/templates              TemplatesList
 *   /newsletter/templates/{new|:id}    TemplateEditor
 *   /newsletter/editions               EditionsList
 *   /newsletter/editions/new           EditionEditor (create)
 *   /newsletter/editions/:id           EditionEditor (edit)
 *   /newsletter/editions/:id/feeds     FeedsList
 *   /newsletter/editions/:id/setup     EditionSetupWizard
 */
export class NewsletterPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // --- Navigation helpers (route directly; sidebar nav is regression-tested separately) ---

  /**
   * Navigate to a route and wait for the page to be "ready":
   *   1. domcontentloaded (the app keeps SSE streams open so `networkidle` never resolves)
   *   2. Header element visible (signals React layout has rendered)
   *   3. <main> has at least some text content (signals route-level component has rendered past "Loading…")
   *
   * Without step 3, tests that assert immediately on content after navigation
   * race the React render and produce flaky "element not visible" failures.
   */
  private async gotoAndSettle(path: string) {
    await this.page.goto(path);
    await this.page.waitForLoadState('domcontentloaded');
    // Header is rendered by AppShell once auth + user resolve.
    await this.page.locator('header, aside').first().waitFor({ state: 'visible', timeout: 15_000 });
    // Wait until <main> has rendered something beyond the boilerplate "Loading…".
    await expect.poll(
      async () => {
        const text = (await this.page.locator('main').textContent().catch(() => null)) ?? '';
        return text.trim().length > 0 && !/^\s*Loading\.{0,3}\s*$/i.test(text.trim());
      },
      { timeout: 10_000 },
    ).toBeTruthy();
  }

  async gotoHome() { await this.gotoAndSettle('/newsletter'); }
  async gotoEditions() { await this.gotoAndSettle('/newsletter/editions'); }
  async gotoNewEdition() { await this.gotoAndSettle('/newsletter/editions/new'); }
  async gotoEdition(id: string) { await this.gotoAndSettle(`/newsletter/editions/${id}`); }
  async gotoFeeds(editionId: string) { await this.gotoAndSettle(`/newsletter/editions/${editionId}/feeds`); }
  async gotoSetupWizard(editionId: string) { await this.gotoAndSettle(`/newsletter/editions/${editionId}/setup`); }
  async gotoGenerate() { await this.gotoAndSettle('/newsletter/generate'); }
  async gotoApprovals() { await this.gotoAndSettle('/newsletter/approvals'); }
  async gotoSends() { await this.gotoAndSettle('/newsletter/sends'); }
  async gotoIngestion() { await this.gotoAndSettle('/newsletter/ingestion'); }
  async gotoTemplates() { await this.gotoAndSettle('/newsletter/templates'); }
  async gotoNewTemplate() { await this.gotoAndSettle('/newsletter/templates/new'); }

  // --- Sidebar Newsletter nav ---

  get sidebarNewsletterToggle(): Locator {
    return this.page.locator('aside').getByRole('button', { name: /^Newsletter$/ });
  }

  async openSidebarNewsletter() {
    // Click only if collapsed (we can't introspect state cheaply, so click and wait).
    const myNewslettersLink = this.page.locator('aside').getByRole('link', { name: /my newsletters/i });
    if (!(await myNewslettersLink.isVisible().catch(() => false))) {
      await this.sidebarNewsletterToggle.click().catch(() => {});
    }
    await expect(myNewslettersLink).toBeVisible({ timeout: 5_000 });
  }

  // --- Common locators ---

  /** Header `?` HelpButton that opens the feature drawer. */
  get helpButton(): Locator {
    // HelpButton has visible text "?" and `title="Help: <section title>"`.
    // No aria-label → match by title attribute prefix.
    return this.page.locator('button[title^="Help:"]').first();
  }

  get helpDrawer(): Locator {
    // Drawer is the div with role="dialog" aria-modal="true" that wraps the
    // backdrop button (aria-label="Close help") AND the inner panel.
    return this.page.locator('[role="dialog"][aria-modal="true"]').first();
  }

  /** "New newsletter" button on EditionsList header. */
  get newNewsletterButton(): Locator {
    return this.page.getByRole('link', { name: /new newsletter/i });
  }

  /** "Show disabled" checkbox on EditionsList. */
  get showDisabledCheckbox(): Locator {
    return this.page.getByLabel(/show disabled/i);
  }

  /** First edition row in the editions table. */
  get firstEditionRow(): Locator {
    return this.page.locator('table tbody tr').first();
  }

  /** Edition row by display name. */
  editionRowByName(name: string): Locator {
    return this.page.locator('table tbody tr').filter({ hasText: name });
  }

  // --- Edition editor form fields ---

  get editionDisplayNameInput(): Locator {
    return this.page.getByLabel(/display name|newsletter name/i).first();
  }

  get editionSenderNameInput(): Locator {
    return this.page.getByLabel(/sender name/i).first();
  }

  get editionGenreSelect(): Locator {
    return this.page.locator('select').filter({ has: this.page.locator('option') }).first();
  }

  get editionSignatureNameInput(): Locator {
    return this.page.getByLabel(/signature name/i).first();
  }

  get editionSignatureRoleInput(): Locator {
    return this.page.getByLabel(/signature role/i).first();
  }

  get editionIntroTextarea(): Locator {
    return this.page.getByLabel(/intro|introduction/i).first();
  }

  get editionSaveButton(): Locator {
    return this.page.getByRole('button', { name: /^save|create newsletter/i }).first();
  }

  // --- Common assertions ---

  async assertNoConsoleErrors(): Promise<void> {
    const text = await this.page.textContent('body');
    expect(text).not.toContain('[object Object]');
    expect(text).not.toMatch(/^\s*ReferenceError|TypeError\s*$/i);
  }

  async dismissHelpDrawerIfOpen() {
    const closeBtn = this.helpDrawer.getByRole('button', { name: /close/i });
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }
}
