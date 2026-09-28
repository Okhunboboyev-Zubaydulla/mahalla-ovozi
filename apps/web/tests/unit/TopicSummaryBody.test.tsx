import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { TopicSummaryBody } from '../../src/components/topics/TopicSummaryBody.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

describe('TopicSummaryBody', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders skeleton shimmer when summary is pending and within 60 seconds', () => {
    const now = new Date('2026-08-24T12:00:10.000Z');
    vi.setSystemTime(now);

    const createdAt = new Date('2026-08-24T12:00:00.000Z').toISOString(); // 10s old

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicSummaryBody summary={null} createdAt={createdAt} />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('topic-summary-skeleton')).toBeDefined();
    expect(screen.queryByTestId('topic-summary-delayed')).toBeNull();
    expect(screen.queryByTestId('topic-summary-ready')).toBeNull();
  });

  it('renders delayed warning notice when summary is pending and older than 60 seconds', () => {
    const now = new Date('2026-08-24T12:01:15.000Z');
    vi.setSystemTime(now);

    const createdAt = new Date('2026-08-24T12:00:00.000Z').toISOString(); // 75s old

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicSummaryBody summary={null} createdAt={createdAt} />
      </ConfigProvider>,
    );

    expect(screen.queryByTestId('topic-summary-skeleton')).toBeNull();
    const delayedNotice = screen.getByTestId('topic-summary-delayed');
    expect(delayedNotice).toBeDefined();
    expect(delayedNotice.textContent).toContain('Мавзу хулосаси кечикмоқда (хабарлар мавжуд)');
  });

  it('transitions from skeleton to delayed notice when 60 seconds elapse', () => {
    const now = new Date('2026-08-24T12:00:50.000Z');
    vi.setSystemTime(now);

    const createdAt = new Date('2026-08-24T12:00:00.000Z').toISOString(); // 50s old

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicSummaryBody summary={null} createdAt={createdAt} />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('topic-summary-skeleton')).toBeDefined();
    expect(screen.queryByTestId('topic-summary-delayed')).toBeNull();

    // Advance 11 seconds (total 61s since createdAt)
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(screen.queryByTestId('topic-summary-skeleton')).toBeNull();
    expect(screen.getByTestId('topic-summary-delayed')).toBeDefined();
  });

  it('renders completed summary text when summary is ready', () => {
    const createdAt = new Date('2026-08-24T12:00:00.000Z').toISOString();
    const summaryText = 'Чилонзор кўчасида сув қувури ёрилиб, йўлни сув босган.';

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicSummaryBody summary={summaryText} createdAt={createdAt} />
      </ConfigProvider>,
    );

    expect(screen.queryByTestId('topic-summary-skeleton')).toBeNull();
    expect(screen.queryByTestId('topic-summary-delayed')).toBeNull();
    const readyEl = screen.getByTestId('topic-summary-ready');
    expect(readyEl).toBeDefined();
    expect(readyEl.textContent).toContain(summaryText);
  });

  it('highlights matching search query in completed summary', () => {
    const createdAt = new Date('2026-08-24T12:00:00.000Z').toISOString();
    const summaryText = 'Чилонзор кўчасида сув қувури ёрилган.';

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicSummaryBody summary={summaryText} createdAt={createdAt} searchQuery="сув" />
      </ConfigProvider>,
    );

    const readyEl = screen.getByTestId('topic-summary-ready');
    const markEl = readyEl.querySelector('mark');
    expect(markEl).toBeDefined();
    expect(markEl?.textContent).toBe('сув');
  });
});
