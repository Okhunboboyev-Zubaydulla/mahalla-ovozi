import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useEffect } from 'react';
import type {
  GetDistrictAnalysisSettingsResponse,
  DistrictAnalysisSettingsDto,
  DistrictAnalysisSettingsHistoryResponse,
} from '@mahalla-ovozi/api-contracts';
import { AiOperationsPage } from '../../src/pages/AiOperationsPage.js';
import { districtSettingsClient } from '../../src/api/district-settings-client.js';
import { districtClient } from '../../src/district/district-client.js';
import { districtTopicsClient } from '../../src/topics/district-topics-client.js';
import * as signalsClient from '../../src/api/signals-client.js';
import { DistrictProvider, useDistrict } from '../../src/district/district-context.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

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

  Object.defineProperty(navigator, 'onLine', {
    writable: true,
    configurable: true,
    value: true,
  });
}

beforeAll(() => {
  setupMatchMedia();
});

const mockActiveDistrictSettings: DistrictAnalysisSettingsDto = {
  id: 'dcfg_dist_chilonzor_v1',
  districtId: 'dist_chilonzor',
  version: 1,
  hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими', 'Сектор раҳбари'],
  localVocabularyAdditions: [
    {
      term: 'Чилонзор-1 мавзеси',
      category: 'Мўлжал ва жойлар',
      description: '1-мавзе маркази',
    },
  ],
  isActive: true,
  activatedAt: '2026-08-01T05:00:00.000Z',
  activatedBy: null,
  changeReason: 'Туманнинг дастлабки фаол созламалари',
  createdAt: '2026-08-01T05:00:00.000Z',
};

const mockDistrictResponse: GetDistrictAnalysisSettingsResponse = {
  districtId: 'dist_chilonzor',
  districtName: 'Чилонзор тумани',
  activeConfiguration: mockActiveDistrictSettings,
  draft: null,
};

const mockDistrictHistoryResponse: DistrictAnalysisSettingsHistoryResponse = {
  districtId: 'dist_chilonzor',
  districtName: 'Чилонзор тумани',
  items: [mockActiveDistrictSettings],
  totalCount: 1,
};

// Helper component to initialize activeDistrictId in test context
const DistrictTestContextInitializer: React.FC<{ initialDistrictId: string | null }> = ({
  initialDistrictId,
}) => {
  const { setActiveDistrictDirectly } = useDistrict();
  useEffect(() => {
    setActiveDistrictDirectly(initialDistrictId);
  }, [initialDistrictId, setActiveDistrictDirectly]);
  return null;
};

function renderAiOperationsPage(initialDistrictId: string | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>
          <DistrictProvider>
            <DistrictTestContextInitializer initialDistrictId={initialDistrictId} />
            <AiOperationsPage />
          </DistrictProvider>
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('AiOperationsPage Architecture & Tab Navigation Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
      districts: [
        {
          id: 'dist_chilonzor',
          name: 'Чилонзор тумани',
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    vi.spyOn(districtTopicsClient, 'listMahallas').mockResolvedValue({
      mahallas: ['1-мавзе', '2-мавзе'],
    });

    vi.spyOn(signalsClient, 'listSignals').mockResolvedValue({
      items: [],
      pagination: {
        limit: 50,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
        totalCount: 0,
      },
    });

    vi.spyOn(districtSettingsClient, 'getDistrictAnalysisSettings').mockResolvedValue(
      mockDistrictResponse,
    );

    vi.spyOn(districtSettingsClient, 'getDistrictSettingsHistory').mockResolvedValue(
      mockDistrictHistoryResponse,
    );
  });

  it('renders page header and exactly 3 tabs, defaulting to monitoring (zero global settings)', async () => {
    renderAiOperationsPage(null);

    // Page title and subtitle
    expect(await screen.findByText('АИ операциялари ва созламалари')).toBeTruthy();
    expect(
      screen.getByText(
        /АИ операциялари мониторинги, туманларга хос атамалар ва таҳлил созламалари тарихини бошқариш/i,
      ),
    ).toBeTruthy();

    // Verify exactly 3 operational tabs exist
    expect(screen.getByRole('tab', { name: /Операциялар мониторинги/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Туман созламалари/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Созламалар тарихи/i })).toBeTruthy();

    // Verify Global Settings tab was completely removed
    expect(screen.queryByRole('tab', { name: /Глобал созламалар/i })).toBeNull();
    expect(screen.queryByText(/Фаол глобал таҳлил созламалари/i)).toBeNull();
    expect(screen.queryByText(/Глобал таҳлил созламалари қораламаси/i)).toBeNull();

    // Default active tab must be monitoring
    const monitoringTab = screen.getByRole('tab', { name: /Операциялар мониторинги/i });
    expect(monitoringTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switches to District tab and displays district prompt when no district is selected', async () => {
    renderAiOperationsPage(null);

    const districtTab = screen.getByRole('tab', { name: /Туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText(
        'Туман созламаларини кўриш ва таҳрирлаш учун аввал туманни танланг',
      ),
    ).toBeTruthy();
    expect(document.getElementById('district-selector')).toBeTruthy();
  });

  it('switches to District tab and displays active card and draft form when district is selected', async () => {
    renderAiOperationsPage('dist_chilonzor');

    const districtTab = screen.getByRole('tab', { name: /Туман созламалари/i });
    fireEvent.click(districtTab);

    expect(await screen.findByText('Фаол туман созламалари')).toBeTruthy();
    expect(screen.getAllByText('Чилонзор тумани').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('dcfg_dist_chilonzor_v1')).toBeTruthy();
    expect(
      screen.getByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();
  });

  it('switches to History tab and displays direct district history panel', async () => {
    renderAiOperationsPage('dist_chilonzor');

    const historyTab = screen.getByRole('tab', { name: /Созламалар тарихи/i });
    fireEvent.click(historyTab);

    // Flattened direct district history panel
    expect(await screen.findByText(/Чилонзор тумани \(dist_chilonzor\)/i)).toBeTruthy();
    expect(screen.getByText('dcfg_dist_chilonzor_v1')).toBeTruthy();

    // Confirm no nested global history tabs exist
    expect(screen.queryByText('Глобал созламалар тарихи')).toBeNull();
  });
});
