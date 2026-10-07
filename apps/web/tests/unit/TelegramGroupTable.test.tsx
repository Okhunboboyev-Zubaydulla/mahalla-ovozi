import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelegramGroupTable } from '../../src/components/TelegramGroupTable.js';
import { telegramGroupClient } from '../../src/district/telegram-group-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { TelegramGroupMapping } from '@mahalla-ovozi/api-contracts';

/**
 * The role the mounted component observes. Left undefined by default so the pre-existing
 * table tests keep the exact surface they were written against, and set explicitly by the
 * role-gating and bulk-action tests below.
 */
const authState = vi.hoisted(() => ({ role: undefined as string | undefined }));

vi.mock('../../src/auth/auth-context.js', () => ({
  useOptionalAuth: () =>
    authState.role
      ? { actor: { id: 'actor_1', role: authState.role, username: 'operator' } }
      : undefined,
}));

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
    isPaused: false,
    isPausedSkippedCount: 0,
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
    isPaused: false,
    isPausedSkippedCount: 0,
    testMessageReceivedAt: null,
    lastValidatedAt: null,
    lastError: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  },
];

function renderTable(
  groups: TelegramGroupMapping[] = mockGroups,
  options: { productOwner?: boolean } = {},
) {
  authState.role = options.productOwner ? 'PRODUCT_OWNER' : undefined;
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
        <AntdApp>
          <TelegramGroupTable districtId="dist_test_1" />
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

/** Selects one option from the paused-state filter. */
async function choosePausedFilter(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText(label));
}

describe('TelegramGroupTable Component Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks also clears the bare vi.fn() matchMedia implementation.
    setupMatchMedia();
    authState.role = undefined;
  });

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
        privacyModeDisabled: false,
      },
      {
        ...mockGroups[1]!,
        transport: 'USERBOT',
        privacyModeDisabled: false,
      },
    ];

    renderTable(mixedGroups);

    await waitFor(() => {
      expect(screen.getByText('BOT_API')).toBeDefined();
      expect(screen.getByText('USERBOT')).toBeDefined();
      expect(screen.getByTestId('privacy-mode-restricted').textContent).toContain('Фаол (Чекланган)');
      expect(screen.getByTestId('privacy-mode-userbot').textContent).toContain('Талаб этилмайди (Тўлиқ қабул)');
    });
  });
});

describe('TelegramGroupTable bulk pause/resume tests', () => {
  const pausedGroup: TelegramGroupMapping = {
    ...mockGroups[1]!,
    id: 'grp_paused',
    mahallaName: 'Гулистон',
    telegramChatTitle: 'Гулистон гуруҳи',
    isPaused: true,
    isPausedSkippedCount: 7,
  };

  function pauseResponse(groups: TelegramGroupMapping[]) {
    return { groups };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    authState.role = undefined;
    vi.spyOn(telegramGroupClient, 'pauseGroups').mockResolvedValue(
      pauseResponse([{ ...mockGroups[0]!, isPaused: true }]),
    );
    vi.spyOn(telegramGroupClient, 'resumeGroups').mockResolvedValue(
      pauseResponse([{ ...pausedGroup, isPaused: false }]),
    );
  });

  it('lets a Product Owner select a single row and sends an explicit one-id list on confirm', async () => {
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    fireEvent.click(screen.getByLabelText('Навбаҳор гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));

    expect(await screen.findByTestId('pause-confirm-count')).toHaveProperty(
      'textContent',
      '1 та гуруҳ тўхтатилади.',
    );

    fireEvent.click(screen.getByTestId('pause-confirm-submit'));

    await waitFor(() => {
      expect(telegramGroupClient.pauseGroups).toHaveBeenCalledWith('dist_test_1', ['grp_1']);
    });
  });

  it('sends one request carrying both selected ids when several rows are selected', async () => {
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    fireEvent.click(screen.getByLabelText('Навбаҳор гуруҳини танлаш'));
    fireEvent.click(screen.getByLabelText('Бўстон гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));
    fireEvent.click(await screen.findByTestId('pause-confirm-submit'));

    await waitFor(() => {
      expect(telegramGroupClient.pauseGroups).toHaveBeenCalledTimes(1);
      expect(telegramGroupClient.pauseGroups).toHaveBeenCalledWith('dist_test_1', ['grp_1', 'grp_2']);
    });
  });

  it('select-all covers the filtered view only and never the hidden rows', async () => {
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    fireEvent.change(
      screen.getByPlaceholderText('Маҳалла номи ёки Chat ID бўйича қидириш...'),
      { target: { value: 'Бўстон' } },
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('Навбаҳор гуруҳини танлаш')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('select-all-visible'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));
    fireEvent.click(await screen.findByTestId('pause-confirm-submit'));

    await waitFor(() => {
      expect(telegramGroupClient.pauseGroups).toHaveBeenCalledWith('dist_test_1', ['grp_2']);
    });
  });

  it('shows the confirmation warning and sends no request when cancelled', async () => {
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    fireEvent.click(screen.getByLabelText('Навбаҳор гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));

    expect(await screen.findByText('Тўхтатилган гуруҳлардан келадиган хабарлар йўқ қилинади')).toBeDefined();
    expect(screen.getByTestId('pause-confirm-count').textContent).toBe('1 та гуруҳ тўхтатилади.');

    fireEvent.click(screen.getByTestId('pause-confirm-cancel'));

    await waitFor(() => {
      expect(telegramGroupClient.pauseGroups).not.toHaveBeenCalled();
    });
    // The badge states what the server reported, never an optimistic guess.
    expect(screen.queryByTestId('paused-badge-grp_1')).toBeNull();
  });

  it('renders the skipped-message badge for a paused group without alarm when the count is zero', async () => {
    renderTable([{ ...pausedGroup, isPausedSkippedCount: 0 }], { productOwner: true });

    await waitFor(() => {
      expect(screen.getByTestId('paused-badge-grp_paused').textContent).toContain(
        'Тўхтатилган — ҳали хабар ўтказиб юборилмади',
      );
      expect(screen.getByTestId('paused-badge-grp_paused').textContent).not.toContain('0 та хабар');
    });
  });

  it('renders the skipped-message count inside the paused badge', async () => {
    renderTable([pausedGroup], { productOwner: true });

    await waitFor(() => {
      expect(screen.getByTestId('paused-badge-grp_paused').textContent).toContain(
        '7 та хабар ўтказиб юборилди',
      );
    });
  });

  it('resumes only the selected paused groups', async () => {
    renderTable([pausedGroup, mockGroups[0]!], { productOwner: true });

    await screen.findByText('Гулистон');
    fireEvent.click(screen.getByLabelText('Гулистон гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни давом эттириш/i }));

    await waitFor(() => {
      expect(telegramGroupClient.resumeGroups).toHaveBeenCalledWith('dist_test_1', ['grp_paused']);
    });
  });

  it('reflects the server-reported state after a successful pause', async () => {
    let currentGroups = mockGroups;
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    expect(screen.queryByTestId('paused-badge-grp_1')).toBeNull();

    // The list the server would return once the pause has been applied.
    vi.spyOn(telegramGroupClient, 'listGroups').mockImplementation(async () => ({
      groups: currentGroups,
    }));
    vi.spyOn(telegramGroupClient, 'pauseGroups').mockImplementation(async () => {
      currentGroups = mockGroups.map((group) =>
        group.id === 'grp_1' ? { ...group, isPaused: true } : group,
      );
      return { groups: currentGroups.filter((group) => group.id === 'grp_1') };
    });

    fireEvent.click(screen.getByLabelText('Навбаҳор гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));
    fireEvent.click(await screen.findByTestId('pause-confirm-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('paused-badge-grp_1')).toBeDefined();
      expect(screen.queryByTestId('paused-badge-grp_2')).toBeNull();
    });
  });

  it('does not invent an optimistic pause for a group the server did not report', async () => {
    vi.spyOn(telegramGroupClient, 'pauseGroups').mockResolvedValue(pauseResponse([]));
    renderTable(mockGroups, { productOwner: true });

    await screen.findByText('Навбаҳор');
    fireEvent.click(screen.getByLabelText('Навбаҳор гуруҳини танлаш'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни тўхтатиш/i }));
    fireEvent.click(await screen.findByTestId('pause-confirm-submit'));

    await waitFor(() => {
      expect(telegramGroupClient.pauseGroups).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('paused-badge-grp_1')).toBeNull();
  });

  it('renders no selection or bulk controls for a District Hokim', async () => {
    renderTable([pausedGroup]);

    await screen.findByText('Гулистон');

    expect(screen.queryByTestId('select-all-visible')).toBeNull();
    expect(screen.queryByLabelText('Гулистон гуруҳини танлаш')).toBeNull();
    expect(screen.queryByRole('button', { name: /Танланганларни тўхтатиш/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Танланганларни давом эттириш/i })).toBeNull();
    // Spec line 534 leaves the Hokim's visibility of the paused state unsettled; the safest
    // default is to hide the badge until that product question is decided.
    expect(screen.queryByTestId('paused-badge-grp_paused')).toBeNull();
  });

  it('keeps the paused badge visible to the Product Owner who operates the control', async () => {
    renderTable([pausedGroup], { productOwner: true });

    await screen.findByText('Гулистон');

    expect(screen.getByTestId('paused-badge-grp_paused')).toBeDefined();
  });

  it('filters the list down to paused groups only and hides the active ones', async () => {
    renderTable([pausedGroup, mockGroups[0]!]);

    await screen.findByText('Гулистон');
    expect(screen.getByText('Навбаҳор')).toBeDefined();

    await choosePausedFilter('Фақат тўхтатилганлар');

    await waitFor(() => {
      expect(screen.getByText('Гулистон')).toBeDefined();
      expect(screen.queryByText('Навбаҳор')).toBeNull();
    });
  });

  it('scopes select-all to exactly the rows visible under the paused filter', async () => {
    renderTable([pausedGroup, mockGroups[0]!], { productOwner: true });

    await screen.findByText('Гулистон');

    await choosePausedFilter('Фақат тўхтатилганлар');

    await waitFor(() => {
      expect(screen.queryByLabelText('Навбаҳор гуруҳини танлаш')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('select-all-visible'));
    fireEvent.click(screen.getByRole('button', { name: /Танланганларни давом эттириш/i }));

    await waitFor(() => {
      expect(telegramGroupClient.resumeGroups).toHaveBeenCalledWith('dist_test_1', ['grp_paused']);
    });
  });
});
