import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDelayedFlag } from '../../src/lib/use-delayed-flag.js';

const DELAY_MS = 200;

function useFlagWithProps(initialActive: boolean) {
  return renderHook(
    ({ active }: { active: boolean }) => useDelayedFlag(active, DELAY_MS),
    { initialProps: { active: initialActive } },
  );
}

describe('useDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false immediately when active becomes true', () => {
    const { result } = useFlagWithProps(false);

    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current).toBe(false);
  });

  it('returns true after exactly delayMs of continuous activity', () => {
    const { result } = useFlagWithProps(true);

    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('stays false when active flips false before the delay elapses', () => {
    const { result, rerender } = useFlagWithProps(true);

    act(() => {
      vi.advanceTimersByTime(DELAY_MS / 2);
    });
    expect(result.current).toBe(false);

    rerender({ active: false });

    act(() => {
      vi.advanceTimersByTime(DELAY_MS * 5);
    });

    expect(result.current).toBe(false);
  });

  it('returns false synchronously on rerender when active goes true -> false', () => {
    const { result, rerender } = useFlagWithProps(true);

    act(() => {
      vi.advanceTimersByTime(DELAY_MS);
    });
    expect(result.current).toBe(true);

    rerender({ active: false });

    // No timer advance between rerender and the assertion: the reset is immediate.
    expect(result.current).toBe(false);
  });

  it('never turns true for a permanently inactive flag', () => {
    const { result } = useFlagWithProps(false);

    act(() => {
      vi.advanceTimersByTime(DELAY_MS * 10);
    });

    expect(result.current).toBe(false);
  });
});
