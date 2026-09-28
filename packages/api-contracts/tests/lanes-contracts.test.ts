import { describe, it, expect } from 'vitest';
import { CANONICAL_LANES, QualifyingLaneSchema } from '../src/index.js';

describe('CANONICAL_LANES', () => {
  it('is ordered HOKIM_RELATED first, matching the dashboard board order', () => {
    // Order is user-visible: FiveLaneBoard renders lanes in this sequence and
    // useLaneOrderPreference falls back to it. It is NOT the schema enum order.
    expect(CANONICAL_LANES).toEqual([
      'HOKIM_RELATED',
      'WATER',
      'ELECTRICITY',
      'GAS',
      'WASTE',
    ]);
  });

  it('is a duplicate-free permutation of QualifyingLaneSchema options', () => {
    expect(CANONICAL_LANES.length).toBe(QualifyingLaneSchema.options.length);
    expect(new Set(CANONICAL_LANES).size).toBe(CANONICAL_LANES.length);
    expect([...CANONICAL_LANES].sort()).toEqual(
      [...QualifyingLaneSchema.options].sort(),
    );
  });

  it('is not silently derived from the schema enum order', () => {
    expect(CANONICAL_LANES).not.toEqual(QualifyingLaneSchema.options);
  });
});
