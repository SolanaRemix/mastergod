"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const { randomUUID } = require("node:crypto");

const PROVIDER_ID = "openai-compatible";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETRIES = 3;
const PRODUCT_DISCOVERY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "purpose", "targetUsers", "roles", "pages", "features", "workflows",
    "dataEntities", "relationships", "authentication", "permissions",
    "integrations", "payments", "notifications", "reporting", "security",
    "mobileAndDesktop", "deployment", "openQuestions"
  ],
  properties: {
    purpose: { type: "string" },
    targetUsers: { type: "array", items: { type: "string" } },
    roles: { type: "array", items: { type: "string" } },
    pages: { type: "array", items: { type: "string" } },
    features: { type: "array", items: { type: "string" } },
    workflows: { type: "array", items: { type: "string" } },
    dataEntities: { type: "array", items: { type: "string" } },
    relationships: { type: "array", items: { type: "string" } },
    authentication: { type: "string" },
    permissions: { type: "array", items: { type: "string" } },
    integrations: { type: "array", items: { type: "string" } },
    payments: { type: "array", items: { type: "string" } },
    notifications: { type: "array", items: { type: "string" } },
    reporting: { type: "array", items: { type: "string" } },
    security: { type: "array", items: { type: "string" } },
    mobileAndDesktop: { type: "string" },
    deployment: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } }
  }
});

class ProviderError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function encryptionKey(value = process.env.GODS_SECRET_KEY) {
  if (typeof value !== "string" || !value) {
    throw new ProviderError("SECRET_KEY_MISSING", "Provider credential encryption is not configured.");
  }
  let key;
  if (/^[a-f\d]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new ProviderError("SECRET_KEY_INVALID", "GODS_SECRET_KEY must encode exactly 32 bytes.");
  }
  return key;
}

function assertProductionSecretKey(environment = process.env) {
  if (environment.NODE_ENV === "production") encryptionKey(environment.GODS_SECRET_KEY);
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(normalized)) return true;
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
    const words = mapped.split(":");
    if (words.length === 2 && words.every((word) => /^[a-f\d]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return isPrivateAddress([
        high >> 8, high & 255, low >> 8, low & 255
      ].join("."));
    }
  }
  return false;
}

async function validateProviderEndpoint(endpoint, {
  allowLocal = process.env.GODS_ALLOW_LOCAL_PROVIDER === "1",
  lookup = dns.lookup
} = {}) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ProviderError("INVALID_PROVIDER_URL", "Provider endpoint must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname.includes("..")) {
    throw new ProviderError("INVALID_PROVIDER_URL", "Provider endpoint must be a credential-free HTTP(S) base URL.");
  }
  if (parsed.protocol === "http:" && !allowLocal) {
    throw new ProviderError("INSECURE_PROVIDER_URL", "HTTP provider endpoints require GODS_ALLOW_LOCAL_PROVIDER=1.");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname }];
  else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new ProviderError("PROVIDER_DNS_FAILED", "Provider endpoint hostname could not be resolved.", { retryable: true });
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ProviderError("PROVIDER_DNS_FAILED", "Provider endpoint hostname did not resolve.", { retryable: true });
  }
  if (!allowLocal && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ProviderError("PRIVATE_PROVIDER_URL", "Private and loopback provider endpoints are disabled.");
  }
  return parsed;
}

function sanitizeError(error) {
  const allowedCodes = new Set([
    "SECRET_KEY_MISSING", "SECRET_KEY_INVALID", "INVALID_PROVIDER_URL", "INSECURE_PROVIDER_URL",
    "PRIVATE_PROVIDER_URL", "PROVIDER_DNS_FAILED", "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED",
    "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_NETWORK_ERROR", "PROVIDER_INVALID_RESPONSE",
    "PROVIDER_INVALID_JSON", "PROVIDER_BLOCKED", "MODEL_NOT_FOUND"
  ]);
  const code = allowedCodes.has(error?.code) ? error.code : "PROVIDER_UNAVAILABLE";
  const messages = {
    SECRET_KEY_MISSING: "Provider credential encryption is not configured.",
    SECRET_KEY_INVALID: "Provider credential encryption is incorrectly configured.",
    INVALID_PROVIDER_URL: "Provider endpoint must be a valid HTTP(S) base URL.",
    INSECURE_PROVIDER_URL: "HTTP provider endpoints require explicit local-provider opt-in.",
    PRIVATE_PROVIDER_URL: "Private and loopback provider endpoints are disabled.",
    PROVIDER_DNS_FAILED: "Provider endpoint hostname could not be resolved.",
    PROVIDER_AUTH_FAILED: "The provider rejected the configured credential.",
    PROVIDER_RATE_LIMITED: "The provider rate limit was reached.",
    PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable.",
    PROVIDER_TIMEOUT: "The provider request timed out.",
    PROVIDER_NETWORK_ERROR: "The provider request could not be completed.",
    PROVIDER_INVALID_RESPONSE: "The provider returned an unsupported response.",
    PROVIDER_INVALID_JSON: "The provider response did not contain valid JSON.",
    PROVIDER_BLOCKED: "No eligible provider is configured for this task.",
    MODEL_NOT_FOUND: "The selected model is not available from this provider."
  };
  return { code, message: messages[code], retryable: Boolean(error?.retryable) };
}

function validateProductDiscovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Product Discovery output must be an object.");
  }
  const expected = PRODUCT_DISCOVERY_SCHEMA.required;
  if (Object.keys(value).some((key) => !expected.includes(key))
    || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Product Discovery output does not match its schema.");
  }
  for (const [key, schema] of Object.entries(PRODUCT_DISCOVERY_SCHEMA.properties)) {
    const item = value[key];
    if (schema.type === "string" && (typeof item !== "string" || item.length > 5000)) {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Product Discovery output does not match its schema.");
    }
    if (schema.type === "array" && (!Array.isArray(item) || item.length > 100
      || item.some((entry) => typeof entry !== "string" || entry.length > 1000))) {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Product Discovery output does not match its schema.");
    }
  }
  return value;
}

function retryDelay(response, attempt, random = Math.random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const absolute = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(absolute) && absolute >= 0) return Math.min(absolute, 30_000);
  }
  return Math.min(250 * (2 ** attempt) + Math.floor(random() * 200), 5000);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Provider response exceeded the supported size.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_JSON", "Provider response was not valid JSON.");
  }
}

class OpenAICompatibleAdapter {
  constructor({ fetchImpl = globalThis.fetch, lookup = dns.lookup, allowLocal = process.env.GODS_ALLOW_LOCAL_PROVIDER === "1", sleep } = {}) {
    this.id = PROVIDER_ID;
    this.capabilities = ["chat-completions", "model-discovery", "json-schema"];
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.allowLocal = allowLocal;
    this.sleep = sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async request(endpoint, pathname, apiKey, options = {}) {
    const base = await validateProviderEndpoint(endpoint, { allowLocal: this.allowLocal, lookup: this.lookup });
    const url = new URL(pathname.replace(/^\//, ""), `${base.href.replace(/\/+$/, "")}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    const signals = [controller.signal];
    if (options.signal) signals.push(options.signal);
    try {
      return await this.fetchImpl(url, {
        method: options.method || "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer " + apiKey,
          ...(options.body ? { "content-type": "application/json" } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: "error",
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (options.signal?.aborted) throw Object.assign(new ProviderError("PROVIDER_TIMEOUT", "Provider request was cancelled."), { retryable: false });
      if (controller.signal.aborted) throw new ProviderError("PROVIDER_TIMEOUT", "Provider request timed out.", { retryable: true });
      throw new ProviderError("PROVIDER_NETWORK_ERROR", "Provider network request failed.", { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(configuration) {
    const response = await this.request(configuration.endpoint, "models", configuration.apiKey);
    if (!response.ok) throw this.httpError(response.status);
    const json = await readJsonResponse(response);
    if (!Array.isArray(json?.data) || json.data.some((model) => !model || typeof model.id !== "string")) {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Provider model list has an unsupported shape.");
    }
    return json.data.map((model) => ({ id: model.id, owned_by: typeof model.owned_by === "string" ? model.owned_by : null }));
  }

  async healthCheck(configuration) {
    const started = Date.now();
    try {
      await this.listModels(configuration);
      return { ok: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: sanitizeError(error) };
    }
  }

  async complete(configuration, { model, messages, jsonSchema, signal }) {
    const requestBody = { model, messages };
    if (jsonSchema) {
      requestBody.response_format = {
        type: "json_schema",
        json_schema: { name: "product_discovery", strict: true, schema: jsonSchema }
      };
    }
    let response;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        response = await this.request(configuration.endpoint, "chat/completions", configuration.apiKey, {
          method: "POST",
          body: requestBody,
          signal
        });
      } catch (error) {
        if (!error.retryable || attempt === MAX_RETRIES - 1) throw error;
        await this.sleep(retryDelay(null, attempt));
        continue;
      }
      if (response.ok) break;
      const error = this.httpError(response.status);
      if (!error.retryable || attempt === MAX_RETRIES - 1) throw error;
      await this.sleep(retryDelay(response, attempt));
    }
    const result = await readJsonResponse(response);
    const choice = result?.choices?.[0]?.message;
    if (!choice || typeof choice.content !== "string") {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Provider completion response has an unsupported shape.");
    }
    let json;
    if (jsonSchema) {
      try {
        json = JSON.parse(choice.content);
      } catch {
        throw new ProviderError("PROVIDER_INVALID_JSON", "Provider completion did not contain valid JSON.");
      }
      validateProductDiscovery(json);
    }
    return {
      text: choice.content,
      json,
      toolCalls: Array.isArray(choice.tool_calls) ? choice.tool_calls : [],
      usage: {
        promptTokens: Number.isInteger(result.usage?.prompt_tokens) ? result.usage.prompt_tokens : null,
        completionTokens: Number.isInteger(result.usage?.completion_tokens) ? result.usage.completion_tokens : null
      }
    };
  }

  httpError(status) {
    if (status === 401 || status === 403) return new ProviderError("PROVIDER_AUTH_FAILED", "Provider rejected credentials.", { status });
    if (status === 404) return new ProviderError("MODEL_NOT_FOUND", "Provider endpoint or model was not found.", { status });
    if (status === 429) return new ProviderError("PROVIDER_RATE_LIMITED", "Provider rate limit reached.", { status, retryable: true });
    if (status >= 500) return new ProviderError("PROVIDER_UNAVAILABLE", "Provider returned a server error.", { status, retryable: true });
    return new ProviderError("PROVIDER_INVALID_RESPONSE", "Provider rejected the request.", { status });
  }
}

class ModelRouter {
  constructor(store) {
    this.store = store;
  }

  async choose({ ownerId, projectId, taskId, inputs, providers }) {
    const eligible = providers.filter((provider) => provider.hasKey
      && provider.model
      && (!inputs.preferred_provider || provider.providerId === inputs.preferred_provider));
    const chosen = eligible.sort((left, right) => left.providerId.localeCompare(right.providerId))[0] || null;
    const decision = {
      id: randomUUID(),
      ownerId,
      projectId,
      taskId,
      inputs,
      providerId: chosen?.providerId || null,
      model: chosen?.model || null,
      reason: chosen
        ? `Selected the configured ${chosen.providerId} provider for ${inputs.task_type}; deterministic provider-id ordering.`
        : "No configured provider has an eligible model for this task."
    };
    await this.store.recordModelRoutingDecision(decision);
    if (!chosen) throw new ProviderError("PROVIDER_BLOCKED", "No eligible provider is configured for Product Discovery.");
    return { ...chosen, reason: decision.reason };
  }
}

class ProviderService {
  constructor(store, options = {}) {
    this.store = store;
    this.adapter = options.adapter || new OpenAICompatibleAdapter(options);
    this.router = new ModelRouter(store);
    this.key = options.encryptionKey || null;
  }

  getKey() {
    return encryptionKey(this.key || process.env.GODS_SECRET_KEY);
  }

  encryptCredential(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  decryptCredential(row) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8"));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("SECRET_KEY_INVALID", "Provider credentials could not be decrypted.");
    }
  }

  async listProviders(ownerId) {
    const credential = await this.store.getProviderCredential(ownerId, PROVIDER_ID);
    return [{
      provider_id: PROVIDER_ID,
      hasKey: Boolean(credential),
      updated_at: credential?.updatedAt || null
    }];
  }

  async saveCredential(ownerId, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.apiKey !== "string" || value.apiKey.trim().length < 1 || value.apiKey.length > 4096
      || typeof value.model !== "string" || !/^[\w./:-]{1,128}$/.test(value.model)) {
      throw Object.assign(new Error("Provide a provider API key and a valid model identifier."), { code: "INVALID_PROVIDER_CREDENTIAL", status: 400 });
    }
    const endpoint = typeof value.endpoint === "string" && value.endpoint.trim()
      ? value.endpoint.trim()
      : DEFAULT_ENDPOINT;
    await validateProviderEndpoint(endpoint, { allowLocal: this.adapter.allowLocal, lookup: this.adapter.lookup });
    const encrypted = this.encryptCredential({ apiKey: value.apiKey, endpoint, model: value.model });
    return this.store.saveProviderCredential({
      id: randomUUID(),
      ownerId,
      providerId: PROVIDER_ID,
      endpoint,
      model: value.model,
      ...encrypted
    });
  }

  async deleteCredential(ownerId) {
    return this.store.deleteProviderCredential(ownerId, PROVIDER_ID);
  }

  async configuration(ownerId) {
    const row = await this.store.getProviderCredential(ownerId, PROVIDER_ID);
    if (!row) return null;
    const decrypted = this.decryptCredential(row);
    return { ...decrypted, model: row.model };
  }

  async listModels(ownerId) {
    const configuration = await this.configuration(ownerId);
    if (!configuration) throw new ProviderError("PROVIDER_BLOCKED", "Configure a provider credential before discovering models.");
    return this.adapter.listModels(configuration);
  }

  async healthCheck(ownerId) {
    const configuration = await this.configuration(ownerId);
    if (!configuration) throw new ProviderError("PROVIDER_BLOCKED", "Configure a provider credential before checking provider health.");
    const health = await this.adapter.healthCheck(configuration);
    await this.store.recordProviderHealth({
      ownerId,
      providerId: PROVIDER_ID,
      checkedAt: new Date().toISOString(),
      ok: health.ok,
      latencyMs: health.latencyMs,
      error: health.error?.code || null
    });
    return health;
  }

  async runProductDiscovery({ ownerId, projectId, task, input, signal }) {
    const inputs = {
      task_type: "product-discovery",
      complexity: "medium",
      budget: "standard",
      require_tools: false,
      require_json: true,
      preferred_provider: input.preferred_provider || null
    };
    let configuration;
    try {
      configuration = await this.configuration(ownerId);
    } catch (error) {
      await this.store.recordModelRoutingDecision({
        id: randomUUID(), ownerId, projectId, taskId: task.taskId, inputs,
        providerId: null, model: null, reason: sanitizeError(error).message
      });
      throw error;
    }
    let selected;
    try {
      selected = await this.router.choose({
        ownerId,
        projectId,
        taskId: task.taskId,
        inputs,
        providers: configuration ? [{
          providerId: PROVIDER_ID,
          model: configuration.model,
          hasKey: true,
          configuration
        }] : []
      });
    } catch (error) {
      if (error.code === "PROVIDER_BLOCKED") {
        throw Object.assign(new Error("No eligible provider is configured for Product Discovery."), {
          code: "AGENT_BLOCKED",
          retryable: false
        });
      }
      throw error;
    }
    const started = Date.now();
    try {
      const completion = await this.adapter.complete(selected.configuration, {
        model: selected.model,
        messages: [
          {
            role: "system",
            content: "Convert the approved application request into the exact required JSON schema. Preserve user intent. Do not invent confirmed integrations, costs, or provider capabilities; list uncertainties in openQuestions. Use empty arrays or clearly labeled defaults when information is absent."
          },
          {
            role: "user",
            content: JSON.stringify({
              originalRequest: input.originalRequest || "",
              approvedRequirements: Array.isArray(input.requirements) ? input.requirements : []
            })
          }
        ],
        jsonSchema: PRODUCT_DISCOVERY_SCHEMA,
        signal
      });
      await this.store.recordModelRequest({
        id: randomUUID(),
        ownerId,
        projectId,
        taskId: task.taskId,
        agentId: "requirements-intelligence",
        providerId: PROVIDER_ID,
        model: selected.model,
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
        latencyMs: Date.now() - started,
        status: "IMPLEMENTED_UNVERIFIED",
        error: null
      });
      return {
        status: "IMPLEMENTED_UNVERIFIED",
        findings: [completion.json],
        evidence: ["Provider response was parsed and validated against the Product Discovery output schema."],
        artifactReferences: [],
        failureReason: null
      };
    } catch (error) {
      const safe = sanitizeError(error);
      await this.store.recordModelRequest({
        id: randomUUID(),
        ownerId,
        projectId,
        taskId: task.taskId,
        agentId: "requirements-intelligence",
        providerId: PROVIDER_ID,
        model: selected.model,
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - started,
        status: "FAILED",
        error: safe.code
      });
      throw new ProviderError(safe.code, safe.message, { retryable: safe.retryable });
    }
  }
}

module.exports = {
  DEFAULT_ENDPOINT,
  MAX_RETRIES,
  ModelRouter,
  OpenAICompatibleAdapter,
  PRODUCT_DISCOVERY_SCHEMA,
  PROVIDER_ID,
  ProviderError,
  ProviderService,
  assertProductionSecretKey,
  encryptionKey,
  isPrivateAddress,
  sanitizeError,
  validateProductDiscovery,
  validateProviderEndpoint
};
