import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../src/lib/api-client.js';
import { districtClient } from '../../src/district/district-client.js';
import { authClient } from '../../src/auth/auth-client.js';
import { useDistrictActivation } from '../../src/district/useDistrictActivation.js';
import { districtQueryKeys } from '../../src/district/query-keys.js';
import { AuthProvider, useAuth } from '../../src/auth/auth-context.js';
import { PrerequisiteItem } from '@mahalla-ovozi/api-contracts';

describe('District Activation & First Login Password State Integration (Phase 5)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.restoreAllMocks();
  });

  const queryWrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const authWrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );

  it('ApiError preserves blockers array when provided (Task 6.1)', () => {
    const blockers: PrerequisiteItem[] = [
      {
        key: 'telegram_bot',
        label: 'Telegram бот уланиши',
        description: 'Telegram бот уланмаган',
        status: 'incomplete',
        blockerReason: 'Telegram бот ҳали уланмаган (1.4-босқич).',
      },
    ];

    const error = new ApiError(
      'Туманни фаоллаштириш учун барча талаблар бажарилмаган.',
      'DISTRICT_NOT_READY',
      409,
      false,
      blockers
    );

    expect(error.code).toBe('DISTRICT_NOT_READY');
    expect(error.statusCode).toBe(409);
    expect(error.blockers).toEqual(blockers);
    expect(error.blockers?.[0]?.key).toBe('telegram_bot');
  });

  describe('useDistrictActivation Hook (Task 6.5)', () => {
    it('executes activation mutation and updates queries on success', async () => {
      const mockDistrict = {
        id: 'dist_123',
        name: 'Чилонзор',
        status: 'ACTIVE' as const,
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      };

      const activateSpy = vi
        .spyOn(districtClient, 'activateDistrict')
        .mockResolvedValueOnce({
          district: mockDistrict,
          activatedAt: mockDistrict.activatedAt!,
          activatedById: 'acc_po',
        });

      const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useDistrictActivation('dist_123'), {
        wrapper: queryWrapper,
      });

      expect(result.current.isActivating).toBe(false);

      await act(async () => {
        const response = await result.current.activateDistrict();
        expect(response.district.status).toBe('ACTIVE');
      });

      expect(activateSpy).toHaveBeenCalledWith('dist_123');
      expect(setQueryDataSpy).toHaveBeenCalledWith(districtQueryKeys.district('dist_123'), {
        district: mockDistrict,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: districtQueryKeys.readiness('dist_123'),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: districtQueryKeys.list(),
      });
    });

    it('gracefully handles DISTRICT_ALREADY_ACTIVE error and refreshes cache', async () => {
      const alreadyActiveError = new ApiError(
        'Туман аллақачон фаоллаштирилган.',
        'DISTRICT_ALREADY_ACTIVE',
        409,
        false
      );

      vi.spyOn(districtClient, 'activateDistrict').mockRejectedValueOnce(alreadyActiveError);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useDistrictActivation('dist_123'), {
        wrapper: queryWrapper,
      });

      let thrownError: unknown;
      await act(async () => {
        try {
          await result.current.activateDistrict();
        } catch (e) {
          thrownError = e;
        }
      });

      expect(thrownError).toBe(alreadyActiveError);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.district('dist_123') });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: districtQueryKeys.readiness('dist_123'),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: districtQueryKeys.list(),
      });
    });

    it('propagates unmet prerequisites error with blockers', async () => {
      const blockers: PrerequisiteItem[] = [
        {
          key: 'hokim_account',
          label: 'Ҳоким аккаунти',
          description: 'Ҳоким аккаунти яратилмаган',
          status: 'incomplete',
          blockerReason: 'Ҳоким аккаунти яратилмаган (1.6-босқич).',
        },
      ];

      const notReadyError = new ApiError(
        'Туманни фаоллаштириш учун барча талаблар бажарилмаган.',
        'DISTRICT_NOT_READY',
        409,
        false,
        blockers
      );

      vi.spyOn(districtClient, 'activateDistrict').mockRejectedValueOnce(notReadyError);

      const { result } = renderHook(() => useDistrictActivation('dist_123'), {
        wrapper: queryWrapper,
      });

      let thrownError: unknown;
      await act(async () => {
        try {
          await result.current.activateDistrict();
        } catch (e) {
          thrownError = e;
        }
      });

      const err = thrownError as ApiError;
      expect(err).toBeDefined();
      expect(err.code).toBe('DISTRICT_NOT_READY');
      expect(err.blockers).toHaveLength(1);
      expect(err.blockers?.[0]?.key).toBe('hokim_account');
    });
  });

  describe('useAuth Hook with mustChangePassword & First Login Flow (Task 6.4)', () => {
    it('initializes mustChangePassword state and transitions to false upon password replacement', async () => {
      // Mock active Hokim session with mustChangePassword: true
      vi.spyOn(authClient, 'fetchSession').mockResolvedValueOnce({
        actor: {
          id: 'acc_hokim_1',
          username: 'hokim_chilonzor',
          role: 'DISTRICT_HOKIM',
          districtId: 'dist_123',
          mustChangePassword: true,
        },
        session: {
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });

      const changePasswordSpy = vi
        .spyOn(authClient, 'changeFirstLoginPassword')
        .mockResolvedValueOnce({
          success: true,
          actor: {
            id: 'acc_hokim_1',
            username: 'hokim_chilonzor',
            role: 'DISTRICT_HOKIM',
            districtId: 'dist_123',
            mustChangePassword: false,
          },
        });

      const { result } = renderHook(() => useAuth(), { wrapper: authWrapper });

      // Wait for session query to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.actor?.role).toBe('DISTRICT_HOKIM');
      expect(result.current.mustChangePassword).toBe(true);

      // Perform password replacement
      await act(async () => {
        const response = await result.current.changeFirstLoginPassword({
          currentPassword: 'Temp-Password-12345!',
          newPassword: 'MyNewPermanentPassword2026!',
        });
        expect(response.success).toBe(true);
      });

      expect(changePasswordSpy).toHaveBeenCalledWith({
        currentPassword: 'Temp-Password-12345!',
        newPassword: 'MyNewPermanentPassword2026!',
      });

      expect(result.current.mustChangePassword).toBe(false);
      expect(result.current.actor?.mustChangePassword).toBe(false);
    });
  });
});
