import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  OverallSystemHealthResponse,
  OperationalIssuesListResponse,
} from '@mahalla-ovozi/api-contracts';
import { SystemHealthPage } from '../../src/pages/SystemHealthPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { healthClient } from '../../src/health/health-client.js';
import { issuesClient } from '../../src/issues/issues-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
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

describe('Story 4.1 & 4.2: SystemHealthPage Component Tests (AC 1, AC 4, AC 11, AC 15, AC 16)', () => {
  let queryClient: QueryClient;

  const mockSystemHealthData: OverallSystemHealthResponse = {
    status: 'Healthy',
    lastCheckAt: '2026-08-25T11:55:00.000Z',
    evaluatedAt: '2026-08-25T12:00:00.000Z',
    globalComponents: [
      {
        component: 'database',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Healthy',
        lastCheckAt: '2026-08-25T11:55:00.000Z',
        checkedAt: '2026-08-25T11:55:00.000Z',
        outcome: 'success',
        errorCode: null,
        errorMessage: null,
        latencyMs: 12,
        isApplicable: true,
        lifecycleStatus: null,
      },
      {
        component: 'processing_queue',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Healthy',
        lastCheckAt: '2026-08-25T11:55:00.000Z',
        checkedAt: '2026-08-25T11:55:00.000Z',
        outcome: 'success',
        errorCode: null,
        errorMessage: null,
        latencyMs: 8,
        isApplicable: true,
        lifecycleStatus: null,
      },
      {
        component: 'scheduled_deletion',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Healthy',
        lastCheckAt: '2026-08-25T11:55:00.000Z',
        checkedAt: '2026-08-25T11:55:00.000Z',
        outcome: 'success',
        errorCode: null,
        errorMessage: null,
        latencyMs: 5,
        isApplicable: true,
        lifecycleStatus: null,
      },
    ],
    districts: [
      {
        districtId: 'dist-chilonzor',
        districtName: 'Чилонзор тумани',
        status: 'Healthy',
        lastCheckAt: '2026-08-25T11:55:00.000Z',
        components: [
          {
            component: 'telegram_bot',
            scope: 'DISTRICT',
            districtId: 'dist-chilonzor',
            status: 'Healthy',
            lastCheckAt: '2026-08-25T11:55:00.000Z',
            checkedAt: '2026-08-25T11:55:00.000Z',
            outcome: 'success',
            errorCode: null,
            errorMessage: null,
            latencyMs: 5,
            isApplicable: true,
            lifecycleStatus: 'ACTIVE',
          },
        ],
        lifecycleStatus: 'ACTIVE',
      },
    ],
    totalDistricts: 1,
    activeDistricts: 1,
  };

  const mockIssuesData: OperationalIssuesListResponse = {
    issues: [],
    totalActive: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    evaluatedAt: '2026-08-25T12:00:00.000Z',
  };

  beforeEach(() => {
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(issuesClient, 'getOperationalIssues').mockResolvedValue(mockIssuesData);
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <DistrictProvider>
            <BrowserRouter>
              <SystemHealthPage />
            </BrowserRouter>
          </DistrictProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  }

  it('renders overall health card, active issues list, global components table, and district matrix when data loads (AC 1, AC 4)', async () => {
    vi.spyOn(healthClient, 'getSystemHealth').mockResolvedValue(mockSystemHealthData);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Тизим ва туманлар ҳолати')).toBeTruthy();
      expect(screen.getByText('Умумий тизим ҳолати')).toBeTruthy();
      expect(screen.getByText('Фаол техник муаммолар')).toBeTruthy();
      expect(screen.getByText('Глобал платформа компонентлари')).toBeTruthy();
      expect(screen.getByText('Туманлар ҳолати матрицаси')).toBeTruthy();
      expect(screen.getByText('Чилонзор тумани')).toBeTruthy();
      expect(screen.getByText('Режалаштирилган ўчириш тизими')).toBeTruthy();
    });
  });

  it('renders honest zero-districts empty state when no districts exist (AC 11)', async () => {
    const zeroDistrictsData: OverallSystemHealthResponse = {
      ...mockSystemHealthData,
      districts: [],
      totalDistricts: 0,
      activeDistricts: 0,
    };

    vi.spyOn(healthClient, 'getSystemHealth').mockResolvedValue(zeroDistrictsData);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Ҳозирча туманлар мавжуд эмас')).toBeTruthy();
    });
  });

  it('displays error alert and retry button on network/fetch failure', async () => {
    vi.spyOn(healthClient, 'getSystemHealth').mockRejectedValue(
      new Error('Сервер билан боғланишда хатолик'),
    );

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('Тизим ҳолати маълумотларини юклашда хатолик юз берди'),
      ).toBeTruthy();
      expect(screen.getByText('Қайта уриниш')).toBeTruthy();
    });
  });
});
