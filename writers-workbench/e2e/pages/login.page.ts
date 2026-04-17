import { type Page, type Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly subtitle: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly googleButton: Locator;
  readonly forgotPasswordLink: Locator;
  readonly signUpLink: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'The Writers Workbench' });
    this.subtitle = page.getByText('Sign in to your account');
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Password');
    this.signInButton = page.getByRole('button', { name: /sign in/i });
    this.googleButton = page.getByRole('button', { name: /continue with google/i });
    this.forgotPasswordLink = page.getByRole('link', { name: /forgot password/i });
    this.signUpLink = page.getByRole('link', { name: /sign up/i });
    this.errorMessage = page.locator('.text-red-600, .text-red-400');
  }

  async goto() {
    await this.page.goto('/login');
    // Wait for Supabase auth to resolve — LoginPage returns null while loading
    await this.heading.waitFor({ state: 'visible', timeout: 15_000 });
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }
}
