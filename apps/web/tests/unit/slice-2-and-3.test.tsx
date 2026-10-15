import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { authClient } from '../../src/auth/auth-client.js';
import { App } from '../../src/App.js';
import { formatTashkentDateTime } from '../../src/lib/formatters.js';
import { ListSignalsQuerySchema } from '@mahalla-ovozi/api-contracts';
import { ConsoleLayout } from '../../src/components/ConsoleLayout.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeAll(() => {
  setupMatchMedia();
});

describe('Slice 2 & Slice 3 Verification Tests', () => {
  describe('S2.2: Eliminate Hokim 403 Noise on Login', () => {
    it('does not invoke listDistricts when logged in as DISTRICT_HOKIM', async () => {
      const listDistrictsSpy = vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
        districts: [],
      });

      vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
        actor: {
          id: 'acc_hokim',
          role: 'DISTRICT_HOKIM',
          username: 'hokim_user',
          districtId: 'dist_1',
        },
        session: {
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <DistrictProvider>
              <div>Dashboard Content</div>
            </DistrictProvider>
          </AuthProvider>
        </QueryClientProvider>
      );

      expect(await screen.findByText('Dashboard Content')).toBeTruthy();
      // Allow any microtasks / reactions to run
      await new Promise((r) => setTimeout(r, 50));
      // Verify listDistricts was never called because enabled: actor?.role === 'PRODUCT_OWNER'
      expect(listDistrictsSpy).not.toHaveBeenCalled();
    });

    it('invokes listDistricts when logged in as PRODUCT_OWNER', async () => {
      const listDistrictsSpy = vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
        districts: [
          {
            id: 'dist_1',
            name: 'Чилонзор',
            region: 'Тошкент',
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
          },
        ],
      });

      vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
        actor: {
          id: 'acc_po',
          role: 'PRODUCT_OWNER',
          username: 'admin',
        },
        session: {
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <DistrictProvider>
              <div>Console Content</div>
            </DistrictProvider>
          </AuthProvider>
        </QueryClientProvider>
      );

      expect(await screen.findByText('Console Content')).toBeTruthy();
      await waitFor(() => {
        expect(listDistrictsSpy).toHaveBeenCalled();
      });
    });
  });

  describe('S2.3: Clean Route Gating for Hokim Deep Links', () => {
    it('redirects DISTRICT_HOKIM from /districts to /', async () => {
      vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
        actor: {
          id: 'acc_hokim',
          role: 'DISTRICT_HOKIM',
          username: 'hokim_user',
          districtId: 'dist_1',
        },
        session: {
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });

      window.history.pushState({}, 'Districts Page', '/districts');

      render(<App />);

      await waitFor(() => {
        expect(window.location.pathname).toBe('/');
      });
    });
  });

  describe('S3.1: Tashkent Timezone Pinning (ADR 0003)', () => {
    it('correctly formats timestamps pinned to Asia/Tashkent UTC+5', () => {
      // 2026-08-18T10:00:00.000Z in UTC is 15:00:00 in Asia/Tashkent (UTC+5)
      const formatted = formatTashkentDateTime('2026-08-18T10:00:00.000Z');
      expect(formatted).toContain('18');
      expect(formatted).toContain('08');
      expect(formatted).toContain('2026');
      expect(formatted).toContain('15:00');

      // Invalid or null inputs
      expect(formatTashkentDateTime(null)).toBe('—');
      expect(formatTashkentDateTime(undefined)).toBe('—');
      expect(formatTashkentDateTime('')).toBe('—');
    });
  });

  describe('S3.2: Canonical Ubiquitous Language', () => {
    it('renders Маҳсулот эгаси instead of Масъул ходим in ConsoleLayout role badge', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
        actor: {
          id: 'acc_po',
          role: 'PRODUCT_OWNER',
          username: 'admin_user',
        },
        session: {
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <DistrictProvider>
                <MemoryRouter>
                  <ConsoleLayout />
                </MemoryRouter>
              </DistrictProvider>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>
      );

      expect(await screen.findByText(/Маҳсулот эгаси/)).toBeTruthy();
      expect(screen.queryByText(/Масъул ходим/)).toBeNull();
    });
  });

  describe('S3.4: Signals Cursor Pagination Contract Alignment', () => {
    it('defaults direction to forward and rejects backward', () => {
      const parsedDefault = ListSignalsQuerySchema.parse({});
      expect(parsedDefault.direction).toBe('forward');

      const parsedExplicit = ListSignalsQuerySchema.parse({ direction: 'forward' });
      expect(parsedExplicit.direction).toBe('forward');

      expect(() => ListSignalsQuerySchema.parse({ direction: 'backward' })).toThrow();
    });
  });
});
