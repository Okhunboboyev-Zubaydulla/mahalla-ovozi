import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelegramGroupTable } from '../../src/components/TelegramGroupTable.js';
import { telegramGroupClient } from '../../src/district/telegram-group-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { TelegramGroupMapping } from '@mahalla-ovozi/api-contracts';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
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

const mockGroups: TelegramGroupMapping[] = [
  {
    id: 'grp_1',
    districtId: 'dist_test_1',
    mahallaName: 'Навбаҳор',
    telegramChatId: '-1001234567890',
    telegramChatTitle: 'Навбаҳор маҳалла гуруҳи',
    telegramChatUsername: 'navbahor_group',
    status: 'VALID',
    botMembershipStatus: 'member',
    privacyModeDisabled: true,
    transport: 'BOT_API',
    testMessageReceivedAt: '2026-08-18T10:00:00.000Z',
    lastValidatedAt: '2026-08-18T10:00:00.000Z',
    lastError: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  },
  {
    id: 'grp_2',
    districtId: 'dist_test_1',
    mahallaName: 'Бўстон',
    telegramChatId: '-1009876543210',
    telegramChatTitle: 'Бўстон маҳалласи',
    telegramChatUsername: null,
    status: 'PENDING',
    botMembershipStatus: 'member',
    privacyModeDisabled: true,
    transport: 'BOT_API',
    testMessageReceivedAt: null,
    lastValidatedAt: null,
    lastError: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  },
];

function renderTable(groups: TelegramGroupMapping[] = mockGroups) {
  vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValue({ groups });
  vi.spyOn(telegramGroupClient, 'deleteGroup').mockResolvedValue({ success: true, deletedGroupId: 'grp_1' });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupTable districtId="dist_test_1" />
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('TelegramGroupTable Component Tests', () => {
  it('renders table headers and group rows with status tags (AC 1, 14)', async () => {
    renderTable();

    await waitFor(() => {
      expect(screen.getByText('Маҳаллалар ва Telegram гуруҳлари харитаси')).toBeDefined();
      expect(screen.getByText('Навбаҳор')).toBeDefined();
      expect(screen.getByText('Бўстон')).toBeDefined();
      expect(screen.getByText('ТАСДИҚЛАНГАН')).toBeDefined();
      expect(screen.getByText('КУТИЛМОҚДА')).toBeDefined();
    });
  });

  it('filters group rows by search input', async () => {
    renderTable();

    await waitFor(() => {
      expect(screen.getByText('Навбаҳор')).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText('Маҳалла номи ёки Chat ID бўйича қидириш...');
    fireEvent.change(searchInput, { target: { value: 'Бўстон' } });

    await waitFor(() => {
      expect(screen.queryByText('Навбаҳор')).toBeNull();
      expect(screen.getByText('Бўстон')).toBeDefined();
    });
  });

  it('renders empty state when no groups exist', async () => {
    renderTable([]);

    await waitFor(() => {
      expect(screen.getByText('Ҳали биронта маҳалла гуруҳи бириктирилмаган')).toBeDefined();
    });
  });

  it('opens drawer when "Янги гуруҳ қўшиш" button is clicked', async () => {
    renderTable();

    await waitFor(() => {
      expect(screen.getByText('Янги гуруҳ қўшиш')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Янги гуруҳ қўшиш'));

    await waitFor(() => {
      expect(screen.getByText('Маҳалла Telegram гуруҳини бириктириш')).toBeDefined();
    });
  });

  it('renders transport tags for BOT_API and USERBOT in the table', async () => {
    const mixedGroups: TelegramGroupMapping[] = [
      {
        ...mockGroups[0]!,
        transport: 'BOT_API',
      },
      {
        ...mockGroups[1]!,
        transport: 'USERBOT',
      },
    ];

    renderTable(mixedGroups);

    await waitFor(() => {
      expect(screen.getByText('BOT_API')).toBeDefined();
      expect(screen.getByText('USERBOT')).toBeDefined();
    });
  });
});
