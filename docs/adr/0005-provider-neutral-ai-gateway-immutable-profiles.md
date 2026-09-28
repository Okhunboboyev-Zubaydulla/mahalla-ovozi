---
status: accepted
date: 2026-08-12
---

# Provider-Neutral AI Gateway and Immutable Profiles

To prevent vendor lock-in and support runtime model switching without code deployments, all LLM interactions pass through an internal provider adapter (`adapters/ai-providers/`) driven by immutable database configuration records (`ai_profiles`).

## Considered Options

- **Direct Third-Party SDKs (OpenAI/Anthropic/Google):** Rejected because direct imports across domain services tightly couple business logic to a single vendor's API idioms and breaking changes.
- **Third-Party AI Orchestration Frameworks (LangChain/LlamaIndex):** Rejected due to massive dependency bloat, opaque abstractions, rapid churn, and unnecessary complexity for structured classification and summarization prompts.

## Consequences

- The platform can switch between local self-hosted engines (Ollama `gemma4:12b` for data sovereignty) and remote high-throughput providers (DeepInfra `DeepSeek-V4-Flash`, `gemini-3.6-flash`) purely via database profile configuration.
- Changing model configurations creates a new immutable profile version, ensuring historical processing runs retain exact configuration lineage.
- Structured JSON outputs from external models must be strictly validated at the adapter boundary using Zod before reaching domain modules.
