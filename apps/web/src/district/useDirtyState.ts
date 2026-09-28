import { useEffect } from 'react';
import { useDistrict } from './district-context.js';

export function useDirtyState(registrationId: string, isDirty: boolean): void {
  const { registerDirty, clearDirty } = useDistrict();

  useEffect(() => {
    if (isDirty) {
      registerDirty(registrationId);
    } else {
      clearDirty(registrationId);
    }

    // P4-D: Auto-cleanup on unmount to prevent ghost dirty-state registrations
    return () => {
      clearDirty(registrationId);
    };
  }, [registrationId, isDirty, registerDirty, clearDirty]);
}
