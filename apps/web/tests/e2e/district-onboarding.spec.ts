import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testUsername = `po_onboard_e2e_${Date.now()}`;
const testPassword = 'Secure-Onboarding-Password-2026!';

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

test.describe('Story 1.3: District Onboarding & Activation Readiness E2E Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as PO before each test
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });

  test('executes complete district onboarding readiness and disclosure confirmation journey (AC 1, 2, 5, 7, 8, 12)', async ({
    page,
  }) => {
    const districtName = `Шайхонтоҳур_${Date.now().toString().slice(-4)}`;
    const regionName = 'Тошкент шаҳри';

    // 1. Navigate to Districts page and create a new district
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();
    await page.fill('#district-name-input', districtName);
    await page.fill('#district-region-input', regionName);
    await page.click('#create-district-submit');

    // Drawer closes and newly created district is selected
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
    const selector = page.locator('.ant-select');
    await expect(selector).toContainText(districtName);

    // 2. Navigate to Overview to inspect Onboarding Checklist (AC 1, AC 2)
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    // Verify Checklist title and initial progress (4/8)
    const checklistTitle = page.locator('text=Туманни фаоллаштиришга тайёрлаш');
    await expect(checklistTitle).toBeVisible();

    const progressSummary = page.locator('text=4 / 8 та талаб бажарилди');
    await expect(progressSummary).toBeVisible();

    // Verify initial truthful prerequisite states (AC 2, AC 8)
    await expect(page.getByText('Туман маълумотлари', { exact: true })).toBeVisible();
    await expect(page.getByText('Тизимга кириш ҳуқуқи', { exact: true })).toBeVisible();
    await expect(page.getByText('Асосий таҳлил созламалари', { exact: true })).toBeVisible();
    await expect(page.getByText('Ҳудудий хавфсизлик чегараси', { exact: true })).toBeVisible();

    await expect(page.getByText('Операцион кириш очиқлигини тасдиқлаш', { exact: true })).toBeVisible();
    await expect(page.getByText('Telegram бот уланиши', { exact: true })).toBeVisible();
    await expect(page.getByText('Гуруҳлар ва маҳаллалар харитаси', { exact: true })).toBeVisible();
    await expect(page.getByText('Ҳоким аккаунти', { exact: true })).toBeVisible();

    // Verify activation button is initially disabled (AC 2, AC 7)
    const activateButton = page.locator('#activate-district-button');
    await expect(activateButton).toBeVisible();
    await expect(activateButton).toBeDisabled();

    // 3. Confirm Standing-Access Disclosure (AC 5, AC 6)
    const confirmButton = page.locator('#open-disclosure-modal-button');
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    // Verify Modal opens with required copy
    const modal = page.locator('.ant-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.ant-modal-title')).toHaveText('Операцион кириш очиқлигини тасдиқлаш');
    await expect(modal).toContainText('Хавфсизлик ва аудит талаби');

    // Click confirm in modal
    await page.click('#confirm-disclosure-submit');
    await expect(modal).not.toBeVisible();

    // Verify progress increments to 5/8 (AC 5, AC 12)
    const updatedProgress = page.locator('text=5 / 8 та талаб бажарилди');
    await expect(updatedProgress).toBeVisible();

    // 4. Verify Resumability across Navigation (AC 8, AC 9)
    await page.locator('.ant-menu').getByText('Тизим ҳолати').click();
    await expect(page).toHaveURL(/.*\/system-health/);

    // Return to Overview
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    // Progress and confirmed state are preserved (5/8)
    await expect(page.locator('text=5 / 8 та талаб бажарилди')).toBeVisible();

    // Activation button remains safely disabled because 3 prerequisites remain (AC 7)
    await expect(activateButton).toBeDisabled();
    await expect(
      page.locator('text=Фаоллаштириш учун барча талаблар бажарилиши керак')
    ).toBeVisible();
  });
});
