import { useEffect, useState, startTransition, RefObject } from 'react';

export interface UseBottomSentinelObserverOptions {
  rootRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLElement | null>;
  thresholdOffsetPx: number;
  enabled: boolean;
  direction?: 'bottom' | 'top';
}

/**
 * Zero-overhead scroll position detection using native IntersectionObserver.
 * Completely replaces onScroll event listeners, eliminating layout thrashing and main-thread lag.
 * Supports both bottom sentinel (detecting scroll-up) and top sentinel (detecting scroll-down).
 */
export function useBottomSentinelObserver({
  rootRef,
  sentinelRef,
  thresholdOffsetPx,
  enabled,
  direction,
}: UseBottomSentinelObserverOptions): boolean {
  const [isScrolledAway, setIsScrolledAway] = useState<boolean>(false);
  const effectiveDirection = direction ?? 'bottom';

  useEffect(() => {
    if (!enabled) {
      setIsScrolledAway(false);
      return;
    }

    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) {
      return;
    }

    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }

    // Root margin configuration:
    // For bottom sentinel: extends upwards by thresholdOffsetPx
    // For top sentinel: extends downwards by thresholdOffsetPx
    const rootMargin =
      effectiveDirection === 'top'
        ? `${thresholdOffsetPx}px 0px 0px 0px`
        : `0px 0px ${thresholdOffsetPx}px 0px`;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry) return;

        // When sentinel is NOT intersecting with (viewport + buffer), user has scrolled away
        const scrolledAway = !entry.isIntersecting;
        startTransition(() => {
          setIsScrolledAway(scrolledAway);
        });
      },
      {
        root,
        rootMargin,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [rootRef, sentinelRef, thresholdOffsetPx, enabled, effectiveDirection]);

  return isScrolledAway;
}

export const useSentinelObserver = useBottomSentinelObserver;
