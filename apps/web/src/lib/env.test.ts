import { describe, it, expect, afterEach, vi } from 'vitest';
import { createEnvConfig, envConfig } from './env';

describe('env config resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults VITE_API_BASE_URL to the empty (same-origin) string', () => {
    expect(createEnvConfig({}).apiBaseUrl).toBe('');
    expect(createEnvConfig({ VITE_API_BASE_URL: '' }).apiBaseUrl).toBe('');
    expect(createEnvConfig({ VITE_API_BASE_URL: '   ' }).apiBaseUrl).toBe('');
  });

  it('keeps the default URL byte-identical to today\u2019s relative path', () => {
    expect(`${envConfig.apiBaseUrl}/api/v1/health/system`).toBe('/api/v1/health/system');
  });

  it('normalises trailing slashes away', () => {
    expect(createEnvConfig({ VITE_API_BASE_URL: 'https://api.example.com/' }).apiBaseUrl).toBe(
      'https://api.example.com',
    );
    expect(
      createEnvConfig({ VITE_API_BASE_URL: ' https://api.example.com/v1/// ' }).apiBaseUrl,
    ).toBe('https://api.example.com/v1');
  });

  it('reports an absurd value with a clear error instead of failing obscurely', () => {
    expect(() => createEnvConfig({ VITE_API_BASE_URL: 'ftp://api.example.com' })).toThrow(
      /VITE_API_BASE_URL/,
    );
    expect(() => createEnvConfig({ VITE_API_BASE_URL: 'not a url' })).toThrow(/VITE_API_BASE_URL/);
  });

  it('falls back to MODE for appEnv and imports cleanly with env unset', async () => {
    expect(createEnvConfig({ MODE: 'production' }).appEnv).toBe('production');
    // An explicitly blank VITE_APP_ENV is treated as "not set" and falls back to 'development'.
    expect(createEnvConfig({ VITE_APP_ENV: '', MODE: 'test' }).appEnv).toBe('development');

    vi.stubEnv('VITE_API_BASE_URL', '');
    const reloaded = await import('./env');
    expect(reloaded.envConfig.apiBaseUrl).toBe('');
  });
});
