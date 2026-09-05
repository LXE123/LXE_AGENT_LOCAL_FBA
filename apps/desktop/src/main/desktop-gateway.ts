import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { shell } from "electron";
import { DashboardRpcError } from "@lxe/desktop-protocol";
import type {
  AgentDashboardRpcCall,
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopConversationActivityPayload,
  DesktopConversationStreamBatch,
  DesktopDashboardDataDomain,
  DesktopHealth,
  DesktopLoggingSinkStatus,
} from "@lxe/desktop-protocol";
import type {
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import { resolveWorkspaceContext } from "@lxe/core";
import {
  createDirectGatewayComposition,
  loadFeishuConfig,
  ProcessAgentRuntime,
  LocalConversationSessionNotFoundError,
  type LocalConversationAttachment,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
  type ResponseRoutePatch,
  type ResponseRouteRecord,
} from "@lxe/gateway/desktop";
import type { DesktopConfigStore } from "./config-store";
import { ElectronInboundImageProcessor } from "./inbound-image";
import type { DesktopPaths } from "./paths";
import { NodeGatewayStore } from "./gateway-store";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  dashboardInvalidationForAgentEvent,
} from "./dashboard-invalidation";
import { publicDashboardChannelHealth } from "./dashboard-channel-health";
import { desktopLxeSkillState } from "./lxeskill-health";
import {
  openConversationArtifact,
  openConversationAttachment,
  revealConversationArtifact,
} from "./conversation-artifacts";
import type { DesktopConversationAttachmentService } from "./conversation-attachments";
import {
  resolveDataServerRuntimeEnvironment,
  withoutDataServerEnvironment,
} from "./data-server-policy";
import { withoutRetiredAgentTraceEnvironment } from "./runtime-environment-policy";

class SplitGatewayStorage implements DirectGatewayStorage {
  constructor(
    private readonly gateway: NodeGatewayStore,
    private readonly agent: ProcessAgentRuntime,
  ) {}

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    await this.gateway.ensureSession(request);
    await this.agent.ensureSession(request);
  }

  upsertResponseRoute(request: JsonObject): Promise<void> {
    return this.gateway.upsertResponseRoute(request);
  }

  getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined> {
    return this.gateway.getSession(sessionId);
  }

  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    return this.agent.appendPendingEvent(sessionId, event);
  }

  hasPendingEvents(sessionId: string): Promise<boolean> {
    return this.agent.hasPendingEvents(sessionId);
  }

  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined> {
    return this.gateway.getResponseRoute(responseRouteId);
  }

  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void> {
    return this.gateway.patchResponseRoute(responseRouteId, update);
  }
}

export interface DesktopGatewayOptions {
  paths: DesktopPaths;
  config: DesktopConfigStore;
  version: string;
  packaged: boolean;
  desktopLoggingStatus: () => DesktopLoggingSinkStatus;
  attachments: DesktopConversationAttachmentService;
  allowedSkillTypes: () => readonly string[];
  onHealthChanged?: (health: DesktopHealth) => void;
  onDashboardInvalidated?: (
    domains: DesktopDashboardDataDomain[],
    sessionIds: string[],
  ) => void;
  onConversationActivity?: (activity: DesktopConversationActivityPayload) => void;
  onConversationStreamBatch?: (batch: DesktopConversationStreamBatch) => void;
  onManagedLlmAuthenticationFailure?: (revision: string) => Promise<void> | void;
}

export class DesktopGateway {
  private readonly imageProcessor = new ElectronInboundImageProcessor();
  private composition: DirectGatewayComposition | undefined;
  private runtime: ProcessAgentRuntime | undefined;
  private store: NodeGatewayStore | undefined;
  private gatewayState: DesktopHealth["gateway"] = "stopped";
  private dashboardObservedRuntimeReady = false;
  private lastError = "";

  constructor(private readonly options: DesktopGatewayOptions) {}

  async start(): Promise<void> {
    if (this.composition) return;
    this.gatewayState = "starting";
    this.publishHealth();
    const setup = this.options.config.state();
    const legacyWorkspace = resolveWorkspaceContext(setup.workspace_root);
    const configuredEnvironment = withoutRetiredAgentTraceEnvironment(
      this.options.config.environment(),
    );
    const processEnvironment = withoutRetiredAgentTraceEnvironment(process.env);
    delete configuredEnvironment.LXE_WORKSPACE_ROOT;
    delete processEnvironment.LXE_WORKSPACE_ROOT;
    for (const target of [configuredEnvironment, processEnvironment]) {
      delete target.LXE_ROOT;
      delete target.LXE_RESOURCE_ROOT;
    }
    const environment: Record<string, string | undefined> = {
      ...withoutDataServerEnvironment(processEnvironment),
      ...withoutDataServerEnvironment(configuredEnvironment),
      LXE_AGENT_SOUL_PATH: this.options.paths.agentSoulPath,
      LXE_SKILLS_ROOT: this.options.paths.skillsRoot,
      LXE_USER_SKILLS_ROOT: this.options.paths.userSkillsRoot,
      LXE_LXESKILL_CATALOG_PATH: this.options.paths.lxeskillCatalogPath,
      LXE_LLM_CONFIG_ROOT: this.options.paths.llmConfigRoot,
      LXE_DATA_ROOT: this.options.paths.dataRoot,
      LXE_AGENT_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "agent.sqlite3"),
      LXE_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "lxeskill.sqlite3"),
      TMP: join(this.options.paths.dataRoot, "tmp"),
      TEMP: join(this.options.paths.dataRoot, "tmp"),
      TMPDIR: join(this.options.paths.dataRoot, "tmp"),
      AGENT_SESSION_BINDINGS_PATH: join(this.options.paths.dataRoot, "db", "sessions.json"),
      LXE_MCP_CONFIG_PATH: join(this.options.paths.dataRoot, "config", "mcp_servers.local.yaml"),
      LXE_CONNECTOR_STATE_PATH: join(this.options.paths.dataRoot, "config", "connector-states.local.json"),
      LXE_MANAGED_PATH: this.options.paths.managedPath,
      LXE_MANAGED_PYTHON: this.options.paths.managedPythonPath,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PLAYWRIGHT_BROWSERS_PATH: this.options.paths.playwrightBrowsersPath,
      ...(this.options.packaged ? {
        PLAYWRIGHT_NODEJS_PATH: join(process.resourcesPath, "runtime", "node", "node.exe"),
        NODE_PATH: join(process.resourcesPath, "runtime", "node", "node_modules"),
      } : {
        LXE_SOURCE_ROOT: this.options.paths.sourceRoot,
        UV_PYTHON: this.options.paths.managedPythonPath,
        UV_PYTHON_DOWNLOADS: "never",
        UV_OFFLINE: "0",
      }),
      ...resolveDataServerRuntimeEnvironment({
        packaged: this.options.packaged,
        sourceEnvironment: { ...configuredEnvironment, ...processEnvironment },
        managedEnvironment: configuredEnvironment,
        machineIdentityPath: join(this.options.paths.dataRoot, "db", "machine_identity.json"),
      }),
    };
    const feishu = loadFeishuConfig(environment);
    const allowedSkillTypes = this.options.allowedSkillTypes();
    let composition: DirectGatewayComposition | undefined;
    const runtime = new ProcessAgentRuntime({
      command: this.options.paths.agentCommand,
      arguments: this.options.paths.agentArguments,
      cwd: this.options.paths.dataRoot,
      environment,
      agentSoulPath: this.options.paths.agentSoulPath,
      skillsRoot: this.options.paths.skillsRoot,
      userSkillsRoot: this.options.paths.userSkillsRoot,
      lxeskillCatalogPath: this.options.paths.lxeskillCatalogPath,
      llmConfigRoot: this.options.paths.llmConfigRoot,
      dataRoot: this.options.paths.dataRoot,
      legacyWorkspace,
      allowedSkillTypes,
      onEmit: async (request) => {
        const emitter = composition?.parts.emitter;
        if (!emitter) throw new Error("Gateway emitter is unavailable");
        await emitter.emit(request);
      },
      onDesktopStream: (request) => {
        const conversations = composition?.parts.conversations;
        if (!conversations || !conversations.handleStreamBatch(request)) {
          throw new Error("Gateway rejected a desktop stream batch");
        }
      },
      onTyping: async (request) => {
        await composition?.parts.emitter?.typing(request);
      },
      onWake: (request) => composition?.parts.heartbeatBridge.handle(request),
      onEvent: (event) => {
        if (event.type === "managed_llm.authentication_failed") {
          void this.options.onManagedLlmAuthenticationFailure?.(
            event.payload.credential_revision,
          );
        }
        composition?.parts.conversations.handleAgentEvent(event);
        const invalidation = dashboardInvalidationForAgentEvent(event);
        if (invalidation) {
          this.options.onDashboardInvalidated?.(
            invalidation.domains,
            invalidation.sessionIds,
          );
        }
      },
      restartDelaysMs: [1_000, 2_000, 5_000],
      onStatus: (status) => {
        const ready = status.state === "ready";
        composition?.syncRuntimeReadiness();
        if (ready && !this.dashboardObservedRuntimeReady) {
          this.options.onDashboardInvalidated?.([...ALL_DASHBOARD_DATA_DOMAINS], []);
        }
        this.dashboardObservedRuntimeReady = ready;
        this.publishHealth();
      },
      onStderr: (line) => {
        if (line.trim()) process.stderr.write(`[agent-cli] ${line}\n`);
      },
    });
    const store = new NodeGatewayStore(
      join(this.options.paths.dataRoot, "db", "gateway.sqlite3"),
      legacyWorkspace,
    );
    store.start();
    const splitStorage = new SplitGatewayStorage(store, runtime);
    composition = createDirectGatewayComposition({
      projectRoot: this.options.paths.dataRoot,
      defaultWorkspace: () => resolveWorkspaceContext(this.options.config.state().workspace_root),
      environment,
      storage: splitStorage,
      runtime,
      maxConcurrency: 2,
      ...(feishu.gatewayEnabled && feishu.missingRequired().length === 0
        ? { feishu: { config: feishu, imageProcessor: new ElectronInboundImageProcessor() } }
        : {}),
      onRunFailure: (_handle, error) => {
        this.lastError = error.message;
        this.publishHealth();
      },
      onObserverError: (error) => {
        this.lastError = error.message;
        this.publishHealth();
      },
      ...(this.options.onConversationActivity
        ? { onConversationActivity: this.options.onConversationActivity }
        : {}),
      ...(this.options.onConversationStreamBatch
        ? { onConversationStreamBatch: this.options.onConversationStreamBatch }
        : {}),
    });
    this.runtime = runtime;
    this.store = store;
    this.composition = composition;
    try {
      await composition.start();
      this.gatewayState = "ready";
      this.lastError = "";
      this.publishHealth();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.lastError = error.message;
      this.gatewayState = "error";
      await Promise.allSettled([composition.stop()]);
      store.stop();
      this.composition = undefined;
      this.runtime = undefined;
      this.store = undefined;
      this.publishHealth();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const composition = this.composition;
    this.composition = undefined;
    if (composition) await composition.stop();
    this.store?.stop();
    this.store = undefined;
    this.runtime = undefined;
    this.dashboardObservedRuntimeReady = false;
    this.gatewayState = "stopped";
    this.publishHealth();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async restartAgent(): Promise<DesktopHealth> {
    if (!this.runtime) {
      await this.start();
      return this.health();
    }
    this.gatewayState = "starting";
    this.publishHealth();
    try {
      await this.runtime.restart();
      this.gatewayState = "ready";
      this.lastError = "";
    } catch (cause) {
      this.gatewayState = "error";
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      this.publishHealth();
    }
    return this.health();
  }

  async updateSkillPermissions(allowedSkillTypes: readonly string[]): Promise<void> {
    if (!this.runtime) return;
    try {
      await this.runtime.updateSkillPermissions(allowedSkillTypes);
    } catch {
      await this.runtime.restart();
    }
  }

  async updateManagedLlmCredential(
    credential: import("@lxe/desktop-protocol").ManagedLlmCredential | null,
  ): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.updateManagedLlmCredential(
      credential,
      this.options.config.managedLlmTarget(),
    );
  }

  async syncModelConfiguration(): Promise<void> {
    if (!this.composition || !this.runtime?.isReady) return;
    const setup = this.options.config.state();
    const environment = this.options.config.environment();
    await this.dashboardCall({
      operation: "models.update",
      input: {
        provider: setup.provider,
        model: environment.AGENT_LLM_MODEL ?? "",
        credential_source: setup.credential_source,
      },
    });
  }

  async dashboardCall<O extends DashboardRpcOperation>(call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>> {
    if (!this.composition || !this.runtime?.isReady) throw new Error("Desktop Gateway is not ready");
    if (call.operation === "channels.health") {
      const items = publicDashboardChannelHealth(
        await this.composition.parts.channels.healthSnapshot(),
      );
      return { items, total: Object.keys(items).length } as DashboardRpcResult<O>;
    }
    if (call.operation === "sessions.delete") {
      const sessionId = call.input.session_id;
      const sessionKeys = Object.values(this.composition.parts.bindings.loadAll())
        .filter((entry) => entry.session_id === sessionId)
        .map((entry) => entry.session_key);
      const releaseFence = this.composition.parts.scheduler.beginSessionDeletion(sessionId, sessionKeys);
      if (!releaseFence) {
        throw new DashboardRpcError(
          "failed_precondition",
          "session has an active or queued turn; stop it before deleting",
        );
      }
      let gatewaySnapshot: ReturnType<NodeGatewayStore["detachSession"]> = undefined;
      let removedBindings: ReturnType<DirectGatewayComposition["parts"]["bindings"]["removeSession"]> = [];
      try {
        gatewaySnapshot = this.store?.detachSession(sessionId);
        removedBindings = this.composition.parts.bindings.removeSession(sessionId);
        const result = await this.runtime.dashboardCall(
          call as AgentDashboardRpcCall<"sessions.delete">,
        );
        this.composition.parts.conversations.forgetSession(sessionId);
        this.composition.parts.runtimeState.forget(sessionId);
        return result as DashboardRpcResult<O>;
      } catch (error) {
        this.store?.restoreSession(gatewaySnapshot);
        this.composition.parts.bindings.restore(removedBindings);
        throw error;
      } finally {
        releaseFence();
      }
    }
    if (call.operation === "sessions.send") {
      try {
        const attachmentIds = call.input.attachment_ids ?? [];
        const staged = attachmentIds.length > 0 ? this.options.attachments.resolve(attachmentIds) : [];
        const attachments: LocalConversationAttachment[] = staged.map((attachment) => ({
          attachment_id: attachment.attachment_id,
          name: attachment.name,
          size_bytes: attachment.size_bytes,
          media_type: attachment.media_type,
          path: attachment.path,
          ...(attachment.media_type.startsWith("image/") ? {
            image_block: this.imageProcessor.prepareModelBlock(
              new Uint8Array(readConversationImage(attachment.path)),
              attachment.media_type,
            ),
          } : {}),
        }));
        const result = await this.composition.parts.conversations.send({
          ...(call.input.session_id ? { session_id: call.input.session_id } : {}),
          text: call.input.text,
          ...(call.input.client_message_id ? { client_message_id: call.input.client_message_id } : {}),
          attachments,
        });
        this.options.attachments.consume(attachmentIds);
        return result as DashboardRpcResult<O>;
      } catch (error) {
        if (error instanceof LocalConversationSessionNotFoundError) {
          throw new DashboardRpcError("not_found", error.message);
        }
        throw error;
      }
    }
    if (call.operation === "sessions.stop") {
      return await this.composition.parts.conversations.stop(call.input.session_id) as DashboardRpcResult<O>;
    }
    if (call.operation === "sessions.activity") {
      return this.composition.parts.conversations.activity(call.input.session_id) as DashboardRpcResult<O>;
    }
    if (call.operation === "sessions.file.open") {
      const { session_id: sessionId, artifact_id: artifactId } = call.input;
      return await openConversationArtifact({
        resolveArtifact: (targetSessionId, targetArtifactId) =>
          this.runtime!.resolveArtifact(targetSessionId, targetArtifactId),
        // shell.openPath answers with the operating system's own failure text;
        // "" means it opened.
        openPath: (path) => shell.openPath(path),
      }, sessionId, artifactId) as DashboardRpcResult<O>;
    }
    if (call.operation === "sessions.file.reveal") {
      const { session_id: sessionId, artifact_id: artifactId } = call.input;
      return await revealConversationArtifact({
        resolveArtifact: (targetSessionId, targetArtifactId) =>
          this.runtime!.resolveArtifact(targetSessionId, targetArtifactId),
        // access rejects with the filesystem's own ENOENT text, which is what
        // the conversation shows when a produced file has been moved away.
        assertExists: (path) => access(path),
        revealPath: (path) => shell.showItemInFolder(path),
      }, sessionId, artifactId) as DashboardRpcResult<O>;
    }
    if (call.operation === "sessions.attachment.open") {
      const { session_id: sessionId, attachment_id: attachmentId } = call.input;
      return await openConversationAttachment({
        resolveAttachment: (targetSessionId, targetAttachmentId) =>
          this.runtime!.resolveAttachment(targetSessionId, targetAttachmentId),
        openPath: (path) => shell.openPath(path),
      }, sessionId, attachmentId) as DashboardRpcResult<O>;
    }
    const result = await this.runtime.dashboardCall(call as AgentDashboardRpcCall) as DashboardRpcResult<O>;
    if (call.operation === "models.update" || call.operation === "models.thinking.update") {
      const model = result as unknown as {
        provider: string;
        model: string;
        credential_source: import("@lxe/desktop-protocol").CredentialSource;
        thinking_state: { level: string };
      };
      this.options.config.saveRuntimePreference(
        model.provider,
        model.model,
        model.thinking_state.level,
        model.credential_source,
      );
    }
    return result;
  }

  health(): DesktopHealth {
    const setup = this.options.config.state();
    const agentStatus = this.runtime?.status();
    const runtimeFilesReady = existsSync(this.options.paths.managedPythonPath)
      && existsSync(this.options.paths.lxeskillModulePath);
    return {
      gateway: this.gatewayState,
      agent_cli: agentStatus?.state ?? "stopped",
      lxeskill: runtimeFilesReady ? desktopLxeSkillState(agentStatus) : "error",
      message: this.lastError || agentStatus?.lxeskillMessage || agentStatus?.message || "",
      version: this.options.version,
      resource_root: this.options.paths.resourceRoot,
      data_root: this.options.paths.dataRoot,
      workspace_root: setup.workspace_root,
      logging: {
        desktop: this.options.desktopLoggingStatus(),
        ...(agentStatus?.logging && agentStatus.state !== "stopped"
          ? { agent_cli: agentStatus.logging }
          : {}),
      },
    };
  }

  private publishHealth(): void {
    this.options.onHealthChanged?.(this.health());
  }
}

function readConversationImage(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    const code = String((cause as NodeJS.ErrnoException)?.code ?? "").trim();
    throw new DashboardRpcError(
      "invalid_argument",
      `Selected image is unavailable or changed${code ? ` (${code})` : ""}`,
    );
  }
}
