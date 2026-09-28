import { useState, useEffect } from 'react';

/**
 * Custom hook that listens to the user's OS / browser reduced-motion preferences.
 * Adheres to accessibility requirements (AC 7, AC 9).
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQueryList = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (mediaQueryList.addEventListener) {
      mediaQueryList.addEventListener('change', listener);
    } else if ('addListener' in mediaQueryList) {
      // Fallback for older browsers / jsdom
      (mediaQueryList as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(listener);
    }

    return () => {
      if (mediaQueryList.removeEventListener) {
        mediaQueryList.removeEventListener('change', listener);
      } else if ('removeListener' in mediaQueryList) {
        (mediaQueryList as { removeListener: (cb: (e: MediaQueryListEvent) => void) => void }).removeListener(listener);
      }
    };
  }, []);

  return prefersReducedMotion;
}
