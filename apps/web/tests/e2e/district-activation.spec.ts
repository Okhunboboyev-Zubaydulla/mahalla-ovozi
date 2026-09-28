import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const testUsername = `po_act_e2e_${Date.now()}`;
const testPassword = 'Secure-Activation-Password-2026!';
const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));

const testBotId = (750000000 + Math.floor(Math.random() * 100000)).toString();
const validToken = `${testBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_ActValid1`;
const testChatId = `-100${Date.now().toString().slice(-10)}`;

let mockTelegramServer: http.Server | null = null;

test.beforeAll(async () => {
  // 1. Spin up mock Telegram API server on port 3099
  mockTelegramServer = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes(validToken) || url.includes(testBotId)) {
      if (url.includes('/getMe')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(testBotId),
              is_bot: true,
              first_name: 'Activation Mahalla Bot',
              username: 'act_mahalla_bot',
              can_read_all_group_messages: true,
            },
          }),
        );
        return;
      }

      if (url.includes('/getChatMember')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              status: 'member',
              user: {
                id: Number(testBotId),
                is_bot: true,
                first_name: 'Activation Mahalla Bot',
              },
            },
          }),
        );
        return;
      }

      if (url.includes('/getChat')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(testChatId),
              title: 'Фаоллаштириш маҳалла гуруҳи',
              type: 'supergroup',
            },
          }),
        );
        return;
      }
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error_code: 401,
        description: 'Unauthorized: invalid bot token',
      }),
    );
  });

  mockTelegramServer.listen(3099);

  // 2. Create PO account via CLI with password piped via stdin per CLI security rule
  execSync(
    `pnpm --filter @mahalla-ovozi/backend cli:manage-po -- --username "${testUsername}"`,
    {
      input: `${testPassword}\n${testPassword}\n`,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: rootDir,
    },
  );
});

test.afterAll(async () => {
  if (mockTelegramServer) {
    mockTelegramServer.close();
  }
});

test.describe('Story 1.7: Validate and Activate a District & Hokim First Sign-In E2E Journeys', () => {
  test('executes complete district activation journey, prerequisite gating, and Hokim first sign-in password replacement (AC 1-18)', async ({
    page,
  }) => {
    const districtName = `Сергели_${Date.now().toString().slice(-4)}`;
    const hokimUsername = `hokim_sergeli_${Date.now().toString().slice(-4)}`;
    const newPermanentPassword = 'MyPermanentHokimPassword2026!';

    // ==========================================
    // STEP 1: Authenticate as Product Owner
    // ==========================================
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');

    // ==========================================
    // STEP 2: Create a new District
    // ==========================================
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();
    await page.fill('#district-name-input', districtName);
    await page.fill('#district-region-input', 'Тошкент шаҳри');
    await page.click('#create-district-submit');

    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
    const selector = page.locator('.ant-select');
    await expect(selector).toContainText(districtName);

    // ==========================================
    // STEP 3: Verify Initial Checklist & Disabled Activation CTA (AC 2, 7)
    // ==========================================
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    await expect(page.locator('text=Туманни фаоллаштиришга тайёрлаш')).toBeVisible();
    await expect(page.locator('text=4 / 8 та талаб бажарилди')).toBeVisible();

    const activateBtn = page.locator('#activate-district-button');
    await expect(activateBtn).toBeVisible();
    await expect(activateBtn).toBeDisabled();

    // ==========================================
    // STEP 4: Prerequisite 5: Standing-Access Disclosure Confirmation (AC 5)
    // ==========================================
    const confirmDisclosureBtn = page.locator('#open-disclosure-modal-button');
    await confirmDisclosureBtn.click();
    await page.click('#confirm-disclosure-submit');
    await expect(page.locator('.ant-modal')).not.toBeVisible();
    await expect(page.locator('text=5 / 8 та талаб бажарилди')).toBeVisible();

    // ==========================================
    // STEP 5: Prerequisite 6: Connect Telegram Bot (AC 6)
    // ==========================================
    await page.locator('.ant-menu').getByText('Telegram бот').click();
    await expect(page).toHaveURL(/.*\/telegram-setup/);
    await page.fill('#telegram-token-input', validToken);
    await page.click('#connect-bot-button');
    await expect(page.locator('text=Уланган / Фаол')).toBeVisible();

    // ==========================================
    // STEP 6: Prerequisite 7: Map Telegram Group to Mahalla (AC 6)
    // ==========================================
    await page.locator('.ant-menu').getByText('Гуруҳлар харитаси').click();
    await expect(page).toHaveURL(/.*\/subscriptions/);

    const openAddGroupBtn = page.locator('#open-add-group-drawer-button, #empty-add-group-button').first();
    await openAddGroupBtn.click();
    await page.fill('#chat-id-input', testChatId);
    await page.fill('#mahalla-name-input', 'Янги Сергели маҳалласи');
    await page.click('#submit-group-mapping-button');
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);

    // ==========================================
    // STEP 7: Prerequisite 8: Create Hokim Account (AC 6)
    // ==========================================
    await page.locator('.ant-menu').getByText('Ҳоким ҳисоблари').click();
    await expect(page).toHaveURL(/.*\/hokim-accounts/);

    const createHokimBtn = page.locator('#create-hokim-account-button, #empty-create-hokim-button').first();
    await createHokimBtn.click();
    await page.fill('#hokim-username-input', hokimUsername);
    await page.click('#create-hokim-submit');

    // Copy temporary password from modal
    const tempPasswordLocator = page.locator('#one-time-password-value');
    await expect(tempPasswordLocator).toBeVisible();
    const tempPassword = (await tempPasswordLocator.innerText()).trim();
    expect(tempPassword.length).toBeGreaterThanOrEqual(15);

    // Close one-time credentials modal
    await page.click('#dismiss-one-time-password-modal');
    await expect(page.locator('.ant-modal')).not.toBeVisible();

    // ==========================================
    // STEP 8: Return to Overview -> All 8 Prerequisites Complete (AC 1, 2)
    // ==========================================
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    await expect(page.locator('text=8 / 8 та талаб бажарилди')).toBeVisible();
    await expect(page.locator('text=Барча талаблар бажарилди! Туманни фаоллаштириш мумкин.')).toBeVisible();
    await expect(activateBtn).toBeEnabled();

    // ==========================================
    // STEP 9: Attempt Hokim Login Before District Activation -> 403 Forbidden (AC 9)
    // ==========================================
    // Navigate to sign-in page to test unactivated login attempt
    await page.goto('/sign-in');
    await page.fill('#username-input', hokimUsername);
    await page.fill('#password-input', tempPassword);
    await page.click('#submit-button');

    // Should receive error alerting that district is not active
    await expect(page.locator('.ant-alert-error')).toBeVisible();
    await expect(page.locator('.ant-alert-error')).toContainText('фаоллаштирилмаган');

    // ==========================================
    // STEP 10: Log back in as PO and Activate District (AC 7, 8, 16)
    // ==========================================
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');

    // Click activation CTA
    await page.click('#activate-district-button');

    // Activation confirmation modal appears
    const activationModal = page.locator('.ant-modal');
    await expect(activationModal).toBeVisible();
    await expect(activationModal.locator('.ant-modal-title')).toHaveText('Туманни фаоллаштиришни тасдиқлаш');
    await expect(activationModal).toContainText('Тайёрлик талаблари текширилди');

    // Submit activation
    await page.click('#activate-district-submit');

    // Modal closes and active banner is displayed
    await expect(activationModal).not.toBeVisible();
    await expect(page.locator('text=Туман расман фаоллаштирилган')).toBeVisible();
    await expect(page.locator('text=✓ Туман аллақачон фаоллаштирилган')).toBeVisible();
    await expect(page.locator('#activate-district-button')).toHaveCount(0);

    // Verify status tag in Districts page is "Фаол" (AC 8, 17)
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);
    await expect(page.locator('.ant-tag-success').filter({ hasText: 'Фаол' })).toBeVisible();

    // ==========================================
    // STEP 11: Hokim First Sign-In & Password Replacement (AC 10, 11, 12, 13)
    // ==========================================
    // Sign out PO by navigating to /sign-in
    await page.goto('/sign-in');

    // Sign in as Hokim with temporary password
    await page.fill('#username-input', hokimUsername);
    await page.fill('#password-input', tempPassword);
    await page.click('#submit-button');

    // Intercepted by ProtectedRoute and redirected to /first-login-password-change
    await expect(page).toHaveURL(/.*\/first-login-password-change/);

    // Verify mandatory informational notice is present (zero consent checkboxes)
    await expect(page.locator('text=Паролни янгилаш')).toBeVisible();
    await expect(page.locator('text=Операцион кириш ва мониторинг тўғрисида огоҳлантириш')).toBeVisible();
    expect(await page.locator('input[type="checkbox"]').count()).toBe(0);

    // Fill password replacement form
    await page.fill('#current-password-input', tempPassword);
    await page.fill('#new-password-input', newPermanentPassword);
    await page.fill('#confirm-password-input', newPermanentPassword);
    await page.click('#change-password-submit-button');

    // Land on dashboard / overview page
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();

    // ==========================================
    // STEP 12: Verify Permanent Password Persists for Future Sign-Ins (AC 13)
    // ==========================================
    await page.goto('/sign-in');
    await page.fill('#username-input', hokimUsername);
    await page.fill('#password-input', newPermanentPassword);
    await page.click('#submit-button');

    // Direct entry to dashboard without password change prompt
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });
});
