import {
  type AiProviderAdapterPort,
  type RawProviderPayload,
  type RawProviderResponse,
  AiGatewayError,
} from '../../modules/ai/types.js';

export class HttpProviderAdapter implements AiProviderAdapterPort {
  public readonly providerName: 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA';

  constructor(providerName: 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA') {
    this.providerName = providerName;
  }

  public async executeRequest(payload: RawProviderPayload): Promise<RawProviderResponse> {
    const startTime = performance.now();
    const timeoutMs = payload.timeoutMs || 10000;

    let url: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    let body: Record<string, any>;

    switch (this.providerName) {
      case 'OPENAI': {
        const baseUrl = payload.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        url = `${baseUrl}/chat/completions`;
        const apiKey = payload.apiKey || process.env.OPENAI_API_KEY || '';
        if (!apiKey) {
          throw new AiGatewayError('AUTHENTICATION_ERROR', 'OpenAI API key is missing', {
            status: 401,
            retryable: false,
            provider: 'OPENAI',
            modelId: payload.modelId,
          });
        }
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          model: payload.modelId,
          messages: [
            { role: 'system', content: payload.systemPrompt },
            { role: 'user', content: payload.userPrompt },
          ],
          temperature: payload.temperature,
          max_tokens: payload.maxOutputTokens,
          response_format: payload.compiledSchema,
        };
        break;
      }

      case 'DEEPINFRA': {
        const baseUrl = payload.baseUrl || process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai';
        url = `${baseUrl}/chat/completions`;
        const apiKey = payload.apiKey || process.env.DEEPINFRA_API_KEY || '';
        if (!apiKey) {
          throw new AiGatewayError('AUTHENTICATION_ERROR', 'DeepInfra API key is missing', {
            status: 401,
            retryable: false,
            provider: 'DEEPINFRA',
            modelId: payload.modelId,
          });
        }
        headers['Authorization'] = `Bearer ${apiKey}`;
        const deepinfraSystemPrompt = `${payload.systemPrompt}\n\nCRITICAL JSON INSTRUCTION: Output ONLY a valid, parseable JSON object adhering strictly to the provided schema. Start immediately with '{'. Do not include markdown fences, preambles, or conversational commentary.`;
        body = {
          model: payload.modelId,
          messages: [
            { role: 'system', content: deepinfraSystemPrompt },
            { role: 'user', content: payload.userPrompt },
          ],
          temperature: payload.temperature,
          max_tokens: Math.max(payload.maxOutputTokens || 0, 2048),
          response_format: payload.compiledSchema,
        };
        break;
      }

      case 'GEMINI': {
        const baseUrl =
          payload.baseUrl ||
          process.env.GEMINI_BASE_URL ||
          'https://generativelanguage.googleapis.com/v1beta';
        url = `${baseUrl}/models/${payload.modelId}:generateContent`;
        const apiKey = payload.apiKey || process.env.GEMINI_API_KEY || '';
        if (!apiKey) {
          throw new AiGatewayError('AUTHENTICATION_ERROR', 'Gemini API key is missing', {
            status: 401,
            retryable: false,
            provider: 'GEMINI',
            modelId: payload.modelId,
          });
        }
        headers['x-goog-api-key'] = apiKey;
        const thinkingBudgetEnv = process.env.GEMINI_THINKING_BUDGET;
        const thinkingLevelEnv = process.env.GEMINI_THINKING_LEVEL;

        let thinkingConfig: Record<string, any> | undefined;
        if (thinkingBudgetEnv !== undefined) {
          const budget = Number(thinkingBudgetEnv);
          if (budget >= 0) thinkingConfig = { thinkingBudget: budget };
        } else {
          const level = thinkingLevelEnv || 'MINIMAL';
          if (level !== 'NONE') {
            thinkingConfig = { thinkingLevel: level };
          }
        }

        body = {
          contents: [
            {
              role: 'user',
              parts: [{ text: payload.userPrompt }],
            },
          ],
          systemInstruction: {
            parts: [{ text: payload.systemPrompt }],
          },
          generationConfig: {
            temperature: payload.temperature,
            maxOutputTokens: Math.max(payload.maxOutputTokens || 0, 2048),
            ...(thinkingConfig ? { thinkingConfig } : {}),
            ...payload.compiledSchema,
          },
        };
        break;
      }

      case 'OLLAMA': {
        const baseUrl = payload.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        url = `${baseUrl}/api/chat`;
        body = {
          model: payload.modelId,
          messages: [
            { role: 'system', content: payload.systemPrompt },
            { role: 'user', content: payload.userPrompt },
          ],
          stream: false,
          options: {
            temperature: payload.temperature,
            num_predict: payload.maxOutputTokens,
            num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192),
          },
          format: payload.compiledSchema,
          think: false,
          keep_alive: process.env.OLLAMA_KEEP_ALIVE || '5m',
        };
        break;
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (isTimeout) {
        throw new AiGatewayError(
          'PROVIDER_TIMEOUT',
          `AI Provider request timed out after ${timeoutMs}ms`,
          {
            status: 504,
            retryable: true,
            provider: this.providerName,
            modelId: payload.modelId,
            cause: err,
          },
        );
      }
      const causeMsg = err?.cause instanceof Error ? err.cause.message : (err?.cause?.code ? String(err.cause.code) : '');
      const detail = causeMsg ? `${err?.message} (${causeMsg})` : `${err?.message}`;
      throw new AiGatewayError('NETWORK_ERROR', `Network error during AI request: ${detail}`, {
        status: 503,
        retryable: true,
        provider: this.providerName,
        modelId: payload.modelId,
        cause: err,
      });
    }

    const durationMs = Math.round(performance.now() - startTime);

    if (!response.ok) {
      let rawErrorBody = '';
      try {
        rawErrorBody = await response.text();
      } catch {
        // ignore
      }

      // Privacy-safe sanitization: truncate and redact potential sensitive prompts in error responses
      const errorBody = rawErrorBody.slice(0, 200);

      if (response.status === 408) {
        throw new AiGatewayError(
          'PROVIDER_TIMEOUT',
          `AI Provider request timed out (HTTP 408): ${errorBody}`,
          {
            status: 408,
            retryable: true,
            provider: this.providerName,
            modelId: payload.modelId,
          },
        );
      }

      if (response.status === 429) {
        let retryAfterMs = 0;
        const retryAfterHeader = response.headers.get('retry-after');
        if (retryAfterHeader) {
          const parsedSeconds = parseFloat(retryAfterHeader);
          if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
            retryAfterMs = Math.max(retryAfterMs, Math.ceil(parsedSeconds * 1000));
          }
        }
        throw new AiGatewayError('RATE_LIMIT_EXCEEDED', `AI Provider rate limit exceeded: ${errorBody}`, {
          status: 429,
          retryable: true,
          provider: this.providerName,
          modelId: payload.modelId,
          retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new AiGatewayError('AUTHENTICATION_ERROR', `AI Provider authentication error (${response.status}): ${errorBody}`, {
          status: response.status,
          retryable: false,
          provider: this.providerName,
          modelId: payload.modelId,
        });
      }

      if (response.status >= 500) {
        throw new AiGatewayError(
          'PROVIDER_SERVER_ERROR',
          `AI Provider internal server error (${response.status}): ${errorBody}`,
          {
            status: response.status,
            retryable: true,
            provider: this.providerName,
            modelId: payload.modelId,
          },
        );
      }

      if (response.status === 400 && errorBody.toLowerCase().includes('safety')) {
        throw new AiGatewayError('PROVIDER_REFUSAL', `AI Provider refused request: ${errorBody}`, {
          status: 400,
          retryable: false,
          provider: this.providerName,
          modelId: payload.modelId,
        });
      }

      throw new AiGatewayError('PROVIDER_SERVER_ERROR', `AI Provider error (${response.status}): ${errorBody}`, {
        status: response.status,
        retryable: false,
        provider: this.providerName,
        modelId: payload.modelId,
      });
    }

    let data: any;
    try {
      data = await response.json();
    } catch (jsonErr: any) {
      throw new AiGatewayError(
        'PROVIDER_SERVER_ERROR',
        `AI Provider returned non-JSON payload: ${jsonErr.message}`,
        {
          status: 502,
          retryable: true,
          provider: this.providerName,
          modelId: payload.modelId,
          cause: jsonErr,
        },
      );
    }

    return this.parseResponse(data, durationMs, payload.modelId);
  }

  private parseResponse(data: any, durationMs: number, modelId?: string): RawProviderResponse {
    switch (this.providerName) {
      case 'OPENAI':
      case 'DEEPINFRA': {
        const choice = data.choices?.[0];
        if (choice?.message?.refusal) {
          throw new AiGatewayError('PROVIDER_REFUSAL', `Model refused request: ${choice.message.refusal}`, {
            status: 400,
            retryable: false,
            provider: this.providerName,
          });
        }
        if (!choice?.message) {
          throw new AiGatewayError(
            'INVALID_OUTPUT_SYNTAX',
            'AI Provider response missing message choices',
            {
              status: 502,
              retryable: true,
              provider: this.providerName,
            },
          );
        }
        const rawContent = choice.message.content || '';
        return {
          rawContent,
          providerRequestId: data.id,
          durationMs,
          tokens: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
            cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      }

      case 'GEMINI': {
        if (!data.candidates?.length && data.promptFeedback?.blockReason) {
          throw new AiGatewayError(
            'PROVIDER_REFUSAL',
            `Gemini prompt blocked (${data.promptFeedback.blockReason})`,
            {
              status: 400,
              retryable: false,
              provider: 'GEMINI',
            },
          );
        }

        const candidate = data.candidates?.[0];
        const finishReason = candidate?.finishReason;

        if (
          finishReason === 'SAFETY' ||
          finishReason === 'RECITATION' ||
          finishReason === 'BLOCKLIST' ||
          finishReason === 'PROHIBITED_CONTENT' ||
          finishReason === 'SPII'
        ) {
          throw new AiGatewayError(
            'PROVIDER_REFUSAL',
            `Gemini content policy refusal: ${finishReason}`,
            {
              status: 400,
              retryable: false,
              provider: 'GEMINI',
            },
          );
        }

        if (finishReason === 'MAX_TOKENS') {
          throw new AiGatewayError(
            'CONTEXT_LIMIT_EXCEEDED',
            'Gemini output truncated due to maxOutputTokens limit',
            {
              status: 400,
              retryable: false,
              provider: 'GEMINI',
            },
          );
        }

        const rawContent = candidate?.content?.parts?.[0]?.text || '';
        return {
          rawContent,
          providerRequestId: data.modelVersion,
          durationMs,
          tokens: {
            inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            cachedTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
          },
        };
      }

      case 'OLLAMA': {
        if (data.done_reason === 'length') {
          throw new AiGatewayError(
            'CONTEXT_LIMIT_EXCEEDED',
            `Ollama output truncated due to context/token limit (prompt: ${data.prompt_eval_count ?? 0}, output: ${data.eval_count ?? 0})`,
            {
              status: 400,
              retryable: false,
              provider: 'OLLAMA',
              modelId: modelId || data.model,
            },
          );
        }

        const rawContent = data.message?.content || '';
        return {
          rawContent,
          durationMs,
          tokens: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
          },
        };
      }
    }
  }
}
