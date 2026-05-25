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

  async gotoHome() {
    await this.page.goto('/newsletter');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoEditions() {
    await this.page.goto('/newsletter/editions');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoNewEdition() {
    await this.page.goto('/newsletter/editions/new');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoEdition(id: string) {
    await this.page.goto(`/newsletter/editions/${id}`);
    await this.page.waitForLoadState('networkidle');
  }

  async gotoFeeds(editionId: string) {
    await this.page.goto(`/newsletter/editions/${editionId}/feeds`);
    await this.page.waitForLoadState('networkidle');
  }

  async gotoSetupWizard(editionId: string) {
    await this.page.goto(`/newsletter/editions/${editionId}/setup`);
    await this.page.waitForLoadState('networkidle');
  }

  async gotoGenerate() {
    await this.page.goto('/newsletter/generate');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoApprovals() {
    await this.page.goto('/newsletter/approvals');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoSends() {
    await this.page.goto('/newsletter/sends');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoIngestion() {
    await this.page.goto('/newsletter/ingestion');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoTemplates() {
    await this.page.goto('/newsletter/templates');
    await this.page.waitForLoadState('networkidle');
  }

  async gotoNewTemplate() {
    await this.page.goto('/newsletter/templates/new');
    await this.page.waitForLoadState('networkidle');
  }

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
    // HelpButton renders an icon-only button with aria-label "Help".
    return this.page.getByRole('button', { name: /help/i }).first();
  }

  get helpDrawer(): Locator {
    // Right-side drawer renders as an aside or div with role="dialog".
    return this.page.locator('[role="dialog"], aside[aria-modal="true"]').filter({
      has: this.page.getByRole('button', { name: /close/i }),
    });
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
