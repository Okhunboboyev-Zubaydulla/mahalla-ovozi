import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import {
  AnalysisSettingsHistoryTable,
  type AnalysisSettingsHistoryTableProps,
} from '../../src/components/ai/AnalysisSettingsHistoryTable.js';
import type {
  DistrictAnalysisSettingsDto,
} from '@mahalla-ovozi/api-contracts';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

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

const mockDistrictHistory: DistrictAnalysisSettingsDto[] = [
  {
    id: 'dcfg_dist_123_v2',
    districtId: 'dist_123',
    version: 2,
    hokimRecognitionTerms: ['Ҳоким', 'Чилонзор ҳокими'],
    localVocabularyAdditions: [
      { term: 'Чилонзор 1-мавзе', category: 'Мўлжал ва жойлар' },
    ],
    isActive: true,
    activatedAt: '2026-08-26T14:00:00.000Z',
    activatedBy: 'po_admin',
    changeReason: 'Чилонзор янги атамалари',
    createdAt: '2026-08-26T14:00:00.000Z',
  },
  {
    id: 'dcfg_dist_123_v1',
    districtId: 'dist_123',
    version: 1,
    hokimRecognitionTerms: ['Ҳоким'],
    localVocabularyAdditions: [],
    isActive: false,
    activatedAt: '2026-08-01T00:00:00.000Z',
    activatedBy: null,
    changeReason: 'Туманнинг дастлабки фаол созламалари',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
];

describe('AnalysisSettingsHistoryTable Component Tests (Story 5.4)', () => {
  function renderTable(props: Partial<AnalysisSettingsHistoryTableProps> = {}) {
    const defaultProps: AnalysisSettingsHistoryTableProps = {
      items: mockDistrictHistory,
      loading: false,
      onRollbackClick: vi.fn(),
      ...props,
    };

    return render(
      <ConfigProvider theme={mahallaTheme}>
        <AnalysisSettingsHistoryTable {...defaultProps} />
      </ConfigProvider>,
    );
  }

  it('renders table columns, version tags, and status badges correctly for district history', () => {
    renderTable();

    // Check version tags
    expect(screen.getByText('V2')).toBeTruthy();
    expect(screen.getByText('dcfg_dist_123_v2')).toBeTruthy();
    expect(screen.getByText('V1')).toBeTruthy();
    expect(screen.getByText('dcfg_dist_123_v1')).toBeTruthy();

    // Check status badges
    expect(screen.getByText('Фаол')).toBeTruthy();
    expect(screen.getByText('Тарихий')).toBeTruthy();

    // Check change reasons
    expect(screen.getByText('Чилонзор янги атамалари')).toBeTruthy();
    expect(screen.getByText('Туманнинг дастлабки фаол созламалари')).toBeTruthy();

    // Check summaries
    expect(screen.getByText(/Ҳоким атамалари: 2 та/)).toBeTruthy();
    expect(screen.getByText(/Маҳаллий луғат: 1 та/)).toBeTruthy();
  });

  it('disables rollback button for active version and enables for historical version', () => {
    const onRollbackClick = vi.fn();
    renderTable({ onRollbackClick });

    const activeBtn = document.getElementById('btn-rollback-dcfg_dist_123_v2') as HTMLButtonElement;
    expect(activeBtn).toBeTruthy();
    expect(activeBtn.disabled).toBe(true);

    const historicalBtn = document.getElementById('btn-rollback-dcfg_dist_123_v1') as HTMLButtonElement;
    expect(historicalBtn).toBeTruthy();
    expect(historicalBtn.disabled).toBe(false);

    fireEvent.click(historicalBtn);
    expect(onRollbackClick).toHaveBeenCalledTimes(1);
    expect(onRollbackClick).toHaveBeenCalledWith(mockDistrictHistory[1]);
  });
});
