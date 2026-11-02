# Provider Integrations

## Increment 1 implementation

The server now has a dependency-free OpenAI-compatible adapter using `fetch`, a deterministic model router, encrypted credential storage, provider health/model discovery routes, and a Product Discovery task path. Product Discovery sends approved project requirements to the configured endpoint and validates the returned structured JSON. Its execution result is `IMPLEMENTED_UNVERIFIED`; model output is not independent proof that the resulting specification is correct.

The implementation supports one adapter ID: `openai-compatible`. No key or external provider is configured in the repository. Real provider connectivity remains `BLOCKED` until an owner supplies credentials, a model, and a permitted endpoint, then runs a live health check. Mock HTTP server tests establish only local adapter behavior.

## Configure a provider

1. Sign in and open **Connect an AI provider**.
2. Enter the provider's OpenAI-compatible API base URL, a key, and the exact model ID supported by that endpoint.
3. Save settings, then use **Check connection** and **Discover models**.
4. Approve a project plan, create its task graph, and choose **Run Product Discovery**.

Saving does not transmit project content. Running Product Discovery sends the original request and approved requirements to the selected provider. Review the provider's terms, data handling, availability, and costs before use. The key is encrypted at rest and is never returned by the API or stored in browser storage.

`GODS_SECRET_KEY` must encode exactly 32 bytes as 64 hexadecimal characters or base64. Production startup refuses to proceed without a valid key. Keep it outside source control and use the same key to decrypt existing credentials after restart; losing or rotating it without re-encrypting credentials makes those credentials unavailable.

The default endpoint is `https://api.openai.com/v1`. Public endpoints are restricted to OpenAI, Azure OpenAI, OpenRouter, and Groq hostnames; non-HTTPS endpoints, unknown public hosts, and private/loopback DNS results are rejected by default. Local development endpoints are allowed only when the server operator explicitly sets `GODS_ALLOW_LOCAL_PROVIDER=1`; do not enable this on an untrusted deployment.

## API

- `GET /api/providers` returns provider IDs, `hasKey`, and credential update times only.
- `PUT /api/providers/openai-compatible/credential` accepts `{apiKey, endpoint, model}`.
- `DELETE /api/providers/openai-compatible/credential` removes the signed-in owner's key.
- `POST /api/providers/openai-compatible/health` checks the saved provider and records its result.
- `GET /api/providers/openai-compatible/models` discovers model IDs.
- `GET /api/projects/:id/routing-decisions` returns that owner's persisted routing decisions.

All writes require an authenticated, same-origin JSON request. Credentials are encrypted with AES-256-GCM. Provider URLs are host-allowlisted and DNS-checked, redirects are rejected, responses are size-limited, retryable failures receive at most three attempts, and errors/audit records omit response bodies and credentials. Node's built-in `fetch` does not expose DNS pinning; keep endpoints to the documented trusted hosts and leave local-provider opt-in disabled on untrusted deployments. Only the Product Discovery agent is provider-wired in Increment 1; other specialist roles remain local or blocked.

No Gemini, Anthropic, provider failover, streaming, or real external provider success is claimed in this increment.
