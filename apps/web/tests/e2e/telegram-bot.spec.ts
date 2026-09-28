import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const testUsername = `po_tg_e2e_${Date.now()}`;
const testPassword = 'Secure-Telegram-Password-2026!';
const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));

const validBotId = (600000000 + Math.floor(Math.random() * 100000)).toString();
const validToken = `${validBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1`;
const replaceBotId = (900000000 + Math.floor(Math.random() * 100000)).toString();
const replaceToken = `${replaceBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_Replacement1`;

let mockTelegramServer: http.Server | null = null;

test.beforeAll(async () => {
  // 1. Spin up mock Telegram API server on port 3099
  mockTelegramServer = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes(validToken)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            id: Number(validBotId),
            is_bot: true,
            first_name: 'Chilonzor Mahalla Bot',
            username: 'chilonzor_mahalla_bot',
          },
        }),
      );
      return;
    }

    if (url.includes(replaceToken)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            id: Number(replaceBotId),
            is_bot: true,
            first_name: 'New Chilonzor Bot',
            username: 'new_chilonzor_bot',
          },
        }),
      );
      return;
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

  await new Promise<void>((resolve) => {
    mockTelegramServer?.listen(3099, '127.0.0.1', () => {
      resolve();
    });
  });

  // 2. Create PO account via CLI with password piped via stdin per CLI security rule
  execSync(
    `pnpm --filter @mahalla-ovozi/backend cli:manage-po -- --username "${testUsername}"`,
    {
      input: `${testPassword}\n${testPassword}\n`,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: rootDir,
    }
  );
});

test.afterAll(async () => {
  if (mockTelegramServer) {
    await new Promise<void>((resolve) => {
      mockTelegramServer?.close(() => resolve());
    });
  }
});

test.describe('Story 1.4: Telegram Bot Connection & Validation E2E Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as PO before each test
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });

  test('executes end-to-end bot connection, validation, checklist sync, replace, and disconnect journey (AC 1, 2, 7, 8, 9, 11, 14, 15)', async ({
    page,
  }) => {
    const districtName = `Чилонзор_ТГ_${Date.now().toString().slice(-4)}`;
    const regionName = 'Тошкент шаҳри';

    // 1. Create a new district
    await page.locator('.ant-menu').getByText('Туманлар').click();
    await expect(page).toHaveURL(/.*\/districts/);

    const createBtn = page.locator('#create-district-button, #empty-create-district-button').first();
    await createBtn.click();
    await page.fill('#district-name-input', districtName);
    await page.fill('#district-region-input', regionName);
    await page.click('#create-district-submit');

    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
    const selector = page.locator('.ant-select');
    await expect(selector).toContainText(districtName);

    // 2. Navigate to Overview to inspect Onboarding Checklist
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    // Check that Telegram Bot prerequisite is initially incomplete with action button
    const tgActionBtn = page.locator('#action-button-telegram_bot');
    await expect(tgActionBtn).toBeVisible();
    await expect(tgActionBtn).toHaveText('Созлаш');

    // 3. Click "Созлаш" on Telegram bot prerequisite to navigate to /telegram-setup
    await tgActionBtn.click();
    await expect(page).toHaveURL(/.*\/telegram-setup/);

    // Verify Not Configured state rendered
    await expect(page.locator('text=Telegram ботни улаш')).toBeVisible();
    await expect(page.locator('text=Бот токенини киритиш бўйича кўрсатма')).toBeVisible();

    // 4. Test Token Input and Connect valid bot
    const tokenInput = page.locator('input[placeholder="123456789:AAF..."]');
    await tokenInput.fill(validToken);

    const submitBtn = page.getByRole('button', { name: 'Ботни текшириш ва улаш' });
    await submitBtn.click();

    // 5. Verify Connected / Valid State
    await expect(page.locator('text=Бириктирилган Telegram бот')).toBeVisible();
    await expect(page.locator('text=ФАОЛ / УЛАНГАН')).toBeVisible();
    await expect(page.locator('text=Chilonzor Mahalla Bot')).toBeVisible();
    await expect(page.locator('text=@chilonzor_mahalla_bot')).toBeVisible();
    await expect(page.locator(`text=${validBotId}:••••••••••••`)).toBeVisible();
    await expect(page.locator('text=AES-256-GCM билан ҳимояланган')).toBeVisible();
    await expect(page.locator('text=Пассив қабул режими')).toBeVisible();

    // 6. Navigate back to Overview to verify Checklist status transition
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    // Prerequisite 6 should now be marked "Бажарилди" and action button gone
    await expect(page.locator('#action-button-telegram_bot')).toHaveCount(0);
    const tgChecklistItem = page.locator('.ant-list-item').filter({ hasText: 'Telegram бот уланиши' });
    await expect(tgChecklistItem.locator('text=Бажарилди')).toBeVisible();

    // 7. Navigate back to Telegram Settings via sidebar menu
    await page.locator('.ant-menu').getByText('Телеграм созламалари').click();
    await expect(page).toHaveURL(/.*\/telegram-setup/);
    await expect(page.locator('text=Бириктирилган Telegram бот')).toBeVisible();

    // 8. Test Replace Bot Modal
    const replaceBtn = page.getByRole('button', { name: 'Ботни алмаштириш' });
    await replaceBtn.click();

    const replaceModal = page.locator('.ant-modal');
    await expect(replaceModal).toBeVisible();
    await expect(replaceModal.locator('.ant-modal-title')).toContainText('Telegram ботни алмаштириш');

    const modalInput = replaceModal.locator('input[placeholder="123456789:AAF..."]');
    await modalInput.fill(replaceToken);

    const confirmReplaceBtn = replaceModal.getByRole('button', { name: 'Алмаштиришни тасдиқлаш' });
    await confirmReplaceBtn.click();

    await expect(replaceModal).not.toBeVisible();
    await expect(page.locator('text=New Chilonzor Bot')).toBeVisible();
    await expect(page.locator('text=@new_chilonzor_bot')).toBeVisible();

    // 9. Test Disconnect Bot Modal
    const disconnectBtn = page.getByRole('button', { name: 'Ботни узиш' });
    await disconnectBtn.click();

    const disconnectModal = page.locator('.ant-modal');
    await expect(disconnectModal).toBeVisible();
    await expect(disconnectModal.locator('.ant-modal-title')).toContainText('Telegram ботни узишни тасдиқланг');

    const confirmDisconnectBtn = disconnectModal.getByRole('button', { name: 'Ҳа, ботни узиш' });
    await confirmDisconnectBtn.click();

    await expect(disconnectModal).not.toBeVisible();
    await expect(page.locator('text=Telegram ботни улаш')).toBeVisible();

    // 10. Verify Checklist Rollback in Overview
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');

    await expect(page.locator('#action-button-telegram_bot')).toBeVisible();
    const tgChecklistItemAfterDisconnect = page.locator('.ant-list-item').filter({ hasText: 'Telegram бот уланиши' });
    await expect(tgChecklistItemAfterDisconnect.locator('text=Тугалланмаган')).toBeVisible();
  });
});
