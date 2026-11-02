# Provider Integrations

No OpenAI, Gemini, Anthropic, DeepSeek, Azure, OpenAI-compatible, or local-model adapter is implemented or configured in this repository. The repository has no provider credentials and the browser does not call an AI service.

`GET /api/agents` reports role metadata, not provider health or model availability. Capability assignments have no model assignment until a provider adapter is implemented, configured, and validated. No provider connection, model routing, streaming, fine-tuning, usage metering, or successful external response is claimed.

To unblock this area, select a provider and supported model, implement its server-side documented adapter and secure credential source, then add configuration validation, health checks, normalized errors, request/usage recording, and integration tests using real authorized credentials. Provider status must remain blocked until those checks pass.
