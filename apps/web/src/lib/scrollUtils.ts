/**
 * Detects user preference for reduced motion (WCAG 2.2 Success Criterion 2.3.3).
 * Returns 'auto' (instant) when reduced motion is preferred by the operating system or browser,
 * or 'smooth' when fluid animation is acceptable.
 */
export function getSafeScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'smooth';
  }
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isReduced = mql?.matches ?? false;
  return isReduced ? 'auto' : 'smooth';
}
