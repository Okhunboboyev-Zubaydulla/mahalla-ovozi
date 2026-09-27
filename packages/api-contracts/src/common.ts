import { z } from 'zod';

/**
 * ISO calendar date string in YYYY-MM-DD format (Asia/Tashkent calendar day).
 * Single canonical source — never copy-paste the regex inline.
 */
export const IsoDateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type IsoDateString = z.infer<typeof IsoDateStringSchema>;

/**
 * Mandatory district identifier — always a non-empty string.
 * Enforces AD-9: explicit district scope is required in all tenant queries.
 */
export const DistrictIdSchema = z.string().min(1);
export type DistrictId = z.infer<typeof DistrictIdSchema>;

/**
 * Optional district identifier for cross-district query filters (Product Owner views).
 * Trim ensures whitespace-only strings are rejected.
 */
export const OptionalDistrictIdSchema = z.string().trim().min(1).optional();
export type OptionalDistrictId = z.infer<typeof OptionalDistrictIdSchema>;

// ---------------------------------------------------------------------------
// Standard API error envelope — all domain errors must conform.
// Exception: strongly-typed domain errors carrying typed payload arrays
// (e.g. DistrictActivationBlockedErrorEnvelope) may use their own shape.
// ---------------------------------------------------------------------------

export const ApiValidationErrorItemSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1),
  code: z.string().optional(),
});
export type ApiValidationErrorItem = z.infer<typeof ApiValidationErrorItemSchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    statusCode: z.number().int().min(400).max(599).optional(),
    details: z.record(z.unknown()).optional(),
    blockers: z.array(z.record(z.unknown())).optional(),
    validationErrors: z.array(ApiValidationErrorItemSchema).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
