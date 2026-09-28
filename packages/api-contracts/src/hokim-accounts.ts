import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

export const HokimAccountStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
export type HokimAccountStatus = z.infer<typeof HokimAccountStatusSchema>;

export const HokimAccountStateEnumSchema = z.enum(['NO_ACCOUNT', 'ACTIVE', 'DISABLED']);
export type HokimAccountStateEnum = z.infer<typeof HokimAccountStateEnumSchema>;

export const DistrictHokimAccountSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  role: z.literal('DISTRICT_HOKIM'),
  status: HokimAccountStatusSchema,
  districtId: DistrictIdSchema,
  credentialVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DistrictHokimAccount = z.infer<typeof DistrictHokimAccountSchema>;

export const GetDistrictHokimAccountResponseSchema = z.object({
  state: HokimAccountStateEnumSchema,
  account: DistrictHokimAccountSchema.nullable(),
});
export type GetDistrictHokimAccountResponse = z.infer<typeof GetDistrictHokimAccountResponseSchema>;

export const HokimUsernameSchema = z
  .string()
  .trim()
  .min(3, 'Фойдаланувчи номи камида 3 та белги бўлиши керак.')
  .max(64, 'Фойдаланувчи номи 64 та белгидан ошмаслиги керак.')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_ -]*[\p{L}\p{N}]$/u, {
    message: 'Фойдаланувчи номи ҳарфлар, рақамлар, бўш жой, дефис ва тагчизиқдан иборат бўлиши керак.',
  });

export const CreateHokimAccountRequestSchema = z.object({
  username: HokimUsernameSchema,
});
export type CreateHokimAccountRequest = z.infer<typeof CreateHokimAccountRequestSchema>;

export const CreateHokimAccountResponseSchema = z.object({
  account: DistrictHokimAccountSchema,
  temporaryPassword: z.string().min(15).max(128),
});
export type CreateHokimAccountResponse = z.infer<typeof CreateHokimAccountResponseSchema>;

export const ResetHokimPasswordResponseSchema = z.object({
  account: DistrictHokimAccountSchema,
  temporaryPassword: z.string().min(15).max(128),
});
export type ResetHokimPasswordResponse = z.infer<typeof ResetHokimPasswordResponseSchema>;

export const ReplaceHokimAccountRequestSchema = z.object({
  newUsername: HokimUsernameSchema,
});
export type ReplaceHokimAccountRequest = z.infer<typeof ReplaceHokimAccountRequestSchema>;

export const ReplaceHokimAccountResponseSchema = z.object({
  account: DistrictHokimAccountSchema,
  temporaryPassword: z.string().min(15).max(128),
  previousAccountId: z.string().min(1),
});
export type ReplaceHokimAccountResponse = z.infer<typeof ReplaceHokimAccountResponseSchema>;

export const UpdateHokimUsernameRequestSchema = z.object({
  username: HokimUsernameSchema,
});
export type UpdateHokimUsernameRequest = z.infer<typeof UpdateHokimUsernameRequestSchema>;

export const UpdateHokimUsernameResponseSchema = z.object({
  account: DistrictHokimAccountSchema,
});
export type UpdateHokimUsernameResponse = z.infer<typeof UpdateHokimUsernameResponseSchema>;

export const DisableHokimAccountResponseSchema = z.object({
  account: DistrictHokimAccountSchema,
});
export type DisableHokimAccountResponse = z.infer<typeof DisableHokimAccountResponseSchema>;
