import 'dotenv/config';
import { AiGateway } from '../modules/ai/ai-gateway.js';
import { HttpProviderAdapter } from '../adapters/ai-providers/http-provider-adapter.js';
import {
  SemanticRelevanceResultSchema,
  SEMANTIC_RELEVANCE_SYSTEM_PROMPT,
} from '../modules/ai/semantic-relevance-evaluator.js';
import type { AiProfile } from '../adapters/db/schema/ai.js';

export async function verifyDeepInfraConnection(): Promise<void> {
  console.log('\n==============================================================');
  console.log('         DEEPINFRA CLOUD LIVE INTEGRATION VERIFICATION        ');
  console.log('==============================================================\n');

  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error('❌ Error: DEEPINFRA_API_KEY is not defined in your environment or apps/backend/.env file.');
    process.exit(1);
  }

  const maskedKey = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
  const modelId = process.env.AI_MODEL_ID || 'deepseek-ai/DeepSeek-V4-Flash-0731';

  console.log(`Provider:        DeepInfra`);
  console.log(`API Key:         ${maskedKey}`);
  console.log(`Target Model:    ${modelId}`);
  console.log(`Base URL:        ${process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai'}`);
  console.log('--------------------------------------------------------------\n');

  const deepinfraAdapter = new HttpProviderAdapter('DEEPINFRA');
  const customAdapters = new Map([['DEEPINFRA', deepinfraAdapter]]);

  const verificationProfile: AiProfile = {
    id: 'prof_deepinfra_verify_v1',
    version: 1,
    operationType: 'SEMANTIC_RELEVANCE',
    provider: 'DEEPINFRA',
    modelId,
    promptVersion: 'prom_rel_v1',
    schemaVersion: 'sch_rel_v1',
    temperature: 0.0,
    maxOutputTokens: 2048,
    timeoutMs: 30000,
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
    createdAt: new Date(),
  };

  const defaultProfiles = new Map([['prof_deepinfra_verify_v1', verificationProfile]]);
  const gateway = new AiGateway({ customAdapters, defaultProfiles });

  const testCivicComplaint =
    'Bogʻzor mahallasida 3 kundan beri toza ichimlik suvi yoʻq, quvurlar yorilib ketgan. Suv taʼminotiga telefon qildik, hech kim kelmadi.';

  console.log(`Evaluating Sample Civic Message:\n"${testCivicComplaint}"\n`);
  console.log('Sending request to DeepInfra API...');
  const t0 = performance.now();

  try {
    const result = await gateway.generateStructured({
      operationType: 'SEMANTIC_RELEVANCE',
      userPrompt: `### CANDIDATE TELEGRAM MESSAGE TO EVALUATE
- Message ID: test-msg-001
- Timestamp: ${new Date().toISOString()}
- Content Type: TEXT
- Text: "${testCivicComplaint}"

### CURRENT DAILY LOCAL CONTEXT SNAPSHOT
Mahalla: Bogʻzor
District ID: dist_test_live
No prior accepted issues for this mahalla today.`,
      systemPrompt: SEMANTIC_RELEVANCE_SYSTEM_PROMPT,
      schema: SemanticRelevanceResultSchema,
      schemaName: 'semantic_relevance_result',
      profileId: 'prof_deepinfra_verify_v1',
    });

    const elapsed = Math.round(performance.now() - t0);
    console.log('\n✅ Verification Result: SUCCESS');
    console.log(`Duration:        ${elapsed}ms`);
    console.log(`Tokens:          Input: ${result.tokens.inputTokens}, Output: ${result.tokens.outputTokens}`);
    console.log(`Estimated Cost:  $${result.estimatedCostUsd.toFixed(6)}`);
    console.log('\nStructured Output:');
    console.log(JSON.stringify(result.data, null, 2));
    console.log('\n==============================================================');
    console.log('       DEEPINFRA INTEGRATION READY FOR PRODUCTION USE          ');
    console.log('==============================================================\n');
  } catch (error: any) {
    console.error('\n❌ Verification Result: FAILED');
    console.error(`Error Code:    ${error?.code || 'UNKNOWN'}`);
    console.error(`Status Code:   ${error?.status || 'N/A'}`);
    console.error(`Error Message: ${error?.message || String(error)}`);
    if (error?.cause) {
      console.error('Underlying Cause:', error.cause);
    }
    process.exit(1);
  }
}

verifyDeepInfraConnection().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
