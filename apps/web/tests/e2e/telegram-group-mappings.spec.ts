import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const testUsername = `po_group_e2e_${Date.now()}`;
const testPassword = 'Secure-TelegramGroup-Password-2026!';
const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));

const testBotId = (800000000 + Math.floor(Math.random() * 100000)).toString();
const validToken = `${testBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_GroupValid1`;
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
              first_name: 'Yunusobod Mahalla Bot',
              username: 'yunusobod_mahalla_bot',
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
                first_name: 'Yunusobod Mahalla Bot',
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
              title: 'Навбаҳор маҳалла гуруҳи',
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

  await new Promise<void>((resolve) => {
    mockTelegramServer?.listen(3099, '127.0.0.1', () => {
      resolve();
    });
  });

  // 2. Create PO account via CLI
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
    await new Promise<void>((resolve) => {
      mockTelegramServer?.close(() => resolve());
    });
  }
});

test.describe('Story 1.5: Telegram Group-to-Mahalla Mappings E2E Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as PO before each test
    await page.goto('/sign-in');
    await page.fill('#username-input', testUsername);
    await page.fill('#password-input', testPassword);
    await page.click('#submit-button');
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Маҳалла Овози')).toBeVisible();
  });

  test('executes end-to-end group mapping, live test message validation, and checklist sync (AC 1, 2, 6, 7, 10, 12, 14, 15)', async ({
    page,
  }) => {
    const districtName = `Юнусобод_Гуруҳ_${Date.now().toString().slice(-4)}`;
    const regionName = 'Тошкент шаҳри';

    // 1. Create a new district via Districts page
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

    // 2. Navigate to Telegram Setup
    await page.locator('.ant-menu').getByText('Телеграм созламалари').click();
    await expect(page).toHaveURL(/.*\/telegram-setup/);
    await expect(page.locator('h2:has-text("Telegram бот созламалари")')).toBeVisible();

    // 3. Connect bot
    const tokenInput = page.locator('input[placeholder="123456789:AAF..."]');
    await tokenInput.fill(validToken);
    await page.getByRole('button', { name: 'Ботни текшириш ва улаш' }).click();

    // 4. Verify Bot is connected and Mappings Table is displayed
    await expect(page.locator('text=ФАОЛ / УЛАНГАН')).toBeVisible();
    await expect(page.locator('text=Маҳаллалар ва Telegram гуруҳлари харитаси')).toBeVisible();

    // 5. Click "Янги гуруҳ қўшиш"
    await page.getByRole('button', { name: 'Янги гуруҳ қўшиш' }).click();
    await expect(page.getByTestId('telegram-group-drawer')).toBeVisible();

    // 6. Fill Mahalla Name and Chat ID
    await page.fill('input[placeholder="Масалан: Навбаҳор"]', 'Навбаҳор');
    await page.fill('input[placeholder="Масалан: -1001234567890"]', testChatId);
    await page.getByRole('button', { name: 'Текшириш ва бириктириш' }).click();

    // 7. Verify drawer automatically closes upon successful Telegram validation without countdown or simulation
    await expect(page.getByTestId('telegram-group-drawer')).not.toBeVisible();

    // 10. Verify Mappings Table has the valid Mahalla mapping
    await expect(page.getByText('Навбаҳор', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-tag:has-text("ТАСДИҚЛАНГАН")')).toBeVisible();

    // 11. Navigate back to District Overview (Readiness checklist)
    await page.locator('.ant-menu').getByText('Умумий кўриниш').click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.locator('text=Туманни фаоллаштиришга тайёрлаш')).toBeVisible();

    // Verify Prerequisite 7 (Гуруҳлар ва маҳаллалар харитаси) status is now passed
    const groupMappingPrereq = page.locator('.ant-list-item').filter({ hasText: 'Гуруҳлар ва маҳаллалар харитаси' });
    await expect(groupMappingPrereq).toBeVisible();
    await expect(groupMappingPrereq.locator('text=Бажарилди')).toBeVisible();
    await expect(groupMappingPrereq.locator('text=1 та маҳалла Telegram гуруҳи муваффақиятли бириктирилди')).toBeVisible();
  });
});
