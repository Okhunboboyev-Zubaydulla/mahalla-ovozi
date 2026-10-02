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
  mahallas: (id: string | null) => ['districts', id, 'mahallas'] as const,
};

export type DistrictQueryKeys = typeof districtQueryKeys;

/**
 * Query key factory for the owner-only archived mahalla administration screen.
 * Follows the same convention as `districtQueryKeys` for caching and invalidation.
 */
export const archivedMahallaQueryKeys = {
  all: ['archived-mahallas'] as const,
  list: () => ['archived-mahallas', 'list'] as const,
};

export type ArchivedMahallaQueryKeys = typeof archivedMahallaQueryKeys;
