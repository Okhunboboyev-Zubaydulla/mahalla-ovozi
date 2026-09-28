import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { TelegramGroupDrawer } from '../../src/components/TelegramGroupDrawer.js';
import { telegramGroupClient } from '../../src/district/telegram-group-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

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

beforeEach(() => {
  vi.restoreAllMocks();
  setupMatchMedia();
});

describe('TelegramGroupDrawer Component Tests', () => {
  it('prevents submission when required fields are empty', async () => {
    const createGroupSpy = vi.spyOn(telegramGroupClient, 'createGroup');

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={() => {}}
          districtId="dist_test_1"
        />
      </ConfigProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Бириктириш/i }));

    await waitFor(() => {
      expect(createGroupSpy).not.toHaveBeenCalled();
    });
  });

  it('submits form, calls createGroup, triggers onGroupSaved, and closes drawer', async () => {
    const onGroupSavedMock = vi.fn();
    const onCloseMock = vi.fn();

    const createGroupSpy = vi.spyOn(telegramGroupClient, 'createGroup').mockResolvedValue({
      group: {
        id: 'grp_new',
        districtId: 'dist_test_1',
        mahallaName: 'Янгиобод',
        telegramChatId: '-1001112223334',
        telegramChatTitle: 'Янгиобод Гуруҳи',
        telegramChatUsername: null,
        status: 'VALID',
        botMembershipStatus: 'member',
        privacyModeDisabled: true,
        transport: 'BOT_API',
        testMessageReceivedAt: null,
        lastValidatedAt: '2026-08-18T10:00:00.000Z',
        lastError: null,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
      },
    });

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={onCloseMock}
          districtId="dist_test_1"
          onGroupSaved={onGroupSavedMock}
        />
      </ConfigProvider>,
    );

    const mahallaInput = screen.getByPlaceholderText('Масалан: Навбаҳор');
    const chatIdInput = screen.getByPlaceholderText('Масалан: -1001234567890');

    fireEvent.change(mahallaInput, { target: { value: 'Янгиобод' } });
    fireEvent.change(chatIdInput, { target: { value: '-1001112223334' } });

    fireEvent.click(screen.getByText('Текшириш ва бириктириш'));

    await waitFor(() => {
      expect(createGroupSpy).toHaveBeenCalledWith('dist_test_1', {
        mahallaName: 'Янгиобод',
        telegramChatId: '-1001112223334',
        transport: 'BOT_API',
      });
      expect(onGroupSavedMock).toHaveBeenCalledTimes(1);
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('allows selecting USERBOT transport and submits with transport: USERBOT', async () => {
    const onGroupSavedMock = vi.fn();
    const onCloseMock = vi.fn();

    const createGroupSpy = vi.spyOn(telegramGroupClient, 'createGroup').mockResolvedValue({
      group: {
        id: 'grp_new_userbot',
        districtId: 'dist_test_1',
        mahallaName: 'Userbot Mahalla',
        telegramChatId: '-1001112223334',
        telegramChatTitle: 'Userbot Mahalla Chat',
        telegramChatUsername: null,
        status: 'VALID',
        botMembershipStatus: null,
        privacyModeDisabled: false,
        transport: 'USERBOT',
        testMessageReceivedAt: null,
        lastValidatedAt: null,
        lastError: null,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
      },
    });

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={onCloseMock}
          districtId="dist_test_1"
          onGroupSaved={onGroupSavedMock}
        />
      </ConfigProvider>,
    );

    const mahallaInput = screen.getByPlaceholderText('Масалан: Навбаҳор');
    const chatIdInput = screen.getByPlaceholderText('Масалан: -1001234567890');

    fireEvent.change(mahallaInput, { target: { value: 'Userbot Mahalla' } });
    fireEvent.change(chatIdInput, { target: { value: '-1001112223334' } });

    const combobox = screen.getByRole('combobox');
    fireEvent.mouseDown(combobox);
    const userbotOption = await screen.findByText('Userbot');
    fireEvent.click(userbotOption);

    fireEvent.click(screen.getByText('Текшириш ва бириктириш'));

    await waitFor(() => {
      expect(createGroupSpy).toHaveBeenCalledWith('dist_test_1', {
        mahallaName: 'Userbot Mahalla',
        telegramChatId: '-1001112223334',
        transport: 'USERBOT',
      });
      expect(onGroupSavedMock).toHaveBeenCalledTimes(1);
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces USERBOT_SESSION_NOT_ACTIVE refusal message to the operator when backend rejects USERBOT', async () => {
    const onCloseMock = vi.fn();
    const refusalReason = 'Туманда Userbot сессияси мавжуд эмас (District ID: dist_test_1).';

    vi.spyOn(telegramGroupClient, 'createGroup').mockRejectedValue(
      new Error(refusalReason),
    );

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={onCloseMock}
          districtId="dist_test_1"
        />
      </ConfigProvider>,
    );

    const mahallaInput = screen.getByPlaceholderText('Масалан: Навбаҳор');
    const chatIdInput = screen.getByPlaceholderText('Масалан: -1001234567890');

    fireEvent.change(mahallaInput, { target: { value: 'Refused Mahalla' } });
    fireEvent.change(chatIdInput, { target: { value: '-1009998887776' } });

    const combobox = screen.getByRole('combobox');
    fireEvent.mouseDown(combobox);
    const userbotOption = await screen.findByText('Userbot');
    fireEvent.click(userbotOption);

    fireEvent.click(screen.getByText('Текшириш ва бириктириш'));

    await waitFor(() => {
      expect(screen.getByText('Бириктиришда хатолик')).toBeDefined();
      expect(screen.getByText(refusalReason)).toBeDefined();
      expect(onCloseMock).not.toHaveBeenCalled();
    });
  });

  it('pre-fills fields and updates group on submit when initialGroup is provided', async () => {
    const onGroupSavedMock = vi.fn();
    const onCloseMock = vi.fn();

    const updateGroupSpy = vi.spyOn(telegramGroupClient, 'updateGroup').mockResolvedValue({
      group: {
        id: 'grp_edit',
        districtId: 'dist_test_1',
        mahallaName: 'Гулистон Янги',
        telegramChatId: '-1005556667778',
        telegramChatTitle: 'Гулистон Гуруҳи',
        telegramChatUsername: null,
        status: 'VALID',
        botMembershipStatus: 'member',
        privacyModeDisabled: true,
        transport: 'BOT_API',
        testMessageReceivedAt: null,
        lastValidatedAt: '2026-08-18T10:00:00.000Z',
        lastError: null,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
      },
    });

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={onCloseMock}
          districtId="dist_test_1"
          onGroupSaved={onGroupSavedMock}
          initialGroup={{
            id: 'grp_edit',
            districtId: 'dist_test_1',
            mahallaName: 'Гулистон',
            telegramChatId: '-1005556667778',
            telegramChatTitle: 'Гулистон Гуруҳи',
            telegramChatUsername: null,
            status: 'VALID',
            botMembershipStatus: 'member',
            privacyModeDisabled: true,
            transport: 'BOT_API',
            testMessageReceivedAt: null,
            lastValidatedAt: null,
            lastError: null,
            createdAt: '2026-08-18T10:00:00.000Z',
            updatedAt: '2026-08-18T10:00:00.000Z',
          }}
        />
      </ConfigProvider>,
    );

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByDisplayValue('Гулистон')).toBeDefined();
    expect(screen.getByDisplayValue('-1005556667778')).toBeDefined();

    const mahallaInput = screen.getByDisplayValue('Гулистон');
    fireEvent.change(mahallaInput, { target: { value: 'Гулистон Янги' } });

    fireEvent.click(screen.getByText('Сақлаш'));

    await waitFor(() => {
      expect(updateGroupSpy).toHaveBeenCalledWith('dist_test_1', 'grp_edit', {
        mahallaName: 'Гулистон Янги',
        telegramChatId: '-1005556667778',
        transport: 'BOT_API',
      });
      expect(onGroupSavedMock).toHaveBeenCalledTimes(1);
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('displays error alert when createGroup fails and leaves drawer open', async () => {
    const onCloseMock = vi.fn();

    vi.spyOn(telegramGroupClient, 'createGroup').mockRejectedValue(
      new Error('Бот ушбу гуруҳда мавжуд эмас.'),
    );

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TelegramGroupDrawer
          open={true}
          onClose={onCloseMock}
          districtId="dist_test_1"
        />
      </ConfigProvider>,
    );

    const mahallaInput = screen.getByPlaceholderText('Масалан: Навбаҳор');
    const chatIdInput = screen.getByPlaceholderText('Масалан: -1001234567890');

    fireEvent.change(mahallaInput, { target: { value: 'Хатолик Маҳалла' } });
    fireEvent.change(chatIdInput, { target: { value: '-1009998887776' } });

    fireEvent.click(screen.getByText('Текшириш ва бириктириш'));

    await waitFor(() => {
      expect(screen.getByText('Бириктиришда хатолик')).toBeDefined();
      expect(screen.getByText('Бот ушбу гуруҳда мавжуд эмас.')).toBeDefined();
      expect(onCloseMock).not.toHaveBeenCalled();
    });
  });
});
