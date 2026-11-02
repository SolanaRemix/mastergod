const CORE_AGENT_DEFINITIONS = [
  ["gods-master-orchestrator", "GODS Master Orchestrator", "Coordinates approved requirements, capability assignments, task dependencies, and execution outcomes.", ["orchestration"], []],
  ["requirements-intelligence", "Requirements Intelligence Agent", "Preserves approved user requirements and derives traceable acceptance checks.", ["product-discovery"], []],
  ["system-architect", "System Architect Agent", "Produces project-specific architecture decisions within the existing platform stack.", ["system-architecture"], []],
  ["ui-ux-design", "UI/UX Design Agent", "Derives project-specific interface and responsive design requirements.", ["user-experience", "ui-generation"], []],
  ["frontend-engineering", "Frontend Engineering Agent", "Identifies frontend responsibilities and dependencies for the approved project.", ["frontend-development"], []],
  ["backend-engineering", "Backend Engineering Agent", "Maps business logic to existing authenticated service boundaries.", ["backend-development", "authentication-design", "external-integrations"], []],
  ["database-engineering", "Database Engineering Agent", "Derives entities and persistence constraints from approved requirements.", ["data-modeling"], []],
  ["ai-model-integration", "AI Model Integration Agent", "Checks model-integration needs and reports provider configuration blockers.", ["model-routing"], []],
  ["dynamic-agent-factory", "Dynamic Agent Factory Agent", "Validates specialist-agent requirements and reports lifecycle blockers.", ["agent-factory"], []],
  ["code-generation-agent", "Code Generation Agent", "Creates request-specific, editable frontend prototype files and documentation in the owned project artifact store.", ["code-generation", "documentation"], ["project-artifact-write"]],
  ["game-development", "Game Development Agent", "Plans supported game tasks and distinguishes the existing 2D game slice from unsupported engines.", ["game-engineering"], []],
  ["asset-generation", "Asset Generation Agent", "Creates asset specifications and reports when an external media generator is unavailable.", ["asset-requirements"], []],
  ["workflow-automation", "Workflow Automation Agent", "Derives a structured workflow blueprint without claiming that unavailable connectors ran.", ["workflow-automation"], []],
  ["web3-blockchain", "Web3 Blockchain Agent", "Checks chain and wallet requirements and blocks unsupported financial operations.", ["blockchain-integration", "swap-transactions"], []],
  ["security-engineering", "Security Engineering Agent", "Reviews project requirements against repository security boundaries and reports risks.", ["security-review"], []],
  ["qa-testing", "QA and Testing Agent", "Validates task contracts and generated artifact read-back evidence; does not invent external test results.", ["test-engineering"], []],
  ["code-review-repair", "Code Review and Repair Agent", "Reviews stored source for bounded structural issues and reports unsupported repair needs.", ["code-review"], []],
  ["performance-accessibility", "Performance and Accessibility Agent", "Checks stored frontend artifacts for basic responsive and semantic affordances.", ["accessibility-review", "performance-review"], []],
  ["devops-deployment", "DevOps and Deployment Agent", "Checks existing release gates and reports missing deployment infrastructure.", ["deployment", "release-management"], []],
  ["independent-verification", "Independent Verification Agent", "Reads persisted task and artifact state back before recording verification evidence.", ["independent-review"], []]
].map(([id, name, description, capabilities, permissions]) => Object.freeze({
  id,
  name,
  description,
  version: "1.0.0",
  capabilities,
  domains: ["*"],
  supportedFrameworks: [],
  supportedLanguages: ["javascript", "typescript", "html", "css", "sql", "markdown"],
  availableTools: permissions,
  providerRequirements: [],
  inputSchema: { projectId: "string", requirementIds: "string[]", blueprintVersion: "string" },
  outputSchema: {
    status: "IMPLEMENTED_UNVERIFIED | BLOCKED | FAILED",
    evidence: "string[]",
    artifactReferences: "string[]",
    findings: "object[]",
    failureReason: "string | null"
  },
  securityPermissions: permissions,
  securityClassification: permissions.length ? "medium" : "low",
  dependencies: [],
  evaluationScore: null,
  reliabilityScore: null,
  estimatedCost: 0,
  costLimit: 0,
  executionLimit: 300,
  availability: "available",
  deploymentStatus: "local",
  executionMode: "deterministic-local",
  ownerId: "platform",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z"
}));

const LEGACY_AGENT_MAP = Object.freeze({
  "product-discovery": "requirements-intelligence",
  "beginner-explanation": "requirements-intelligence",
  "systems-architect": "system-architect",
  "ux-research": "ui-ux-design",
  "ui-generator": "frontend-engineering",
  "frontend-engineer": "frontend-engineering",
  "backend-engineer": "backend-engineering",
  "database-engineer": "database-engineering",
  authentication: "backend-engineering",
  integration: "backend-engineering",
  "model-router": "ai-model-integration",
  "workflow-automation": "workflow-automation",
  testing: "qa-testing",
  security: "security-engineering",
  performance: "performance-accessibility",
  accessibility: "performance-accessibility",
  documentation: "code-generation-agent",
  deployment: "devops-deployment",
  "qa-critic": "independent-verification",
  "release-manager": "devops-deployment"
});

function safeText(value, maxLength = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function basicResult(findings, evidence, status = "IMPLEMENTED_UNVERIFIED", failureReason = null) {
  return { status, findings, evidence, artifactReferences: [], failureReason };
}

function renderPrototype(input) {
  const projectName = safeText(input.title || input.projectType || "Project", 100);
  const requirements = Array.isArray(input.requirements) ? input.requirements : [];
  const requirementLines = requirements.map((item) => safeText(item.text, 500)).filter(Boolean);
  const escapedTitle = projectName.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
  const serializedRequirements = JSON.stringify(requirementLines).replace(/</g, "\\u003c");
  return {
    "generated-app/index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Project-specific interface prototype"><title>${escapedTitle}</title><link rel="stylesheet" href="styles.css"></head>
<body><header class="topbar"><a class="brand" href="#">${escapedTitle}</a><span class="prototype-tag">LOCAL PROTOTYPE</span></header>
<main><section class="hero"><p class="eyebrow">PROJECT WORKSPACE</p><h1>${escapedTitle}</h1><p class="intro">A request-specific starting point based on your approved project requirements.</p></section>
<section class="panel"><div class="section-heading"><div><p class="eyebrow">APPROVED SCOPE</p><h2>Project requirements</h2></div><span id="item-count" class="count"></span></div><form id="item-form"><label class="sr-only" for="new-item">Add a project item</label><input id="new-item" maxlength="160" placeholder="Add an item…" required><button type="submit">Add item</button></form><ul id="items" class="items"></ul><p class="notice">Prototype data is stored in this browser only. Server database, authentication, and production integrations are not connected in this generated preview.</p></section>
<footer>Generated from the approved blueprint · Edit these source files in GODS</footer></main><script src="app.js" defer></script></body></html>`,
    "generated-app/styles.css": `:root{color-scheme:dark;--bg:#05070b;--panel:rgba(17,25,40,.78);--line:rgba(255,255,255,.12);--text:#f4f7ff;--muted:#a5b1c6;--purple:#a855f7;--cyan:#00d9ff;--green:#00e887}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 12% 0%,rgba(168,85,247,.16),transparent 42%),radial-gradient(ellipse at 90% 22%,rgba(0,217,255,.12),transparent 38%),var(--bg);color:var(--text);font:16px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}.topbar{display:flex;justify-content:space-between;align-items:center;padding:18px clamp(18px,5vw,72px);border-bottom:1px solid var(--line);backdrop-filter:blur(16px)}.brand{font-weight:750;color:var(--text);text-decoration:none}.prototype-tag,.count{color:var(--cyan);font-size:.75rem;letter-spacing:.1em}main{width:min(980px,90vw);margin:clamp(35px,8vh,80px) auto}.hero{margin-bottom:28px}.eyebrow{margin:0 0 8px;color:var(--cyan);font-size:.72rem;letter-spacing:.16em}.hero h1{margin:0;font-size:clamp(2rem,6vw,4rem);line-height:1.08}.intro{color:var(--muted);max-width:62ch}.panel{padding:clamp(18px,4vw,36px);border:1px solid var(--line);border-radius:24px;background:var(--panel);box-shadow:0 22px 80px rgba(0,0,0,.32);backdrop-filter:blur(20px)}.section-heading{display:flex;justify-content:space-between;align-items:center}.section-heading h2{margin:0 0 18px;font-size:1.4rem}form{display:flex;gap:10px}input{min-width:0;flex:1;padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:#090e18;color:var(--text);font:inherit}button{padding:12px 18px;border:1px solid rgba(0,217,255,.45);border-radius:12px;background:linear-gradient(120deg,rgba(168,85,247,.32),rgba(0,217,255,.16));color:var(--text);font:inherit;font-weight:650;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.items{display:grid;gap:10px;padding:0;list-style:none}.items li{display:flex;justify-content:space-between;gap:12px;padding:13px 15px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.035);overflow-wrap:anywhere}.items li button{padding:5px 10px;border-color:rgba(255,69,103,.4)}.notice{margin:20px 0 0;color:var(--muted);font-size:.82rem}footer{margin-top:24px;color:var(--muted);font-size:.8rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:600px){.topbar{padding:14px 5vw}main{width:90vw;margin:35px auto}form{flex-direction:column}form button{width:100%}.panel{border-radius:18px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}`,
    "generated-app/app.js": `"use strict";
const initialItems = ${serializedRequirements};
const storageKey = "gods-project-${safeText(input.projectId, 80)}";
const list = document.querySelector("#items");
const form = document.querySelector("#item-form");
const field = document.querySelector("#new-item");
const count = document.querySelector("#item-count");
let items;
try { const stored = JSON.parse(localStorage.getItem(storageKey)); items = Array.isArray(stored) ? stored.filter((item) => typeof item === "string").slice(0, 200) : [...initialItems]; }
catch { items = [...initialItems]; }
function render() {
  list.replaceChildren();
  count.textContent = String(items.length) + " ITEMS";
  items.forEach((text, index) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove " + text);
    remove.addEventListener("click", () => { items.splice(index, 1); persist(); });
    row.append(label, remove);
    list.append(row);
  });
}
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(items)); } catch {} render(); }
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = field.value.trim();
  if (!value || items.length >= 200) return;
  items.push(value.slice(0, 160));
  field.value = "";
  persist();
});
render();`
  };
}

function createCoreAgentHandlers(store, { providers } = {}) {
  const handlers = new Map();
  for (const agent of CORE_AGENT_DEFINITIONS) {
    handlers.set(agent.id, async (input, context) => {
      if (context.signal.aborted) throw Object.assign(new Error("Agent task was cancelled."), { code: "TASK_ABORTED", retryable: false });
      const requirements = Array.isArray(input.requirements) ? input.requirements : [];
      const requirementIds = requirements.map((requirement) => requirement.id).filter((id) => typeof id === "string");
      switch (agent.id) {
        case "requirements-intelligence":
          if (providers) return providers.runProductDiscovery({
            ownerId: context.task.ownerId,
            projectId: context.task.projectId,
            task: context.task,
            input,
            signal: context.signal
          });
          return basicResult(
            requirements.map(({ id, text }) => ({ requirementId: id, statement: safeText(text), acceptanceCheck: `Confirm implementation evidence for: ${safeText(text, 220)}` })),
            [`Read ${requirements.length} approved requirement(s) from the task input.`]
          );
        case "system-architect":
          return basicResult([{
            projectType: input.projectType || "general",
            runtime: "Generated files are static browser prototypes; existing GODS runtime remains Node.js and SQLite.",
            boundaries: ["External providers unavailable", "Generated code is not executed by the server"]
          }], [`Used project type ${safeText(input.projectType || "general", 80)} and the existing runtime contract.`]);
        case "ui-ux-design":
          return basicResult([{
            visualDirection: /\b(game|racing|arcade)\b/i.test(String(input.originalRequest))
              ? "Game-focused interface with high-contrast controls and a play surface."
              : /\b(wallet|swap|web3|blockchain)\b/i.test(String(input.originalRequest))
                ? "Financial interface prioritizing explicit transaction review and trust signals."
                : "Responsive enterprise glass panels with a cyan/purple accent and readable hierarchy.",
            mobile: "Single-column layout with full-width primary actions."
          }], ["Selected visual direction from this project's request; no external design model was called."]);
        case "database-engineering":
          return basicResult([{
            entities: [...new Set(requirements.flatMap((item) => (item.text.match(/\b(users?|drivers?|vehicles?|loads?|customers?|orders?|projects?|tasks?|payments?|invoices?)\b/gi) || []).map((value) => value.toLowerCase())))],
            note: "Schema proposal only; no generated project database migration was executed."
          }], [`Analyzed ${requirements.length} approved requirement(s).`]);
        case "ai-model-integration":
          return basicResult([], ["No provider credentials or model adapter are configured."], "BLOCKED", "AI provider integration is not configured.");
        case "dynamic-agent-factory":
          return basicResult([{ lifecycle: ["DESIGN", "GENERATE", "VALIDATE", "TEST", "SECURITY REVIEW", "APPROVE", "DEPLOY"] }], ["Produced a lifecycle outline only; persistent agent creation and isolated deployment are unavailable."]);
        case "code-generation-agent": {
          const files = renderPrototype(input);
          const artifactReferences = [];
          for (const [artifactPath, contents] of Object.entries(files)) {
            const existing = await store.readArtifact(context.task.projectId, context.task.ownerId, artifactPath);
            if (existing) {
              if (existing.responsibleAgent !== "code-generation-agent") {
                throw Object.assign(new Error(`Refusing to overwrite owner-managed artifact ${artifactPath}.`), { code: "ARTIFACT_CONFLICT", retryable: false });
              }
              const saved = await store.writeArtifact(context.task.projectId, context.task.ownerId, artifactPath,
                contents, existing.version, "Generated by the local code-generation agent.");
              artifactReferences.push(`${saved.path}@v${saved.version}`);
            } else {
              const created = await store.createArtifact(context.task.projectId, context.task.ownerId, artifactPath,
                contents, artifactPath.split(".").pop());
              artifactReferences.push(`${created.path}@v${created.version}`);
            }
          }
          const generated = basicResult(
            [{ type: "responsive-client-prototype", files: artifactReferences, dataPersistence: "browser-localStorage-only" }],
            ["Created project-specific editable HTML, CSS, and JavaScript files.", "Artifacts were written to SQLite and read back by the artifact store."]
          );
          generated.artifactReferences = artifactReferences;
          generated.toolCalls = artifactReferences.length ? ["project-artifact-write"] : [];
          return generated;
        }
        case "game-development":
          return basicResult([{ supported: "Existing deterministic 2D Canvas game studio", unsupported: ["3D engine generation", "provider-backed assets"] }], ["Checked the current game-studio capability boundary."]);
        case "asset-generation":
          return basicResult([{ prompts: requirements.filter((item) => /\b(image|icon|asset|audio|music|sprite)\b/i.test(item.text)).map((item) => safeText(item.text)) }], ["No external media generator is configured."]);
        case "workflow-automation":
          return basicResult([{ trigger: "manual", steps: requirements.map((item, index) => ({ order: index + 1, description: safeText(item.text), status: "PLANNED" })) }], ["Generated workflow planning data only; no connector executed."]);
        case "web3-blockchain":
          return basicResult([], ["No blockchain RPC, wallet adapter, quote provider, or transaction verifier is configured."], "BLOCKED", "Web3 transactions and provider-backed reads are not configured.");
        case "security-engineering":
          return basicResult([{ checks: ["Project ownership is enforced by project APIs.", "Generated app is a client-side prototype.", "No server-side generated code execution is enabled."] }], ["Reviewed the project input and current execution boundary."]);
        case "qa-testing":
          return basicResult([{ checks: [
            { name: "approved-requirements-present", passed: requirements.length > 0 },
            { name: "task-identifiers-present", passed: typeof context.task.taskId === "string" },
            { name: "artifact-writes", status: "NOT_RUN" }
          ] }], [`Checked ${requirements.length} requirement(s) and task ${context.task.taskId}; these are contract checks, not generated-project tests.`]);
        case "code-review-repair":
          return basicResult([{ review: "No generated files were modified by this review task.", repairs: [] }], ["No independent repair is claimed."]);
        case "performance-accessibility":
          return basicResult([{ checks: ["Responsive viewport metadata", "Semantic document landmarks", "Keyboard-focusable controls"] }], ["Checks describe generated prototype source, not a browser accessibility audit."]);
        case "devops-deployment":
          return basicResult([], ["Production deployment host and credentials are not configured."], "BLOCKED", "Deployment remains blocked by missing production infrastructure.");
        case "independent-verification": {
          const tasks = await store.listAgentTasks(context.task.projectId, context.task.ownerId);
          const artifacts = await store.listArtifacts(context.task.projectId, context.task.ownerId);
          return basicResult([{
            completedTasks: (tasks || []).filter((task) => task.status === "COMPLETED").length,
            artifactPaths: (artifacts?.files || []).map((file) => file.path)
          }], ["Read task graph and artifact inventory back from the project database."]);
        }
        case "gods-master-orchestrator":
          return basicResult([{ requirementIds, projectType: input.projectType || "general", next: "Execute dependency-ready specialist tasks." }], ["Used the approved task input; no external model or provider was invoked."]);
        case "frontend-engineering":
          return basicResult([{ interfaceRequirements: requirements.filter((item) => /\b(page|screen|dashboard|interface|mobile|responsive|button|form)\b/i.test(item.text)).map((item) => item.id) }], ["Derived frontend work from approved requirements."]);
        case "backend-engineering":
          return basicResult([{ serviceBoundaries: ["Existing project API", "Existing SQLite owner-scoped artifact store"] }], ["No new backend endpoints were generated by this planning agent."]);
        default:
          return basicResult([{ role: agent.name }], ["Executed the registered local specialist contract."]);
      }
    });
  }
  return handlers;
}

module.exports = { CORE_AGENT_DEFINITIONS, LEGACY_AGENT_MAP, createCoreAgentHandlers };
