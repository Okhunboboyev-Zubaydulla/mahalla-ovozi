import { useCallback } from 'react';

/**
 * Deterministically moves accessibility focus to the originating Lane header
 * or the dashboard main heading if the opener element is missing or unmounted (AC 7).
 */
export function useFocusFallback() {
  const returnFocus = useCallback((originatingLane?: string) => {
    if (originatingLane) {
      const laneHeader = document.getElementById(`lane-header-${originatingLane}`);
      if (laneHeader) {
        laneHeader.focus();
        return;
      }
    }

    const mainHeading = document.getElementById('dashboard-main-heading');
    if (mainHeading) {
      mainHeading.focus();
    }
  }, []);

  return { returnFocus };
}
