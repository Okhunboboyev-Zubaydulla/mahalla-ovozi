import { describe, it, expect } from 'vitest';
import { mapConcurrent } from '../src/utils/concurrency.js';

describe('mapConcurrent utility', () => {
  it('returns empty array when input is empty', async () => {
    const result = await mapConcurrent([], 3, async (x) => x);
    expect(result).toEqual([]);
  });

  it('preserves exact input ordering across concurrent execution', async () => {
    const items = [10, 50, 20, 40, 30];
    const result = await mapConcurrent(items, 2, async (delayMs, idx) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `item-${idx}-${delayMs}`;
    });

    expect(result).toEqual([
      'item-0-10',
      'item-1-50',
      'item-2-20',
      'item-3-40',
      'item-4-30',
    ]);
  });

  it('bounds maximum concurrent executions to the specified limit', async () => {
    let activeWorkers = 0;
    let maxObservedWorkers = 0;
    const items = Array.from({ length: 15 }, (_, i) => i);

    await mapConcurrent(items, 3, async () => {
      activeWorkers += 1;
      maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeWorkers -= 1;
      return true;
    });

    expect(maxObservedWorkers).toBeLessThanOrEqual(3);
    expect(activeWorkers).toBe(0);
  });

  it('propagates errors if a mapped worker rejects', async () => {
    const items = [1, 2, 3, 4];
    await expect(
      mapConcurrent(items, 2, async (item) => {
        if (item === 3) {
          throw new Error('Failure on item 3');
        }
        return item * 2;
      }),
    ).rejects.toThrow('Failure on item 3');
  });
});
