import { type Page, type Locator, expect } from '@playwright/test';

/**
 * RegressionPage — the shared driver for the FULL UI regression suite (e2e/regression/*.spec.ts).
 *
 * Goal: exercise and ASSERT every page, button, and interactive function in the whole application so
 * the suite elicits UI bugs (blank pages, dead routes, broken lazy-loads, missing/disabled controls,
 * modals that won't open/close). It runs against DEV (no local servers) with the shared auth state.
 *
 * The route inventory below is verified against writers-workbench/client/src/App.tsx and each
 * component (see knowledgebase/.../Engineering/testing/ui-regression/). Every top-level route a signed-in
 * user can reach is listed with a `marker` — a piece of text/heading that MUST appear once the page has
 * rendered — so `assertRenders` proves the page is not blank, not stuck on "Loading…", and not the
 * ErrorBoundary fallback.
 */
export interface RouteSpec {
  path: string;
  /** Human label for the test title. */
  name: string;
  /** A regex that must match visible page text once rendered (heading / landmark / empty-state copy). */
  marker: RegExp;
  /** Feature area (groups the spec files). */
  area: string;
}

export class RegressionPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  /** Every reachable top-level route + a render marker. `:id` routes are covered by dedicated specs. */
  static readonly ROUTES: RouteSpec[] = [
    { area: 'dashboard', path: '/', name: 'Dashboard', marker: /Welcome back|Recent Activity|No content yet/i },
    { area: 'projects', path: '/projects', name: 'Projects', marker: /Projects|No projects yet/i },
    { area: 'library', path: '/library', name: 'Content Library', marker: /Content Library|Title|No content|type/i },
    { area: 'brainstorm', path: '/brainstorm', name: 'Brainstorm', marker: /Brainstorm|Book Concept|Analyze Content/i },
    { area: 'outlines', path: '/outlines', name: 'Outlines', marker: /Outline|No outlines yet/i },
    { area: 'research', path: '/research', name: 'Research', marker: /Research|No research reports yet/i },
    { area: 'story-arcs', path: '/story-arcs', name: 'Story Arcs', marker: /arcs? available|Story Arc|Create Custom Arc|Create Your First Arc/i },
    { area: 'genres', path: '/genres', name: 'Genres', marker: /Genres|New Genre|Public Genres/i },
    { area: 'sources', path: '/sources', name: 'Sources', marker: /Sources?|No sources found|All Types/i },
    { area: 'cost', path: '/cost', name: 'Cost Dashboard', marker: /Cost|Total Cost|No usage data yet/i },
    { area: 'credits', path: '/credits', name: 'Credits', marker: /Credits|Balance|transactions/i },
    { area: 'trash', path: '/trash', name: 'Trash', marker: /Trash|Trash is empty|Restore/i },
    { area: 'settings', path: '/settings', name: 'Settings', marker: /Settings|Display Name|Email Delivery|Appearance/i },
    // Newsletter suite
    { area: 'newsletter', path: '/newsletter', name: 'Newsletter Home', marker: /Newsletter|Generate newsletter|No newsletters yet|active run/i },
    { area: 'newsletter', path: '/newsletter/generate', name: 'Newsletter Generate', marker: /Generate|Edition|Send date|No enabled editions/i },
    { area: 'newsletter', path: '/newsletter/approvals', name: 'Pending Approvals', marker: /approval|Pending|Stage|No .*approval|Back to Newsletter/i },
    { area: 'newsletter', path: '/newsletter/sends', name: 'Scheduled Sends', marker: /Send|Status|No sends|Edition/i },
    { area: 'newsletter', path: '/newsletter/ingestion', name: 'Ingestion', marker: /Ingest|Date|feed|No /i },
    { area: 'newsletter', path: '/newsletter/templates', name: 'Templates', marker: /Template|New template|Edition/i },
    { area: 'newsletter', path: '/newsletter/templates/new', name: 'Template Editor (new)', marker: /Template|HTML|Save|Name/i },
    { area: 'newsletter', path: '/newsletter/editions', name: 'Editions', marker: /newsletter|Edition|New newsletter|Show disabled/i },
    { area: 'newsletter', path: '/newsletter/editions/new', name: 'Edition Editor (new)', marker: /Display name|Newsletter name|Genre|Create newsletter/i },
  ];

  /** Routes that should be UNREACHABLE / access-denied for a normal (non-admin) test user. */
  static readonly GUARDED_ROUTES: { path: string; deniedMarker: RegExp; name: string }[] = [
    { path: '/admin', name: 'Admin', deniedMarker: /do not have admin access|Admin Panel/i },
    { path: '/superuser', name: 'Superuser', deniedMarker: /Superuser access required|Superuser Console/i },
  ];

  async goto(path: string) {
    await this.page.goto(path);
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Navigate to a route and PROVE it rendered: the shell is present, content is not empty, it is not
   * stuck on the Suspense "Loading…" fallback, it is not the ErrorBoundary crash screen, and the
   * route's marker text is visible. Returns nothing; throws (fails the test) on any of those.
   */
  async assertRenders(route: RouteSpec) {
    await this.goto(route.path);
    // Shell chrome present (header or sidebar) — proves auth + AppShell mounted, not a bare /login.
    await this.page.locator('header, aside, nav').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Not the ErrorBoundary fallback.
    await expect(
      this.page.getByText(/Something went wrong|Application error|ChunkLoadError/i),
      `${route.name} (${route.path}) rendered the ErrorBoundary crash screen`,
    ).toHaveCount(0);

    // Content settled past the Suspense "Loading…" gate and is non-empty.
    await expect
      .poll(
        async () => {
          const body = (await this.page.locator('body').innerText().catch(() => '')) ?? '';
          const t = body.trim();
          if (t.length < 3) return 'empty';
          if (/^\s*Loading\.{0,3}\s*$/i.test(t)) return 'loading';
          return 'ready';
        },
        { timeout: 20_000, message: `${route.name} (${route.path}) never rendered content` },
      )
      .toBe('ready');

    // The route's own marker.
    await expect(
      this.page.getByText(route.marker).first(),
      `${route.name} (${route.path}) is missing its render marker ${route.marker}`,
    ).toBeVisible({ timeout: 15_000 });
  }

  main(): Locator {
    return this.page.locator('main');
  }

  // --------------------------------------------------------------------------- shared interactions
  /** Open a modal dialog via a trigger, assert it opened, close it via Escape or a Close/Cancel control. */
  async assertDialogOpensAndCloses(open: () => Promise<void>, dialog: Locator) {
    await open();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Prefer a Cancel/Close button; fall back to Escape.
    const cancel = dialog.getByRole('button', { name: /^(Cancel|Close)$/i }).first();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
}
