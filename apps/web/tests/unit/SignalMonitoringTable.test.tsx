import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignalMonitoringTable } from '../../src/components/ai/SignalMonitoringTable.js';
import * as signalsClient from '../../src/api/signals-client.js';
import { districtClient } from '../../src/district/district-client.js';
import { districtTopicsClient } from '../../src/topics/district-topics-client.js';

describe('SignalMonitoringTable Component Tests', () => {
  let queryClient: QueryClient;

  beforeAll(() => {
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
      districts: [
        {
          id: 'dist_1',
          name: 'Чилонзор тумани',
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'dist_2',
          name: 'Юнусобод тумани',
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    vi.spyOn(districtTopicsClient, 'listMahallas').mockResolvedValue({
      mahallas: ['Наврўз', 'Катта Чилонзор'],
    });

    vi.spyOn(signalsClient, 'listSignals').mockImplementation(async (query): Promise<any> => {
      if (query?.cursor === 'cursor_page_2') {
        return {
          items: [
            {
              id: 'sig_2',
              intakeId: 'int_2',
              districtId: 'dist_1',
              districtName: 'Чилонзор тумани',
              mahallaName: 'Катта Чилонзор',
              originalTimestamp: '2026-09-01T09:00:00.000Z',
              calendarDay: '2026-09-01',
              verbatimText: 'Электр таъминотида узилиш кузатилди',
              status: 'ACCEPTED',
              isRelevant: true,
              relevantLanes: ['ELECTRICITY'],
              exclusionReason: null,
              reasoning: 'Электр энергияси узилиши',
              createdAt: '2026-09-01T09:05:00.000Z',
            },
          ],
          pagination: {
            limit: 20,
            nextCursor: null,
            prevCursor: 'cursor_page_1',
            hasNextPage: false,
            hasPrevPage: true,
          },
        };
      }

      return {
        items: [
          {
            id: 'sig_1',
            intakeId: 'int_1',
            districtId: 'dist_1',
            districtName: 'Чилонзор тумани',
            mahallaName: 'Наврўз',
            originalTimestamp: '2026-09-01T10:00:00.000Z',
            calendarDay: '2026-09-01',
            verbatimText: 'Сув босими жуда паст бўлиб қолди',
            status: 'ACCEPTED',
            isRelevant: true,
            relevantLanes: ['WATER'],
            exclusionReason: null,
            reasoning: 'Сув таъминоти муаммоси қайд этилди',
            createdAt: '2026-09-01T10:05:00.000Z',
          },
        ],
        pagination: {
          limit: 20,
          nextCursor: 'cursor_page_2',
          prevCursor: null,
          hasNextPage: true,
          hasPrevPage: false,
        },
      };
    });
  });

  const renderComponent = (props: { initialDistrictId?: string | null } = {}) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider>
          <SignalMonitoringTable {...props} />
        </ConfigProvider>
      </QueryClientProvider>,
    );
  };

  it('renders filter controls including Mahalla AutoComplete and Date RangePicker', async () => {
    renderComponent({ initialDistrictId: 'dist_1' });

    // Table title
    expect(screen.getByText('АИ хабар таснифи ва сигналлар мониторинги')).toBeTruthy();

    // Mahalla placeholder
    expect(screen.getByText('Маҳалла бўйича қидириш')).toBeTruthy();

    // Date range placeholders
    expect(screen.getByPlaceholderText('Бошланғич сана')).toBeTruthy();
    expect(screen.getByPlaceholderText('Якуний сана')).toBeTruthy();

    // Search input
    expect(screen.getByPlaceholderText('Матн бўйича қидириш...')).toBeTruthy();
  });

  it('renders pagination bar with page tag and page size selector', async () => {
    renderComponent({ initialDistrictId: 'dist_1' });

    // Wait for signal items
    expect(await screen.findByText('1-саҳифа')).toBeTruthy();
    expect(screen.getByText('Олдингиси')).toBeTruthy();
    expect(screen.getByText('Кейингиси')).toBeTruthy();
    expect(screen.getByText('20 / саҳифа')).toBeTruthy();
  });

  it('renders table rows and action button', async () => {
    renderComponent({ initialDistrictId: 'dist_1' });

    expect(await screen.findByText('Сув босими жуда паст бўлиб қолди')).toBeTruthy();
    expect(screen.getByText('Наврўз')).toBeTruthy();
    expect(screen.getByText('Қабул қилинди')).toBeTruthy();
    expect(screen.getByText('Кўриш')).toBeTruthy();
  });

  it('handles search input change and resets filters cleanly', async () => {
    renderComponent({ initialDistrictId: 'dist_1' });

    await screen.findByText('Сув босими жуда паст бўлиб қолди');

    // Initially no clear filters button
    expect(screen.queryByText('Филтрларни тозалаш')).toBeNull();

    // Enter search text
    const searchInput = screen.getByPlaceholderText('Матн бўйича қидириш...');
    fireEvent.change(searchInput, { target: { value: 'сув' } });

    // "Филтрларни тозалаш" button appears
    expect(await screen.findByText('Филтрларни тозалаш')).toBeTruthy();

    // Click "Филтрларни тозалаш"
    fireEvent.click(screen.getByText('Филтрларни тозалаш'));

    // Verify input reset
    expect((searchInput as HTMLInputElement).value).toBe('');

    // Clear filters button disappears
    await waitFor(() => {
      expect(screen.queryByText('Филтрларни тозалаш')).toBeNull();
    });
  });

  it('navigates through pages using next and previous buttons', async () => {
    renderComponent({ initialDistrictId: 'dist_1' });

    // Wait for initial load
    expect(await screen.findByText(/Сув босими жуда паст/)).toBeTruthy();
    expect(screen.getByText('1-саҳифа')).toBeTruthy();
    const prevBtn = screen.getByText('Олдингиси').closest('button');
    const nextBtn = screen.getByText('Кейингиси').closest('button');

    expect(prevBtn?.disabled).toBe(true);
    expect(nextBtn?.disabled).toBe(false);

    // Click next page
    fireEvent.click(nextBtn!);

    // Should navigate to page 2
    expect(await screen.findByText('2-саҳифа', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText(/Электр таъминотида узилиш/, {}, { timeout: 3000 })).toBeTruthy();
    expect(prevBtn?.disabled).toBe(false);
    expect(nextBtn?.disabled).toBe(true);

    // Click previous page
    fireEvent.click(prevBtn!);

    // Should return to page 1
    expect(await screen.findByText('1-саҳифа', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText(/Сув босими жуда паст/, {}, { timeout: 3000 })).toBeTruthy();
    expect(prevBtn?.disabled).toBe(true);
  });
});
