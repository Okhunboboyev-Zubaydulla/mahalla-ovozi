import {
  type AiProviderAdapterPort,
  type RawProviderPayload,
  type RawProviderResponse,
  AiGatewayError,
} from '../../modules/ai/types.js';

export interface MockAdapterBehavior {
  response?: Record<string, unknown> | string;
  error?: AiGatewayError;
  delayMs?: number;
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
}

export class MockProviderAdapter implements AiProviderAdapterPort {
  public readonly providerName = 'MOCK' as const;
  private callHistory: RawProviderPayload[] = [];
  private queuedBehaviors: MockAdapterBehavior[] = [];
  private defaultResponse: Record<string, unknown> = {
    is_relevant: true,
    relevant_lanes: ['WATER'],
    exclusion_reason: null,
    reasoning: 'Mock relevance decision',
  };

  constructor(defaultResponse?: Record<string, unknown>) {
    if (defaultResponse) {
      this.defaultResponse = defaultResponse;
    }
  }

  public enqueueBehavior(behavior: MockAdapterBehavior): void {
    this.queuedBehaviors.push(behavior);
  }

  public setNextResponse(response: Record<string, unknown> | string): void {
    this.queuedBehaviors.push({ response });
  }

  public setNextError(error: AiGatewayError): void {
    this.queuedBehaviors.push({ error });
  }

  public getCalls(): RawProviderPayload[] {
    return [...this.callHistory];
  }

  public setDefaultResponse(response: Record<string, unknown>): void {
    this.defaultResponse = response;
  }

  public clearHistory(): void {
    this.callHistory = [];
    this.queuedBehaviors = [];
  }

  public async executeRequest(payload: RawProviderPayload): Promise<RawProviderResponse> {
    this.callHistory.push(payload);

    const behavior = this.queuedBehaviors.shift();

    if (behavior?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    }

    if (behavior?.error) {
      throw behavior.error;
    }

    const responseContent = behavior?.response !== undefined ? behavior.response : this.defaultResponse;
    const rawContent =
      typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent);

    return {
      rawContent,
      providerRequestId: `mock_req_${Math.random().toString(36).slice(2, 10)}`,
      durationMs: behavior?.delayMs ?? 15,
      tokens: behavior?.tokens ?? {
        inputTokens: 100,
        outputTokens: 30,
        cachedTokens: 0,
      },
    };
  }
}
