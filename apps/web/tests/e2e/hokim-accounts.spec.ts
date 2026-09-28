import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testUsername = `po_hokim_e2e_${Date.now()}`;
const testPassword = 'Secure-Hokim-Password-2026!';
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

test.describe('Story 1.6: Create and Manage the District Hokim Account E2E Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as PO before each test
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });

  test('executes end-to-end Hokim account creation, one-time credential modal, checklist sync, reset, disable, and replace journey (AC 1-17)', async ({
    page,
  }) => {
    const districtName = `HokimE2E_${Date.now().toString().slice(-4)}`;
    const hokimUsername1 = `hokim_e2e_${Date.now().toString().slice(-4)}`;
    const hokimUsername2 = `hokim_rep_${Date.now().toString().slice(-4)}`;

    // 1. Navigate to Districts page and create a new district
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();
    await page.fill('#district-name-input', districtName);
    await page.fill('#district-region-input', 'Тошкент шаҳри');
    await page.click('#create-district-submit');

    // Drawer closes and newly created district is selected
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
    const selector = page.locator('.ant-select');
    await expect(selector).toContainText(districtName);

    // 2. Navigate to Overview to inspect initial checklist (Prerequisite 8 incomplete)
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.getByText('Ҳоким аккаунти', { exact: true })).toBeVisible();

    // 3. Navigate to Hokim Accounts page via menu
    await page.locator('.ant-menu').getByText('Ҳоким ҳисоблари').click();
    await expect(page).toHaveURL(/.*\/hokim-accounts/);

    // 4. Verify NO_ACCOUNT state
    await expect(page.locator('text=Ҳоким аккаунти яратилмаган')).toBeVisible();
    const createHokimBtn = page.getByRole('button', { name: 'Ҳоким аккаунтини яратиш' });
    await expect(createHokimBtn).toBeVisible();

    // 5. Open Create Hokim Modal
    await createHokimBtn.click();
    await expect(page.locator('text=Ҳоким аккаунтини яратиш').first()).toBeVisible();

    // Fill form and submit
    await page.fill('input[id*="username"]', hokimUsername1);
    await page.getByRole('button', { name: 'Аккаунт яратиш' }).click();

    // 6. One-Time Credential Modal appears with temporary password
    await expect(page.locator('text=Диққат! Бир марталик хавфсизлик маълумоти')).toBeVisible();
    await expect(page.locator('.ant-modal').getByText(hokimUsername1, { exact: true })).toBeVisible();
    const tempPasswordElement = page.locator('#temporary-password-display');
    await expect(tempPasswordElement).toBeVisible();
    const temporaryPassword = await tempPasswordElement.textContent();
    expect(temporaryPassword).toBeTruthy();
    expect(temporaryPassword!.length).toBeGreaterThanOrEqual(15);

    // Close One-Time Credential Modal
    await page.getByRole('button', { name: 'Тушундим, ойнани ёпиш' }).click();
    await expect(page.locator('text=Диққат! Бир марталик хавфсизлик маълумоти')).toHaveCount(0);

    // 7. Verify ACTIVE state
    await expect(page.locator(`text=@${hokimUsername1}`)).toBeVisible();
    await expect(page.locator('text=Туман ҳокими')).toBeVisible();
    await expect(page.locator('text=Фаол').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Паролни янгилаш' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Аккаунтни алмаштириш' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Фаолсизлантириш' })).toBeVisible();

    // 8. Verify Overview checklist item is now PASSED (AC 13)
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator(`text=@${hokimUsername1}`)).toBeVisible();

    // 9. Return to Hokim Accounts page and Reset Password (AC 9)
    await page.locator('.ant-menu').getByText('Ҳоким ҳисоблари').click();
    await expect(page).toHaveURL(/.*\/hokim-accounts/);

    await page.getByRole('button', { name: 'Паролни янгилаш' }).click();
    await expect(page.locator('text=Ҳоким аккаунти паролини янгилаш')).toBeVisible();
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Паролни янгилаш' }).click();

    // One-Time Credential Modal appears for new password
    await expect(page.locator('text=Парол муваффақиятли янгиланди')).toBeVisible();
    await page.getByRole('button', { name: 'Тушундим, ойнани ёпиш' }).click();

    // 10. Disable Account (AC 11)
    await page.getByRole('button', { name: 'Фаолсизлантириш' }).click();
    await expect(page.locator('text=Ҳоким аккаунтини фаолсизлантириш')).toBeVisible();
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Фаолсизлантириш' }).click();

    // Verify DISABLED state
    await expect(page.locator('text=Фаолсизлантирилган').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Аккаунтни алмаштириш' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Янги аккаунт яратиш' })).toBeVisible();

    // 11. Replace Account with new username (AC 10)
    await page.getByRole('button', { name: 'Аккаунтни алмаштириш' }).click();
    await expect(page.locator('text=Ҳоким аккаунтини алмаштириш')).toBeVisible();
    await page.fill('input[id*="newUsername"]', hokimUsername2);
    await page.locator('.ant-modal').locator('button[type="submit"]').click();

    // One-Time Credential Modal appears with new credentials
    await expect(page.locator('text=Ҳоким аккаунти муваффақиятли алмаштирилди')).toBeVisible();
    await expect(page.locator('.ant-modal').getByText(hokimUsername2, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Тушундим, ойнани ёпиш' }).click();

    // Verify new ACTIVE state
    await expect(page.locator(`text=@${hokimUsername2}`)).toBeVisible();
    await expect(page.locator('text=Фаол').first()).toBeVisible();
  });
});
