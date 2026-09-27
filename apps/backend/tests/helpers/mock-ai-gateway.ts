import { AiGateway, type AiGatewayPort } from '../../src/modules/ai/ai-gateway.js';
import { MockProviderAdapter } from '../../src/adapters/ai-providers/mock-provider-adapter.js';
import {
  defaultSemanticRelevanceProfile,
  defaultTopicMatchingProfile,
  defaultTopicProjectionProfile,
} from '../../src/adapters/db/seeds.js';
import type { AiProfile } from '../../src/adapters/db/schema/ai.js';

export interface MockAiGatewayController {
  gateway: AiGatewayPort;
  mockAdapter: MockProviderAdapter;
}

export function createMockAiGateway(defaultResponse?: Record<string, unknown>): MockAiGatewayController {
  const mockAdapter = new MockProviderAdapter(defaultResponse);

  const customAdapters = new Map<string, any>();
  customAdapters.set('OPENAI', mockAdapter);
  customAdapters.set('MOCK', mockAdapter);
  customAdapters.set('GEMINI', mockAdapter);
  customAdapters.set('DEEPINFRA', mockAdapter);
  customAdapters.set('OLLAMA', mockAdapter);

  const defaultProfiles = new Map<string, AiProfile>();
  defaultProfiles.set(
    'prof_rel_2026_08_v1',
    defaultSemanticRelevanceProfile as AiProfile,
  );
  defaultProfiles.set(
    'prof_match_2026_08_v1',
    defaultTopicMatchingProfile as AiProfile,
  );
  defaultProfiles.set(
    'prof_proj_2026_08_v1',
    defaultTopicProjectionProfile as AiProfile,
  );

  const gateway = new AiGateway({
    customAdapters,
    defaultProfiles,
  });

  return {
    gateway,
    mockAdapter,
  };
}
