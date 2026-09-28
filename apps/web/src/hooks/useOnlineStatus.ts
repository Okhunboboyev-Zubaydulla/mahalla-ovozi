import { useState, useEffect } from 'react';

/**
 * Tracks the browser's online/offline status reactively.
 * Returns true when the browser reports no network connectivity.
 *
 * SSR-safe: initialises to false (optimistic), then syncs from
 * navigator.onLine inside useEffect so it never runs on the server.
 */
export function useOnlineStatus(): boolean {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    // Sync initial state from the real browser value
    setIsOffline(!navigator.onLine);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOffline;
}
