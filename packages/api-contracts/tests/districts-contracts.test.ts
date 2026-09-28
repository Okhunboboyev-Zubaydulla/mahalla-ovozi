import { describe, it, expect } from 'vitest';
import {
  DistrictStatusSchema,
  DistrictSchema,
  CreateDistrictRequestSchema,
  CreateDistrictResponseSchema,
  ListDistrictsResponseSchema,
  GetDistrictResponseSchema,
  UpdateDistrictRequestSchema,
  UpdateDistrictResponseSchema,
} from '../src/index.js';

describe('District API Contracts', () => {
  describe('DistrictStatusSchema', () => {
    it('accepts valid status values', () => {
      const validStatuses = ['SETUP_INCOMPLETE', 'ACTIVE', 'SUSPENDED', 'CANCELLED'];
      for (const status of validStatuses) {
        expect(DistrictStatusSchema.safeParse(status).success).toBe(true);
      }
    });

    it('rejects unknown status values', () => {
      expect(DistrictStatusSchema.safeParse('DELETED').success).toBe(false);
      expect(DistrictStatusSchema.safeParse('INACTIVE').success).toBe(false);
    });
  });

  describe('CreateDistrictRequestSchema', () => {
    it('accepts valid district name and region', () => {
      const payload = {
        name: 'Чилонзор',
        region: 'Тошкент шаҳри',
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Чилонзор');
        expect(result.data.region).toBe('Тошкент шаҳри');
      }
    });

    it('accepts valid district name without region', () => {
      const payload = {
        name: 'Мирзо Улуғбек',
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Мирзо Улуғбек');
        expect(result.data.region).toBeUndefined();
      }
    });

    it('transforms empty or whitespace-only region to undefined', () => {
      const payload = {
        name: 'Юнусобод',
        region: '   ',
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Юнусобод');
        expect(result.data.region).toBeUndefined();
      }
    });

    it('accepts null region and transforms it to undefined', () => {
      const payload = {
        name: 'Учтепа',
        region: null,
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Учтепа');
        expect(result.data.region).toBeUndefined();
      }
    });

    it('returns custom Uzbek error message when name is omitted', () => {
      const result = CreateDistrictRequestSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toBe('Туман номи киритилиши шарт.');
      }
    });

    it('trims district name before checking length (P1-C)', () => {
      // "  a  " trimmed has length 1, which must fail the >= 2 check
      const payload = {
        name: '  a  ',
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('counts code points using Unicode spread (B10)', () => {
      // 2 emoji: 2 code points, 4 UTF-16 code units
      const payload = {
        name: '🇺🇿🇺🇿',
      };
      const result = CreateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejects district name longer than 100 code points', () => {
      const longName = 'а'.repeat(101);
      const result = CreateDistrictRequestSchema.safeParse({ name: longName });
      expect(result.success).toBe(false);
    });

    it('rejects region longer than 100 code points', () => {
      const longRegion = 'б'.repeat(101);
      const result = CreateDistrictRequestSchema.safeParse({
        name: 'Самарқанд',
        region: longRegion,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DistrictSchema & Response Schemas', () => {
    it('validates a complete District object (P1-B)', () => {
      const district = {
        id: 'dist_12345',
        name: 'Олмазор',
        region: 'Тошкент',
        status: 'SETUP_INCOMPLETE',
        createdAt: '2026-08-17T12:00:00.000Z',
      };
      const result = DistrictSchema.safeParse(district);
      expect(result.success).toBe(true);
    });

    it('rejects non-ISO-8601 datetime for createdAt', () => {
      const district = {
        id: 'dist_12345',
        name: 'Олмазор',
        status: 'SETUP_INCOMPLETE',
        createdAt: 'invalid-date',
      };
      const result = DistrictSchema.safeParse(district);
      expect(result.success).toBe(false);
    });

    it('validates CreateDistrictResponseSchema wrapping { district } (P1-A)', () => {
      const response = {
        district: {
          id: 'dist_12345',
          name: 'Яшнобод',
          status: 'SETUP_INCOMPLETE',
          createdAt: '2026-08-17T12:00:00.000Z',
        },
      };
      const result = CreateDistrictResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('validates ListDistrictsResponseSchema and GetDistrictResponseSchema', () => {
      const listResponse = {
        districts: [
          {
            id: 'dist_1',
            name: 'Яккасарой',
            status: 'SETUP_INCOMPLETE',
            createdAt: '2026-08-17T12:00:00.000Z',
          },
        ],
      };
      expect(ListDistrictsResponseSchema.safeParse(listResponse).success).toBe(true);

      const getResponse = {
        district: {
          id: 'dist_1',
          name: 'Яккасарой',
          status: 'SETUP_INCOMPLETE',
          createdAt: '2026-08-17T12:00:00.000Z',
        },
      };
      expect(GetDistrictResponseSchema.safeParse(getResponse).success).toBe(true);
    });
  });

  describe('UpdateDistrictRequestSchema', () => {
    it('accepts both updated name and region', () => {
      const payload = {
        name: 'Чилонзор (Янгиланган)',
        region: 'Тошкент вилояти',
      };
      const result = UpdateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Чилонзор (Янгиланган)');
        expect(result.data.region).toBe('Тошкент вилояти');
      }
    });

    it('accepts updating name only', () => {
      const payload = {
        name: 'Мирзо Улуғбек',
      };
      const result = UpdateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Мирзо Улуғбек');
        expect(result.data.region).toBeUndefined();
      }
    });

    it('accepts updating region only', () => {
      const payload = {
        region: 'Самарқанд вилояти',
      };
      const result = UpdateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBeUndefined();
        expect(result.data.region).toBe('Самарқанд вилояти');
      }
    });

    it('transforms empty region to null', () => {
      const payload = {
        region: '   ',
      };
      const result = UpdateDistrictRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.region).toBeNull();
      }
    });

    it('rejects empty object with at least one field required error', () => {
      const result = UpdateDistrictRequestSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toBe('Камида битта майдон киритилиши керак.');
      }
    });

    it('rejects invalid short name', () => {
      const result = UpdateDistrictRequestSchema.safeParse({ name: ' a ' });
      expect(result.success).toBe(false);
    });
  });
});

