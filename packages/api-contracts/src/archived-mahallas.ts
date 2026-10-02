import { z } from 'zod';

/**
 * Owner-only ARCHIVED mahalla administration contracts.
 *
 * An ARCHIVED topic is a topic whose Telegram group was deleted; the row is preserved on
 * purpose and only a PRODUCT_OWNER may inspect or permanently remove it.
 */

/** Per-table deletion counters returned by the shared topic deletion cascade. */
export const TopicCascadeDeletionCountsSchema = z.object({
  evidenceCount: z.number().int().min(0),
  projectionsCount: z.number().int().min(0),
  aiOperationsCount: z.number().int().min(0),
  intakeRecordsCount: z.number().int().min(0),
  jobRecordsCount: z.number().int().min(0),
  topicDeletedCount: z.number().int().min(0),
});
export type TopicCascadeDeletionCountsDto = z.infer<typeof TopicCascadeDeletionCountsSchema>;

export const ArchivedMahallaListItemSchema = z.object({
  topicId: z.string().min(1),
  districtId: z.string().min(1),
  districtName: z.string(),
  mahallaName: z.string().min(1),
  // The archive moment is the topic's last update; there is no dedicated archived_at column.
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  evidenceCount: z.number().int().min(0),
  projectionCount: z.number().int().min(0),
});
export type ArchivedMahallaListItemDto = z.infer<typeof ArchivedMahallaListItemSchema>;

export const ListArchivedMahallasResponseSchema = z.object({
  items: z.array(ArchivedMahallaListItemSchema),
});
export type ListArchivedMahallasResponse = z.infer<typeof ListArchivedMahallasResponseSchema>;

export const ArchivedMahallaTopicParamsSchema = z.object({
  topicId: z.string().trim().min(1),
});
export type ArchivedMahallaTopicParams = z.infer<typeof ArchivedMahallaTopicParamsSchema>;

/** Type-to-confirm payload: the owner must retype the mahalla name verbatim. */
export const DeleteArchivedMahallaRequestSchema = z.object({
  confirmMahallaName: z
    .string({ invalid_type_error: 'Маҳалла номи матн кўринишида бўлиши керак.' })
    .trim()
    .min(1, 'Тасдиқлаш учун маҳалла номини тўлиқ киритинг.')
    .max(255, 'Маҳалла номи 255 та белгидан ошмаслиги керак.'),
});
export type DeleteArchivedMahallaRequest = z.infer<typeof DeleteArchivedMahallaRequestSchema>;

export const DeleteArchivedMahallaResponseSchema = z.object({
  topicId: z.string().min(1),
  deleted: z.literal(true),
  counts: TopicCascadeDeletionCountsSchema,
});
export type DeleteArchivedMahallaResponse = z.infer<typeof DeleteArchivedMahallaResponseSchema>;
