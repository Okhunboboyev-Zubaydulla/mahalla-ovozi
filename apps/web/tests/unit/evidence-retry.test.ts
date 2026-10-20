import { describe, it, expect } from 'vitest';
import { evidenceRetryDelay } from '../../src/topics/evidence-retry.js';

describe('evidenceRetryDelay', () => {
  it('retries the first failure after 250ms', () => {
    expect(evidenceRetryDelay(0)).toBe(250);
  });

  it('retries later failures after 500ms', () => {
    expect(evidenceRetryDelay(1)).toBe(500);
    expect(evidenceRetryDelay(2)).toBe(500);
  });

  it('never returns a delay long enough to look like a stalled request', () => {
    for (let attemptIndex = 0; attemptIndex <= 5; attemptIndex += 1) {
      expect(evidenceRetryDelay(attemptIndex)).toBeLessThanOrEqual(500);
      expect(evidenceRetryDelay(attemptIndex)).toBeGreaterThan(0);
    }
  });
});
