/**
 * Fixed, short retry backoff ladder shared by the topic-evidence query clients.
 *
 * TanStack Query's default exponential delay starts at 1s, so a single dropped
 * keep-alive socket costs 1-3s of visible loading even though the backend never
 * fails at the HTTP level. `attemptIndex` is 0-based in React Query v5: index 0
 * means "the first attempt just failed".
 */
export function evidenceRetryDelay(attemptIndex: number): number {
  return attemptIndex < 1 ? 250 : 500;
}
