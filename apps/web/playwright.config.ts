import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node --import tsx/esm src/entrypoints/http.ts',
      cwd: '../backend',
      url: 'http://localhost:3000/api/v1/auth/session',
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi_test',
        PORT: '3000',
        TELEGRAM_API_BASE_URL: process.env.TELEGRAM_API_BASE_URL || 'http://127.0.0.1:3099',
      },
    },
    {
      command: 'pnpm dev --port 5173',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
