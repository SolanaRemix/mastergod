type AgentTaskState = "BLOCKED" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED";

type AgentTask = {
  taskId: string;
  projectId: string;
  ownerId: string;
  generationId: string;
  projectType: string;
  title: string;
  agentId: string;
  dependencies: string[];
  input: Record<string, unknown>;
  timeoutSeconds: number;
  maxAttempts: number;
  attempt: number;
  status: AgentTaskState;
  blockedReason: string | null;
  error: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type TaskHandler = (input: Record<string, unknown>, context: {
  task: AgentTask;
  signal: AbortSignal;
}) => Promise<Record<string, unknown>>;

type TaskStore = {
  createAgentTasks(projectId: string, ownerId: string, tasks: AgentTask[], execution?: Record<string, unknown>): Promise<AgentTask[] | null>;
  listAgentTasks(projectId: string, ownerId: string): Promise<AgentTask[] | null>;
  getAgentTask(projectId: string, ownerId: string, taskId: string): Promise<AgentTask | null>;
  transitionAgentTask(
    projectId: string,
    ownerId: string,
    taskId: string,
    expectedState: AgentTaskState,
    nextState: AgentTaskState,
    update: Record<string, unknown>,
    details: Record<string, unknown>
  ): Promise<AgentTask | null>;
  listAgentTaskEvents(projectId: string, ownerId: string, taskId: string): Promise<Record<string, unknown>[] | null>;
};

const { randomUUID } = require("node:crypto");

const TRANSITIONS: Record<AgentTaskState, AgentTaskState[]> = {
  BLOCKED: ["QUEUED"],
  QUEUED: ["RUNNING", "BLOCKED"],
  RUNNING: ["COMPLETED", "FAILED", "RETRYING", "BLOCKED"],
  RETRYING: ["QUEUED", "FAILED", "BLOCKED"],
  COMPLETED: [],
  FAILED: ["RETRYING"]
};

const VALID_RESULT_STATUSES = new Set(["VERIFIED", "IMPLEMENTED_UNVERIFIED", "BLOCKED", "FAILED"]);

function asError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; code?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "AGENT_TASK_FAILED",
      message: typeof value.message === "string" ? value.message : "The agent task failed."
    };
  }
  return { code: "AGENT_TASK_FAILED", message: "The agent task failed." };
}

function validateResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw Object.assign(new Error("Agent output must be a structured object."), { code: "INVALID_AGENT_OUTPUT" });
  }
  const output = result as Record<string, unknown>;
  if (!VALID_RESULT_STATUSES.has(String(output.status))
    || !Array.isArray(output.evidence)
    || !output.evidence.every((item) => typeof item === "string")
    || !Array.isArray(output.artifactReferences)
    || !output.artifactReferences.every((item) => typeof item === "string")) {
    throw Object.assign(new Error("Agent output does not match the declared output contract."), {
      code: "INVALID_AGENT_OUTPUT"
    });
  }
  if (output.status === "VERIFIED" && output.evidence.length === 0) {
    throw Object.assign(new Error("Verified agent output must include evidence."), { code: "MISSING_EVIDENCE" });
  }
  if (output.status === "BLOCKED") {
    throw Object.assign(new Error(
      typeof output.failureReason === "string" ? output.failureReason : "The agent reported a blocker."
    ), { code: "AGENT_BLOCKED" });
  }
  if (output.status === "FAILED") {
    throw Object.assign(new Error(
      typeof output.failureReason === "string" ? output.failureReason : "The agent reported a failure."
    ), { code: "AGENT_REPORTED_FAILURE" });
  }
  return output;
}

class AgentOrchestrator {
  store: TaskStore;
  handlers: Map<string, TaskHandler>;

  constructor(store: TaskStore) {
    this.store = store;
    this.handlers = new Map();
  }

  registerAgent(agentId: string, handler: TaskHandler): void {
    if (typeof agentId !== "string" || !agentId || typeof handler !== "function") {
      throw new TypeError("Register an agent ID and an executable task handler.");
    }
    this.handlers.set(agentId, handler);
  }

  async persistGraph(projectId: string, ownerId: string, tasks: AgentTask[], execution?: Record<string, unknown>): Promise<AgentTask[] | null> {
    const handlers = this.handlers;
    const now = new Date().toISOString();
    const prepared = tasks.map((task) => {
      const dependenciesReady = task.dependencies.length === 0;
      const hasWorker = handlers.has(task.agentId);
      return {
        ...task,
        status: (hasWorker && dependenciesReady ? "QUEUED" : "BLOCKED") as AgentTaskState,
        blockedReason: !hasWorker
          ? `No verified worker is registered for ${task.agentId}.`
          : dependenciesReady
            ? null
            : "Waiting for prerequisite tasks to complete.",
        attempt: 0,
        error: null,
        result: null,
        createdAt: now,
        updatedAt: now
      };
    });
    return this.store.createAgentTasks(projectId, ownerId, prepared, execution);
  }

  listTasks(projectId: string, ownerId: string): Promise<AgentTask[] | null> {
    return this.store.listAgentTasks(projectId, ownerId);
  }

  listEvents(projectId: string, ownerId: string, taskId: string): Promise<Record<string, unknown>[] | null> {
    return this.store.listAgentTaskEvents(projectId, ownerId, taskId);
  }

  async executeTask(projectId: string, ownerId: string, taskId: string): Promise<AgentTask | null> {
    let task = await this.store.getAgentTask(projectId, ownerId, taskId);
    if (!task) return null;
    if (!["QUEUED", "BLOCKED", "FAILED"].includes(task.status)) return task;
    if (task.status === "FAILED" && task.error?.retryable === false) return task;

    const handler = this.handlers.get(task.agentId);
    if (!handler) return task;
    if (task.dependencies.length) {
      const tasks = await this.store.listAgentTasks(projectId, ownerId);
      if (!tasks) return null;
      const dependencyStates = new Map(tasks.map((item) => [item.taskId, item.status]));
      if (task.dependencies.some((dependency) => dependencyStates.get(dependency) !== "COMPLETED")) {
        if (task.status !== "BLOCKED") {
          task = await this.transition(task, "BLOCKED", {
            blockedReason: "Waiting for prerequisite tasks to complete."
          }, { reason: "dependencies-incomplete" });
        }
        return task;
      }
    }

    if (task.status === "BLOCKED") {
      task = await this.transition(task, "QUEUED", { blockedReason: null }, { reason: "worker-and-dependencies-ready" });
      if (!task) return null;
    }
    if (task.status === "FAILED") {
      if (task.attempt >= task.maxAttempts) return task;
      task = await this.transition(task, "RETRYING", { error: null }, { reason: "manual-retry" });
      if (!task) return null;
      task = await this.transition(task, "QUEUED", { blockedReason: null }, { reason: "manual-retry-queued" });
      if (!task) return null;
    }
    if (task.status !== "QUEUED") return task;

    const running = await this.transition(task, "RUNNING", {
      attempt: task.attempt + 1,
      blockedReason: null,
      error: null
    }, { reason: "worker-started", workerId: task.agentId });
    if (!running) return this.store.getAgentTask(projectId, ownerId, taskId);

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`Task exceeded its ${running.timeoutSeconds}-second timeout.`), {
            code: "TASK_TIMEOUT"
          }));
        }, Math.max(1, running.timeoutSeconds) * 1000);
      });
      const result = await Promise.race([
        handler(running.input, { task: running, signal: controller.signal }),
        timedOut
      ]);
      const output = validateResult(result);
      return this.transition(running, "COMPLETED", {
        result: output,
        error: null
      }, { reason: "worker-completed", outputStatus: output.status });
    } catch (error) {
      const failure = asError(error);
      if (failure.code === "TASK_TIMEOUT") failure.retryable = false;
      if (failure.code === "AGENT_BLOCKED") {
        return this.transition(running, "BLOCKED", {
          blockedReason: failure.message,
          error: failure
        }, { reason: "worker-reported-blocker" });
      }
      if (failure.retryable !== false && running.attempt < running.maxAttempts) {
        const retrying = await this.transition(running, "RETRYING", {
          error: failure
        }, { reason: "retry-scheduled", failure });
        if (!retrying) return null;
        const queued = await this.transition(retrying, "QUEUED", {
          blockedReason: null
        }, { reason: "retry-queued", nextAttempt: retrying.attempt + 1 });
        if (!queued) return null;
        return this.executeTask(projectId, ownerId, taskId);
      }
      return this.transition(running, "FAILED", {
        error: failure
      }, { reason: "attempts-exhausted", failure });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private transition(
    task: AgentTask,
    nextState: AgentTaskState,
    update: Record<string, unknown>,
    details: Record<string, unknown>
  ): Promise<AgentTask | null> {
    if (!TRANSITIONS[task.status].includes(nextState)) {
      throw new Error(`Invalid agent task transition: ${task.status} -> ${nextState}.`);
    }
    return this.store.transitionAgentTask(
      task.projectId,
      task.ownerId,
      task.taskId,
      task.status,
      nextState,
      { ...update, updatedAt: new Date().toISOString() },
      { ...details, transitionId: randomUUID() }
    );
  }
}

module.exports = { AgentOrchestrator };
