import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictProvider, useDistrict } from '../../src/district/district-context.js';
import { useDirtyState } from '../../src/district/useDirtyState.js';
import { UnsavedChangesModal } from '../../src/components/UnsavedChangesModal.js';
import { EditDistrictDrawer } from '../../src/components/EditDistrictDrawer.js';
import { District } from '@mahalla-ovozi/api-contracts';
import { ApiError } from '../../src/lib/api-client.js';

describe('District State & Switching Engine', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <DistrictProvider>{children}</DistrictProvider>
    </QueryClientProvider>
  );

  it('initializes with null active district and clean dirty state', () => {
    const { result } = renderHook(() => useDistrict(), { wrapper });

    expect(result.current.activeDistrictId).toBeNull();
    expect(result.current.hasDirtyForms).toBe(false);
    expect(result.current.pendingTransition).toBeNull();
  });

  it('switches district cleanly when forms are not dirty', async () => {
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');

    const { result } = renderHook(() => useDistrict(), { wrapper });

    // Set initial district
    act(() => {
      result.current.setActiveDistrictDirectly('dist_1');
    });
    expect(result.current.activeDistrictId).toBe('dist_1');

    // Switch to dist_2
    await act(async () => {
      await result.current.switchDistrict('dist_2');
    });

    // Verify 4-step atomic sequence: cancel queries -> remove queries -> set new ID (P4-B)
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ['districts', 'dist_1'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['districts', 'dist_1'] });
    expect(result.current.activeDistrictId).toBe('dist_2');
  });

  it('registers and unregisters dirty state with auto-cleanup on unmount (P4-D)', () => {
    const { result, rerender, unmount } = renderHook(
      ({ isDirty }) => {
        useDirtyState('test-form-1', isDirty);
        return useDistrict();
      },
      {
        wrapper,
        initialProps: { isDirty: false },
      }
    );

    expect(result.current.hasDirtyForms).toBe(false);

    // Form becomes dirty
    rerender({ isDirty: true });
    expect(result.current.hasDirtyForms).toBe(true);

    // Form becomes clean
    rerender({ isDirty: false });
    expect(result.current.hasDirtyForms).toBe(false);

    // Form becomes dirty again, then unmounts
    rerender({ isDirty: true });
    expect(result.current.hasDirtyForms).toBe(true);
    unmount();

    // After unmount, dirty registry must be clean
    const { result: cleanResult } = renderHook(() => useDistrict(), { wrapper });
    expect(cleanResult.current.hasDirtyForms).toBe(false);
  });

  it('intercepts switch transition when dirty and displays UnsavedChangesModal (P5-G)', async () => {
    const TestComponent: React.FC = () => {
      const { switchDistrict } = useDistrict();
      useDirtyState('drawer-form', true);

      return (
        <div>
          <button onClick={() => switchDistrict('dist_new')}>Switch</button>
          <UnsavedChangesModal />
        </div>
      );
    };

    render(
      <QueryClientProvider client={queryClient}>
        <DistrictProvider>
          <TestComponent />
        </DistrictProvider>
      </QueryClientProvider>
    );

    // Trigger switch while dirty
    fireEvent.click(screen.getByText('Switch'));

    // Modal should appear
    expect(await screen.findByText('Сақланмаган ўзгаришлар мавжуд')).toBeTruthy();
    expect(screen.getByText('Таҳрирлашни давом эттириш')).toBeTruthy();
    expect(screen.getByText('Ўзгаришларни бекор қилиш')).toBeTruthy();

    // Click Continue Editing (safe action) -> modal closes, no transition
    fireEvent.click(screen.getByText('Таҳрирлашни давом эттириш'));
    expect(screen.queryByText('Сақланмаган ўзгаришлар мавжуд')).toBeNull();
  });

  it('ApiError sets isNetworkError appropriately', () => {
    const netErr = new ApiError('Offline', 'NETWORK_ERROR', 0, true);
    expect(netErr.isNetworkError).toBe(true);
    expect(netErr.statusCode).toBe(0);

    const normalErr = new ApiError('Not found', 'NOT_FOUND', 404, false);
    expect(normalErr.isNetworkError).toBe(false);
    expect(normalErr.statusCode).toBe(404);
  });

  it('does not register dirty state when EditDistrictDrawer is closed with non-null district', () => {
    const mockDistrict: District = {
      id: 'dist_test',
      name: 'Sharof Rashidov',
      region: 'Jizzax viloyati',
      status: 'SETUP_INCOMPLETE',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const TestComponent: React.FC = () => {
      const { hasDirtyForms } = useDistrict();
      return (
        <div>
          <span data-testid="dirty-status">{hasDirtyForms ? 'dirty' : 'clean'}</span>
          <EditDistrictDrawer open={false} district={mockDistrict} onClose={() => {}} />
        </div>
      );
    };

    render(
      <QueryClientProvider client={queryClient}>
        <DistrictProvider>
          <TestComponent />
        </DistrictProvider>
      </QueryClientProvider>
    );

    expect(screen.getByTestId('dirty-status').textContent).toBe('clean');
  });

  it('persists and restores activeDistrictId from localStorage', async () => {
    localStorage.setItem('mahalla_active_district_id', 'dist_stored_123');

    const { result } = renderHook(() => useDistrict(), { wrapper });
    expect(result.current.activeDistrictId).toBe('dist_stored_123');

    // Switch district and verify localStorage update
    await act(async () => {
      await result.current.switchDistrict('dist_switched_456');
    });
    expect(localStorage.getItem('mahalla_active_district_id')).toBe('dist_switched_456');
    expect(result.current.activeDistrictId).toBe('dist_switched_456');

    // Clear district and verify localStorage removal
    await act(async () => {
      result.current.setActiveDistrictDirectly(null);
    });
    expect(localStorage.getItem('mahalla_active_district_id')).toBeNull();
    expect(result.current.activeDistrictId).toBeNull();
  });

  it('auto-cleanses activeDistrictId when ID does not exist in districts list', async () => {
    const mockDistricts: District[] = [
      {
        id: 'dist_valid_1',
        name: 'Sharof Rashidov',
        region: 'Jizzax viloyati',
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    queryClient.setQueryData(['districts', 'list'], { districts: mockDistricts });
    localStorage.setItem('mahalla_active_district_id', 'dist_deleted_999');

    const { result } = renderHook(() => useDistrict(), { wrapper });

    // Should detect that dist_deleted_999 is missing from mockDistricts and cleanse to null
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.activeDistrictId).toBeNull();
    expect(localStorage.getItem('mahalla_active_district_id')).toBeNull();
  });
});


