import { type Page, type Locator } from '@playwright/test';

/**
 * The passwordless login screen: an email, then a 6-digit code. There is no password field and no
 * separate sign-up or forgot-password page; one form serves new and returning users.
 */
export class LoginPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly subtitle: Locator;
  readonly emailInput: Locator;
  readonly sendCodeButton: Locator;
  readonly codeHeading: Locator;
  readonly codeInput: Locator;
  readonly signInButton: Locator;
  readonly differentEmailButton: Locator;
  readonly googleButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'The Writers Workbench' });
    this.subtitle = page.getByText('Sign in with your email');
    this.emailInput = page.getByLabel('Email');
    this.sendCodeButton = page.getByRole('button', { name: /email me a code/i });
    this.codeHeading = page.getByText('Enter the code we emailed you');
    this.codeInput = page.getByLabel('6-digit code');
    this.signInButton = page.getByRole('button', { name: /^sign in$/i });
    this.differentEmailButton = page.getByRole('button', { name: /use a different email/i });
    this.googleButton = page.getByRole('button', { name: /continue with google/i });
    this.errorMessage = page.locator('.text-red-600, .text-red-400');
  }

  async goto() {
    await this.page.goto('/login');
    // Wait for Supabase auth to resolve — LoginPage returns null while loading
    await this.heading.waitFor({ state: 'visible', timeout: 15_000 });
  }

  async requestCode(email: string) {
    await this.emailInput.fill(email);
    await this.sendCodeButton.click();
  }
}
