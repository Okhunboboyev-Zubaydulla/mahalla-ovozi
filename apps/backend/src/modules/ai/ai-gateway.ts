import { eq, and, desc } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import { aiProfiles, type AiProfile } from '../../adapters/db/schema/ai.js';
import {
  type GenerateStructuredOptions,
  type AiGatewayResult,
  type AiProviderAdapterPort,
  type RawProviderPayload,
  type ProviderAttemptRecord,
  AiGatewayError,
} from './types.js';
import { compileProviderSchema } from './schema-compiler.js';

export interface AiGatewayPort {
  generateStructured<T>(options: GenerateStructuredOptions<T>): Promise<AiGatewayResult<T>>;
  getProfile(profileId: string): Promise<AiProfile | null>;
  getActiveProfile(operationType: string): Promise<AiProfile | null>;
}

export interface AiGatewayOptions {
  db?: DbClient;
  customAdapters?: Map<string, AiProviderAdapterPort>;
  defaultProfiles?: Map<string, AiProfile>;
}

export class AiGateway implements AiGatewayPort {
  private db?: DbClient;
  private adapters: Map<string, AiProviderAdapterPort> = new Map();
  private staticProfiles: Map<string, AiProfile> = new Map();

  constructor(options?: AiGatewayOptions) {
    this.db = options?.db;

    if (options?.customAdapters) {
      for (const [key, adapter] of options.customAdapters.entries()) {
        this.adapters.set(key, adapter);
      }
    }

    if (options?.defaultProfiles) {
      for (const [id, profile] of options.defaultProfiles.entries()) {
        this.staticProfiles.set(id, profile);
      }
    }
  }

  public registerAdapter(key: string, adapter: AiProviderAdapterPort): void {
    this.adapters.set(key, adapter);
  }

  public setStaticProfile(profile: AiProfile): void {
    this.staticProfiles.set(profile.id, profile);
  }

  public async getProfile(profileId: string): Promise<AiProfile | null> {
    if (this.staticProfiles.has(profileId)) {
      return this.staticProfiles.get(profileId)!;
    }

    if (this.db) {
      const [record] = await this.db
        .select()
        .from(aiProfiles)
        .where(eq(aiProfiles.id, profileId))
        .limit(1);
      if (record) {
        return record;
      }
    }

    return null;
  }

  public async getActiveProfile(operationType: string): Promise<AiProfile | null> {
    const matchingStatic: AiProfile[] = [];
    for (const profile of this.staticProfiles.values()) {
      if (profile.operationType === operationType && profile.isActive) {
        matchingStatic.push(profile);
      }
    }
    if (matchingStatic.length > 0) {
      matchingStatic.sort((a, b) => b.version - a.version);
      return matchingStatic[0] ?? null;
    }

    if (this.db) {
      const [record] = await this.db
        .select()
        .from(aiProfiles)
        .where(and(eq(aiProfiles.operationType, operationType), eq(aiProfiles.isActive, true)))
        .orderBy(desc(aiProfiles.version))
        .limit(1);
      if (record) {
        return record;
      }
    }

    return null;
  }

  private getAdapter(provider: string): AiProviderAdapterPort {
    const adapter = this.adapters.get(provider);
    if (adapter) {
      return adapter;
    }

    throw new AiGatewayError('PROVIDER_SERVER_ERROR', `No adapter registered for AI provider: ${provider}. Wire adapters at the composition root via AiGatewayOptions.customAdapters or registerAdapter().`, {
      retryable: false,
      provider,
    });
  }

  private calculateCostUsd(
    provider: string,
    _modelId: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    if (provider === 'OLLAMA' || provider === 'MOCK') {
      return 0.0;
    }
    if (provider === 'GEMINI') {
      // Gemini 2.0 / 1.5 Flash: $0.075 / 1M input, $0.30 / 1M output
      return Number(((inputTokens * 0.000000075) + (outputTokens * 0.0000003)).toFixed(6));
    }
    if (provider === 'DEEPINFRA') {
      // DeepInfra DeepSeek V4 Flash: $0.06 / 1M input, $0.18 / 1M output
      return Number(((inputTokens * 0.00000006) + (outputTokens * 0.00000018)).toFixed(6));
    }
    // OpenAI default: $0.15 / 1M input, $0.60 / 1M output
    return Number(((inputTokens * 0.00000015) + (outputTokens * 0.0000006)).toFixed(6));
  }

  public async generateStructured<T>(
    options: GenerateStructuredOptions<T>,
  ): Promise<AiGatewayResult<T>> {
    const callStartTime = performance.now();
    let profile: AiProfile | null = null;
    if (options.profileId) {
      profile = await this.getProfile(options.profileId);
    } else {
      profile = await this.getActiveProfile(options.operationType);
    }

    if (!profile) {
      throw new AiGatewayError(
        'PROFILE_NOT_FOUND',
        `No AI profile found for operation ${options.operationType}${options.profileId ? ` (${options.profileId})` : ''}`,
        { retryable: false },
      );
    }

    const adapter = this.getAdapter(profile.provider);
    const retryPolicy = (profile.retryPolicy as {
      maxAttempts?: number;
      backoffFactor?: number;
      initialDelayMs?: number;
    }) || { maxAttempts: 3, backoffFactor: 2, initialDelayMs: 500 };

    const maxAttempts = retryPolicy.maxAttempts ?? 3;
    const backoffFactor = retryPolicy.backoffFactor ?? 2;
    const initialDelayMs = retryPolicy.initialDelayMs ?? 500;

    const schemaName = options.schemaName || `${options.operationType.toLowerCase()}_schema`;
    const compiledSchema = compileProviderSchema(
      profile.provider as any,
      options.schema,
      schemaName,
    );

    const payload: RawProviderPayload = {
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      compiledSchema,
      schemaName,
      modelId: profile.modelId,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs,
    };

    let lastError: unknown = null;
    let totalTokens = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let finalDurationMs = 0;
    let finalProviderRequestId: string | undefined;
    const recordedAttempts: ProviderAttemptRecord[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.deadlineMs && performance.now() - callStartTime > options.deadlineMs) {
        throw new AiGatewayError(
          'PROVIDER_TIMEOUT',
          `Operation exceeded allocated deadline of ${options.deadlineMs}ms`,
          { status: 504, retryable: false, provider: profile.provider, modelId: profile.modelId },
        );
      }

      const attemptStartTime = performance.now();
      try {
        const response = await adapter.executeRequest(payload);
        finalDurationMs = response.durationMs;
        finalProviderRequestId = response.providerRequestId;
        totalTokens = {
          inputTokens: response.tokens.inputTokens,
          outputTokens: response.tokens.outputTokens,
          cachedTokens: response.tokens.cachedTokens ?? 0,
        };

        // 1. JSON Syntax Validation (strip markdown code block fences if present)
        let parsedJson: any;
        const cleanContent = response.rawContent
          .trim()
          .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
          .trim();

        try {
          parsedJson = JSON.parse(cleanContent);
        } catch (jsonErr: any) {
          throw new AiGatewayError(
            'INVALID_OUTPUT_SYNTAX',
            `Model output failed JSON syntax validation: ${jsonErr.message}`,
            {
              status: 502,
              retryable: attempt < maxAttempts,
              provider: profile.provider,
              modelId: profile.modelId,
              cause: jsonErr,
            },
          );
        }

        // 2. Semantic Schema Validation via Zod
        //
        // The gateway validates exactly what the model returned. It deliberately does NOT
        // rewrite caller-owned fields: each caller's schema owns the tolerance it needs for
        // model quirks, via its own z.preprocess. See GenerateStructuredOptions in types.ts.
        const parseResult = options.schema.safeParse(parsedJson);
        if (!parseResult.success) {
          throw new AiGatewayError(
            'INVALID_OUTPUT_SEMANTICS',
            `Model output failed semantic schema validation: ${parseResult.error.message}`,
            {
              status: 502,
              retryable: attempt < maxAttempts,
              provider: profile.provider,
              modelId: profile.modelId,
              cause: parseResult.error,
            },
          );
        }

        const estimatedCostUsd = this.calculateCostUsd(
          profile.provider,
          profile.modelId,
          totalTokens.inputTokens,
          totalTokens.outputTokens,
        );

        // Record successful attempt
        recordedAttempts.push({
          attemptNumber: attempt,
          provider: profile.provider,
          modelId: profile.modelId,
          providerRequestId: finalProviderRequestId,
          durationMs: finalDurationMs,
          inputTokens: totalTokens.inputTokens,
          outputTokens: totalTokens.outputTokens,
          cachedTokens: totalTokens.cachedTokens,
          estimatedCostUsd: estimatedCostUsd.toString(),
          status: 'SUCCESS',
        });

        return {
          data: parseResult.data,
          profileId: profile.id,
          provider: profile.provider,
          modelId: profile.modelId,
          providerRequestId: finalProviderRequestId,
          durationMs: Math.round(performance.now() - callStartTime),
          tokens: totalTokens,
          estimatedCostUsd,
          attempts: recordedAttempts,
        };
      } catch (err: any) {
        lastError = err;
        const attemptDurationMs = Math.round(performance.now() - attemptStartTime);
        const errorCode = err instanceof AiGatewayError ? err.code : 'PROVIDER_SERVER_ERROR';
        const isRefusal = errorCode === 'PROVIDER_REFUSAL';
        const isTimeout = errorCode === 'PROVIDER_TIMEOUT';
        const status: 'ERROR' | 'TIMEOUT' | 'REFUSAL' = isTimeout
          ? 'TIMEOUT'
          : isRefusal
            ? 'REFUSAL'
            : 'ERROR';

        const rawErrorMessage = err instanceof Error ? err.message : String(err);
        const scrubbedMessage = rawErrorMessage
          .replace(/sk-[A-Za-z0-9_-]{10,}/gi, 'sk-[REDACTED]')
          .replace(/AIza[A-Za-z0-9_-]{10,}/gi, 'AIza[REDACTED]')
          .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]')
          .slice(0, 200);

        recordedAttempts.push({
          attemptNumber: attempt,
          provider: profile.provider,
          modelId: profile.modelId,
          durationMs: attemptDurationMs,
          status,
          errorCode,
          sanitizedErrorMessage: scrubbedMessage,
        });

        const isRetryable =
          err instanceof AiGatewayError
            ? err.retryable
            : true;

        if (attempt < maxAttempts && isRetryable) {
          let delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);

          if (err instanceof AiGatewayError && err.code === 'RATE_LIMIT_EXCEEDED' && err.retryAfterMs && err.retryAfterMs > 0) {
            delay = Math.max(delay, err.retryAfterMs);
          }

          await new Promise((res) => setTimeout(res, delay));
          continue;
        }

        break;
      }
    }

    if (lastError instanceof AiGatewayError) {
      throw lastError;
    }

    throw new AiGatewayError(
      'PROVIDER_SERVER_ERROR',
      `AI Gateway failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      {
        status: 500,
        retryable: false,
        provider: profile.provider,
        modelId: profile.modelId,
        cause: lastError,
      },
    );
  }
}
