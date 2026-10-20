import { useEffect, useState } from 'react';

/**
 * Delays an "active" flag before it becomes visible.
 *
 * Returns false while `active` has been true for less than `delayMs`, and true
 * once it has stayed true continuously for at least `delayMs`. Resets to false
 * immediately when `active` becomes false. Use it to avoid flashing loading
 * skeletons for work that usually finishes almost instantly.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [isDelayedActive, setIsDelayedActive] = useState(false);

  useEffect(() => {
    if (!active) {
      setIsDelayedActive(false);
      return;
    }

    const timer = setTimeout(() => {
      setIsDelayedActive(true);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return isDelayedActive;
}
