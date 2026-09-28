import { z } from 'zod';
import { IsoDateStringSchema, DistrictIdSchema } from './common.js';

export const QualifyingLaneSchema = z.enum([
  'WATER',
  'ELECTRICITY',
  'GAS',
  'WASTE',
  'HOKIM_RELATED',
]);
export type QualifyingLane = z.infer<typeof QualifyingLaneSchema>;

/**
 * The five dashboard lanes in their canonical user-visible display order.
 *
 * Deliberately an explicit literal, NOT derived from `QualifyingLaneSchema.options`:
 * the enum is ordered WATER-first, but the dashboard board renders HOKIM_RELATED
 * first, and `useLaneOrderPreference` uses this sequence as its fallback order.
 * Deriving it from the enum would silently reorder the Hokim board.
 */
export const CANONICAL_LANES: readonly QualifyingLane[] = [
  'HOKIM_RELATED',
  'WATER',
  'ELECTRICITY',
  'GAS',
  'WASTE',
];

export const TopicPrimaryLaneSchema = QualifyingLaneSchema;
export type TopicPrimaryLane = QualifyingLane;

export const TelegramReplyMetadataSchema = z.object({
  replyToMessageId: z.string().min(1),
  replyToUserId: z.string().optional(),
  replyToIsForwarded: z.boolean(),
  replyToIsBot: z.boolean(),
});
export type TelegramReplyMetadata = z.infer<typeof TelegramReplyMetadataSchema>;

export const SearchMatchBadgeSchema = z.enum(['evidence', 'author']);
export type SearchMatchBadge = z.infer<typeof SearchMatchBadgeSchema>;

export const TopicCardItemSchema = z.object({
  id: z.string(),
  districtId: DistrictIdSchema,
  mahallaName: z.string(),
  calendarDay: z.string(),
  /**
   * The projected summary, or `null` when no `topic_projections` row exists yet.
   * `null` is the explicit "projection pending" signal — it replaces the former
   * practice of comparing against a sentinel display string.
   */
  summary: z.string().nullable(),
  primaryLane: QualifyingLaneSchema,
  lanes: z.array(QualifyingLaneSchema),
  additionalLanes: z.array(QualifyingLaneSchema),
  evidenceCount: z.number().int().min(0),
  latestMeaningfulActivityTimestamp: z.string().datetime(),
  isNew: z.boolean(),
  isUpdated: z.boolean(),
  searchMatchBadge: SearchMatchBadgeSchema.nullable().optional(),
  latestUpdate: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TopicCardItem = z.infer<typeof TopicCardItemSchema>;

export const HokimLaneBoardDataSchema = z.object({
  lane: QualifyingLaneSchema,
  topics: z.array(TopicCardItemSchema),
  totalCount: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type HokimLaneBoardData = z.infer<typeof HokimLaneBoardDataSchema>;

export const DateFilterScopeSchema = z.enum(['today', 'yesterday', 'custom']);
export type DateFilterScope = z.infer<typeof DateFilterScopeSchema>;

export const LanesQueryParamSchema = z
  .union([z.array(QualifyingLaneSchema), z.string()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null || val === '') return undefined;
    let items: string[] = [];
    if (typeof val === 'string') {
      items = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(val)) {
      items = val
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : item))
        .map((s) => (typeof s === 'string' ? s.trim() : s))
        .filter(Boolean);
    } else {
      return undefined;
    }
    const unique = Array.from(new Set(items));
    return unique.length > 0 ? (unique as QualifyingLane[]) : undefined;
  });
export type LanesQueryParam = z.infer<typeof LanesQueryParamSchema>;

export const TopicDateFilterFields = {
  dateScope: DateFilterScopeSchema.default('today'),
  dateFrom: IsoDateStringSchema.optional(),
  dateTo: IsoDateStringSchema.optional(),
};

export const TopicBaseFilterFields = {
  ...TopicDateFilterFields,
  mahallaName: z.string().trim().min(1).optional(),
  lanes: LanesQueryParamSchema,
  calendarDay: IsoDateStringSchema.optional(),
};

export const TopicSearchFilterFields = {
  ...TopicDateFilterFields,
  mahallaName: z.string().trim().min(1).optional(),
  lanes: z.array(QualifyingLaneSchema).min(1).max(5).optional(),
  calendarDay: IsoDateStringSchema.optional(),
};

export function refineDateScopeRange<
  T extends { dateScope?: string; dateFrom?: string; dateTo?: string },
>(data: T, ctx: z.RefinementCtx): void {
  if (data.dateScope === 'custom') {
    if (!data.dateFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Бошланиш санаси (dateFrom) киритилиши шарт.',
        path: ['dateFrom'],
      });
    }
    if (!data.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Тугаш санаси (dateTo) киритилиши шарт.',
        path: ['dateTo'],
      });
    }
    if (data.dateFrom && data.dateTo && data.dateFrom > data.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Бошланиш санаси тугаш санасидан катта бўлиши мумкин эмас.',
        path: ['dateFrom'],
      });
    }
  }
}

export const TopicDateFilterSchema = z
  .object(TopicDateFilterFields)
  .superRefine(refineDateScopeRange);
export type TopicDateFilter = z.input<typeof TopicDateFilterSchema>;
export type TopicDateFilterOutput = z.output<typeof TopicDateFilterSchema>;

export const TopicBaseFilterSchema = z
  .object(TopicBaseFilterFields)
  .superRefine(refineDateScopeRange);
export type TopicBaseFilter = z.input<typeof TopicBaseFilterSchema>;
export type TopicBaseFilterOutput = z.output<typeof TopicBaseFilterSchema>;

/**
 * Composable field decorators for Topic query and search contracts.
 */
const baselineField = {
  baselineTimestamp: z.string().datetime().optional(),
};

const searchField = {
  search: z
    .string()
    .trim()
    .max(200, 'Қидирув сўзи 200 та белгидан ошмаслиги керак')
    .optional(),
};

const cursorPaginationFields = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// 1. Hokim Topic Board (GET Query & POST Search)
export const HokimTopicBoardQuerySchema = z
  .object({
    ...TopicBaseFilterFields,
    ...baselineField,
  })
  .superRefine(refineDateScopeRange);
export type HokimTopicBoardQuery = z.input<typeof HokimTopicBoardQuerySchema>;
export type HokimTopicBoardQueryOutput = z.output<typeof HokimTopicBoardQuerySchema>;

export const HokimTopicBoardSearchBodySchema = z
  .object({
    ...searchField,
    ...TopicSearchFilterFields,
    ...baselineField,
  })
  .superRefine(refineDateScopeRange);
export type HokimTopicBoardSearchBody = z.input<typeof HokimTopicBoardSearchBodySchema>;
export type HokimTopicBoardSearchBodyOutput = z.output<typeof HokimTopicBoardSearchBodySchema>;

// 2. Hokim Lane (GET Query & POST Search)
export const HokimLaneQuerySchema = z
  .object({
    lane: QualifyingLaneSchema,
    ...TopicBaseFilterFields,
    ...cursorPaginationFields,
    ...baselineField,
  })
  .superRefine(refineDateScopeRange);
export type HokimLaneQuery = z.input<typeof HokimLaneQuerySchema>;
export type HokimLaneQueryOutput = z.output<typeof HokimLaneQuerySchema>;

export const HokimLaneSearchBodySchema = z
  .object({
    lane: QualifyingLaneSchema,
    ...searchField,
    ...TopicSearchFilterFields,
    ...cursorPaginationFields,
    ...baselineField,
  })
  .superRefine(refineDateScopeRange);
export type HokimLaneSearchBody = z.input<typeof HokimLaneSearchBodySchema>;
export type HokimLaneSearchBodyOutput = z.output<typeof HokimLaneSearchBodySchema>;

// 3. Hokim Topic Statistics (GET Query & POST Search)
export const HokimTopicStatisticsQuerySchema = TopicBaseFilterSchema;
export type HokimTopicStatisticsQuery = z.input<typeof HokimTopicStatisticsQuerySchema>;
export type HokimTopicStatisticsQueryOutput = z.output<typeof HokimTopicStatisticsQuerySchema>;

export const HokimTopicStatisticsSearchBodySchema = z
  .object({
    ...searchField,
    ...TopicSearchFilterFields,
  })
  .superRefine(refineDateScopeRange);
export type HokimTopicStatisticsSearchBody = z.input<typeof HokimTopicStatisticsSearchBodySchema>;
export type HokimTopicStatisticsSearchBodyOutput = z.output<typeof HokimTopicStatisticsSearchBodySchema>;

// 4. District Topics (GET Query & POST Search)
export const DistrictTopicsFilterFields = {
  ...TopicBaseFilterFields,
  ...cursorPaginationFields,
};

export const DistrictTopicsSearchBodyFilterFields = {
  ...TopicSearchFilterFields,
  ...cursorPaginationFields,
};

export const DistrictTopicsQuerySchema = z
  .object(DistrictTopicsFilterFields)
  .superRefine(refineDateScopeRange);

export type DistrictTopicsQuery = z.input<typeof DistrictTopicsQuerySchema>;
export type DistrictTopicsQueryInput = z.input<typeof DistrictTopicsQuerySchema>;
export type DistrictTopicsQueryOutput = z.output<typeof DistrictTopicsQuerySchema>;

export const DistrictTopicsSearchBodySchema = z
  .object({
    ...searchField,
    ...DistrictTopicsSearchBodyFilterFields,
  })
  .superRefine(refineDateScopeRange);

export type DistrictTopicsSearchBody = z.input<typeof DistrictTopicsSearchBodySchema>;
export type DistrictTopicsSearchBodyInput = z.input<typeof DistrictTopicsSearchBodySchema>;
export type DistrictTopicsSearchBodyOutput = z.output<typeof DistrictTopicsSearchBodySchema>;

// 5. Response DTOs
export const HokimTopicBoardResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  calendarDay: z.string(),
  evaluationId: z.string().uuid(),
  visitBaselineTimestamp: z.string().datetime().nullable(),
  currentVisitTimestamp: z.string().datetime(),
  serverEvaluatedAt: z.string().datetime(),
  hasProcessingDelay: z.boolean().default(false),
  lanes: z.record(QualifyingLaneSchema, HokimLaneBoardDataSchema),
});
export type HokimTopicBoardResponse = z.infer<typeof HokimTopicBoardResponseSchema>;

export const HokimLaneResponseSchema = z.object({
  lane: QualifyingLaneSchema,
  topics: z.array(TopicCardItemSchema),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type HokimLaneResponse = z.infer<typeof HokimLaneResponseSchema>;

export const HokimMahallasResponseSchema = z.object({
  mahallas: z.array(z.string()),
});
export type HokimMahallasResponse = z.infer<typeof HokimMahallasResponseSchema>;

export const TopicEvidenceItemSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  verbatimText: z.string(),
  contentType: z.string(),
  originalTimestamp: z.string().datetime(),
  formattedTime: z.string(),
  authorName: z.string().nullable(),
  authorUsername: z.string().nullable(),
  isAnchor: z.boolean(),
  isHokimRelated: z.boolean().default(false),
  telegramDeepLink: z.string().nullable(),
});
export type TopicEvidenceItem = z.infer<typeof TopicEvidenceItemSchema>;

export const TopicEvidenceQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  order: z.enum(['ASC', 'DESC']).default('ASC'),
});
export type TopicEvidenceQuery = z.input<typeof TopicEvidenceQuerySchema>;
export type TopicEvidenceQueryOutput = z.output<typeof TopicEvidenceQuerySchema>;

export const TopicEvidenceResponseSchema = z.object({
  topic: TopicCardItemSchema,
  anchorQuote: z.string(),
  anchorEvidenceId: z.string(),
  evidence: z.array(TopicEvidenceItemSchema),
  totalCount: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type TopicEvidenceResponse = z.infer<typeof TopicEvidenceResponseSchema>;

export const TopicStatisticCard1ComparisonSchema = z.discriminatedUnion('isAvailable', [
  z.object({
    isAvailable: z.literal(true),
    previousValue: z.number().int().min(0),
    delta: z.number().int(),
    comparisonPeriodType: z.enum([
      'equivalent_same_time_yesterday',
      'previous_calendar_day',
      'previous_custom_range',
    ]),
    comparisonPeriodLabel: z.string(),
  }),
  z.object({
    isAvailable: z.literal(false),
    reason: z.enum([
      'UNSUPPORTED_FILTER_SCOPE',
      'OUTSIDE_RETENTION_WINDOW',
      'NO_PRIOR_PERIOD',
    ]),
  }),
]);
export type TopicStatisticCard1Comparison = z.infer<typeof TopicStatisticCard1ComparisonSchema>;

export const TopicStatisticCard4Schema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('most_active_service_lane'),
    leaderLane: QualifyingLaneSchema.nullable(),
    leaderTopicCount: z.number().int().min(0),
    isTie: z.boolean(),
    tiedCount: z.number().int().min(0),
    isZero: z.boolean(),
  }),
  z.object({
    mode: z.literal('multi_lane_topics'),
    multiLaneTopicCount: z.number().int().min(0),
  }),
]);
export type TopicStatisticCard4 = z.infer<typeof TopicStatisticCard4Schema>;

export const TopicStatisticCard5Schema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('most_active_mahalla'),
    leaderMahalla: z.string().nullable(),
    leaderTopicCount: z.number().int().min(0),
    isTie: z.boolean(),
    tiedCount: z.number().int().min(0),
    isZero: z.boolean(),
  }),
  z.object({
    mode: z.literal('multi_evidence_topics'),
    multiEvidenceTopicCount: z.number().int().min(0),
  }),
]);
export type TopicStatisticCard5 = z.infer<typeof TopicStatisticCard5Schema>;

export const HokimTopicStatisticsResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  calendarDay: z.string(),
  evaluationId: z.string().uuid(),
  serverEvaluatedAt: z.string().datetime(),
  totalUniqueTopics: z.number().int().min(0),
  card1Comparison: TopicStatisticCard1ComparisonSchema,
  hokimRelatedTopics: z.number().int().min(0),
  hokimEvidenceCount: z.number().int().min(0),
  activeMahallasCount: z.number().int().min(0),
  totalAcceptedEvidenceCount: z.number().int().min(0),
  card4: TopicStatisticCard4Schema,
  card5: TopicStatisticCard5Schema,
});
export type HokimTopicStatisticsResponse = z.infer<typeof HokimTopicStatisticsResponseSchema>;

export const DistrictTopicsPageResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  topics: z.array(TopicCardItemSchema),
  totalCount: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
  serverEvaluatedAt: z.string().datetime(),
});

export type DistrictTopicsPageResponse = z.infer<typeof DistrictTopicsPageResponseSchema>;

export const DistrictMahallasResponseSchema = HokimMahallasResponseSchema;
export type DistrictMahallasResponse = HokimMahallasResponse;




