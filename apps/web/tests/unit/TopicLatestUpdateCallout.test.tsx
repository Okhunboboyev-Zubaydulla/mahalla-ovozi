import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { TopicLatestUpdateCallout } from '../../src/components/topics/TopicLatestUpdateCallout.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

describe('TopicLatestUpdateCallout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders null when evidenceCount < 2 even if latestUpdate is provided', () => {
    const { container } = render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicLatestUpdateCallout
          latestUpdate="14-уйда свет ўчди"
          evidenceCount={1}
          timestamp="2026-09-11T10:00:00.000Z"
        />
      </ConfigProvider>,
    );

    expect(screen.queryByTestId('topic-latest-update-callout')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders null when latestUpdate is null, undefined, or empty string', () => {
    const { rerender } = render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicLatestUpdateCallout
          latestUpdate={null}
          evidenceCount={3}
          timestamp="2026-09-11T10:00:00.000Z"
        />
      </ConfigProvider>,
    );
    expect(screen.queryByTestId('topic-latest-update-callout')).toBeNull();

    rerender(
      <ConfigProvider theme={mahallaTheme}>
        <TopicLatestUpdateCallout
          latestUpdate="   "
          evidenceCount={3}
          timestamp="2026-09-11T10:00:00.000Z"
        />
      </ConfigProvider>,
    );
    expect(screen.queryByTestId('topic-latest-update-callout')).toBeNull();
  });

  it('renders callout with relative time and message text when evidenceCount >= 2 and latestUpdate exists', () => {
    const now = new Date('2026-09-11T10:15:00.000Z');
    vi.setSystemTime(now);

    const timestamp = '2026-09-11T10:00:00.000Z'; // 15 minutes ago
    const latestUpdate = '14-уй олдида электр сими ёнаётгани маълум қилинди';

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicLatestUpdateCallout
          latestUpdate={latestUpdate}
          evidenceCount={2}
          timestamp={timestamp}
        />
      </ConfigProvider>,
    );

    const callout = screen.getByTestId('topic-latest-update-callout');
    expect(callout).toBeDefined();
    expect(callout.textContent).toContain('Сўнгги хабар');
    expect(callout.textContent).toContain('15 дақ олдин');
    expect(callout.textContent).toContain(latestUpdate);
  });

  it('highlights search query inside latestUpdate', () => {
    const now = new Date('2026-09-11T10:05:00.000Z');
    vi.setSystemTime(now);

    const timestamp = '2026-09-11T10:00:00.000Z';
    const latestUpdate = '14-уй олдида кабел ёнаётгани маълум қилинди';

    render(
      <ConfigProvider theme={mahallaTheme}>
        <TopicLatestUpdateCallout
          latestUpdate={latestUpdate}
          evidenceCount={4}
          timestamp={timestamp}
          searchQuery="кабел"
        />
      </ConfigProvider>,
    );

    const callout = screen.getByTestId('topic-latest-update-callout');
    const markEl = callout.querySelector('mark');
    expect(markEl).toBeDefined();
    expect(markEl?.textContent).toBe('кабел');
  });
});
