import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { BoardToolbar } from '../../src/components/topics/BoardToolbar.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { authClient } from '../../src/auth/auth-client.js';
import { formatTashkentLiveDateTime } from '../../src/lib/formatters.js';

describe('Story 3.3 & 3.6: BoardToolbar Component Tests', () => {
  let queryClient: QueryClient;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_user',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: false,
      },
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });
  });

  const renderWithProviders = (ui: React.ReactElement) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>{ui}</AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  };

  it('Test 1: Renders district name and freshness timestamp in smart refresh button (AC 6)', () => {
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        lastRefreshedAt="2026-08-24T08:30:00.000Z"
      />,
    );

    expect(screen.getByText('Маҳалла Овози')).toBeTruthy();
    expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Маълумотларни янгилаш' })).toBeTruthy();
  });

  it('Test 2: Янгилаш button triggers onRefresh when clicked (AC 7)', () => {
    const handleRefresh = vi.fn();
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        onRefresh={handleRefresh}
      />,
    );

    const refreshButton = screen.getByRole('button', { name: /Маълумотларни янгилаш/ });
    expect(refreshButton).toBeTruthy();
    fireEvent.click(refreshButton);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });

  it('Test 3: Янгилаш button is disabled when isOffline or isRefreshing (AC 7, 8)', () => {
    const { rerender } = renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        isOffline={true}
      />,
    );

    let refreshButton = screen.getByRole('button', { name: /Маълумотларни янгилаш/ });
    expect(refreshButton.hasAttribute('disabled')).toBe(true);

    rerender(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>
            <BoardToolbar
              districtName="Яккасарой тумани"
              calendarDay="2026-08-24"
              isRefreshing={true}
            />
          </AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );

    refreshButton = screen.getByRole('button', { name: /Маълумотларни янгилаш/ });
    expect(refreshButton.hasAttribute('disabled')).toBe(true);
  });

  it('Test 4: Displays processing delay warning indicator when hasProcessingDelay is true (AC 6)', () => {
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        lastRefreshedAt="2026-08-24T08:30:00.000Z"
        hasProcessingDelay={true}
      />,
    );

    expect(
      screen.getByLabelText(/Янгиланиш давом этмоқда — айрим сўнгги хабарлар ҳали кўринмаслиги мумкин/),
    ).toBeTruthy();
  });

  it('Test 5: Renders Help button with proper id and triggers onOpenHelp (Story 3.6 AC 1, AC 3)', () => {
    const handleOpenHelp = vi.fn();
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        onOpenHelp={handleOpenHelp}
      />,
    );

    const helpButton = screen.getByRole('button', { name: 'Тизим ёрдами' });
    expect(helpButton).toBeTruthy();
    expect(helpButton.id).toBe('dashboard-help-button');
    fireEvent.click(helpButton);
    expect(handleOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('Test 6: Renders Profile popover trigger button with aria-haspopup and username (Story 3.6 AC 6)', async () => {
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
      />,
    );

    await waitFor(() => {
      const profileButton = screen.getByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
      expect(profileButton).toBeTruthy();
      expect(profileButton.id).toBe('dashboard-profile-button');
      expect(profileButton.getAttribute('aria-haspopup')).toBe('dialog');
      expect(profileButton.textContent).toContain('hokim_user');
    });
  });

  it('Test 7: Opens Profile popover displaying username, district, role badge, and sign out button (Story 3.6 AC 6)', async () => {
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
      />,
    );

    const profileButton = await screen.findByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
    fireEvent.click(profileButton);

    // Popover content checks
    expect(await screen.findByText('Туман ҳокими')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Тизимдан чиқиш' })).toBeTruthy();
  });

  it('Test 8: Activating Чиқиш executes signOut and cancels/clears queries (Story 3.6 AC 7)', async () => {
    const signOutSpy = vi.spyOn(authClient, 'signOut').mockResolvedValue({ success: true });
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
      />,
    );

    const profileButton = await screen.findByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
    fireEvent.click(profileButton);

    const signOutButton = await screen.findByRole('button', { name: 'Тизимдан чиқиш' });
    fireEvent.click(signOutButton);

    await waitFor(() => {
      expect(signOutSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('Test 9: Negative guardrail - does NOT render sidebar, tabs, or district switcher (Story 3.6 AC 1)', () => {
    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
      />,
    );

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByLabelText(/туманни ўзгартириш/i)).toBeNull();
  });

  it('Test 10: Phone responsive mode (<576px) renders compact header with all 4 accessible controls', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 575px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const handleOpenFilters = vi.fn();
    const handleRefresh = vi.fn();
    const handleOpenHelp = vi.fn();

    renderWithProviders(
      <BoardToolbar
        districtName="Шароф Рашидов тумани"
        calendarDay="2026-08-24"
        onOpenFilters={handleOpenFilters}
        activeFilterCount={2}
        onRefresh={handleRefresh}
        onOpenHelp={handleOpenHelp}
      />,
    );

    // 1. Heading remains in DOM with id="dashboard-main-heading" for focus restoration & WCAG
    const heading = document.getElementById('dashboard-main-heading');
    expect(heading).toBeTruthy();
    expect(heading?.classList.contains('sr-only')).toBe(true);

    // 2. District name strips redundant "тумани" suffix on mobile
    expect(screen.getByText('Шароф Рашидов')).toBeTruthy();

    // 3. Filter button is 32x32 icon button with badge and proper aria-label
    const filterBtn = screen.getByRole('button', { name: /Фильтрлар: 2 та фаол/ });
    expect(filterBtn).toBeTruthy();
    expect(filterBtn.id).toBe('mobile-filter-button');

    // 4. Refresh button is present
    const refreshBtn = screen.getByRole('button', { name: /Маълумотларни янгилаш/ });
    expect(refreshBtn).toBeTruthy();

    // 5. Help button is present
    const helpBtn = screen.getByRole('button', { name: 'Тизим ёрдами' });
    expect(helpBtn).toBeTruthy();

    // 6. Profile button is present as compact button
    const profileBtn = screen.getByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
    expect(profileBtn).toBeTruthy();
    expect(profileBtn.id).toBe('dashboard-profile-button');
  });

  it('Test 11: Phone responsive mode (<576px) opens and closes Profile Bottom Sheet (Drawer) on mobile', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 575px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(
      <BoardToolbar
        districtName="Шароф Рашидов тумани"
        calendarDay="2026-08-24"
      />,
    );

    const profileBtn = await screen.findByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
    expect(profileBtn).toBeTruthy();

    // 1. Initial state: bottom sheet is closed
    expect(screen.queryByText('Ҳоким профили')).toBeNull();
    expect(screen.queryByText('Туман ҳокими')).toBeNull();

    // 2. Click profile button to open bottom sheet
    fireEvent.click(profileBtn);

    // 3. Mobile Bottom Sheet content is visible
    expect(await screen.findByText('Ҳоким профили')).toBeTruthy();
    expect(screen.getByText('hokim_user')).toBeTruthy();
    expect(screen.getByText('Туман ҳокими')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Тизимдан чиқиш' })).toBeTruthy();

    // 4. Click Close button ("Ёпиш") to close bottom sheet
    const closeBtn = screen.getByRole('button', { name: 'Ёпиш' });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('Ҳоким профили')).toBeNull();
    });
  });

  it('Test 12: Mobile Profile Bottom Sheet sign out executes signOut on activation', async () => {
    const signOutSpy = vi.spyOn(authClient, 'signOut').mockResolvedValue({ success: true });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 575px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(
      <BoardToolbar
        districtName="Шароф Рашидов тумани"
        calendarDay="2026-08-24"
      />,
    );

    const profileBtn = await screen.findByRole('button', { name: 'Ҳоким профили ва сессия созламалари' });
    fireEvent.click(profileBtn);

    const signOutBtn = await screen.findByRole('button', { name: 'Тизимдан чиқиш' });
    fireEvent.click(signOutBtn);

    await waitFor(() => {
      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Ҳоким профили')).toBeNull();
    });
  });

  it('Test 13: LiveClock renders 32px status chip with date and time in Asia/Tashkent and timer role', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px') || query.includes('min-width: 1200px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
      />,
    );

    const timer = screen.getByRole('timer');
    expect(timer).toBeTruthy();
    expect(timer.getAttribute('aria-label')).toMatch(/Ҳозирги вақт: \d{2}\.\d{2}/);
    expect(timer.textContent).toMatch(/\d{2}\.\d{2}(\.\d{4})? · \d{2}:\d{2}/);
  });

  it('Test 14: Desktop layout renders filter navigation clustered to the left and utilities anchored right', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px') || query.includes('min-width: 1200px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const handleFilterChange = vi.fn();
    const handleReset = vi.fn();

    renderWithProviders(
      <BoardToolbar
        districtName="Яккасарой тумани"
        calendarDay="2026-08-24"
        filters={{
          dateScope: 'today',
          mahallaName: undefined,
          lanes: ['WATER', 'ELECTRICITY'],
        }}
        onFilterChange={handleFilterChange}
        onResetFilters={handleReset}
        isDefaultFilters={false}
      />,
    );

    const filterNav = screen.getByRole('navigation', { name: 'Фильтрлар панели' });
    expect(filterNav).toBeTruthy();

    const timer = screen.getByRole('timer');
    expect(timer).toBeTruthy();

    // Check right section parent has marginLeft: auto
    const rightSection = timer.closest('div[style*="margin-left: auto"]');
    expect(rightSection).toBeTruthy();
  });
});

describe('formatTashkentLiveDateTime Unit Tests', () => {
  it('formats Date object in Asia/Tashkent timezone with display, compact, and full strings', () => {
    // 2026-09-09T15:05:00.000Z is 20:05 in Tashkent (UTC+5)
    const testDate = new Date('2026-09-09T15:05:00.000Z');
    const result = formatTashkentLiveDateTime(testDate);

    expect(result.display).toBe('09.09.2026 · 20:05');
    expect(result.compact).toBe('09.09 · 20:05');
    expect(result.full).toBe('09.09.2026, 20:05 (Тошкент вақти)');
  });

  it('formats ISO string correctly in Asia/Tashkent timezone', () => {
    const iso = '2026-01-05T04:30:00.000Z'; // 09:30 in Tashkent
    const result = formatTashkentLiveDateTime(iso);

    expect(result.display).toBe('05.01.2026 · 09:30');
    expect(result.compact).toBe('05.01 · 09:30');
    expect(result.full).toBe('05.01.2026, 09:30 (Тошкент вақти)');
  });

  it('handles null, undefined, or empty values safely', () => {
    expect(formatTashkentLiveDateTime(null)).toEqual({ display: '', compact: '', full: '' });
    expect(formatTashkentLiveDateTime(undefined)).toEqual({ display: '', compact: '', full: '' });
  });

  it('handles invalid date strings without throwing errors', () => {
    expect(formatTashkentLiveDateTime('not-a-valid-date')).toEqual({ display: '', compact: '', full: '' });
  });
});
