import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

/**
 * Canonical lifecycle status for a district Telegram userbot session:
 * - PENDING: Session created or re-enabled, awaiting interactive CLI authentication.
 *   Note: Re-enabling a previously disabled session transitions status to PENDING
 *   rather than ACTIVE because the kill switch performs server-side revocation and wipes
 *   stored credentials. This requires no response shape change ({ session: PublicDistrictUserbotSession }).
 * - ACTIVE: Session authenticated and actively monitoring assigned groups.
 * - BANNED: Session banned by Telegram; cannot be re-authenticated or re-enabled.
 * - DISABLED: Session intentionally disabled via kill switch; secrets wiped.
 */
export const UserbotSessionStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'BANNED',
  'DISABLED',
]);
export type UserbotSessionStatus = z.infer<typeof UserbotSessionStatusSchema>;

/**
 * Public representation of a District's userbot session returned by API endpoints:
 * - Read session endpoint (GET /api/v1/districts/:districtId/userbot-session) returns `{ session: PublicDistrictUserbotSession | null }`.
 * - Enable session endpoint (POST /api/v1/districts/:districtId/userbot-session/enable) returns `{ session: PublicDistrictUserbotSession }`.
 *   When re-enabling a previously disabled session, status transitions to PENDING rather than ACTIVE
 *   because revocation wiped the session string and API credentials.
 */
export const PublicDistrictUserbotSessionSchema = z.object({
  id: z.string(),
  districtId: DistrictIdSchema,
  phoneNumber: z.string(),
  apiId: z.string(),
  status: UserbotSessionStatusSchema,
  hasSession: z.boolean(),
  lastSeenAt: z.string().datetime().nullable(),
  lastSuccessfulConnectionAt: z.string().datetime().nullable().optional(),
  inboundUpdateCounter: z.number().optional(),
  isStale: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PublicDistrictUserbotSession = z.infer<
  typeof PublicDistrictUserbotSessionSchema
>;

/**
 * Strict international E.164 phone number format:
 * Must start with `+` followed by 7 to 15 digits (first digit 1-9).
 * Spaces, dashes, letters, and punctuation are rejected.
 */
export const PhoneNumberSchema = z
  .string({
    required_error: 'phoneNumber is required',
    invalid_type_error: 'phoneNumber must be a string',
  })
  .regex(/^\+[1-9]\d{6,14}$/, {
    message: 'phoneNumber must be in international format (e.g. +998901234567) without spaces or dashes',
  });
export type PhoneNumber = z.infer<typeof PhoneNumberSchema>;

/**
 * Positive integer API ID:
 * Must parse as a positive integer > 0.
 * Accepts numeric JSON value or numeric string without decimal, negative sign, or symbols.
 * Transforms to string for downstream persistence and protocol use.
 */
export const ApiIdSchema = z
  .union(
    [
      z.string({
        invalid_type_error: 'apiId must be a positive integer',
      }),
      z.number({
        invalid_type_error: 'apiId must be a positive integer',
      }),
    ],
    {
      errorMap: () => ({ message: 'apiId must be a positive integer' }),
    },
  )
  .superRefine((val, ctx) => {
    if (typeof val === 'number') {
      if (!Number.isInteger(val) || val <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiId must be a positive integer',
        });
      }
    } else if (typeof val === 'string') {
      if (!/^[1-9]\d*$/.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiId must be a positive integer',
        });
      }
    }
  })
  .transform((val) => String(val));
export type ApiId = z.infer<typeof ApiIdSchema>;

/**
 * Optional API Hash:
 * Non-emptiness check, not a pattern match.
 * Whitespace-only strings are normalized to undefined (treated as absent).
 */
export const ApiHashSchema = z
  .string({
    invalid_type_error: 'apiHash must be a string',
  })
  .nullish()
  .transform((val) => {
    if (val === undefined || val === null) {
      return undefined;
    }
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });
export type ApiHash = z.infer<typeof ApiHashSchema>;

export const CreateUserbotSessionRequestSchema = z.object({
  phoneNumber: PhoneNumberSchema,
  apiId: ApiIdSchema,
  apiHash: ApiHashSchema,
});
export type CreateUserbotSessionRequest = z.infer<
  typeof CreateUserbotSessionRequestSchema
>;
