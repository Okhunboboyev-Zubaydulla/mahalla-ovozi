import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictsPage } from '../../src/pages/DistrictsPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
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
}

beforeAll(() => {
  setupMatchMedia();
});

describe('DistrictsPage & CreateDistrictDrawer Component Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  function renderDistrictsPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <DistrictProvider>
            <BrowserRouter>
              <DistrictsPage />
            </BrowserRouter>
          </DistrictProvider>
        </ConfigProvider>
      </QueryClientProvider>
    );
  }

  it('renders honest empty state with CTA when no districts exist (AC 2)', async () => {
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValueOnce({
      districts: [],
    });

    renderDistrictsPage();

    expect(await screen.findByText('Ҳозирча туманлар мавжуд эмас')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Туман қўшиш/i })).toBeTruthy();
  });

  it('renders table with columns, status tag, and Tashkent date when districts exist (AC 3, P5-I)', async () => {
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValueOnce({
      districts: [
        {
          id: '01951234-5678-7000-8000-000000000001',
          name: 'Чилонзор',
          region: 'Тошкент шаҳри',
          status: 'SETUP_INCOMPLETE',
          createdAt: '2026-08-17T10:00:00.000Z',
        },
      ],
    });

    renderDistrictsPage();

    expect(await screen.findByText('Чилонзор')).toBeTruthy();
    expect(screen.getByText('Тошкент шаҳри')).toBeTruthy();
    expect(screen.getByText('Созлаш тугалланмаган')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Туманлар рўйхати' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Танлаш/i })).toBeTruthy();
  });

  it('opens CreateDistrictDrawer and validates required fields with error summary (P5-E)', async () => {
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValueOnce({
      districts: [],
    });

    renderDistrictsPage();

    const openCta = await screen.findByRole('button', { name: /Туман қўшиш/i });
    fireEvent.click(openCta);

    // Drawer should appear
    expect(await screen.findByText('Янги туман қўшиш')).toBeTruthy();
    expect(screen.getByText('Туман номи')).toBeTruthy();
    expect(screen.getByText('Вилоят / Ҳудуд')).toBeTruthy();

    // Click submit with empty input
    const submitBtn = screen.getByRole('button', { name: /Сақлаш/i });
    fireEvent.click(submitBtn);

    // Error summary should be visible
    expect(await screen.findByText(/Тўлдиришда хатоликлар мавжуд/i)).toBeTruthy();
  });

  it('renders ACTIVE status tag with check icon for active districts (AC 8, 17)', async () => {
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValueOnce({
      districts: [
        {
          id: '01951234-5678-7000-8000-000000000002',
          name: 'Миробод',
          region: 'Тошкент шаҳри',
          status: 'ACTIVE',
          createdAt: '2026-08-18T10:00:00.000Z',
          activatedAt: '2026-08-19T12:00:00.000Z',
        },
      ],
    });

    renderDistrictsPage();

    expect(await screen.findByText('Миробод')).toBeTruthy();
    expect(screen.getByText('Фаол')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Кўриш: Миробод/i })).toBeTruthy();
  });

  it('opens EditDistrictDrawer when clicking Таҳрирлаш and pre-fills form values', async () => {
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValueOnce({
      districts: [
        {
          id: 'dist_edit_123',
          name: 'Чилонзор',
          region: 'Тошкент шаҳри',
          status: 'SETUP_INCOMPLETE',
          createdAt: '2026-08-17T10:00:00.000Z',
        },
      ],
    });

    const updateSpy = vi
      .spyOn(districtClient, 'updateDistrict')
      .mockResolvedValueOnce({
        district: {
          id: 'dist_edit_123',
          name: 'Чилонзор (Янгиланган)',
          region: 'Тошкент вилояти',
          status: 'SETUP_INCOMPLETE',
          createdAt: '2026-08-17T10:00:00.000Z',
        },
      });

    renderDistrictsPage();

    const editBtn = await screen.findByRole('button', { name: /Таҳрирлаш: Чилонзор/i });
    fireEvent.click(editBtn);

    // Edit drawer should appear with title and pre-filled inputs
    expect(await screen.findByText('Туман маълумотларини таҳрирлаш')).toBeTruthy();
    const nameInput = document.getElementById('edit-district-name-input') as HTMLInputElement;
    const regionInput = document.getElementById('edit-district-region-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Чилонзор');
    expect(regionInput.value).toBe('Тошкент шаҳри');

    // Change input and submit
    fireEvent.change(nameInput, { target: { value: 'Чилонзор (Янгиланган)' } });
    fireEvent.change(regionInput, { target: { value: 'Тошкент вилояти' } });

    const submitBtn = document.getElementById('edit-district-submit') as HTMLButtonElement;
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dist_edit_123', {
        name: 'Чилонзор (Янгиланган)',
        region: 'Тошкент вилояти',
      });
    });
  });
});


