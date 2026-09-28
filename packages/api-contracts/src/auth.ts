import { z } from 'zod';

export const ActorRoleSchema = z.enum(['PRODUCT_OWNER', 'DISTRICT_HOKIM']);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

export const ActorContextSchema = z.object({
  id: z.string().min(1),
  role: ActorRoleSchema,
  username: z.string().min(1),
  districtId: z.string().nullable().optional(),
  mustChangePassword: z.boolean().optional(),
});
export type ActorContext = z.infer<typeof ActorContextSchema>;

/**
 * An actor guaranteed to carry a usable district scope.
 *
 * This is a narrowing of `ActorContext`, not a second actor declaration: a
 * `PRODUCT_OWNER` legitimately has `districtId: null`, while district-bound
 * operations (Hokim board, lane batch, statistics, evidence reads) require a
 * real district. The requirement is expressed once, here, instead of being
 * re-declared as a parallel interface in every consuming module.
 *
 * Obtain one through `isDistrictScopedActor`; never cast to it.
 */
export interface DistrictScopedActor extends ActorContext {
  districtId: string;
}

/**
 * Validates that an actor carries a non-blank district scope and narrows it.
 *
 * Blank and whitespace-only values are rejected because a district id is used
 * directly as a tenant filter; an empty string would silently match nothing
 * rather than fail loudly.
 */
export function isDistrictScopedActor(actor: ActorContext): actor is DistrictScopedActor {
  return typeof actor.districtId === 'string' && actor.districtId.trim() !== '';
}

export const SignInRequestSchema = z.object({
  username: z.string().min(3).max(64),
  // B10: Use code-point count (not UTF-16 .length) to match password-policy.ts.
  // z.string().max(N) counts UTF-16 code units; emoji take 2 units but 1 code point.
  // A valid 128-codepoint password with emoji would fail .max(128) — use refine instead.
  password: z.string().min(15).refine(
    (val) => [...val].length <= 128,
    { message: 'Парол узунлиги 128 белгидан ошмаслиги керак.' }
  ),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const SessionInfoSchema = z.object({
  expiresAt: z.string().datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SignInResponseSchema = z.object({
  actor: ActorContextSchema,
  session: SessionInfoSchema,
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

/**
 * Session verification response contract.
 * Both sign-in and session verification return identical actor context and session info.
 * SessionResponseSchema aliases SignInResponseSchema to maintain semantic distinction
 * for endpoint consumers without duplicating schema definitions.
 */
export const SessionResponseSchema = SignInResponseSchema;
export type SessionResponse = SignInResponse;

export const SignOutResponseSchema = z.object({
  success: z.literal(true),
});
export type SignOutResponse = z.infer<typeof SignOutResponseSchema>;

export const FirstSignInPasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1, { message: 'Жорий парол киритилиши шарт.' }),
  newPassword: z
    .string()
    .min(15, { message: 'Янги парол камида 15 та белгидан иборат бўлиши керак.' })
    .refine(
      (val) => [...val].length <= 128,
      { message: 'Парол узунлиги 128 белгидан ошмаслиги керак.' }
    ),
});
export type FirstSignInPasswordChangeRequest = z.infer<typeof FirstSignInPasswordChangeRequestSchema>;

export const FirstSignInPasswordChangeResponseSchema = z.object({
  success: z.literal(true),
  actor: ActorContextSchema,
});
export type FirstSignInPasswordChangeResponse = z.infer<typeof FirstSignInPasswordChangeResponseSchema>;


