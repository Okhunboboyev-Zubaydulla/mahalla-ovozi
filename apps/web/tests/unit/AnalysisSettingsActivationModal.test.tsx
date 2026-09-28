import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AnalysisSettingsActivationModal,
  type AnalysisSettingsActivationModalProps,
} from '../../src/components/ai/AnalysisSettingsActivationModal.js';
import {
  type DistrictAnalysisSettingsDto,
  type DistrictAnalysisSettingsDraftDto,
} from '@mahalla-ovozi/api-contracts';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { ApiError } from '../../src/lib/api-client.js';

function setupMatchMedia() {
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
}

beforeAll(() => {
  setupMatchMedia();
});

const mockDistrictActiveSettings: DistrictAnalysisSettingsDto = {
  id: 'dcfg_dist_123_v1',
  districtId: 'dist_123',
  version: 1,
  hokimRecognitionTerms: ['Ҳоким'],
  localVocabularyAdditions: [
    { term: 'Чилонзор', category: 'Мўлжал' },
  ],
  isActive: true,
  activatedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const mockDistrictDraftWithChanges: DistrictAnalysisSettingsDraftDto = {
  id: 'draft_dist_123',
  districtId: 'dist_123',
  baseActiveVersionId: 'dcfg_dist_123_v1',
  hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими'],
  localVocabularyAdditions: [
    { term: 'Чилонзор', category: 'Мўлжал' },
    { term: 'Оқтепа', category: 'Мўлжал' },
  ],
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

describe('AnalysisSettingsActivationModal Component Tests (Story 5.3)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  function renderModal(props: Partial<AnalysisSettingsActivationModalProps> = {}) {
    const defaultProps: AnalysisSettingsActivationModalProps = {
      open: true,
      districtId: 'dist_123',
      districtName: 'Чилонзор тумани',
      activeVersionId: 'dcfg_dist_123_v1',
      activeSettings: mockDistrictActiveSettings,
      draftSettings: mockDistrictDraftWithChanges,
      onConfirm: vi.fn().mockResolvedValue(undefined),
      onCancel: vi.fn(),
      ...props,
    };

    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AnalysisSettingsActivationModal {...defaultProps} />
        </ConfigProvider>
      </QueryClientProvider>,
    );
  }

  it('renders modal with target scope, active version, future-only warning, and diff viewer (AC 1, 2, 4)', async () => {
    renderModal();

    expect(
      screen.getByText('Таҳлил созламаларини фаоллаштириш'),
    ).toBeTruthy();
    expect(screen.getByText('Чилонзор тумани (ID: dist_123)')).toBeTruthy();
    expect(screen.getByText('dcfg_dist_123_v1')).toBeTruthy();

    // Future-only invariant warning notice (AC 4, AD-8)
    expect(
      screen.getByText(/Ушбу созламалар фақат келгуси таҳлиллар учун амал қилади/i),
    ).toBeTruthy();

    // Diff items rendered
    expect(screen.getByText('Ҳокимга оид атамалар (Hokim Recognition Terms)')).toBeTruthy();
    expect(screen.getByText('+ Туман ҳокими')).toBeTruthy();
    expect(screen.getByText('+ Оқтепа')).toBeTruthy();
  });

  it('blocks activation when draft has no effective changes (AC 3)', async () => {
    renderModal({
      draftSettings: {
        ...mockDistrictActiveSettings,
        id: 'draft_dist_123',
        baseActiveVersionId: 'dcfg_dist_123_v1',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    });

    expect(
      screen.getAllByText(
        /Қораламада фаол созламаларга нисбатан ҳеч қандай ўзгариш мавжуд эмас/i,
      ).length,
    ).toBeGreaterThan(0);

    const confirmBtn = screen.getByRole('button', {
      name: /Фаоллаштиришни тасдиқлаш/i,
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('validates change reason: requires minimum 5 characters and rejects prohibited secrets (AC 5)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderModal({ onConfirm });

    const textarea = screen.getByPlaceholderText(
      /Масалан: Модель аниқлигини ошириш ва янги ҳудудий атамаларни киритиш/i,
    );
    const confirmBtn = screen.getByRole('button', {
      name: /Фаоллаштиришни тасдиқлаш/i,
    });

    // 1. Submit empty -> validation error
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(
        screen.queryByText(/Ўзгартириш сабаби киритилиши шарт/i),
      ).toBeTruthy();
    });
    expect(onConfirm).not.toHaveBeenCalled();

    // 2. Submit < 5 chars -> length error
    fireEvent.change(textarea, { target: { value: 'Test' } });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(
        screen.queryByText(/Ўзгартириш сабаби камида 5 та белгидан иборат бўлиши керак/i),
      ).toBeTruthy();
    });
    expect(onConfirm).not.toHaveBeenCalled();

    // 3. Submit with Telegram bot token -> secret scanning error
    fireEvent.change(textarea, {
      target: {
        value:
          'Valid length change reason with bot token 123456789:AAFlkjdsflkjsdflkjsdflkjsdflkjsdfl in it',
      },
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(
        screen.queryByText(/Ўзгартириш сабабида махфий маълумотлар .* кўрсатилиши мумкин эмас/i),
      ).toBeTruthy();
    });
    expect(onConfirm).not.toHaveBeenCalled();

    // 4. Submit valid reason -> onConfirm called
    fireEvent.change(textarea, {
      target: {
        value: 'Модель аниқлигини ошириш ва янги луғат атамаларини фаоллаштириш',
      },
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        'Модель аниқлигини ошириш ва янги луғат атамаларини фаоллаштириш',
      );
    });
  });

  it('handles stale baseline version conflict (409) with refresh prompt (AC 9)', async () => {
    const onConfirm = vi.fn().mockRejectedValue(
      new ApiError(
        'Фаол созламалар версияси ўзгарган. Илтимос, саҳифани янгилаб, қайта кўриб чиқинг.',
        'STALE_BASELINE_VERSION',
        409,
        false,
      ),
    );
    const onRefresh = vi.fn();

    renderModal({ onConfirm, onRefresh });

    const textarea = screen.getByPlaceholderText(
      /Масалан: Модель аниқлигини ошириш ва янги ҳудудий атамаларни киритиш/i,
    );
    const confirmBtn = screen.getByRole('button', {
      name: /Фаоллаштиришни тасдиқлаш/i,
    });

    fireEvent.change(textarea, {
      target: { value: 'Valid operational change reason' },
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(/Версиялар зиддияти \(409 Conflict\)/i),
      ).toBeTruthy();
    });

    const refreshBtn = screen.getByRole('button', {
      name: /Саҳифани янгилаш/i,
    });
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    const cancelBtn = screen.getByRole('button', { name: /Бекор қилиш/i });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalled();
  });
});
