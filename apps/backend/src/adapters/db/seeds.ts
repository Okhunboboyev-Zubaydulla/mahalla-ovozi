import { and, ne } from 'drizzle-orm';
import {
  aiProfiles,
  NewAiProfile,
  districtAnalysisSettingsVersions,
  NewDistrictAnalysisSettingsVersion,
} from './schema/ai.js';
import { DEFAULT_HOKIM_RECOGNITION_TERMS } from '@mahalla-ovozi/api-contracts';
import type { DbOrTx } from './client.js';
import { activeAiConfig } from '../../modules/ai/ai-config.js';

const defaultProvider: 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA' =
  (process.env.AI_PROVIDER as 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA') ||
  activeAiConfig.modelProvider ||
  'OLLAMA';
const defaultModelId: string =
  process.env.AI_MODEL_ID ||
  (activeAiConfig.modelProvider === defaultProvider ? activeAiConfig.modelId : '') ||
  (defaultProvider === 'DEEPINFRA'
    ? 'deepseek-ai/DeepSeek-V4-Flash-0731'
    : defaultProvider === 'GEMINI'
      ? 'gemini-3.6-flash'
      : defaultProvider === 'OPENAI'
        ? 'gpt-4o-mini'
        : 'gemma4:12b');
const defaultTimeoutMs = 30000;

export const defaultSemanticRelevanceProfile: NewAiProfile = {
  id: 'prof_rel_2026_08_v1',
  version: 1,
  operationType: 'SEMANTIC_RELEVANCE',
  provider: defaultProvider,
  modelId: defaultModelId,
  promptVersion: 'prom_rel_v1',
  schemaVersion: 'sch_rel_v1',
  temperature: activeAiConfig.temperature,
  maxOutputTokens: activeAiConfig.maxOutputTokens,
  timeoutMs: defaultTimeoutMs,
  retryPolicy: {
    maxAttempts: 3,
    backoffFactor: 2,
    initialDelayMs: 1000,
  },
  capabilities: {
    structuredOutputs: true,
    jsonSchemaMode: 'strict',
  },
  isActive: true,
};

export const defaultTopicMatchingProfile: NewAiProfile = {
  id: 'prof_match_2026_08_v1',
  version: 1,
  operationType: 'TOPIC_MATCHING',
  provider: defaultProvider,
  modelId: defaultModelId,
  promptVersion: 'prom_match_v1',
  schemaVersion: 'sch_match_v1',
  temperature: 0.0,
  maxOutputTokens: 2048,
  timeoutMs: defaultTimeoutMs,
  retryPolicy: {
    maxAttempts: 3,
    backoffFactor: 2,
    initialDelayMs: 1000,
  },
  capabilities: {
    structuredOutputs: true,
    jsonSchemaMode: 'strict',
  },
  isActive: true,
};

export const defaultTopicProjectionProfile: NewAiProfile = {
  id: 'prof_proj_2026_08_v1',
  version: 1,
  operationType: 'TOPIC_DERIVED_PROJECTION',
  provider: defaultProvider,
  modelId: defaultModelId,
  promptVersion: 'prom_proj_v1',
  schemaVersion: 'sch_proj_v1',
  temperature: 0.0,
  maxOutputTokens: 2048,
  timeoutMs: defaultTimeoutMs,
  retryPolicy: {
    maxAttempts: 3,
    backoffFactor: 2,
    initialDelayMs: 1000,
  },
  capabilities: {
    structuredOutputs: true,
    jsonSchemaMode: 'strict',
  },
  isActive: true,
};


export async function ensureDefaultAiProfiles(db: DbOrTx): Promise<void> {
  await db
    .update(aiProfiles)
    .set({ isActive: false })
    .where(
      and(
        ne(aiProfiles.id, defaultSemanticRelevanceProfile.id),
        ne(aiProfiles.id, defaultTopicMatchingProfile.id),
        ne(aiProfiles.id, defaultTopicProjectionProfile.id),
      ),
    );

  await db
    .insert(aiProfiles)
    .values(defaultSemanticRelevanceProfile)
    .onConflictDoUpdate({
      target: aiProfiles.id,
      set: {
        provider: defaultSemanticRelevanceProfile.provider,
        modelId: defaultSemanticRelevanceProfile.modelId,
        temperature: defaultSemanticRelevanceProfile.temperature,
        maxOutputTokens: defaultSemanticRelevanceProfile.maxOutputTokens,
        timeoutMs: defaultSemanticRelevanceProfile.timeoutMs,
        retryPolicy: defaultSemanticRelevanceProfile.retryPolicy,
        isActive: true,
      },
    });
  await db
    .insert(aiProfiles)
    .values(defaultTopicMatchingProfile)
    .onConflictDoUpdate({
      target: aiProfiles.id,
      set: {
        provider: defaultTopicMatchingProfile.provider,
        modelId: defaultTopicMatchingProfile.modelId,
        timeoutMs: defaultTopicMatchingProfile.timeoutMs,
        retryPolicy: defaultTopicMatchingProfile.retryPolicy,
        isActive: true,
      },
    });
  await db
    .insert(aiProfiles)
    .values(defaultTopicProjectionProfile)
    .onConflictDoUpdate({
      target: aiProfiles.id,
      set: {
        provider: defaultTopicProjectionProfile.provider,
        modelId: defaultTopicProjectionProfile.modelId,
        timeoutMs: defaultTopicProjectionProfile.timeoutMs,
        retryPolicy: defaultTopicProjectionProfile.retryPolicy,
        isActive: true,
      },
    });
}

export function createDefaultDistrictAnalysisSettingsVersion(
  districtId: string,
): NewDistrictAnalysisSettingsVersion {
  return {
    id: `dcfg_${districtId}_v1`,
    districtId,
    version: 1,
    hokimRecognitionTerms: [...DEFAULT_HOKIM_RECOGNITION_TERMS],
    localVocabularyAdditions: [],
    isActive: true,
    activatedAt: new Date('2026-08-01T00:00:00.000Z'),
    activatedBy: null,
    changeReason: 'Туманнинг дастлабки фаол созламалари',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

export async function ensureDefaultDistrictAnalysisSettings(
  db: DbOrTx,
  districtId: string,
): Promise<void> {
  const defaultVersion = createDefaultDistrictAnalysisSettingsVersion(districtId);
  await db
    .insert(districtAnalysisSettingsVersions)
    .values(defaultVersion)
    .onConflictDoNothing({ target: districtAnalysisSettingsVersions.id });
}


