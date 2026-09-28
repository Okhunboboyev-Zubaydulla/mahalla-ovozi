import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testUsername = `po_e2e_${Date.now()}`;
const testPassword = 'Secure-E2E-Password-2026!';

const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));

test.beforeAll(async () => {
  // F7 & CLI Security: Pipe password through stdin to prevent command-line exposure
  execSync(
    `pnpm --filter @mahalla-ovozi/backend cli:manage-po -- --username "${testUsername}"`,
    {
      input: `${testPassword}\n${testPassword}\n`,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: rootDir,
    }
  );
});

test.describe('Story 1.1: Product Owner Sign-In E2E Journeys', () => {
  test('unauthenticated visitor navigating to protected route is redirected to /sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/.*\/sign-in/);
    await expect(page.locator('h2')).toHaveText('Тизимга кириш');
  });

  test('sign-in with invalid credentials displays generic Uzbek Cyrillic error', async ({ page }) => {
    await page.goto('/sign-in');

    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', 'WrongPassword12345!');
    await page.click('#submit-button');

    const errorAlert = page.locator('[role="alert"]');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toHaveText(/Нотўғри фойдаланувчи номи ёки парол\./);
    await expect(page).toHaveURL(/.*\/sign-in/);
  });

  test('sign-in with valid credentials navigates to protected landing and sign-out revokes session', async ({ page }) => {
    await page.goto('/sign-in');

    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');

    // Land on protected page
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Масъул ходим бошқарув панели')).toBeVisible();
    await expect(page.locator(`text=${testUsername}`).first()).toBeVisible();

    // Click Sign Out
    await page.click('#sign-out-button');
    await expect(page).toHaveURL(/.*\/sign-in/);

    // Try navigating back to /
    await page.goto('/');
    await expect(page).toHaveURL(/.*\/sign-in/);
  });

  test('supports full keyboard navigation (Tab & Enter)', async ({ page }) => {
    await page.goto('/sign-in');

    // Focus and fill via keyboard
    await page.focus('#username-input');
    await page.keyboard.type(testUsername);
    await page.keyboard.press('Tab');
    await page.keyboard.type(testPassword);
    await page.keyboard.press('Enter');

    // Should successfully log in and reach landing
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Масъул ходим бошқарув панели')).toBeVisible();
  });

  test('displays network uncertainty message when server connection is aborted', async ({ page }) => {
    await page.goto('/sign-in');

    // Abort API requests to simulate network disruption
    await page.route('**/api/v1/auth/sign-in', (route) => route.abort('failed'));

    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');

    const warningAlert = page.locator('[role="alert"]');
    await expect(warningAlert).toBeVisible();
    await expect(warningAlert).toHaveText(/Сервер билан алоқа мавжуд эмас\. Тармоқни текширинг\./);
  });
});
