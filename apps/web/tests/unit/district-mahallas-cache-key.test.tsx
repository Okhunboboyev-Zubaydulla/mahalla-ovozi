import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../src/auth/auth-context.js', () => ({
  useAuth: () => ({
    actor: { id: 'acc_1', districtId: 'dist_1', role: 'DISTRICT_HOKIM' },
    isAuthenticated: true,
    mustChangePassword: false,
    isLoading: false,
  }),
  useOptionalAuth: () => undefined,
}));

import { useDistrictMahallas } from '../../src/topics/useDistrictMahallas.js';
import { useDistrictTopicsMahallas } from '../../src/topics/district-topics-client.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { districtTopicsClient } from '../../src/topics/district-topics-client.js';

describe('district mahallas cache key ownership', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(hokimTopicsClient, 'getDistrictMahallas').mockResolvedValue(['Alpha', 'Beta']);
    vi.spyOn(districtTopicsClient, 'listMahallas').mockResolvedValue({ mahallas: ['Alpha', 'Beta'] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('does not serve the hokim list shape to the district hook', async () => {
    const { result } = renderHook(
      () => ({
        hokim: useDistrictMahallas(),
        district: useDistrictTopicsMahallas('dist_1'),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.district.data).toBeDefined());

    expect(result.current.district.data?.mahallas).toEqual(['Alpha', 'Beta']);
  });

  it('does not serve the district response shape to the hokim hook', async () => {
    const { result } = renderHook(
      () => ({
        district: useDistrictTopicsMahallas('dist_1'),
        hokim: useDistrictMahallas(),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.hokim.mahallas).toHaveLength(2));

    expect(Array.isArray(result.current.hokim.mahallas)).toBe(true);
    expect(result.current.hokim.mahallas).toEqual(['Alpha', 'Beta']);
  });
});
