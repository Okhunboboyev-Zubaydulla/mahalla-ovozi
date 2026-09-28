import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelegramSetupPage } from '../../src/pages/TelegramSetupPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { telegramBotClient } from '../../src/district/telegram-bot-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { District, TelegramBotInfo } from '@mahalla-ovozi/api-contracts';

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

const mockDistricts: District[] = [
  {
    id: 'dist_test_1',
    name: 'Чилонзор',
    region: 'Тошкент ш.',
    status: 'SETUP_INCOMPLETE',
    createdAt: '2026-08-18T10:00:00.000Z',
  },
];

const mockBot: TelegramBotInfo = {
  id: 'tg_bot_123',
  districtId: 'dist_test_1',
  botId: '123456789',
  botUsername: 'chilonzor_mahalla_bot',
  botFirstName: 'Chilonzor Mahalla Bot',
  tokenMasked: '123456789:••••••••••••',
  status: 'VALID',
  lastValidatedAt: '2026-08-18T10:00:00.000Z',
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T10:00:00.000Z',
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={mahallaTheme}>
        <DistrictProvider>
          <BrowserRouter>{ui}</BrowserRouter>
        </DistrictProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}

describe('TelegramSetupPage Component Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    sessionStorage.clear();
    vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({ districts: mockDistricts });
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValue({ district: mockDistricts[0]! });
  });

  it('renders empty guide prompt when no active district is selected', async () => {
    renderWithProviders(<TelegramSetupPage />);

    expect(await screen.findByText('Туман танланмаган')).toBeTruthy();
    expect(
      screen.getByText('Telegram ботни созлаш учун аввал юқоридаги танлагичдан туманни танланг.')
    ).toBeTruthy();
  });

  it('renders "Not Configured" form when district has no bot connected', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: null,
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    expect(await screen.findByText('Telegram ботни улаш')).toBeTruthy();
    expect(screen.getByText('Бот токенини киритиш бўйича кўрсатма')).toBeTruthy();
    expect(screen.getByPlaceholderText('123456789:AAF...')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ботни текшириш ва улаш/i })).toBeTruthy();
  });

  it('validates bot token format and rejects invalid inputs', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: null,
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    const input = await screen.findByPlaceholderText('123456789:AAF...');
    const submitBtn = screen.getByRole('button', { name: /Ботни текшириш ва улаш/i });

    fireEvent.change(input, { target: { value: 'invalid_token_format' } });
    fireEvent.click(submitBtn);

    expect(
      await screen.findByText(/Илтимос, тўғри Telegram бот токенини киритинг/i)
    ).toBeTruthy();
  });

  it('connects valid bot successfully on submit', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: null,
    });
    vi.spyOn(telegramBotClient, 'connectDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    const input = await screen.findByPlaceholderText('123456789:AAF...');
    const submitBtn = screen.getByRole('button', { name: /Ботни текшириш ва улаш/i });

    fireEvent.change(input, {
      target: { value: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1' },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(telegramBotClient.connectDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1', {
        token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1',
      });
    });
  });

  it('renders "Connected / Valid" state with bot metadata and passive notice', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    expect(await screen.findByText('Бириктирилган Telegram бот')).toBeTruthy();
    expect(screen.getByText('ФАОЛ / УЛАНГАН')).toBeTruthy();
    expect(screen.getByText('Chilonzor Mahalla Bot')).toBeTruthy();
    expect(screen.getByText('@chilonzor_mahalla_bot')).toBeTruthy();
    expect(screen.getByText('123456789:••••••••••••')).toBeTruthy();
    expect(screen.getByText('AES-256-GCM билан ҳимояланган')).toBeTruthy();
    expect(screen.getByText('Пассив қабул режими')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ботни алмаштириш/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ботни узиш/i })).toBeTruthy();
  });

  it('opens and confirms bot replacement modal', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });
    vi.spyOn(telegramBotClient, 'connectDistrictTelegramBot').mockResolvedValueOnce({
      bot: { ...mockBot, botId: '987654321', botUsername: 'new_bot' },
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    const replaceBtn = await screen.findByRole('button', { name: /Ботни алмаштириш/i });
    fireEvent.click(replaceBtn);

    expect(await screen.findByText('Telegram ботни алмаштириш')).toBeTruthy();
    const modalInput = screen.getAllByPlaceholderText('123456789:AAF...')[0]!;
    fireEvent.change(modalInput, {
      target: { value: '987654321:ABCdefGHIjklMNOpqrSTUvwxYZ_Replacement1' },
    });

    const confirmReplaceBtn = screen.getByRole('button', { name: /Алмаштиришни тасдиқлаш/i });
    fireEvent.click(confirmReplaceBtn);

    await waitFor(() => {
      expect(telegramBotClient.connectDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1', {
        token: '987654321:ABCdefGHIjklMNOpqrSTUvwxYZ_Replacement1',
      });
    });
  });

  it('opens and confirms bot disconnection modal', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });
    vi.spyOn(telegramBotClient, 'disconnectDistrictTelegramBot').mockResolvedValueOnce({
      success: true,
      disconnectedBotId: '123456789',
    });

    renderWithProviders(<TelegramSetupPage districtId="dist_test_1" />);

    const disconnectBtn = await screen.findByRole('button', { name: /Ботни узиш/i });
    fireEvent.click(disconnectBtn);

    expect(await screen.findByText('Telegram ботни узишни тасдиқланг')).toBeTruthy();

    const confirmDeleteBtn = screen.getByRole('button', { name: /Ҳа, ботни узиш/i });
    fireEvent.click(confirmDeleteBtn);

    await waitFor(() => {
      expect(telegramBotClient.disconnectDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1');
    });
  });
});
