import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login.page';

/**
 * The login screen, unauthenticated.
 *
 * The product signs in with an emailed code. These tests had been checking for a password field and
 * forgot-password / sign-up links that were removed when login went passwordless, so they failed on
 * every pull request while the screen itself was fine.
 *
 * The server's code endpoint is stubbed here: this suite runs in CI with no Supabase service key and
 * no mail server, and what is under test is the screen. The real request-and-verify path, against a
 * real database, is `auth-otp.spec.ts`.
 */
test.describe('Login Page', () => {
  let loginPage: LoginPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    await loginPage.goto();
  });

  test('asks for an email and nothing else', async ({ page }) => {
    await expect(loginPage.heading).toBeVisible();
    await expect(loginPage.subtitle).toBeVisible();
    await expect(loginPage.emailInput).toBeVisible();
    await expect(loginPage.sendCodeButton).toBeVisible();
    await expect(page.getByText(/No password needed/)).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /forgot password|sign up/i })).toHaveCount(0);
  });

  test('Google OAuth button is hidden when provider is disabled', async () => {
    // VITE_GOOGLE_OAUTH_ENABLED defaults to "false" until Supabase Google
    // provider is configured (Client ID/Secret + redirect URI). Showing the
    // button before then makes it look broken because Supabase rejects
    // signInWithOAuth with "provider is not enabled". Flip this assertion
    // (and add a setup step that sets the env var) once OAuth is wired up.
    await expect(loginPage.googleButton).toHaveCount(0);
  });

  test('cannot send a code until an email is typed', async () => {
    await expect(loginPage.sendCodeButton).toBeDisabled();
    await loginPage.emailInput.fill('test@example.com');
    await expect(loginPage.sendCodeButton).toBeEnabled();
  });

  test('sends the email and moves to the code step', async ({ page }) => {
    let sent: unknown = null;
    await page.route('**/api/auth/otp/request', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });
    await loginPage.requestCode('test@example.com');

    await expect(loginPage.codeHeading).toBeVisible();
    await expect(page.getByText('We sent a code to test@example.com.')).toBeVisible();
    expect(sent).toEqual({ email: 'test@example.com' });

    // Digits only, six of them, before Sign in is offered.
    await loginPage.codeInput.fill('12ab34');
    await expect(loginPage.codeInput).toHaveValue('1234');
    await expect(loginPage.signInButton).toBeDisabled();
    await loginPage.codeInput.fill('123456');
    await expect(loginPage.signInButton).toBeEnabled();

    await loginPage.differentEmailButton.click();
    await expect(loginPage.emailInput).toBeVisible();
  });

  test('shows the server\'s reason when a code cannot be sent', async ({ page }) => {
    await page.route('**/api/auth/otp/request', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many codes requested. Try again in a minute.' } }),
      }),
    );
    await loginPage.requestCode('test@example.com');
    await expect(loginPage.errorMessage).toHaveText('Too many codes requested. Try again in a minute.');
    await expect(loginPage.emailInput).toBeVisible();
  });
});
