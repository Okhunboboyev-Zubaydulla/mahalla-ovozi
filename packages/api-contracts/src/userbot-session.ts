import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

export const UserbotSessionStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'BANNED',
  'DISABLED',
]);
export type UserbotSessionStatus = z.infer<typeof UserbotSessionStatusSchema>;

export const PublicDistrictUserbotSessionSchema = z.object({
  id: z.string(),
  districtId: DistrictIdSchema,
  phoneNumber: z.string(),
  apiId: z.string(),
  status: UserbotSessionStatusSchema,
  hasSession: z.boolean(),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PublicDistrictUserbotSession = z.infer<
  typeof PublicDistrictUserbotSessionSchema
>;

export const CreateUserbotSessionRequestSchema = z.object({
  phoneNumber: z.string().min(1),
  apiId: z.string().min(1),
  apiHash: z.string().optional(),
});
export type CreateUserbotSessionRequest = z.infer<
  typeof CreateUserbotSessionRequestSchema
>;

export const CreateUserbotSessionResponseSchema = z.object({
  session: PublicDistrictUserbotSessionSchema,
});
export type CreateUserbotSessionResponse = z.infer<
  typeof CreateUserbotSessionResponseSchema
>;

export const GetUserbotSessionResponseSchema = z.object({
  session: PublicDistrictUserbotSessionSchema.nullable(),
});
export type GetUserbotSessionResponse = z.infer<
  typeof GetUserbotSessionResponseSchema
>;

export const DisableUserbotSessionResponseSchema = z.object({
  session: PublicDistrictUserbotSessionSchema,
});
export type DisableUserbotSessionResponse = z.infer<
  typeof DisableUserbotSessionResponseSchema
>;

export const EnableUserbotSessionResponseSchema = z.object({
  session: PublicDistrictUserbotSessionSchema,
});
export type EnableUserbotSessionResponse = z.infer<
  typeof EnableUserbotSessionResponseSchema
>;
