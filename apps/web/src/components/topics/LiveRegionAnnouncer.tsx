import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  LiveAnnouncerContext,
  LiveAnnouncerContextValue,
  formatTopicUpdateAnnouncement,
} from '../../hooks/useLiveAnnouncer.js';

export interface LiveAnnouncerProviderProps {
  children: React.ReactNode;
}

const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export const LiveAnnouncerProvider: React.FC<LiveAnnouncerProviderProps> = ({ children }) => {
  const [message, setMessage] = useState<string>('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const announce = useCallback((text: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }

    // 350ms debounce (AC 4)
    debounceTimerRef.current = setTimeout(() => {
      // Brief string reset to ensure consecutive identical announcements are caught by screen readers
      setMessage('');
      resetTimerRef.current = setTimeout(() => {
        setMessage(text);
      }, 50);
    }, 350);
  }, []);

  const announceTopicUpdate = useCallback(
    (newCount: number, updatedCount: number) => {
      const announcement = formatTopicUpdateAnnouncement(newCount, updatedCount);
      if (announcement) {
        announce(announcement);
      }
    },
    [announce],
  );

  const contextValue: LiveAnnouncerContextValue = {
    message,
    announce,
    announceTopicUpdate,
  };

  return (
    <LiveAnnouncerContext.Provider value={contextValue}>
      {children}
      <div
        id="dashboard-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={visuallyHiddenStyle}
      >
        {message}
      </div>
    </LiveAnnouncerContext.Provider>
  );
};
