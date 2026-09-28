import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LiveAnnouncerProvider } from '../../src/components/topics/LiveRegionAnnouncer.js';
import {
  useLiveAnnouncer,
  formatTopicUpdateAnnouncement,
} from '../../src/hooks/useLiveAnnouncer.js';

describe('Story 3.3: LiveRegionAnnouncer & Formatting Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 1: formatTopicUpdateAnnouncement formats atomic Uzbek Cyrillic messages correctly', () => {
    expect(formatTopicUpdateAnnouncement(2, 1)).toBe('2 та янги мавзу қўшилди, 1 та мавзуга янги хабар қўшилди.');
    expect(formatTopicUpdateAnnouncement(3, 0)).toBe('3 та янги мавзу қўшилди.');
    expect(formatTopicUpdateAnnouncement(0, 4)).toBe('4 та мавзуга янги хабар қўшилди.');
    expect(formatTopicUpdateAnnouncement(0, 0)).toBeNull();
  });

  it('Test 2: LiveAnnouncerProvider mounts permanent polite live region in DOM (AC 4)', () => {
    render(
      <LiveAnnouncerProvider>
        <div>Content</div>
      </LiveAnnouncerProvider>,
    );

    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toBeTruthy();
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.getAttribute('aria-atomic')).toBe('true');
    expect(liveRegion.id).toBe('dashboard-live-region');
  });

  it('Test 3: announce debounces by 350ms before setting message (AC 4)', () => {
    const TestComponent = () => {
      const { announceTopicUpdate } = useLiveAnnouncer();
      return (
        <button
          onClick={() => {
            announceTopicUpdate(2, 1);
          }}
        >
          Trigger Update
        </button>
      );
    };

    render(
      <LiveAnnouncerProvider>
        <TestComponent />
      </LiveAnnouncerProvider>,
    );

    const liveRegion = screen.getByRole('status');
    expect(liveRegion.textContent).toBe('');

    const button = screen.getByRole('button', { name: 'Trigger Update' });
    act(() => {
      button.click();
    });

    // Before 350ms, region remains empty
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(liveRegion.textContent).toBe('');

    // After 350ms + 50ms string reset, message appears
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(liveRegion.textContent).toBe('2 та янги мавзу қўшилди, 1 та мавзуга янги хабар қўшилди.');
  });
});
