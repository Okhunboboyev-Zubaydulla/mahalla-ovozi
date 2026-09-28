import { createContext, useContext } from 'react';

export interface LiveAnnouncerContextValue {
  message: string;
  announce: (message: string) => void;
  announceTopicUpdate: (newCount: number, updatedCount: number) => void;
}

export const LiveAnnouncerContext = createContext<LiveAnnouncerContextValue | undefined>(undefined);

export function useLiveAnnouncer(): LiveAnnouncerContextValue {
  const context = useContext(LiveAnnouncerContext);
  if (!context) {
    throw new Error('useLiveAnnouncer must be used within a LiveAnnouncerProvider');
  }
  return context;
}

export function formatTopicUpdateAnnouncement(newCount: number, updatedCount: number): string | null {
  if (newCount > 0 && updatedCount > 0) {
    return `${newCount} та янги мавзу қўшилди, ${updatedCount} та мавзуга янги хабар қўшилди.`;
  }
  if (newCount > 0) {
    return `${newCount} та янги мавзу қўшилди.`;
  }
  if (updatedCount > 0) {
    return `${updatedCount} та мавзуга янги хабар қўшилди.`;
  }
  return null;
}

export function formatSearchAnnouncement(count: number): string {
  if (count === 0) {
    return 'Танланган шартлар бўйича мавзулар топилмади';
  }
  return `Қидирув бўйича ${count} та мос мавзу топилди`;
}

