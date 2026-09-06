import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
  AgentJob,
  EmitRequest,
  JsonObject,
  JsonValue,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentRunTurnResult,
  parseJsonRpcEnvelope,
  parseJsonRpcJson,
  decodeAgentEvent,
  type AgentDashboardRpcCall,
  type AgentDashboardRpcOperation,
  type AgentCommand,
  type AgentCommandPayloads,
  type AgentEvent,
  type AgentNotification,
  type AgentRequest,
  type AgentResponse,
  type DashboardRpcResult,
  type DesktopLoggingSinkStatus,
  type ManagedLlmCredential,
  type ManagedLlmTarget,
} from "@lxe/desktop-protocol";
import { createLogger, type Logger } from "@lxe/core";
import type {
  DirectAgentRuntime,
  DirectRuntimeOutcome,
} from "./composition";
import { RuntimeRequestError, type RunHandle, type SteeringMessage } from "./scheduler";

type Environment = Record<string, string | undefined>;
type ProcessState = "stopped" | "starting" | "ready" | "error";

export interface AgentProcessStatus {
  state: ProcessState;
  pid: number;
  message: string;
  lxeskillAvailable?: boolean;
  lxeskillMessage?: string;
  logging?: DesktopLoggingSinkStatus;
}

export interface ProcessAgentRuntimeOptions {
  command: string;
  arguments?: string[];
  cwd: string;
  environment: Environment;
  agentSoulPath: string;
  skillsRoot: string;
  userSkillsRoot: string;
  lxeskillCatalogPath: string;
  llmConfigRoot: string;
  dataRoot: string;
  legacyWorkspace: WorkspaceContext;
  allowedSkillTypes?: readonly string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
  onEmit?: (request: EmitRequest) => Promise<void> | void;
  onDesktopStream?: (
    request: Extract<AgentEvent, { type: "conversation.stream.delta" }>["payload"],
  ) => Promise<void> | void;
  onTyping?: (request: Extract<AgentEvent, { type: "typing.changed" }>["payload"]) => Promise<void> | void;
  onWake?: (request: JsonObject) => Promise<void> | void;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  onStatus?: (status: AgentProcessStatus) => void;
  onStderr?: (line: string) => void;
  logger?: Logger;
}

export class AgentProcessError extends Error {
  constructor(
    message: string,
    readonly code = "AgentProcessError",
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "AgentProcessError";
  }
}

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

const objectValue = (value: JsonValue): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const LOGGING_DISABLED_REASONS = new Set(["", "disabled_by_config", "missing_log_file", "sink_failed"]);

const loggingStatus = (value: JsonValue | undefined): DesktopLoggingSinkStatus | undefined => {
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
  if (!object || typeof object.local_file_enabled !== "boolean") return undefined;
  const consoleLevel = String(object.console_level ?? "");
  const fileLevel = String(object.file_level ?? "");
  const disabledReason = String(object.disabled_reason ?? "");
  if (!LOG_LEVELS.has(consoleLevel) || !LOG_LEVELS.has(fileLevel) || !LOGGING_DISABLED_REASONS.has(disabledReason)) {
    return undefined;
  }
  return {
    local_file_enabled: object.local_file_enabled,
    file_path: String(object.file_path ?? ""),
    disabled_reason: disabledReason as DesktopLoggingSinkStatus["disabled_reason"],
    last_error: String(object.last_error ?? ""),
    console_level: consoleLevel as DesktopLoggingSinkStatus["console_level"],
    file_level: fileLevel as DesktopLoggingSinkStatus["file_level"],
  };
};

export class ProcessAgentRuntime implements DirectAgentRuntime {
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancelledRuns = new Set<string>();
  private generation = 0;
  private notifications = Promise.resolve();
  private incompatible = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: Interface | undefined;
  private stderr: Interface | undefined;
  private state: ProcessState = "stopped";
  private statusMessage = "";
  private stopping = false;
  private manuallyStopped = true;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteHealthSnapshot: JsonObject = {};
  private allowedSkillTypes: string[];

  constructor(private readonly options: ProcessAgentRuntimeOptions) {
    this.logger = options.logger ?? createLogger("gateway.agent_process");
    this.allowedSkillTypes = [...new Set(
      (options.allowedSkillTypes ?? []).map((item) => item.trim()).filter(Boolean),
    )];
  }

  get isReady(): boolean {
    return this.state === "ready" && Boolean(this.child && !this.child.killed);
  }

  status(): AgentProcessStatus {
    const lxeSkillAvailable = this.remoteHealthSnapshot.lxeskill_available;
    const lxeSkillMessage = String(this.remoteHealthSnapshot.lxeskill_message ?? "").trim();
    const logging = loggingStatus(this.remoteHealthSnapshot.logging);
    return {
      state: this.state,
      pid: this.child?.pid ?? 0,
      message: this.statusMessage,
      ...(typeof lxeSkillAvailable === "boolean"
        ? { lxeskillAvailable: lxeSkillAvailable }
        : {}),
      ...(lxeSkillMessage ? { lxeskillMessage: lxeSkillMessage } : {}),
      ...(logging ? { logging } : {}),
    };
  }

  async start(): Promise<void> {
    this.manuallyStopped = false;
    this.incompatible = false;
    await this.launch(false);
  }

  private async launch(recovering: boolean): Promise<void> {
    if (this.isReady) return;
    if (this.child) await this.terminateChild();
    this.stopping = false;
    this.remoteHealthSnapshot = {};
    this.setStatus("starting", recovering ? "Recovering agent-cli" : "Starting agent-cli");
    const child = spawn(
      this.options.command,
      [
        ...(this.options.arguments ?? []),
        "serve",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ],
      {
        cwd: this.options.cwd,
        env: { ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    const generation = ++this.generation;
    this.notifications = Promise.resolve();
    this.stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stdout.on("line", (line) => { if (this.child === child) this.handleLine(line, generation); });
    this.stderr.on("line", (line) => {
      if (this.child !== child) return;
      this.options.onStderr?.(line);
      this.logger.debug("agent_cli_stderr", { line });
    });
    child.once("error", (error) => { if (this.child === child) this.handleExit(error); });
    child.once("exit", (code, signal) => { if (this.child === child) this.handleExit(new AgentProcessError(
      `agent-cli exited: code=${String(code ?? "")} signal=${String(signal ?? "")}`,
      "AgentProcessExited",
    )); });
    try {
      this.remoteHealthSnapshot = objectValue(await this.request("initialize", {
        protocol_version: AGENT_PROTOCOL_VERSION,
        agent_soul_path: this.options.agentSoulPath,
        skills_root: this.options.skillsRoot,
        user_skills_root: this.options.userSkillsRoot,
        lxeskill_catalog_path: this.options.lxeskillCatalogPath,
        llm_config_root: this.options.llmConfigRoot,
        data_root: this.options.dataRoot,
        legacy_workspace: this.options.legacyWorkspace,
        allowed_skill_types: [...this.allowedSkillTypes],
      }, this.options.requestTimeoutMs ?? 30_000));
      if (this.remoteHealthSnapshot.protocol_version !== AGENT_PROTOCOL_VERSION) {
        this.incompatible = true;
        throw new AgentProcessError(`Unsupported agent protocol version: expected ${AGENT_PROTOCOL_VERSION}, received ${String(this.remoteHealthSnapshot.protocol_version)}`, "AgentProtocolVersionMismatch", -32002);
      }
      if (this.child !== child) throw new AgentProcessError("agent-cli connection changed during initialization");
      this.setStatus("ready", "agent-cli is ready");
      this.restartAttempt = 0;
    } catch (cause) {
      if (this.child === child) await this.terminateChild();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.child && this.generation <= generation + 1) {
        this.setStatus("error", error.message);
        if (recovering) this.scheduleRecovery();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartAttempt = 0;
    if (!this.child) {
      this.setStatus("stopped", "");
      return;
    }
    this.stopping = true;
    try {
      await this.request("shutdown", {}, this.options.shutdownTimeoutMs ?? 5_000);
    } catch {
      // The process may have already exited; termination below is idempotent.
    }
    await this.terminateChild();
    this.setStatus("stopped", "");
    this.stopping = false;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async runTurn(job: AgentJob, handle: RunHandle): Promise<DirectRuntimeOutcome> {
    const releaseProcess = handle.registerProcess({
      kill: () => this.cancelRun(handle.runId),
      forceKill: () => this.cancelRun(handle.runId),
    });
    try {
      return parseAgentRunTurnResult(await this.request("run_turn", { job }, 0));
    } finally {
      this.cancelledRuns.delete(handle.runId);
      releaseProcess();
    }
  }

  async cancelTurn(handle: RunHandle): Promise<void> {
    await this.cancelRun(handle.runId);
  }

  async steerTurn(handle: RunHandle, message: Required<SteeringMessage>): Promise<void> {
    const result = objectValue(await this.request("steer_turn", {
      run_id: handle.runId,
      text: message.text,
      response_route_id: message.response_route_id,
      message_id: message.message_id,
    }));
    if (result.accepted !== true) {
      throw new RuntimeRequestError("run_not_found", "agent-cli rejected steering");
    }
  }

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    await this.request("ensure_session", { request });
  }

  async updateSkillPermissions(allowedSkillTypes: readonly string[]): Promise<void> {
    const normalized = [...new Set(
      allowedSkillTypes.map((item) => item.trim()).filter(Boolean),
    )];
    if (normalized.length === this.allowedSkillTypes.length
      && normalized.every((item) => this.allowedSkillTypes.includes(item))) return;
    this.allowedSkillTypes = normalized;
    if (!this.isReady) return;
    const result = objectValue(await this.request(
      "update_skill_permissions",
      { allowed_skill_types: [...normalized] },
    ));
    if (result.updated !== true) {
      throw new AgentProcessError(
        "agent-cli rejected the Skill permission update",
        "AgentProtocolError",
      );
    }
  }

  async updateManagedLlmCredential(
    credential: ManagedLlmCredential | null,
    target?: ManagedLlmTarget,
  ): Promise<void> {
    const managedTarget = target ?? credential;
    this.options.environment.LXE_MANAGED_LLM_PROVIDER = managedTarget?.provider ?? "";
    this.options.environment.LXE_MANAGED_LLM_MODEL = managedTarget?.model ?? "";
    this.options.environment.LXE_MANAGED_LLM_API_KEY = credential?.api_key ?? "";
    this.options.environment.LXE_MANAGED_LLM_CREDENTIAL_REVISION = credential?.credential_revision ?? "";
    this.options.environment.LXE_MANAGED_LLM_INVALID_REVISION = credential?.invalid_revision ?? "";
    if (!this.isReady) return;
    const result = objectValue(await this.request(
      "update_managed_llm_credential",
      { credential, ...(managedTarget ? { target: managedTarget } : {}) },
    ));
    if (result.updated !== true) {
      throw new AgentProcessError(
        "agent-cli rejected the managed LLM credential update",
        "AgentProtocolError",
      );
    }
  }

  async appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    await this.request("append_pending_event", { session_id: sessionId, event });
  }

  async hasPendingEvents(sessionId: string): Promise<boolean> {
    return objectValue(await this.request("has_pending_events", { session_id: sessionId })).pending === true;
  }

  async resolveArtifact(sessionId: string, artifactId: string): Promise<string | undefined> {
    const result = objectValue(await this.request("resolve_artifact", {
      session_id: sessionId,
      artifact_id: artifactId,
    }));
    if (result.found === false) return undefined;
    const path = String(result.path ?? "").trim();
    if (result.found !== true || !path) {
      throw new AgentProcessError("agent-cli returned a malformed artifact resolution", "AgentProtocolError");
    }
    return path;
  }

  async resolveAttachment(sessionId: string, attachmentId: string): Promise<string | undefined> {
    const result = objectValue(await this.request("resolve_attachment", {
      session_id: sessionId,
      attachment_id: attachmentId,
    }));
    if (result.found === false) return undefined;
    const path = String(result.path ?? "").trim();
    if (result.found !== true || !path) {
      throw new AgentProcessError("agent-cli returned a malformed attachment resolution", "AgentProtocolError");
    }
    return path;
  }

  async dashboardCall<O extends AgentDashboardRpcOperation>(
    call: AgentDashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>> {
    return await this.request("dashboard_call", call) as DashboardRpcResult<O>;
  }

  private async cancelRun(runId: string): Promise<void> {
    if (!this.isReady) return;
    if (this.cancelledRuns.has(runId)) return;
    const result = objectValue(await this.request("cancel_turn", { run_id: runId }, 5_000));
    if (result.cancelled !== true) {
      throw new RuntimeRequestError("run_not_found", "agent-cli could not find the active run");
    }
    this.cancelledRuns.add(runId);
  }

  private request<C extends AgentCommand>(
    command: C,
    payload: AgentCommandPayloads[C],
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<JsonValue> {
    if (!this.child || this.child.stdin.destroyed) {
      return Promise.reject(new AgentProcessError("agent-cli is not running", "AgentProcessUnavailable"));
    }
    const id = randomUUID();
    const request: AgentRequest<C> = {
      jsonrpc: "2.0",
      id,
      method: command,
      params: payload,
    } as AgentRequest<C>;
    return new Promise<JsonValue>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = { resolve: resolveRequest, reject: rejectRequest };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          rejectRequest(new AgentProcessError(
            `agent-cli request timed out: ${command}`,
            "AgentRequestTimeout",
          ));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      this.child!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        rejectRequest(error);
      });
    });
  }

  private handleLine(line: string, generation: number): void {
    try {
      const value = parseJsonRpcJson(line);
      if (Array.isArray(value) && !value.length) throw new Error("Empty JSON-RPC output batch");
      for (const item of Array.isArray(value) ? value : [value]) {
        const message = parseJsonRpcEnvelope(item);
        if (!("method" in message)) this.handleResponse(message);
        else if (!("id" in message)) {
          const event = decodeAgentEvent(message as AgentNotification);
          this.notifications = this.notifications.then(async () => {
            if (generation === this.generation) await this.handleEvent(event, generation);
          }).catch((error) => this.logger.error("agent_event_delivery_failed", { type: event.type, error }));
        } else throw new Error("Unexpected agent-cli request");
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.logger.error("invalid_agent_cli_output", { error });
      void this.failConnection(error);
    }
  }

  private async failConnection(error: Error): Promise<void> {
    this.setStatus("error", error.message);
    this.rejectPending(error);
    const termination = this.terminateChild();
    const generation = this.generation;
    await termination;
    if (generation === this.generation && !this.child && !this.stopping && !this.manuallyStopped) this.scheduleRecovery();
  }

  private handleResponse(response: AgentResponse): void {
    if (response.id === null) throw new Error("error" in response ? response.error.message : "Uncorrelated JSON-RPC response with null id");
    const pending = typeof response.id === "string" ? this.pending.get(response.id) : undefined;
    if (!pending) {
      this.logger.debug("unmatched_agent_response", { id: response.id });
      return;
    }
    this.pending.delete(response.id as string);
    if (pending.timer) clearTimeout(pending.timer);
    if ("result" in response) pending.resolve(response.result);
    else {
      if (response.error.code === -32002) this.incompatible = true;
      const data = objectValue(response.error.data ?? null);
      pending.reject(new AgentProcessError(response.error.message,
        typeof data.code === "string" ? data.code : "AgentProtocolError", response.error.code));
    }
  }

  private async handleEvent(event: AgentEvent, generation: number): Promise<void> {
    try {
      if (event.type === "item.completed") await this.options.onEmit?.(event.payload);
      else if (event.type === "conversation.stream.delta") await this.options.onDesktopStream?.(event.payload);
      else if (event.type === "typing.changed") await this.options.onTyping?.(event.payload);
      else if (event.type === "agent.wake") await this.options.onWake?.(event.payload);
      else if (event.type === "system.ready" || event.type === "system.status") {
        const status = loggingStatus(event.payload.logging);
        if (status) {
          this.remoteHealthSnapshot = { ...this.remoteHealthSnapshot, logging: status };
          this.options.onStatus?.(this.status());
        }
      }
      if (generation === this.generation) await this.options.onEvent?.(event);
    } catch (cause) {
      this.logger.error("agent_event_delivery_failed", { type: event.type, error: cause });
    }
  }

  private handleExit(error: Error): void {
    if (!this.child) return;
    this.child = undefined;
    this.generation += 1;
    this.notifications = Promise.resolve();
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = undefined;
    this.stderr = undefined;
    this.rejectPending(error);
    const planned = this.stopping || this.manuallyStopped;
    this.setStatus(planned ? "stopped" : "error", planned ? "" : error.message);
    if (!planned) this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.manuallyStopped || this.incompatible || this.restartTimer) return;
    const delays = this.options.restartDelaysMs ?? [];
    const delay = delays[this.restartAttempt];
    if (delay === undefined) return;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.manuallyStopped || this.incompatible) return;
      void this.launch(true).catch(() => undefined);
    }, delay);
    this.restartTimer.unref?.();
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.generation += 1;
    this.notifications = Promise.resolve();
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = undefined;
    this.stderr = undefined;
    this.rejectPending(new AgentProcessError("agent-cli stopped", "AgentProcessStopped"));
    if (!child.killed) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveTimeout();
          }, 2_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.cancelledRuns.clear();
  }

  private setStatus(state: ProcessState, message: string): void {
    this.state = state;
    this.statusMessage = message;
    this.options.onStatus?.(this.status());
  }
}
