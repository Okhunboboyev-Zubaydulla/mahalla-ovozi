import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTelegramLibrary,
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER,
} from '../src/adapters/telegram/telegram-library-loader.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const telegramAdaptersDir = path.join(testsDir, '..', 'src', 'adapters', 'telegram');

function readAdapterSource(fileName: string): string {
  return readFileSync(path.join(telegramAdaptersDir, fileName), 'utf8');
}

describe('Ticket 01: One shared Telegram library loader', () => {
  it('resolves the client constructor and the session constructor as one pair', async () => {
    const library = await loadTelegramLibrary<unknown>(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER);

    expect(typeof library.TelegramClient).toBe('function');
    expect(typeof library.StringSession).toBe('function');
  });

  it('surfaces an unavailable library as a plain error naming the specifier', async () => {
    await expect(
      loadTelegramLibrary({
        moduleSpecifier: 'telegram-library-that-is-not-installed',
        sessionModuleSpecifier: 'telegram-library-that-is-not-installed/sessions/index.js',
        eventsModuleSpecifier: 'telegram-library-that-is-not-installed/events',
      }),
    ).rejects.toThrowError(/telegram-library-that-is-not-installed/);
  });

  it('stays free of caller-specific error types and caller-specific logging', () => {
    const source = readFileSync(
      path.join(telegramAdaptersDir, 'telegram-library-loader.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/UserbotAuthError/);
    expect(source).not.toMatch(/utils\/logger/);
    expect(source).not.toMatch(/logger\./);
  });

  it('converges every userbot runtime import site on the shared loader', () => {
    const clientAdapter = readAdapterSource('userbot-client-adapter.ts');
    const authAdapter = readAdapterSource('userbot-auth-client.ts');

    expect(clientAdapter).toMatch(/telegram-library-loader\.js/);
    expect(authAdapter).toMatch(/telegram-library-loader\.js/);

    // No userbot runtime code reaches the MTProto library by any other route.
    expect(clientAdapter).not.toMatch(/await import\(/);
    expect(authAdapter).not.toMatch(/await import\(/);
  });
});
