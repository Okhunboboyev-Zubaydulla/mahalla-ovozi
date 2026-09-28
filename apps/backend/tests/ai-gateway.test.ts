import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { AiGateway } from '../src/modules/ai/ai-gateway.js';
import {
  compilePortableJsonSchema,
  compileProviderSchema,
} from '../src/modules/ai/schema-compiler.js';
import { MockProviderAdapter } from '../src/adapters/ai-providers/mock-provider-adapter.js';
import { HttpProviderAdapter } from '../src/adapters/ai-providers/http-provider-adapter.js';
import { AiGatewayError } from '../src/modules/ai/types.js';
import type { AiProfile } from '../src/adapters/db/schema/ai.js';

describe('AI Gateway & Portable Schema Compiler Unit Tests', () => {
  const TestSchema = z.object({
    title: z.string().describe('The title of the issue'),
    count: z.number().describe('Estimated count'),
    is_urgent: z.boolean().describe('Urgency flag'),
    category: z.enum(['WATER', 'ELECTRICITY', 'GAS']),
    notes: z.string().nullable().describe('Optional notes'),
  });

  const testProfile: AiProfile = {
    id: 'prof_test_v1',
    version: 1,
    operationType: 'SEMANTIC_RELEVANCE',
    provider: 'MOCK',
    modelId: 'mock-model-v1',
    promptVersion: 'prom_v1',
    schemaVersion: 'sch_v1',
    temperature: 0.0,
    maxOutputTokens: 200,
    timeoutMs: 5000,
    retryPolicy: {
      maxAttempts: 3,
      backoffFactor: 1.5,
      initialDelayMs: 10,
    },
    capabilities: {
      structuredOutputs: true,
      jsonSchemaMode: 'strict',
    },
    isActive: true,
    createdAt: new Date(),
  };

  describe('Portable JSON Schema Compiler', () => {
    it('compiles Zod schema to strict JSON Schema with required keys and additionalProperties: false', () => {
      const compiled = compilePortableJsonSchema(TestSchema);

      expect(compiled.type).toBe('object');
      expect(compiled.additionalProperties).toBe(false);
      expect(compiled.required).toEqual(['title', 'count', 'is_urgent', 'category', 'notes']);
      expect(compiled.properties?.title.type).toBe('string');
      expect(compiled.properties?.count.type).toBe('number');
      expect(compiled.properties?.is_urgent.type).toBe('boolean');
      expect(compiled.properties?.category.enum).toEqual(['WATER', 'ELECTRICITY', 'GAS']);
      expect(compiled.properties?.notes.nullable).toBe(true);
    });

    it('compiles for OpenAI and DeepInfra with strict json_schema wrapper and anyOf nullables', () => {
      const openAiFormat: any = compileProviderSchema('OPENAI', TestSchema, 'test_payload');
      expect(openAiFormat.type).toBe('json_schema');
      expect(openAiFormat.json_schema.name).toBe('test_payload');
      expect(openAiFormat.json_schema.strict).toBe(true);
      expect(openAiFormat.json_schema.schema.additionalProperties).toBe(false);
      // OpenAI strict mode uses anyOf for nullables without nullable: true
      expect(openAiFormat.json_schema.schema.properties.notes.anyOf).toEqual([
        { type: 'string', description: 'Optional notes' },
        { type: 'null' },
      ]);
      expect(openAiFormat.json_schema.schema.properties.notes.nullable).toBeUndefined();

      const deepInfraFormat: any = compileProviderSchema('DEEPINFRA', TestSchema, 'test_payload');
      expect(deepInfraFormat.type).toBe('json_schema');
      expect(deepInfraFormat.json_schema.name).toBe('test_payload');
    });

    it('compiles z.literal and z.nativeEnum correctly', () => {
      const StatusEnum = {
        ACTIVE: 'active',
        INACTIVE: 'inactive',
      } as const;
      const EnumSchema = z.object({
        mode: z.literal('DIRECT'),
        status: z.nativeEnum(StatusEnum),
      });

      const compiled = compilePortableJsonSchema(EnumSchema);
      expect(compiled.properties?.mode.type).toBe('string');
      expect(compiled.properties?.mode.enum).toEqual(['DIRECT']);
      expect(compiled.properties?.status.type).toBe('string');
      expect(compiled.properties?.status.enum).toEqual(['active', 'inactive']);
    });

    it('compiles for Gemini REST with responseSchema and uppercase types', () => {
      const geminiFormat: any = compileProviderSchema('GEMINI', TestSchema, 'test_payload');
      expect(geminiFormat.responseMimeType).toBe('application/json');
      expect(geminiFormat.responseSchema.type).toBe('OBJECT');
      expect(geminiFormat.responseSchema.properties.title.type).toBe('STRING');
      expect(geminiFormat.responseSchema.properties.count.type).toBe('NUMBER');
      expect(geminiFormat.responseSchema.properties.is_urgent.type).toBe('BOOLEAN');
      expect(geminiFormat.responseSchema.properties.notes.nullable).toBe(true);
      // Nullable field omitted from required in Gemini to prevent validation error
      expect(geminiFormat.responseSchema.required).not.toContain('notes');
    });

    it('compiles for Ollama format', () => {
      const ollamaFormat: any = compileProviderSchema('OLLAMA', TestSchema, 'test_payload');
      expect(ollamaFormat.type).toBe('object');
      expect(ollamaFormat.properties.title.type).toBe('string');
    });
  });

  describe('AI Gateway Execution & Retries', () => {
    let mockAdapter: MockProviderAdapter;
    let gateway: AiGateway;

    beforeEach(() => {
      mockAdapter = new MockProviderAdapter({
        title: 'Water Pipe Burst',
        count: 5,
        is_urgent: true,
        category: 'WATER',
        notes: null,
      });

      const customAdapters = new Map<string, any>();
      customAdapters.set('MOCK', mockAdapter);

      const defaultProfiles = new Map<string, AiProfile>();
      defaultProfiles.set('prof_test_v1', testProfile);

      gateway = new AiGateway({ customAdapters, defaultProfiles });
    });

    it('executes successfully and returns structured validated result with metrics and attempt tracking', async () => {
      const result = await gateway.generateStructured({
        operationType: 'SEMANTIC_RELEVANCE',
        profileId: 'prof_test_v1',
        systemPrompt: 'You are an analyzer',
        userPrompt: 'Analyze this complaint',
        schema: TestSchema,
        schemaName: 'test_schema',
      });

      expect(result.data.title).toBe('Water Pipe Burst');
      expect(result.data.category).toBe('WATER');
      expect(result.profileId).toBe('prof_test_v1');
      expect(result.provider).toBe('MOCK');
      expect(result.tokens.inputTokens).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.status).toBe('SUCCESS');
    });

    it('strips markdown code block fences returned by models', async () => {
      mockAdapter.setNextResponse('```json\n{\n  "title": "Water Leak",\n  "count": 1,\n  "is_urgent": false,\n  "category": "WATER",\n  "notes": null\n}\n```');

      const result = await gateway.generateStructured({
        operationType: 'SEMANTIC_RELEVANCE',
        profileId: 'prof_test_v1',
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: TestSchema,
        schemaName: 'test_schema',
      });

      expect(result.data.title).toBe('Water Leak');
    });

    it('throws PROFILE_NOT_FOUND when requested profile does not exist', async () => {
      await expect(
        gateway.generateStructured({
          operationType: 'SEMANTIC_RELEVANCE',
          profileId: 'non_existent_profile',
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: TestSchema,
          schemaName: 'test_schema',
        }),
      ).rejects.toMatchObject({
        code: 'PROFILE_NOT_FOUND',
      });
    });

    it('retries on transient rate limit (429) and captures attempt history in attempts array', async () => {
      // 1st attempt fails with rate limit, 2nd attempt succeeds
      mockAdapter.enqueueBehavior({
        error: new AiGatewayError('RATE_LIMIT_EXCEEDED', 'Rate limited', {
          status: 429,
          retryable: true,
        }),
      });

      const result = await gateway.generateStructured({
        operationType: 'SEMANTIC_RELEVANCE',
        profileId: 'prof_test_v1',
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: TestSchema,
        schemaName: 'test_schema',
      });

      expect(result.data.title).toBe('Water Pipe Burst');
      expect(mockAdapter.getCalls()).toHaveLength(2);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.status).toBe('ERROR');
      expect(result.attempts[0]?.errorCode).toBe('RATE_LIMIT_EXCEEDED');
      expect(result.attempts[1]?.status).toBe('SUCCESS');
    });

    it('retries on syntax error (invalid JSON string) and succeeds on subsequent attempt', async () => {
      // 1st attempt returns malformed JSON string
      mockAdapter.setNextResponse('INVALID_NOT_JSON');

      const result = await gateway.generateStructured({
        operationType: 'SEMANTIC_RELEVANCE',
        profileId: 'prof_test_v1',
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: TestSchema,
        schemaName: 'test_schema',
      });

      expect(result.data.title).toBe('Water Pipe Burst');
      expect(mockAdapter.getCalls()).toHaveLength(2);
    });

    it('throws INVALID_OUTPUT_SYNTAX when model produces invalid JSON across all attempts', async () => {
      mockAdapter.setNextResponse('MALFORMED_JSON_1');
      mockAdapter.setNextResponse('MALFORMED_JSON_2');
      mockAdapter.setNextResponse('MALFORMED_JSON_3');

      await expect(
        gateway.generateStructured({
          operationType: 'SEMANTIC_RELEVANCE',
          profileId: 'prof_test_v1',
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: TestSchema,
          schemaName: 'test_schema',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_OUTPUT_SYNTAX',
      });

      expect(mockAdapter.getCalls()).toHaveLength(3);
    });

    it('throws INVALID_OUTPUT_SEMANTICS when model output violates Zod schema across all attempts', async () => {
      const invalidData = {
        title: 'Title',
        count: 'NOT_A_NUMBER', // Violation
        is_urgent: true,
        category: 'INVALID_CATEGORY', // Violation
      };

      mockAdapter.setNextResponse(invalidData);
      mockAdapter.setNextResponse(invalidData);
      mockAdapter.setNextResponse(invalidData);

      await expect(
        gateway.generateStructured({
          operationType: 'SEMANTIC_RELEVANCE',
          profileId: 'prof_test_v1',
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: TestSchema,
          schemaName: 'test_schema',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_OUTPUT_SEMANTICS',
      });

      expect(mockAdapter.getCalls()).toHaveLength(3);
    });

    it('does not retry on non-retryable error (e.g. AUTHENTICATION_ERROR)', async () => {
      mockAdapter.setNextError(
        new AiGatewayError('AUTHENTICATION_ERROR', 'Bad API Key', {
          status: 401,
          retryable: false,
        }),
      );

      await expect(
        gateway.generateStructured({
          operationType: 'SEMANTIC_RELEVANCE',
          profileId: 'prof_test_v1',
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: TestSchema,
          schemaName: 'test_schema',
        }),
      ).rejects.toMatchObject({
        code: 'AUTHENTICATION_ERROR',
      });

      expect(mockAdapter.getCalls()).toHaveLength(1);
    });

    // L3-P05-02: the gateway used to rewrite caller-owned fields (decision,
    // matched_topic_id, primary_lane, lanes, is_hokim_related, is_relevant,
    // exclusion_reason, relevant_lanes, reasoning) BEFORE safeParse. It no longer does:
    // a schema that wants model quirks tolerated must declare that tolerance itself.
    it('L3-P05-02: does not repair caller-owned payload fields before safeParse', async () => {
      // The caller's schema owns its consistency rule. Before L3-P05-02 the gateway
      // pre-nulled primary_lane for MATCH_EXISTING_TOPIC, so this refine could never
      // fire in production. It must now.
      const CallerOwnedSchema = z
        .object({
          decision: z.enum(['MATCH_EXISTING_TOPIC', 'NEW_TOPIC']),
          matched_topic_id: z.string().nullable(),
          primary_lane: z.string().nullable(),
        })
        .refine(
          (data) =>
            data.decision !== 'MATCH_EXISTING_TOPIC' || data.primary_lane === null,
          { message: 'MATCH_EXISTING_TOPIC requires a null primary_lane' },
        );

      const inconsistent = {
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_id: 'top_1',
        primary_lane: 'WATER',
      };
      mockAdapter.setNextResponse(inconsistent);
      mockAdapter.setNextResponse(inconsistent);
      mockAdapter.setNextResponse(inconsistent);

      await expect(
        gateway.generateStructured({
          operationType: 'TOPIC_MATCHING',
          profileId: 'prof_test_v1',
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: CallerOwnedSchema,
          schemaName: 'caller_owned_schema',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_OUTPUT_SEMANTICS' });

      expect(mockAdapter.getCalls()).toHaveLength(3);
    });

    it('L3-P05-02: still strips markdown code block fences (provider-generic cleanup)', async () => {
      const CallerOwnedSchema = z.object({
        decision: z.enum(['MATCH_EXISTING_TOPIC', 'NEW_TOPIC']),
        matched_topic_id: z.string().nullable(),
        primary_lane: z.string().nullable(),
      });

      mockAdapter.setNextResponse({
        decision: 'NEW_TOPIC',
        matched_topic_id: null,
        primary_lane: 'WATER',
      });

      const result = await gateway.generateStructured({
        operationType: 'TOPIC_MATCHING',
        profileId: 'prof_test_v1',
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: CallerOwnedSchema,
        schemaName: 'caller_owned_schema',
      });

      expect(result.data.decision).toBe('NEW_TOPIC');
      expect(result.data.primary_lane).toBe('WATER');
    });
  });

  describe('HttpProviderAdapter - Ollama Provider', () => {
    it('throws CONTEXT_LIMIT_EXCEEDED when Ollama returns done_reason = length', async () => {
      const adapter = new HttpProviderAdapter('OLLAMA');
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              model: 'gemma4:12b',
              done: true,
              done_reason: 'length',
              prompt_eval_count: 3927,
              eval_count: 169,
              message: { role: 'assistant', content: '{"summary": "incomplete...' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )) as any;

        await expect(
          adapter.executeRequest({
            systemPrompt: 'sys',
            userPrompt: 'user',
            compiledSchema: {},
            schemaName: 'test',
            modelId: 'gemma4:12b',
            temperature: 0,
            maxOutputTokens: 600,
            timeoutMs: 1000,
          }),
        ).rejects.toMatchObject({
          code: 'CONTEXT_LIMIT_EXCEEDED',
          message: expect.stringContaining('Ollama output truncated due to context/token limit'),
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sets num_ctx and keep_alive in Ollama request payload', async () => {
      const adapter = new HttpProviderAdapter('OLLAMA');
      const originalFetch = globalThis.fetch;
      let capturedBody: any;
      try {
        globalThis.fetch = (async (_url: any, init: any) => {
          capturedBody = JSON.parse(init.body);
          return new Response(
            JSON.stringify({
              model: 'gemma4:12b',
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 100,
              eval_count: 50,
              message: { role: 'assistant', content: '{"status": "ok"}' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }) as any;

        await adapter.executeRequest({
          systemPrompt: 'sys',
          userPrompt: 'user',
          compiledSchema: {},
          schemaName: 'test',
          modelId: 'gemma4:12b',
          temperature: 0.1,
          maxOutputTokens: 500,
          timeoutMs: 1000,
        });

        expect(capturedBody.options.num_ctx).toBe(8192);
        expect(capturedBody.keep_alive).toBe('5m');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
