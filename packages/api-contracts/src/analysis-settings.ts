import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

export const AiModelProviderEnumSchema = z.enum([
  'OPENAI',
  'GEMINI',
  'DEEPINFRA',
  'OLLAMA',
]);
export type AiModelProvider = z.infer<typeof AiModelProviderEnumSchema>;

// ==========================================
// District Analysis Settings Contracts (Story 5.2)
// ==========================================

export const DEFAULT_HOKIM_RECOGNITION_TERMS = [
  'Ҳоким',
  'Туман ҳокими',
  'Ҳоким ёрдамчиси',
  'Ҳокимият',
  'Сектор раҳбари',
  'Hokim',
  'Tuman hokimi',
  'Hokimiyat',
] as const;

export const DEFAULT_DISTRICT_VOCABULARY_CATEGORIES = [
  'Маҳалла номлари',
  'Мўлжал ва жойлар',
  'Маҳаллий атамалар',
  'Сув ҳавзалари ва каналлар',
  'Маҳаллий муассасалар',
  'Бошқа',
] as const;

export const DistrictLocalVocabularyItemSchema = z.object({
  term: z
    .string()
    .trim()
    .min(1, 'Атама бўш бўлиши мумкин эмас.')
    .max(100, 'Атама 100 та белгидан ошмаслиги керак.'),
  category: z
    .string()
    .trim()
    .min(1, 'Тоифа бўш бўлиши мумкин эмас.')
    .max(100, 'Тоифа 100 та белгидан ошмаслиги керак.'),
  description: z
    .string()
    .trim()
    .max(500, 'Тавсиф 500 та белгидан ошмаслиги керак.')
    .optional(),
});
export type DistrictLocalVocabularyItem = z.infer<
  typeof DistrictLocalVocabularyItemSchema
>;

export const DistrictAnalysisSettingsDtoSchema = z.object({
  id: z.string(),
  districtId: DistrictIdSchema,
  version: z.number().int().positive(),
  hokimRecognitionTerms: z.array(z.string()),
  localVocabularyAdditions: z.array(DistrictLocalVocabularyItemSchema),
  isActive: z.boolean(),
  activatedAt: z.string().datetime().nullable(),
  activatedBy: z.string().nullable().optional(),
  changeReason: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});
export type DistrictAnalysisSettingsDto = z.infer<
  typeof DistrictAnalysisSettingsDtoSchema
>;

export const DistrictAnalysisSettingsDraftDtoSchema = z.object({
  id: z.string(),
  districtId: DistrictIdSchema,
  baseActiveVersionId: z.string().nullable().optional(),
  hokimRecognitionTerms: z.array(z.string()),
  localVocabularyAdditions: z.array(DistrictLocalVocabularyItemSchema),
  updatedBy: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DistrictAnalysisSettingsDraftDto = z.infer<
  typeof DistrictAnalysisSettingsDraftDtoSchema
>;

export const SaveDistrictAnalysisSettingsDraftSchema = z.object({
  hokimRecognitionTerms: z
    .array(
      z
        .string()
        .trim()
        .min(2, 'Ҳоким атамаси камида 2 та белгидан иборат бўлиши керак.')
        .max(100, 'Ҳоким атамаси 100 та белгидан ошмаслиги керак.'),
    )
    .min(1, 'Камида 1 та ҳокимга оид атама киритилиши шарт.')
    .max(50, 'Ҳокимга оид атамалар сони 50 тадан ошмаслиги керак.')
    .superRefine((terms, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        if (!term) continue;
        const normalized = term
          .trim()
          .normalize('NFC')
          .replace(/\s+/g, ' ')
          .toLowerCase();
        if (seen.has(normalized)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Ҳоким атамаси такрорланмаслиги керак: "${term}".`,
            path: [i],
          });
        }
        seen.add(normalized);
      }
    }),
  localVocabularyAdditions: z
    .array(DistrictLocalVocabularyItemSchema)
    .max(100, 'Маҳаллий луғат атамалари сони 100 тадан ошмаслиги керак.')
    .default([])
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const normalized = item.term
          .trim()
          .normalize('NFC')
          .replace(/\s+/g, ' ')
          .toLowerCase();
        if (seen.has(normalized)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Маҳаллий луғат атамаси такрорланмаслиги керак: "${item.term}".`,
            path: [i, 'term'],
          });
        }
        seen.add(normalized);
      }
    }),
});
export type SaveDistrictAnalysisSettingsDraftRequest = z.infer<
  typeof SaveDistrictAnalysisSettingsDraftSchema
>;

export const GetDistrictAnalysisSettingsResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  activeConfiguration: DistrictAnalysisSettingsDtoSchema,
  draft: DistrictAnalysisSettingsDraftDtoSchema.nullable(),
});
export type GetDistrictAnalysisSettingsResponse = z.infer<
  typeof GetDistrictAnalysisSettingsResponseSchema
>;

export const SaveDistrictAnalysisSettingsDraftResponseSchema = z.object({
  draft: DistrictAnalysisSettingsDraftDtoSchema,
  message: z.string(),
});
export type SaveDistrictAnalysisSettingsDraftResponse = z.infer<
  typeof SaveDistrictAnalysisSettingsDraftResponseSchema
>;

// ==========================================
// Story 5.3: Activation Contracts & Secret Scanning
// ==========================================

export const PROHIBITED_SECRET_PATTERNS = [
  // 1. Telegram Bot Token: 7 to 12 digits, colon, and 34 to 36 base64url characters
  /\b\d{7,12}:[A-Za-z0-9_-]{34,36}\b/,
  // 2. OpenAI API Keys (Legacy sk-, Project sk-proj-, Service Account sk-svcacct-, Admin sk-admin-, Org sk-org-)
  /\bsk-(?:proj-|svcacct-|admin-|org-)?[A-Za-z0-9_-]{20,}\b/,
  // 3. Google AI Studio / Gemini API Keys (Legacy AIza... and Modern AQ....)
  /\b(?:AIza[0-9A-Za-z-_]{35}|AQ\.[0-9A-Za-z-_]{20,})\b/,
  // 4. Groq Cloud API Key
  /\bgsk_[A-Za-z0-9_-]{40,64}\b/,
  // 5. Anthropic Claude API Key (sk-ant-api..., sk-ant-admin..., sk-ant-oat..., sk-ant-sid...)
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  // 6. JSON Web Tokens (JWT: 3 base64url parts starting with eyJ)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // 7. Authorization Bearer Token header string
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*\b/i,
  // 8. Explicit key assignment patterns (e.g. api_key = "...", secret = '...')
  /(?:api[_-]?key|secret[_-]?key|bot[_-]?token|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-.~+=]{16,}['"]?/i,
];

export function containsProhibitedSecrets(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return PROHIBITED_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Applies the prohibited-secret check inside an object-level `.superRefine` block.
 * Keeps secret-scanning regex patterns local to analysis-settings and avoids
 * Zod type gymnastics from field-level refinement on ZodEffects.
 */
export function applySecretCheck(
  val: string | null | undefined,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (val != null && containsProhibitedSecrets(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message:
        'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.',
    });
  }
}


export const ChangeReasonSchema = z
  .string({ invalid_type_error: 'Ўзгартириш сабаби матн бўлиши шарт.' })
  .trim()
  .min(5, 'Ўзгартириш сабаби камида 5 та белгидан иборат бўлиши шарт.')
  .max(500, 'Ўзгартириш сабаби 500 та белгидан ошмаслиги керак.')
  .superRefine((val, ctx) => {
    if (containsProhibitedSecrets(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Ўзгартириш сабабида махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.',
      });
    }
  });


export const ActivateDistrictAnalysisSettingsRequestSchema = z.object({
  baseActiveVersionId: z
    .string({ invalid_type_error: 'Базавий фаол версия идентификатори талаб қилинади.' })
    .trim()
    .min(1, 'Базавий фаол версия идентификатори талаб қилинади.'),
  changeReason: ChangeReasonSchema,
});
export type ActivateDistrictAnalysisSettingsRequest = z.infer<
  typeof ActivateDistrictAnalysisSettingsRequestSchema
>;

export const ActivateDistrictAnalysisSettingsResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  activeConfiguration: DistrictAnalysisSettingsDtoSchema,
  previousVersionId: z.string(),
  message: z.string(),
});
export type ActivateDistrictAnalysisSettingsResponse = z.infer<
  typeof ActivateDistrictAnalysisSettingsResponseSchema
>;

// ==========================================
// Story 5.4: History & Rollback Contracts
// ==========================================

export const DistrictAnalysisSettingsHistoryResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  items: z.array(DistrictAnalysisSettingsDtoSchema),
  totalCount: z.number().int().nonnegative(),
});
export type DistrictAnalysisSettingsHistoryResponse = z.infer<
  typeof DistrictAnalysisSettingsHistoryResponseSchema
>;
export const RollbackDistrictAnalysisSettingsRequestSchema = z.object({
  baseActiveVersionId: z
    .string({ invalid_type_error: 'Базавий фаол версия идентификатори талаб қилинади.' })
    .trim()
    .min(1, 'Базавий фаол версия идентификатори талаб қилинади.'),
  targetVersionId: z
    .string({ invalid_type_error: 'Қайтариладиган версия идентификатори талаб қилинади.' })
    .trim()
    .min(1, 'Қайтариладиган версия идентификатори талаб қилинади.'),
  changeReason: ChangeReasonSchema,
});
export type RollbackDistrictAnalysisSettingsRequest = z.infer<
  typeof RollbackDistrictAnalysisSettingsRequestSchema
>;

export const RollbackDistrictAnalysisSettingsResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  activeConfiguration: DistrictAnalysisSettingsDtoSchema,
  restoredFromVersionId: z.string(),
  previousActiveVersionId: z.string(),
  message: z.string(),
});
export type RollbackDistrictAnalysisSettingsResponse = z.infer<
  typeof RollbackDistrictAnalysisSettingsResponseSchema
>;
