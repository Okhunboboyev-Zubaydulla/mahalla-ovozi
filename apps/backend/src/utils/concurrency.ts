/**
 * Maps an array of items asynchronously with a bounded concurrency ceiling.
 * Preserves the exact input order in the resolved results array.
 *
 * @param items Array of items to process
 * @param limit Maximum number of active asynchronous tasks running concurrently
 * @param fn Async worker callback for each item
 * @returns Promise resolving to the mapped array in original order
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const effectiveLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(items.length, effectiveLimit);
  const workers: Promise<void>[] = [];

  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
