import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IssueDetailDrawer } from '../../src/components/issues/IssueDetailDrawer.js';
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('Story 4.2 & Story 4.3: IssueDetailDrawer Component Tests (AC 1, AC 5, AC 7, AC 9, AC 16)', () => {
  let queryClient: QueryClient;

  const mockIssue: OperationalIssue = {
    id: 'issue-test-1',
    logicalKey: 'DISTRICT:dist-1:telegram_bot:BOT_TOKEN_INVALID',
    scope: 'DISTRICT',
    districtId: 'dist-1',
    districtName: 'Чилонзор тумани',
    component: 'telegram_bot',
    issueCategory: 'BOT_TOKEN_INVALID',
    severity: 'Critical',
    status: 'ACTIVE',
    healthStatus: 'Unavailable',
    sanitizedTitle: 'Telegram бот токени нотўғри',
    sanitizedDescription: 'Чилонзор тумани учун киритилган Telegram бот токени яроқсиз ёки хато.',
    recommendedAction: 'Бот созламаларини текширинг ва токенни қайта киритинг',
    targetRoute: '/telegram-setup?districtId=dist-1',
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    latestCheckAt: new Date().toISOString(),
    resolvedAt: null,
    isRetryEligible: false,
    metadata: null,
  };

  const mockRetryEligibleIssue: OperationalIssue = {
    id: 'issue-retry-2',
    logicalKey: 'DISTRICT:dist-1:topic_projection:TOPIC_PROCESSING_DELAY',
    scope: 'DISTRICT',
    districtId: 'dist-1',
    districtName: 'Чилонзор тумани',
    component: 'ai_operations',
    issueCategory: 'TOPIC_PROCESSING_DELAY',
    severity: 'Warning',
    status: 'ACTIVE',
    healthStatus: 'Degraded',
    sanitizedTitle: 'Мавзуларни қайта ҳисоблаш кечикмоқда',
    sanitizedDescription: 'Мавзулар бўйича проекцияларни ҳисоблаш навбати тўхтаб қолган.',
    recommendedAction: 'Проекцияни қайта ҳисоблашни ишга туширинг',
    targetRoute: null,
    startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    latestCheckAt: new Date().toISOString(),
    resolvedAt: null,
    isRetryEligible: true,
    pendingRetry: false,
    retryCount: 1,
    lastRetryAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    metadata: { topicId: 'topic-123' },
  };

  beforeEach(() => {
    setupMatchMedia();
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.spyOn(issuesClient, 'getOperationalIssueDetail').mockResolvedValue({
      issue: mockIssue,
      auditEvents: [
        {
          id: 'audit-1',
          action: 'OPERATIONAL_ISSUE_DETECTED',
          actorId: 'system:health-monitor',
          actorRole: 'SYSTEM',
          createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          metadata: { issueId: 'issue-test-1' },
        },
      ],
    });
  });

  function renderDrawer(issue: OperationalIssue = mockIssue, open = true, onClose = vi.fn()) {
    const openerEl = document.createElement('button');
    document.body.appendChild(openerEl);
    const openerRef = { current: openerEl };

    return render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <IssueDetailDrawer
            issue={issue}
            open={open}
            onClose={onClose}
            openerRef={openerRef}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  }

  it('renders issue detail metadata, diagnostic attributes, and audit timeline', async () => {
    renderDrawer(mockIssue, true);

    expect(screen.getByText('Муаммо тафсилотлари')).toBeTruthy();
    expect(screen.getByText('Telegram бот токени нотўғри')).toBeTruthy();
    expect(screen.getByText('Чилонзор тумани')).toBeTruthy();
    expect(screen.getByText('telegram_bot')).toBeTruthy();
    expect(screen.getByText('BOT_TOKEN_INVALID')).toBeTruthy();
    expect(screen.getByText('Тавсия этилган ҳаракат')).toBeTruthy();
    expect(screen.getByText('Бот созламаларига ўтиш')).toBeTruthy();
  });

  it('navigates to target management route when action button is clicked', () => {
    const onClose = vi.fn();
    renderDrawer(mockIssue, true, onClose);

    const actionBtn = screen.getByRole('button', { name: /бот созламаларига ўтиш/i });
    fireEvent.click(actionBtn);

    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/telegram-setup?districtId=dist-1');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderDrawer(mockIssue, true, onClose);

    const closeBtn = screen.getByRole('button', {
      name: /муаммо тафсилотлари панелидан чиқиш/i,
    });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalled();
  });

  it('renders retry button in recommended action card for retry-eligible issues (Story 4.3 AC 1, AC 7)', async () => {
    vi.spyOn(issuesClient, 'getOperationalIssueDetail').mockResolvedValue({
      issue: mockRetryEligibleIssue,
      auditEvents: [
        {
          id: 'audit-1',
          action: 'OPERATIONAL_ISSUE_DETECTED',
          actorId: 'system:health-monitor',
          actorRole: 'SYSTEM',
          createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          metadata: { issueId: 'issue-retry-2' },
        },
        {
          id: 'audit-2',
          action: 'OPERATIONAL_RETRY_TRIGGERED',
          actorId: 'acc_po_123',
          actorRole: 'PRODUCT_OWNER',
          createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          metadata: {
            issueId: 'issue-retry-2',
            retryTrackingId: 'retry-track-456',
            reason: 'Тезкор қайта ҳисоблаш',
          },
        },
      ],
    });

    const retrySpy = vi.spyOn(issuesClient, 'retryOperationalIssue').mockResolvedValue({
      accepted: true,
      retryTrackingId: 'retry-track-789',
      operationType: 'TELEGRAM_TOPIC_PROJECTION',
      targetId: 'topic-123',
      queuedAt: new Date().toISOString(),
      message: 'Қайта ижро этиш навбатга муваффақиятли қўшилди.',
    });

    renderDrawer(mockRetryEligibleIssue, true);

    const retryBtn = await screen.findByRole('button', { name: /муаммони қайта ижро этиш/i });
    expect(retryBtn).toBeTruthy();

    fireEvent.click(retryBtn);

    // Popconfirm shows prompt
    expect(screen.getByText('Қайта ижро этишни тасдиқлайсизми?')).toBeTruthy();
    const confirmBtn = screen.getByText('Ҳа, қайта ижро этиш');
    const buttonEl = confirmBtn.closest('button') || confirmBtn;
    fireEvent.click(buttonEl);

    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledWith('issue-retry-2', undefined);
    });

    // Verify timeline displays OPERATIONAL_RETRY_TRIGGERED
    expect(await screen.findByText('Қайта ижро этиш сўралди')).toBeTruthy();
    expect(screen.getByText('Маҳсулот эгаси')).toBeTruthy();
    expect(screen.getByText(/Тезкор қайта ҳисоблаш/)).toBeTruthy();
  });
});
