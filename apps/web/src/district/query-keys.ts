/**
 * Canonical Query Key Factory for District Management & Workspace Domain (AD-10).
 * Guarantees unified serialization for TanStack Query caching, cancellation, and invalidation.
 */
export const districtQueryKeys = {
  all: ['districts'] as const,
  list: () => ['districts', 'list'] as const,
  district: (id: string | null) => ['districts', id] as const,
  readiness: (id: string | null) => ['districts', id, 'readiness'] as const,
  bot: (id: string | null) => ['districts', id, 'telegram-bot'] as const,
  groups: (id: string | null) => ['districts', id, 'telegram-groups'] as const,
  hokim: (id: string | null) => ['districts', id, 'hokim-account'] as const,
};

export type DistrictQueryKeys = typeof districtQueryKeys;
