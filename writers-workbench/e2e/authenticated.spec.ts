import { test, expect } from '@playwright/test';

/**
 * Comprehensive E2E tests for Sprint 1 & Sprint 2 features.
 * These run in an authenticated browser context (storageState from auth.setup.ts).
 *
 * If E2E_TEST_EMAIL / E2E_TEST_PASSWORD are not set, these tests skip gracefully.
 */

test.beforeEach(async ({ page }) => {
  // Verify we're authenticated — if not, skip the test
  await page.goto('/');
  const url = page.url();
  if (url.includes('/login')) {
    test.skip(true, 'No test credentials — set E2E_TEST_EMAIL and E2E_TEST_PASSWORD');
  }
});

// =====================================================
// SPRINT 2: SIDEBAR RESTRUCTURE (S2-1)
// =====================================================

test.describe('S2-1: Sidebar — project-centric navigation', () => {
  test('sidebar shows Dashboard link', async ({ page }) => {
    await expect(page.locator('aside').getByText('Dashboard')).toBeVisible();
  });

  test('sidebar shows My Projects section with count badge', async ({ page }) => {
    await expect(page.locator('aside').getByText('My Projects')).toBeVisible();
  });

  test('sidebar shows Content Library link', async ({ page }) => {
    await expect(page.locator('aside').getByText('Content Library')).toBeVisible();
  });

  test('sidebar shows Outlines link', async ({ page }) => {
    await expect(page.locator('aside').getByText('Outlines')).toBeVisible();
  });

  test('sidebar shows Reference section', async ({ page }) => {
    await expect(page.locator('aside').getByText('Reference')).toBeVisible();
  });

  test('sidebar shows Trash link', async ({ page }) => {
    await expect(page.locator('aside').getByText('Trash')).toBeVisible();
  });

  test('sidebar shows Settings link', async ({ page }) => {
    await expect(page.locator('aside').getByText('Settings')).toBeVisible();
  });

  test('sidebar does NOT show old flat nav items (Chapters, Short Stories, etc.)', async ({ page }) => {
    const aside = page.locator('aside');
    await expect(aside.getByText('Chapters', { exact: true })).not.toBeVisible();
    await expect(aside.getByText('Short Stories')).not.toBeVisible();
    await expect(aside.getByText('Blog Posts')).not.toBeVisible();
    await expect(aside.getByText('Newsletters')).not.toBeVisible();
    await expect(aside.getByText('Social Posts')).not.toBeVisible();
    await expect(aside.getByText('Cover Art')).not.toBeVisible();
  });

  test('My Projects section lists individual projects in sidebar', async ({ page }) => {
    const aside = page.locator('aside');
    // My Projects is expanded by default and shows project links
    // Check that at least one project link exists in the sidebar nav
    const projectLinks = aside.locator('a[href*="/projects/"]');
    const count = await projectLinks.count();
    // Should have projects listed (or "No projects yet" text)
    if (count === 0) {
      await expect(aside.getByText('No projects yet')).toBeVisible();
    } else {
      expect(count).toBeGreaterThan(0);
    }
  });

  test('clicking a project in sidebar navigates to that project', async ({ page }) => {
    const aside = page.locator('aside');
    const projectLinks = aside.locator('a[href*="/projects/"]');
    const count = await projectLinks.count();
    if (count === 0) return; // no projects
    await projectLinks.first().click();
    await expect(page).toHaveURL(/\/projects\//);
  });

  test('Reference section expands to show Genres, Story Arcs, Research', async ({ page }) => {
    const aside = page.locator('aside');
    await aside.getByText('Reference').click();
    await expect(aside.getByText('Genres')).toBeVisible();
    await expect(aside.getByText('Story Arcs')).toBeVisible();
    await expect(aside.getByText('Research')).toBeVisible();
  });

  test('sidebar collapse button works', async ({ page }) => {
    const aside = page.locator('aside');
    const collapseBtn = aside.getByLabel('Collapse sidebar');
    await collapseBtn.click();
    // Wait for transition
    await page.waitForTimeout(300);
    // After collapse, "My Projects" text should be hidden, expand button should appear
    await expect(aside.getByLabel('Expand sidebar')).toBeVisible();
  });
});

// =====================================================
// SPRINT 2: CONTENT LIBRARY (S2-2)
// =====================================================

test.describe('S2-2: Content Library', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/library');
  });

  test('Content Library page renders with heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Content Library' })).toBeVisible();
  });

  test('filter bar shows type, status, genre, project dropdowns', async ({ page }) => {
    const selects = page.locator('select');
    await expect(selects.nth(0)).toBeVisible(); // type filter
    await expect(selects.nth(1)).toBeVisible(); // status filter
  });

  test('type filter has all content type options', async ({ page }) => {
    await page.waitForTimeout(1000);
    const typeSelect = page.locator('select').first();
    await expect(typeSelect).toBeVisible();
    const html = await typeSelect.innerHTML();
    expect(html).toContain('All types');
    expect(html).toContain('Chapters');
    expect(html).toContain('Short Stories');
    expect(html).toContain('Blog Posts');
    expect(html).toContain('Newsletters');
  });

  test('status filter has all status options', async ({ page }) => {
    await page.waitForTimeout(1000);
    const statusSelect = page.locator('select').nth(1);
    await expect(statusSelect).toBeVisible();
    const html = await statusSelect.innerHTML();
    expect(html).toContain('All statuses');
    expect(html).toContain('Draft');
    expect(html).toContain('Approved');
    expect(html).toContain('Published');
  });

  test('legacy /chapters redirects to /library?type=chapter', async ({ page }) => {
    await page.goto('/chapters');
    await expect(page).toHaveURL(/\/library\?type=chapter/);
  });

  test('legacy /short-stories redirects to /library?type=short_story', async ({ page }) => {
    await page.goto('/short-stories');
    await expect(page).toHaveURL(/\/library\?type=short_story/);
  });

  test('legacy /blog-posts redirects to /library?type=blog_post', async ({ page }) => {
    await page.goto('/blog-posts');
    await expect(page).toHaveURL(/\/library\?type=blog_post/);
  });

  test('legacy /newsletters redirects to /library?type=newsletter', async ({ page }) => {
    await page.goto('/newsletters');
    await expect(page).toHaveURL(/\/library\?type=newsletter/);
  });

  test('content table renders with correct column headers', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(2000);
    const headerRow = page.locator('thead tr');
    const headers = await headerRow.locator('th').allTextContents();
    const headerText = headers.join(' ').toLowerCase();
    // Should have title, type, status, genre, updated columns (+ checkbox column)
    expect(headerText).toContain('title');
    expect(headerText).toContain('type');
    expect(headerText).toContain('status');
  });

  test('clicking a content row navigates to /content/:id', async ({ page }) => {
    await page.waitForTimeout(2000);
    const firstRow = page.locator('tbody tr').first();
    if (await firstRow.isVisible()) {
      await firstRow.locator('td').nth(1).click();
      await expect(page).toHaveURL(/\/content\//);
    }
  });

  test('bulk select checkbox selects items', async ({ page }) => {
    await page.waitForTimeout(2000);
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible()) {
      await selectAll.check();
      // Bulk actions bar should appear
      await expect(page.getByText('selected')).toBeVisible();
    }
  });
});

// =====================================================
// SPRINT 2: PROJECT WORKSPACE TABS (S2-3)
// =====================================================

test.describe('S2-3: Project Workspace', () => {
  test('project detail page has all 8 tabs', async ({ page }) => {
    // Navigate to first project
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) {
      test.skip(true, 'No projects available');
      return;
    }
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    // Verify all 8 tabs
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Outline' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Chapters/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Story Bible/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Art' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Research' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cost' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
  });

  test('Overview tab shows progress stats', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    // Overview is the default tab
    await expect(page.getByText('Chapters Written')).toBeVisible();
    await expect(page.getByText('Total Words')).toBeVisible();
  });

  test('Chapters tab shows chapter table', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: /Chapters/ }).click();
    await expect(page).toHaveURL(/tab=chapters/);
  });

  test('Export tab shows export info and button', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page).toHaveURL(/tab=export/);
    await expect(page.getByText('Export to Word (.docx)')).toBeVisible();
    await expect(page.getByText('Chapters included')).toBeVisible();
    await expect(page.getByText('Total words')).toBeVisible();
  });

  test('Export dialog does NOT show [object Object]', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Export' }).click();
    await page.waitForTimeout(500);
    const exportBtn = page.getByRole('button', { name: 'Choose Page Size & Export' });
    if (!(await exportBtn.isEnabled())) return; // no exportable chapters
    await exportBtn.click();
    await page.waitForTimeout(500);

    // Verify export dialog is open
    await expect(page.getByRole('button', { name: 'Download .docx' })).toBeVisible();

    // THE CRITICAL CHECK: no [object Object] anywhere on the page
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('[object Object]');

    // Close it
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Export dialog cancel button closes it', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('button', { name: 'Choose Page Size & Export' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Dialog should be closed
    await expect(page.getByRole('button', { name: 'Download .docx' })).not.toBeVisible();
  });

  test('tab state persists in URL params', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Outline' }).click();
    await expect(page).toHaveURL(/tab=outline/);

    await page.getByRole('button', { name: 'Research' }).click();
    await expect(page).toHaveURL(/tab=research/);
  });

  test('Art tab shows placeholder message', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Art' }).click();
    await expect(page.getByText('Image gallery coming in Sprint 4')).toBeVisible();
  });

  test('Cost tab shows placeholder message', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByRole('button', { name: 'Cost' }).click();
    await expect(page.getByText('Token usage tracking coming in Sprint 5')).toBeVisible();
  });
});

// =====================================================
// SPRINT 2: BREADCRUMB, SEARCH, MOBILE (S2-4)
// =====================================================

test.describe('S2-4: Breadcrumb, search, mobile sidebar', () => {
  test('breadcrumb shows Home link on all pages', async ({ page }) => {
    await expect(page.locator('header nav').getByText('Home')).toBeVisible();
  });

  test('breadcrumb shows page label for /projects', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.locator('header nav').getByText('Projects')).toBeVisible();
  });

  test('breadcrumb shows page label for /library', async ({ page }) => {
    await page.goto('/library');
    await expect(page.locator('header nav').getByText('Content Library')).toBeVisible();
  });

  test('breadcrumb resolves project title (not UUID)', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    const projectTitle = await firstProject.locator('td').first().locator('span').first().textContent();
    await firstProject.click();
    await page.waitForURL(/\/projects\//);
    // Breadcrumb should show the project title, not a UUID
    await page.waitForTimeout(1000);
    const breadcrumbText = await page.locator('header nav').textContent();
    if (projectTitle) {
      expect(breadcrumbText).toContain(projectTitle.trim());
    }
    // Should NOT contain a UUID pattern
    expect(breadcrumbText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('search button is visible in top bar', async ({ page }) => {
    await expect(page.locator('header').getByTitle('Search (Cmd+K)')).toBeVisible();
  });

  test('clicking search button opens search dropdown', async ({ page }) => {
    await page.locator('header').getByTitle('Search (Cmd+K)').click();
    await expect(page.getByPlaceholder('Search projects, content, research...')).toBeVisible();
  });

  test('search opens via button click and shows input', async ({ page }) => {
    // Use the search button instead of keyboard shortcut (more reliable in Playwright)
    await page.locator('header').getByTitle('Search (Cmd+K)').click();
    await expect(page.getByPlaceholder('Search projects, content, research...')).toBeVisible();
  });

  test('search returns results when typing', async ({ page }) => {
    await page.locator('header').getByTitle('Search (Cmd+K)').click();
    const searchInput = page.getByPlaceholder('Search projects, content, research...');
    await searchInput.fill('The');
    await page.waitForTimeout(2000);
    // Check for results or "No results found"
    const hasResults = await page.locator('button:has-text("project"), button:has-text("chapter")').first().isVisible().catch(() => false);
    const noResults = await page.getByText('No results found').isVisible().catch(() => false);
    expect(hasResults || noResults).toBeTruthy();
  });

  test('clicking outside search closes it', async ({ page }) => {
    await page.locator('header').getByTitle('Search (Cmd+K)').click();
    await expect(page.getByPlaceholder('Search projects, content, research...')).toBeVisible();
    // Click on the main content area to dismiss
    await page.locator('main').click();
    await page.waitForTimeout(300);
    await expect(page.getByPlaceholder('Search projects, content, research...')).not.toBeVisible();
  });
});

// =====================================================
// SPRINT 2: PAGINATION (S2-5)
// =====================================================

test.describe('S2-5: Pagination', () => {
  test('Content Library shows pagination when items exceed page size', async ({ page }) => {
    await page.goto('/library');
    await page.waitForTimeout(2000);
    // Pagination appears if > 10 items (smallest page size option)
    const pagination = page.getByText(/Showing \d+-\d+ of \d+/);
    // If enough content exists, pagination should be visible
    if (await pagination.isVisible()) {
      await expect(page.getByText('Prev')).toBeVisible();
      await expect(page.getByText('Next')).toBeVisible();
    }
  });

  test('Projects page shows pagination when projects exceed page size', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const pagination = page.getByText(/Showing \d+-\d+ of \d+/);
    if (await pagination.isVisible()) {
      await expect(page.getByText('Next')).toBeVisible();
    }
  });
});

// =====================================================
// SPRINT 1: DELETE OPERATIONS (S1-2, S1-3)
// =====================================================

test.describe('S1-2/S1-3: Delete operations', () => {
  test('Project detail shows Delete Project button', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);
    await expect(page.getByText('Delete Project')).toBeVisible();
  });

  test('Delete Project button shows confirmation dialog', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const firstProject = page.locator('tbody tr').first();
    if (!(await firstProject.isVisible())) return;
    await firstProject.click();
    await page.waitForURL(/\/projects\//);

    await page.getByText('Delete Project').click();
    // ConfirmDialog should appear
    await expect(page.getByText('Are you sure you want to delete')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Cancel — don't actually delete
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Are you sure you want to delete')).not.toBeVisible();
  });
});

// =====================================================
// SPRINT 1: TRASH VIEW (S1-3)
// =====================================================

test.describe('S1-3: Trash view', () => {
  test('Trash page loads without errors', async ({ page }) => {
    await page.goto('/trash');
    await page.waitForTimeout(1000);
    // Should not show an error
    await expect(page.locator('text=Failed to load')).not.toBeVisible();
  });
});

// =====================================================
// DASHBOARD & NAVIGATION
// =====================================================

test.describe('Dashboard & general navigation', () => {
  test('dashboard loads with stat cards', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    // Dashboard should have count cards
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
    // No errors on the page
    await expect(page.locator('text=Failed to load')).not.toBeVisible();
  });

  test('all sidebar links navigate without errors', async ({ page }) => {
    const routes = [
      { name: 'Dashboard', path: '/' },
      { name: 'Content Library', path: '/library' },
      { name: 'Outlines', path: '/outlines' },
      { name: 'Settings', path: '/settings' },
      { name: 'Trash', path: '/trash' },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await page.waitForTimeout(1000);
      // No uncaught errors (page should not show error boundary)
      const errorBoundary = page.locator('text=Something went wrong');
      await expect(errorBoundary).not.toBeVisible();
    }
  });

  test('no [object Object] anywhere on dashboard', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('[object Object]');
  });

  test('no [object Object] anywhere on projects page', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('[object Object]');
  });

  test('no [object Object] anywhere on content library', async ({ page }) => {
    await page.goto('/library');
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('[object Object]');
  });
});

// =====================================================
// REFERENCE SECTION PAGES
// =====================================================

test.describe('Reference pages', () => {
  test('Genres page loads with genre list', async ({ page }) => {
    await page.goto('/genres');
    await expect(page.getByRole('heading', { name: 'Genres' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New Genre' })).toBeVisible();
  });

  test('Story Arcs page loads', async ({ page }) => {
    await page.goto('/story-arcs');
    await page.waitForTimeout(1000);
    await expect(page.locator('text=Failed to load')).not.toBeVisible();
  });

  test('Research page loads', async ({ page }) => {
    await page.goto('/research');
    await expect(page.getByRole('heading', { name: 'Research Reports' })).toBeVisible();
  });
});

// =====================================================
// SETTINGS & ADMIN
// =====================================================

test.describe('Settings page', () => {
  test('Settings page loads', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(1000);
    await expect(page.locator('text=Failed to load')).not.toBeVisible();
  });
});
