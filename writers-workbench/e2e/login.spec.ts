import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login.page';

test.describe('Login Page', () => {
  let loginPage: LoginPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    await loginPage.goto();
  });

  test('renders all login form fields', async () => {
    await expect(loginPage.heading).toBeVisible();
    await expect(loginPage.subtitle).toBeVisible();
    await expect(loginPage.emailInput).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    await expect(loginPage.signInButton).toBeVisible();
  });

  test('renders Google OAuth button', async () => {
    await expect(loginPage.googleButton).toBeVisible();
  });

  test('renders forgot password and sign up links', async () => {
    await expect(loginPage.forgotPasswordLink).toBeVisible();
    await expect(loginPage.forgotPasswordLink).toHaveAttribute('href', '/forgot-password');
    await expect(loginPage.signUpLink).toBeVisible();
    await expect(loginPage.signUpLink).toHaveAttribute('href', '/signup');
  });

  test('email and password fields accept input', async () => {
    await loginPage.emailInput.fill('test@example.com');
    await loginPage.passwordInput.fill('password123');
    await expect(loginPage.emailInput).toHaveValue('test@example.com');
    await expect(loginPage.passwordInput).toHaveValue('password123');
  });

  test('sign in button shows loading state on submit', async ({ page }) => {
    await loginPage.emailInput.fill('test@example.com');
    await loginPage.passwordInput.fill('password123');
    await loginPage.signInButton.click();
    // Button text changes to "Signing in..." while submitting
    await expect(page.getByRole('button', { name: /signing in/i })).toBeVisible();
  });
});
