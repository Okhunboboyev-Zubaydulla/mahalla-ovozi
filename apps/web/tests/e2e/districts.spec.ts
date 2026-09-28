import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testUsername = `po_dist_e2e_${Date.now()}`;
const testPassword = 'Secure-District-Password-2026!';

const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));

test.beforeAll(async () => {
  // Create PO account via CLI with password piped via stdin per CLI security rule
  execSync(
    `pnpm --filter @mahalla-ovozi/backend cli:manage-po -- --username "${testUsername}"`,
    {
      input: `${testPassword}\n${testPassword}\n`,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: rootDir,
    }
  );
});

test.describe('Story 1.2: District Management & Context Switching E2E Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as PO before each test
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });

  test('displays persistent console layout with 8 navigation sections in Uzbek Cyrillic', async ({ page }) => {
    const menu = page.locator('.ant-menu');
    await expect(menu.getByText('Умумий кўриниш')).toBeVisible();
    await expect(menu.getByText('Тизим ҳолати')).toBeVisible();
    await expect(menu.getByText('Туманлар')).toBeVisible();
    await expect(menu.getByText('Телеграм созламалари')).toBeVisible();
    await expect(menu.getByText('Обуналар')).toBeVisible();
    await expect(menu.getByText('Ҳоким ҳисоблари')).toBeVisible();
    await expect(menu.getByText('АИ операциялари')).toBeVisible();
    await expect(menu.getByText('Аудит тарихи')).toBeVisible();
  });

  test('creates a new district via drawer, auto-selects it, and verifies table status', async ({ page }) => {
    const districtName = `Юнусобод_${Date.now().toString().slice(-4)}`;
    const regionName = 'Тошкент шаҳри';

    // Navigate to Districts page
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    // Open Create District Drawer
    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();

    // Verify drawer is open
    await expect(page.locator('.ant-drawer-open .ant-drawer-title')).toHaveText('Янги туман қўшиш');

    // Test validation on empty submit
    await page.click('#create-district-submit');
    const errorSummary = page.locator('#create-district-error-summary');
    await expect(errorSummary).toBeVisible();
    await expect(errorSummary).toContainText('Тўлдиришда хатоликлар мавжуд');

    // Fill valid data
    await page.fill('#district-name-input', districtName);
    await page.fill('#district-region-input', regionName);
    await page.click('#create-district-submit');

    // Drawer should close (no open drawer)
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);

    // Verify district appears in table
    const tableRegion = page.locator('div[role="region"][aria-label="Туманлар рўйхати"]');
    await expect(tableRegion).toBeVisible();
    await expect(tableRegion).toContainText(districtName);
    await expect(tableRegion).toContainText(regionName);
    await expect(tableRegion).toContainText('Созлаш тугалланмаган');

    // Verify newly created district is selected in top selector
    const selector = page.locator('.ant-select');
    await expect(selector).toBeVisible();
    await expect(selector).toContainText(districtName);
  });

  test('intercepts drawer close when form is dirty and displays unsaved changes modal', async ({ page }) => {
    // Navigate to Districts page
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    // Open drawer and type draft
    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();
    await page.fill('#district-name-input', 'Қорақомиш');

    // Try closing drawer via Cancel button while form is dirty
    await page.click('.ant-drawer-open button:has-text("Бекор қилиш")');

    // Unsaved changes modal should appear
    const modal = page.locator('.ant-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Сақланмаган ўзгаришлар мавжуд');
    await expect(modal).toContainText('Киритилган маълумотлар сақланмаган');

    // Click Continue Editing -> modal closes, drawer remains open with draft intact
    await page.click('.ant-modal button:has-text("Таҳрирлашни давом эттириш")');
    await expect(modal).not.toBeVisible();
    await expect(page.locator('#district-name-input')).toHaveValue('Қорақомиш');

    // Try closing again and choose Discard
    await page.click('.ant-drawer-open button:has-text("Бекор қилиш")');
    await expect(modal).toBeVisible();
    await page.click('.ant-modal button:has-text("Ўзгаришларни бекор қилиш")');

    // Modal and Drawer close
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
  });
});
