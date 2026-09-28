import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  QualifyingLaneSchema,
  TelegramReplyMetadataSchema,
  CursorPaginationQuerySchema,
  CursorPaginationMetaSchema,
  ApiErrorEnvelopeSchema,
  DistrictActivationBlockedErrorEnvelopeSchema,
  TopicDateFilterSchema,
  TopicBaseFilterSchema,
  HokimTopicBoardQuerySchema,
  HokimLaneQuerySchema,
  createKeysetPageSchema,
  encodeKeysetCursor,
  decodeKeysetCursor,
} from '../src/index.js';

describe('Topics and Pagination Contracts', () => {
  it('validates all 5 civic qualifying lanes', () => {
    const lanes = ['WATER', 'ELECTRICITY', 'GAS', 'WASTE', 'HOKIM_RELATED'];
    for (const lane of lanes) {
      expect(QualifyingLaneSchema.parse(lane)).toBe(lane);
    }
    expect(() => QualifyingLaneSchema.parse('INVALID_LANE')).toThrow();
  });

  it('validates telegram reply metadata schema', () => {
    const valid = {
      replyToMessageId: '12345',
      replyToUserId: '67890',
      replyToIsForwarded: false,
      replyToIsBot: true,
    };
    expect(TelegramReplyMetadataSchema.parse(valid)).toEqual(valid);
  });

  it('validates keyset cursor pagination query schema with defaults', () => {
    const parsed = CursorPaginationQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.direction).toBe('forward');
    expect(parsed.cursor).toBeUndefined();
  });

  it('validates decoupled generic error envelope and activation blocked envelope', () => {
    const genericErr = {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Access denied',
        details: { attempts: 3 },
      },
    };
    expect(ApiErrorEnvelopeSchema.parse(genericErr)).toEqual(genericErr);

    const activationErr = {
      error: {
        code: 'DISTRICT_NOT_READY' as const,
        message: 'Prerequisites incomplete',
        blockers: [
          {
            key: 'telegram_bot' as const,
            label: 'Bot',
            description: 'Connect bot',
            status: 'incomplete' as const,
          },
        ],
      },
    };
    expect(DistrictActivationBlockedErrorEnvelopeSchema.parse(activationErr)).toEqual(activationErr);
  });

  it('validates TopicDateFilterSchema with defaults and custom range invariants', () => {
    // Default today
    const defaultToday = TopicDateFilterSchema.parse({});
    expect(defaultToday.dateScope).toBe('today');

    // Valid custom range
    const validCustom = TopicDateFilterSchema.parse({
      dateScope: 'custom',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-15',
    });
    expect(validCustom.dateScope).toBe('custom');
    expect(validCustom.dateFrom).toBe('2026-08-01');
    expect(validCustom.dateTo).toBe('2026-08-15');

    // Custom missing dateFrom
    expect(() =>
      TopicDateFilterSchema.parse({
        dateScope: 'custom',
        dateTo: '2026-08-15',
      }),
    ).toThrow('Бошланиш санаси (dateFrom) киритилиши шарт.');

    // Custom missing dateTo
    expect(() =>
      TopicDateFilterSchema.parse({
        dateScope: 'custom',
        dateFrom: '2026-08-01',
      }),
    ).toThrow('Тугаш санаси (dateTo) киритилиши шарт.');

    // Custom dateFrom > dateTo
    expect(() =>
      TopicDateFilterSchema.parse({
        dateScope: 'custom',
        dateFrom: '2026-08-20',
        dateTo: '2026-08-10',
      }),
    ).toThrow('Бошланиш санаси тугаш санасидан катта бўлиши мумкин эмас.');
  });

  it('validates TopicBaseFilterSchema with lane normalization and mahalla filtering', () => {
    // Comma-separated lanes string normalization
    const parsed = TopicBaseFilterSchema.parse({
      mahallaName: 'Navbahor',
      lanes: 'WATER, GAS, WATER',
    });
    expect(parsed.mahallaName).toBe('Navbahor');
    expect(parsed.lanes).toEqual(['WATER', 'GAS']);

    // Empty lanes string resolves to undefined
    const parsedEmpty = TopicBaseFilterSchema.parse({
      lanes: '',
    });
    expect(parsedEmpty.lanes).toBeUndefined();
  });

  it('validates composed HokimTopicBoardQuerySchema and HokimLaneQuerySchema', () => {
    const boardQuery = HokimTopicBoardQuerySchema.parse({
      dateScope: 'today',
      baselineTimestamp: '2026-08-25T00:00:00.000Z',
    });
    expect(boardQuery.baselineTimestamp).toBe('2026-08-25T00:00:00.000Z');

    const laneQuery = HokimLaneQuerySchema.parse({
      lane: 'ELECTRICITY',
      limit: '15',
    });
    expect(laneQuery.lane).toBe('ELECTRICITY');
    expect(laneQuery.limit).toBe(15);
  });

  it('encodes and decodes keyset cursors reliably with full resilience', () => {
    const payload = {
      id: 'top_12345',
      timestamp: '2026-08-25T07:00:00.000Z',
      generation: 2,
    };
    const encoded = encodeKeysetCursor(payload);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    // Base64url check: no +, /, or =
    expect(encoded).not.toMatch(/[+/=]/);

    const decoded = decodeKeysetCursor<{ id: string; timestamp: string; generation: number }>(encoded);
    expect(decoded).toEqual(payload);

    // Resilient error handling on corrupt or non-string inputs
    expect(decodeKeysetCursor(null)).toBeNull();
    expect(decodeKeysetCursor(undefined)).toBeNull();
    expect(decodeKeysetCursor('')).toBeNull();
    expect(decodeKeysetCursor('not_valid_base64_json!@#$')).toBeNull();
    expect(decodeKeysetCursor(Buffer.from('{"invalid":"no_id"}').toString('base64url'))).toBeNull();
  });

  it('generates type-safe keyset page response schemas using createKeysetPageSchema', () => {
    const SimpleItemSchema = z.object({
      id: z.string(),
      title: z.string(),
    });
    const PageSchema = createKeysetPageSchema(SimpleItemSchema);

    const validPage = {
      items: [
        { id: '1', title: 'First Topic' },
        { id: '2', title: 'Second Topic' },
      ],
      pagination: {
        limit: 20,
        hasNextPage: true,
        hasPrevPage: false,
        nextCursor: encodeKeysetCursor({ id: '2' }),
        totalCount: 42,
      },
    };

    const parsed = PageSchema.parse(validPage);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.pagination.hasNextPage).toBe(true);
    expect(parsed.pagination.nextCursor).toBe(validPage.pagination.nextCursor);
  });
});
