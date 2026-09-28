import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActiveIssuesList } from '../../src/components/issues/ActiveIssuesList.js';
import { OperationalIssue } from '@mahalla-ovozi/api-contracts';
import { issuesClient } from '../../src/issues/issues-client.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
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

describe('Story 4.2 & Story 4.3: ActiveIssuesList Component Tests (AC 1, AC 3, AC 7, AC 16)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  const mockIssues: OperationalIssue[] = [
    {
      id: 'issue-crit-1',
      logicalKey: 'GLOBAL:global:database:DATABASE_CONNECTION_ERROR',
      scope: 'GLOBAL',
      districtId: null,
      districtName: null,
      component: 'database',
      issueCategory: 'DATABASE_CONNECTION_ERROR',
      severity: 'Critical',
      status: 'ACTIVE',
      healthStatus: 'Unavailable',
      sanitizedTitle: 'Маълумотлар базасига уланишда хатолик',
      sanitizedDescription: 'PostgreSQL сервери билан алоқа йўқолди.',
      recommendedAction: 'PostgreSQL сервери ҳолатини текширинг',
      targetRoute: null,
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      latestCheckAt: new Date().toISOString(),
      resolvedAt: null,
      isRetryEligible: false,
      metadata: null,
    },
    {
      id: 'issue-warn-1',
      logicalKey: 'DISTRICT:dist-1:telegram_bot:BOT_DISCONNECTED',
      scope: 'DISTRICT',
      districtId: 'dist-1',
      districtName: 'Чилонзор тумани',
      component: 'telegram_bot',
      issueCategory: 'BOT_DISCONNECTED',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'Degraded',
      sanitizedTitle: 'Telegram бот уланмаган ёки фаол эмас',
      sanitizedDescription: 'Чилонзор Telegram боти билан алоқа мавжуд эмас.',
      recommendedAction: 'Бот созламаларини текширинг',
      targetRoute: '/telegram-setup?districtId=dist-1',
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      latestCheckAt: new Date().toISOString(),
      resolvedAt: null,
      isRetryEligible: false,
      metadata: null,
    },
    {
      id: 'issue-retry-1',
      logicalKey: 'DISTRICT:dist-1:telegram_intake:MESSAGE_INTAKE_DELAY',
      scope: 'DISTRICT',
      districtId: 'dist-1',
      districtName: 'Чилонзор тумани',
      component: 'message_intake',
      issueCategory: 'MESSAGE_INTAKE_DELAY',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'Degraded',
      sanitizedTitle: 'Telegram хабарларни қабул қилиш кечикмоқда',
      sanitizedDescription: 'Хабарларни қабул қилиш ва саралаш навбати тўхталган.',
      recommendedAction: 'Хабарларни қайта ижро этинг',
      targetRoute: null,
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      latestCheckAt: new Date().toISOString(),
      resolvedAt: null,
      isRetryEligible: true,
      pendingRetry: false,
      retryCount: 0,
      metadata: { intakeId: 'intake-1' },
    },
  ];

  it('renders active operational issues with severity badges, titles, and relative duration', () => {
    const onSelectIssue = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={mockIssues}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Фаол техник муаммолар')).toBeTruthy();
    expect(screen.getByText('Маълумотлар базасига уланишда хатолик')).toBeTruthy();
    expect(screen.getByText('Telegram бот уланмаган ёки фаол эмас')).toBeTruthy();
    expect(screen.getByText('Telegram хабарларни қабул қилиш кечикмоқда')).toBeTruthy();
    expect(screen.getByText('Муҳим')).toBeTruthy();
    expect(screen.getByText('10 дақиқа олдин')).toBeTruthy();
  });

  it('renders empty state when there are zero active issues', () => {
    const onSelectIssue = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={[]}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Фаол техник муаммолар мавжуд эмас')).toBeTruthy();
    expect(screen.getByText('Барча тизим ва туман хизматлари барқарор ишламоқда')).toBeTruthy();
  });

  it('renders retry button only for retry-eligible issues (Story 4.3 AC 1)', () => {
    const onSelectIssue = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={mockIssues}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    const retryButtons = screen.getAllByRole('button', { name: /қайта ижро этиш/i });
    expect(retryButtons.length).toBe(1);
    expect(screen.getByText('Қайта уриниш')).toBeTruthy();
  });

  it('renders disabled pending state when pendingRetry is true (Story 4.3 AC 1)', () => {
    const onSelectIssue = vi.fn();
    const pendingIssues: OperationalIssue[] = [
      {
        ...mockIssues[2]!,
        pendingRetry: true,
      },
    ];

    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={pendingIssues}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Қайта ижро этилмоқда...')).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: /қайта ижро этиш/i });
    expect(retryBtn.hasAttribute('disabled')).toBe(true);
  });

  it('calls onSelectIssue when "Батафсил" button is clicked', () => {
    const onSelectIssue = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={mockIssues}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    const detailButtons = screen.getAllByRole('button', { name: /батафсил/i });
    expect(detailButtons.length).toBe(3);

    fireEvent.click(detailButtons[0]!);
    expect(onSelectIssue).toHaveBeenCalledWith(mockIssues[0], expect.anything());
  });

  it('triggers retry mutation upon Popconfirm confirmation (Story 4.3 AC 7)', async () => {
    const onSelectIssue = vi.fn();
    const retrySpy = vi.spyOn(issuesClient, 'retryOperationalIssue').mockResolvedValue({
      accepted: true,
      retryTrackingId: 'retry-track-123',
      operationType: 'TELEGRAM_CONTENT_QUALIFICATION',
      targetId: 'intake-1',
      queuedAt: new Date().toISOString(),
      message: 'Қайта ижро этиш навбатга муваффақиятли қўшилди.',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ActiveIssuesList
          issues={mockIssues}
          onSelectIssue={onSelectIssue}
        />
      </QueryClientProvider>,
    );

    const retryBtn = screen.getByRole('button', { name: /қайта ижро этиш/i });
    fireEvent.click(retryBtn);

    // Popconfirm opens
    expect(screen.getByText('Қайта ижро этишни тасдиқлайсизми?')).toBeTruthy();
    expect(screen.getByText('Ҳа, қайта ижро этиш')).toBeTruthy();

    // Confirm click
    const confirmBtn = screen.getByText('Ҳа, қайта ижро этиш');
    const buttonEl = confirmBtn.closest('button') || confirmBtn;
    fireEvent.click(buttonEl);

    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledWith('issue-retry-1', undefined);
    });
  });
});
