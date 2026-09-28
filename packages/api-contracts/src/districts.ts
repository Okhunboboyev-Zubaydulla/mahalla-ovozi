import { z } from 'zod';

export const DistrictStatusSchema = z.enum([
  'SETUP_INCOMPLETE',
  'ACTIVE',
  'GRACE',
  'SUSPENDED',
  'CANCELLED',
]);
export type DistrictStatus = z.infer<typeof DistrictStatusSchema>;

export const DistrictSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.string().optional(),
  status: DistrictStatusSchema,
  createdAt: z.string().datetime(), // UTC ISO 8601 — frontend converts to Asia/Tashkent
  activatedAt: z.string().datetime().nullable().optional(),
  activatedById: z.string().nullable().optional(),
});
export type District = z.infer<typeof DistrictSchema>;

export const CreateDistrictRequestSchema = z.object({
  // P1-C: .trim() first, then code-point length refines using spread [...val].length (B10)
  name: z
    .string({
      required_error: 'Туман номи киритилиши шарт.',
      invalid_type_error: 'Туман номи матн кўринишида бўлиши керак.',
    })
    .trim()
    .refine((val) => [...val].length >= 2, {
      message: 'Туман номи камида 2 та белгидан иборат бўлиши керак.',
    })
    .refine((val) => [...val].length <= 100, {
      message: 'Туман номи 100 та белгидан ошмаслиги керак.',
    }),
  region: z
    .string({
      invalid_type_error: 'Вилоят/ҳудуд номи матн кўринишида бўлиши керак.',
    })
    .trim()
    .refine((val) => [...val].length <= 100, {
      message: 'Вилоят/ҳудуд номи 100 та белгидан ошмаслиги керак.',
    })
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
});
export type CreateDistrictRequest = z.infer<typeof CreateDistrictRequestSchema>;

export const CreateDistrictResponseSchema = z.object({
  district: DistrictSchema,
});
export type CreateDistrictResponse = z.infer<typeof CreateDistrictResponseSchema>;

export const ListDistrictsResponseSchema = z.object({
  districts: z.array(DistrictSchema),
});
export type ListDistrictsResponse = z.infer<typeof ListDistrictsResponseSchema>;

export const GetDistrictResponseSchema = z.object({
  district: DistrictSchema,
});
export type GetDistrictResponse = z.infer<typeof GetDistrictResponseSchema>;

export const ActivateDistrictResponseSchema = z.object({
  district: DistrictSchema,
  activatedAt: z.string().datetime(),
  activatedById: z.string().min(1),
});
export type ActivateDistrictResponse = z.infer<typeof ActivateDistrictResponseSchema>;

export const UpdateDistrictRequestSchema = z
  .object({
    name: z
      .string({
        invalid_type_error: 'Туман номи матн кўринишида бўлиши керак.',
      })
      .trim()
      .refine((val) => [...val].length >= 2, {
        message: 'Туман номи камида 2 та белгидан иборат бўлиши керак.',
      })
      .refine((val) => [...val].length <= 100, {
        message: 'Туман номи 100 та белгидан ошмаслиги керак.',
      })
      .optional(),
    region: z
      .string({
        invalid_type_error: 'Вилоят/ҳудуд номи матн кўринишида бўлиши керак.',
      })
      .trim()
      .refine((val) => [...val].length <= 100, {
        message: 'Вилоят/ҳудуд номи 100 та белгидан ошмаслиги керак.',
      })
      .nullish()
      .transform((val) => (val && val.length > 0 ? val : null))
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.region !== undefined, {
    message: 'Камида битта майдон киритилиши керак.',
  });
export type UpdateDistrictRequest = z.infer<typeof UpdateDistrictRequestSchema>;

export const UpdateDistrictResponseSchema = z.object({
  district: DistrictSchema,
});
export type UpdateDistrictResponse = z.infer<typeof UpdateDistrictResponseSchema>;

// ---------------------------------------------------------------------------
// District Readiness & Prerequisite Contracts (absorbed from readiness.ts)
// ---------------------------------------------------------------------------

export const PrerequisiteStatusSchema = z.enum(['passed', 'incomplete', 'failed']);
export type PrerequisiteStatus = z.infer<typeof PrerequisiteStatusSchema>;

export const PrerequisiteKeySchema = z.enum([
  'district_identity',
  'access_eligibility',
  'analysis_configuration',
  'district_isolation',
  'disclosure_confirmation',
  'telegram_bot',
  'group_mappings',
  'hokim_account',
]);
export type PrerequisiteKey = z.infer<typeof PrerequisiteKeySchema>;

export const PrerequisiteItemSchema = z.object({
  key: PrerequisiteKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  status: PrerequisiteStatusSchema,
  blockerReason: z.string().optional(),
  actionRequired: z.boolean().optional(),
  actionPath: z.string().optional(),
  completedAt: z.string().datetime().optional(),
  completedBy: z.string().optional(),
});
export type PrerequisiteItem = z.infer<typeof PrerequisiteItemSchema>;

export const DistrictReadinessSchema = z.object({
  districtId: z.string().min(1),
  districtName: z.string().min(1),
  status: DistrictStatusSchema,
  isActivationReady: z.boolean(),
  passedCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  evaluatedAt: z.string().datetime(),
  items: z.array(PrerequisiteItemSchema),
  disclosureConfirmedAt: z.string().datetime().nullable(),
  disclosureConfirmedById: z.string().nullable(),
});
export type DistrictReadiness = z.infer<typeof DistrictReadinessSchema>;

export const GetDistrictReadinessResponseSchema = z.object({
  readiness: DistrictReadinessSchema,
});
export type GetDistrictReadinessResponse = z.infer<typeof GetDistrictReadinessResponseSchema>;

export const ConfirmDisclosureResponseSchema = z.object({
  districtId: z.string().min(1),
  disclosureConfirmedAt: z.string().datetime(),
  disclosureConfirmedById: z.string().min(1),
});
export type ConfirmDisclosureResponse = z.infer<typeof ConfirmDisclosureResponseSchema>;

/**
 * Strongly-typed domain error for district activation blocking.
 * Uses PrerequisiteItemSchema[] instead of the generic Record<string,unknown>[]
 * in ApiErrorEnvelopeSchema — this is a justified exception per the grilling decision.
 */
export const DistrictActivationBlockedErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.literal('DISTRICT_NOT_READY'),
    message: z.string().min(1),
    blockers: z.array(PrerequisiteItemSchema),
  }),
});
export type DistrictActivationBlockedErrorEnvelope = z.infer<
  typeof DistrictActivationBlockedErrorEnvelopeSchema
>;



