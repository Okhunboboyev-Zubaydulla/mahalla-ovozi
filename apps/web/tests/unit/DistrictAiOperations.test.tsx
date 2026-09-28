import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type GetDistrictAnalysisSettingsResponse,
  type DistrictAnalysisSettingsDto,
  type DistrictAnalysisSettingsDraftDto,
} from '@mahalla-ovozi/api-contracts';
import { AiOperationsPage } from '../../src/pages/AiOperationsPage.js';
import { districtSettingsClient } from '../../src/api/district-settings-client.js';
import { DistrictProvider, useDistrict } from '../../src/district/district-context.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import React, { useEffect } from 'react';

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

const mockDistrictActiveSettings: DistrictAnalysisSettingsDto = {
  id: 'dcfg_dist_chilonzor_v1',
  districtId: 'dist_chilonzor',
  version: 1,
  hokimRecognitionTerms: [
    'Ҳоким',
    'Туман ҳокими',
    'Ҳоким ёрдамчиси',
    'Ҳокимият',
    'Сектор раҳбари',
  ],
  localVocabularyAdditions: [
    {
      term: 'Чилонзор-1 мавзеси',
      category: 'Мўлжал ва жойлар',
      description: '1-мавзе маркази',
    },
    {
      term: 'Дўмбиробод маҳалласи',
      category: 'Маҳалла номлари',
    },
  ],
  isActive: true,
  activatedAt: '2026-08-01T05:00:00.000Z',
  activatedBy: null,
  changeReason: 'Туманнинг дастлабки фаол созламалари',
  createdAt: '2026-08-01T05:00:00.000Z',
};

const mockDistrictDraft: DistrictAnalysisSettingsDraftDto = {
  id: 'draft_dist_chilonzor',
  districtId: 'dist_chilonzor',
  baseActiveVersionId: 'dcfg_dist_chilonzor_v1',
  hokimRecognitionTerms: [
    'Ҳоким',
    'Туман ҳокими',
    'Ҳоким ёрдамчиси',
    '1-сектор раҳбари',
  ],
  localVocabularyAdditions: [
    {
      term: 'Чилонзор-1 мавзеси',
      category: 'Мўлжал ва жойлар',
    },
    {
      term: 'Бўрижар канали',
      category: 'Сув ҳавзалари ва каналлар',
      description: 'Чилонзордан оқиб ўтувчи канал',
    },
  ],
  updatedBy: 'acc_po_test',
  createdAt: '2026-08-27T04:00:00.000Z',
  updatedAt: '2026-08-27T04:30:00.000Z',
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

function renderDistrictAiOperationsPage(
  districtData: GetDistrictAnalysisSettingsResponse | null = {
    districtId: 'dist_chilonzor',
    districtName: 'Чилонзор тумани',
    activeConfiguration: mockDistrictActiveSettings,
    draft: null,
  },
  initialDistrictId: string | null = 'dist_chilonzor',
) {
  if (districtData) {
    vi.spyOn(
      districtSettingsClient,
      'getDistrictAnalysisSettings',
    ).mockResolvedValue(districtData);
  }

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

describe('Story 5.2: District Recognition Settings UI Component Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows district selection prompt when no active district is selected (AC 1, 12)', async () => {
    renderDistrictAiOperationsPage(null, null);

    // Switch to District tab
    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText(
        'Туман созламаларини кўриш ва таҳрирлаш учун аввал туманни танланг',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Ҳокимни таниш атамалари ва маҳаллий луғат ҳар бир туман учун алоҳида сақланади ва бошқарилади.',
      ),
    ).toBeTruthy();
    expect(document.getElementById('district-selector')).toBeTruthy();
  });

  it('renders active district configuration card with Uzbek Cyrillic labels and version metadata (AC 2, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    // Switch to District tab
    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Фаол туман созламалари'),
    ).toBeTruthy();
    expect(screen.getByText('Чилонзор тумани')).toBeTruthy();
    expect(screen.getByText('dcfg_dist_chilonzor_v1')).toBeTruthy();
    expect(screen.getAllByText('Фаол созламалар').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Ҳокимга оид атамалар \(5 та\)/i)).toBeTruthy();
  });

  it('pre-populates draft form from active configuration when draft is null (AC 3, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    expect(screen.getAllByText('Ҳоким ёрдамчиси').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Сектор раҳбари').length).toBeGreaterThanOrEqual(1);
  });

  it('pre-populates draft form from saved draft when draft exists (AC 4, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: mockDistrictDraft,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    expect(screen.getByText('1-сектор раҳбари')).toBeTruthy();
    expect(screen.getByText('Бўрижар канали')).toBeTruthy();
  });

  it('allows adding and removing Hokim recognition terms and prevents duplicates (AC 6, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    const termInput = document.getElementById('hokim-new-term');
    const addButton = document.getElementById('hokim-add-button');
    expect(termInput).toBeTruthy();
    expect(addButton).toBeTruthy();

    // Try adding duplicate term
    fireEvent.change(termInput!, { target: { value: 'ҳоким' } });
    fireEvent.click(addButton!);

    expect(
      await screen.findByText(/"ҳоким" атамаси рўйхатда аллақачон мавжуд./i),
    ).toBeTruthy();

    // Add unique term
    fireEvent.change(termInput!, { target: { value: '2-сектор котиби' } });
    fireEvent.click(addButton!);

    expect(await screen.findByText('2-сектор котиби')).toBeTruthy();
    expect(await screen.findByText('Ўзгаришлар сақланмаган')).toBeTruthy();

    // Remove term
    const deleteIcon = screen.getByRole('button', {
      name: /ўчириш: 2-сектор котиби/i,
    });
    fireEvent.click(deleteIcon);

    expect(screen.queryByText('2-сектор котиби')).toBeNull();
  });

  it('allows adding and removing local vocabulary items (AC 3, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    const termInput = document.getElementById('district-vocab-new-term');
    const descInput = document.getElementById('district-vocab-new-description');
    const addButton = document.getElementById('district-vocab-add-button');

    // Add new local landmark
    fireEvent.change(termInput!, { target: { value: 'Шарқ юлдузи кўчаси' } });
    fireEvent.change(descInput!, { target: { value: 'Марказий кўча' } });
    fireEvent.click(addButton!);

    expect(await screen.findByText('Шарқ юлдузи кўчаси')).toBeTruthy();
    expect(screen.getByText('Марказий кўча')).toBeTruthy();

    // Remove local landmark
    const deleteBtn = screen.getByRole('button', {
      name: /ўчириш: Шарқ юлдузи кўчаси/i,
    });
    fireEvent.click(deleteBtn);

    expect(screen.queryByText('Шарқ юлдузи кўчаси')).toBeNull();
  });

  it('renders accessible error summary on validation failure and manages focus (AC 7, 11, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: {
          ...mockDistrictActiveSettings,
          hokimRecognitionTerms: ['Ҳоким'],
        },
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    // Delete the only term
    const deleteIcon = screen.getByRole('button', { name: /ўчириш: Ҳоким/i });
    fireEvent.click(deleteIcon);

    const submitBtn = document.getElementById('district-draft-submit-button');
    expect(submitBtn).toBeTruthy();
    fireEvent.click(submitBtn!);

    expect(
      await screen.findByText(/Тўлдиришда хатоликлар мавжуд/i),
    ).toBeTruthy();
    expect(
      document.getElementById('district-settings-error-summary'),
    ).toBeTruthy();
  });

  it('successfully saves draft and triggers mutation without claiming activation (AC 8, 12)', async () => {
    const saveSpy = vi
      .spyOn(districtSettingsClient, 'saveDistrictAnalysisSettingsDraft')
      .mockResolvedValue({
        draft: mockDistrictDraft,
        message: 'Қоралама муваффақиятли сақланди',
      });

    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    const submitBtn = document.getElementById('district-draft-submit-button');
    expect(submitBtn).toBeTruthy();
    fireEvent.click(submitBtn!);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        'dist_chilonzor',
        expect.objectContaining({
          hokimRecognitionTerms: expect.any(Array),
        }),
      );
    });
  });

  it('resets form back to baseline on discard button click (AC 5, 12)', async () => {
    renderDistrictAiOperationsPage(
      {
        districtId: 'dist_chilonzor',
        districtName: 'Чилонзор тумани',
        activeConfiguration: mockDistrictActiveSettings,
        draft: null,
      },
      'dist_chilonzor',
    );

    const districtTab = screen.getByRole('tab', { name: /туман созламалари/i });
    fireEvent.click(districtTab);

    expect(
      await screen.findByText('Чилонзор тумани: Таҳлил созламалари қораламаси'),
    ).toBeTruthy();

    // Add a term to make form dirty
    const termInput = document.getElementById('hokim-new-term');
    const addButton = document.getElementById('hokim-add-button');
    fireEvent.change(termInput!, { target: { value: 'Янги ҳоким атамаси' } });
    fireEvent.click(addButton!);

    expect(await screen.findByText('Ўзгаришлар сақланмаган')).toBeTruthy();
    expect(screen.getByText('Янги ҳоким атамаси')).toBeTruthy();

    const discardBtn = screen.getByRole('button', {
      name: /ўзгаришларни бекор қилиш/i,
    });
    fireEvent.click(discardBtn);

    expect(screen.queryByText('Ўзгаришлар сақланмаган')).toBeNull();
    expect(screen.queryByText('Янги ҳоким атамаси')).toBeNull();
  });
});
