import { contextFingerprint } from "./context-meter";
import { captureEnvironment, environmentChanged, environmentMessage } from "./environment-context";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type { AgentJob, EmitRequest, JsonObject, WorkspaceContext } from "@lxe/protocol";
import {
  assertWorkspaceAvailable,
  createLogger,
  runWithLogContext,
  sameWorkspaceContext,
  workspaceContextFrom,
  type Environment,
  type Logger,
} from "@lxe/core";
import {
  ToolExecutionError,
  ToolRegistry,
  unknownToolFailureDetails,
  type ToolExposureOptions,
} from "../tooling/registry";
import {
  ContextCompactionError,
  ContextOverflowError,
  ContextPipeline,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTokens,
  requestContextTokenEstimate,
  isContextOverflowError,
  trimToolResultBlocks,
  type ContextCompactionResult,
} from "./context";
import { FinalAnswerStreamer } from "./final-answer-streamer";
import {
  providerEndpointUrl,
  RuntimeProviderError,
  type RuntimeProviderManager,
} from "../providers/provider";
import { RuntimeTurnObserver } from "./turn-observer";
import {
  heartbeatPrompt,
  normalizePendingSystemEvents,
  userContentWithSystemEvents,
  withTurnContext,
} from "./system-events";
import type { RuntimeWireTraceAttempt, RuntimeWireTraceControllerPort } from "../providers/wire-trace";
import type {
  AgentRuntime,
  RuntimeContentBlock,
  RuntimeEmitter,
  RuntimeHandle,
  RuntimeMessage,
  RuntimeMessageContent,
  RuntimeProvider,
  RuntimeSkillSnapshot,
  RuntimeWorkspaceInstanceProvider,
  RuntimeStore,
  AssistantMessageEvent,
  SystemPromptContext,
  SkillActivationUsage,
  SkillExecutionUsage,
  RuntimeTurnContextRecord,
  AssistantMessage,
  RuntimeUsage,
  ToolResultBlock,
  ToolCallBlock,
  TurnOutcome,
} from "./types";

export interface TypeScriptAgentRuntimeOptions {
  store: RuntimeStore;
  provider?: RuntimeProvider;
  providerManager?: RuntimeProviderManager;
  wireTraceController?: RuntimeWireTraceControllerPort;
  tools: ToolRegistry;
  toolExposure?: ToolExposureOptions | (() => ToolExposureOptions);
  skillSnapshot?: (workspace: WorkspaceContext) => RuntimeSkillSnapshot;
  workspaceInstances?: RuntimeWorkspaceInstanceProvider;
  resolveSkillMetadata?: (skillName: string) => { module: string } | undefined;
  emitter: RuntimeEmitter;
  onSessionChanged?: (
    sessionId: string,
    change: "messages" | "usage" | "artifacts" | "attachments",
  ) => Promise<void> | void;
  onManagedLlmAuthenticationFailure?: (
    provider: string,
    model: string,
    credentialRevision: string,
  ) => Promise<void> | void;
  artifactRoot?: string;
  systemPrompt: string | ((context: SystemPromptContext) => string);
  maxSteps?: number;
  contextWindowTokens?: number;
  environment?: Environment;
  logger?: Logger;
  display?: {
    model: string;
    contextWindowTokens: number;
    toolUseMode: "off" | "on" | "full";
    showFullPaths: boolean;
  };
  services?: Array<{
    start(registry: ToolRegistry): Promise<void>;
    stop(): Promise<void>;
  }>;
}

const toolCallBlocks = (content: RuntimeContentBlock[]): ToolCallBlock[] =>
  content.filter((block): block is ToolCallBlock =>
    block.type === "tool_call" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    block.arguments !== null && typeof block.arguments === "object" && !Array.isArray(block.arguments));

const textContent = (content: RuntimeContentBlock[]): string =>
  content
    .filter((block): block is RuntimeContentBlock & { text: string } =>
      block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();

const isCancelled = (handle: RuntimeHandle): boolean => handle.cancelled || handle.signal.aborted;

interface TurnUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const addUsage = (target: TurnUsageTotals, usage: RuntimeUsage): void => {
  target.input += Math.max(0, Math.trunc(usage.input_tokens ?? 0));
  target.output += Math.max(0, Math.trunc(usage.output_tokens ?? 0));
  target.cacheRead += Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
  target.cacheCreation += Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
};

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_PROVIDER_ATTEMPTS = 3;
export const MAX_STEP_REPLY = "本轮已达到最大步骤，请发送下一条消息继续。";

export class TypeScriptAgentRuntime implements AgentRuntime {
  private readonly logger: Logger;
  private readonly reportedInvalidCredentialRevisions = new Set<string>();

  private async notifySessionChanged(
    sessionId: string,
    change: "messages" | "usage" | "artifacts" | "attachments",
  ): Promise<void> {
    try {
      await this.options.onSessionChanged?.(sessionId, change);
    } catch (error) {
      this.logger.warn("session_change_delivery_failed", { session_id: sessionId, change, error });
    }
  }

  private async appendMessage(
    sessionId: string,
    message: RuntimeMessage,
    reason: string,
    turnId?: string,
  ): Promise<void> {
    await this.options.store.appendMessage(sessionId, message, reason, turnId);
    await this.notifySessionChanged(sessionId, "messages");
  }

  private async appendTurnError(sessionId: string, turnId: string, message: string): Promise<void> {
    await this.options.store.appendTurnError(sessionId, turnId, message);
    await this.notifySessionChanged(sessionId, "messages");
  }

  private readonly active = new Set<RuntimeHandle>();
  private started = false;

  constructor(private readonly options: TypeScriptAgentRuntimeOptions) {
    this.logger = options.logger ?? createLogger("runtime");
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.store.start();
    const startedServices: NonNullable<TypeScriptAgentRuntimeOptions["services"]> = [];
    try {
      for (const service of this.options.services ?? []) {
        await service.start(this.options.tools);
        startedServices.push(service);
      }
    } catch (cause) {
      await Promise.allSettled(startedServices.reverse().map((service) => service.stop()));
      await this.options.store.stop();
      throw cause;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await Promise.allSettled([...this.active].map(async (handle) => {
      if (!handle.signal.aborted) this.logger.warn("runtime stopped with active turn");
    }));
    await Promise.allSettled([...(this.options.services ?? [])].reverse().map((service) => service.stop()));
    await this.options.workspaceInstances?.disposeAll("runtime_stop");
    await this.options.store.stop();
    this.started = false;
  }

  async runTurn(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome> {
    return runWithLogContext({
      session_id: job.session_id,
      turn_id: job.job_id,
      response_route_id: job.response_route_id,
      message_id: job.message_id,
    }, () => this.runTurnInContext(job, handle));
  }

  private async runTurnInContext(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome> {
    if (!this.started) throw new Error("runtime is not started");
    const session = await this.options.store.getSession(job.session_id);
    if (!session) throw new Error(`session not found: ${job.session_id}`);
    const requestedWorkspace = workspaceContextFrom(job.workspace);
    if (!sameWorkspaceContext(session.workspace, requestedWorkspace)) {
      throw new Error(`job workspace does not match session: ${job.session_id}`);
    }
    const workspace = assertWorkspaceAvailable(session.workspace);
    const providerSnapshot = this.options.providerManager?.acquire();
    const provider = providerSnapshot?.provider ?? this.options.provider;
    if (!provider) throw new Error("runtime provider is not configured");
    const skillActivations = new Map<string, SkillActivationUsage>();
    const skillExecutions: SkillExecutionUsage[] = [];
    const descriptor = providerSnapshot?.descriptor;
    const metricSource = String(job.source.platform ?? "").trim() === "desktop" ? job.source : session.source;
    const sourceExtra = metricSource.extra !== null && typeof metricSource.extra === "object" &&
      !Array.isArray(metricSource.extra) ? metricSource.extra as JsonObject : {};
    const observer = new RuntimeTurnObserver();
    const wireTraceTurn = this.options.wireTraceController?.startTurn(job.session_id, job.job_id);
    const contextWindowTokens = descriptor?.contextWindowTokens ?? this.options.contextWindowTokens ?? this.options.display?.contextWindowTokens;
    const contextPipeline = new ContextPipeline({
      provider,
      store: this.options.store,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    });
    const turnPlatform = String(job.source.platform ?? session.source.platform ?? "").trim();
    const userIdentity = { platform: turnPlatform, userId: String(job.user_id ?? "") };
    const finalAnswerStreamer = job.response_route_id
      && (turnPlatform === "feishu" || turnPlatform === "desktop" || turnPlatform === "cli")
      ? new FinalAnswerStreamer({
          sessionId: job.session_id,
          turnId: job.job_id,
          responseRouteId: job.response_route_id,
          emit: (request) => this.emitBestEffort(request, "stream"),
          ...(turnPlatform === "desktop" && this.options.emitter.desktopStream
            ? { emitDesktopBatch: (request) => this.emitDesktopStreamBestEffort(request) }
            : {}),
          ...(this.options.display ? {
            model: descriptor?.model ?? this.options.display.model,
            contextWindowTokens: descriptor?.contextWindowTokens ?? this.options.display.contextWindowTokens,
          } : {}),
          // Desktop owns its own expandable tool-result presentation. Do not
          // let the Feishu card setting strip successful results from the
          // local live view; other channels keep their configured behaviour.
          toolUseMode: turnPlatform === "desktop"
            ? "full"
            : (this.options.display?.toolUseMode ?? "on"),
          // Path shortening exists because a Feishu card is read in a group
          // chat by people who are not on this machine - hence the FEISHU_
          // setting behind it. The desktop window is the machine's own owner
          // looking at their own filesystem, so it does not apply there.
          // Secret redaction is separate and still runs either way.
          showFullPaths: turnPlatform === "desktop"
            || (this.options.display?.showFullPaths ?? false),
        })
      : undefined;
    this.active.add(handle);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let apiCalls = 0;
    let toolCalls = 0;
    let typingStarted = false;
    let workspaceLease: Awaited<ReturnType<RuntimeWorkspaceInstanceProvider["acquire"]>> | undefined;
    const startedAt = Date.now() / 1_000;
    const toolUsage = new Map<string, { calls: number; errors: number; duration_ms: number }>();
    const emittedArtifactPaths = new Set<string>();
    const toolRecoveryAttempts = new Map<string, number>();
    let usageRecorded = false;
    const accountedMessages = new Set<string>();
    const accountMessage = (message: AssistantMessage): void => {
      if (accountedMessages.has(message.id)) return;
      accountedMessages.add(message.id);
      const usage = message.usage;
      inputTokens += Math.max(0, Math.trunc(usage.input_tokens));
      outputTokens += Math.max(0, Math.trunc(usage.output_tokens));
      cacheReadTokens += Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
      cacheCreationTokens += Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
      if (usage.status !== "unreported") finalAnswerStreamer?.updateUsage(usage);
    };
    const accountContext = (result: ContextCompactionResult): void => {
      const usage: TurnUsageTotals = {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheCreation: cacheCreationTokens,
      };
      addUsage(usage, result.usage);
      inputTokens = usage.input;
      outputTokens = usage.output;
      cacheReadTokens = usage.cacheRead;
      cacheCreationTokens = usage.cacheCreation;
      apiCalls += result.apiCalls;
      if (result.apiCalls > 0) finalAnswerStreamer?.updateUsage(result.usage);
    };
    const recordUsage = async (status: TurnOutcome["status"], error?: unknown): Promise<void> => {
      if (usageRecorded) return;
      usageRecorded = true;
      const elapsedMs = Math.max(0, Math.trunc((Date.now() / 1_000 - startedAt) * 1_000));
      try {
        await this.options.store.recordTurn(job.session_id, {
          turn_id: job.job_id,
          started_at: startedAt,
          platform: turnPlatform,
          bot_app_id: String(sourceExtra.bot_app_id ?? job.raw_data.app_id ?? "").trim(),
          bot_id: String(sourceExtra.bot_id ?? "").trim(),
          bot_name: String(sourceExtra.bot_name ?? "").trim(),
          provider: descriptor?.name ?? "custom",
          model: descriptor?.model ?? this.options.display?.model ?? "",
          status,
          elapsed_ms: elapsedMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          tool_calls: toolCalls,
          api_calls: apiCalls,
          tools: [...toolUsage.entries()].map(([name, usage]) => ({ name, ...usage })),
          activations: [...skillActivations.values()],
          executions: skillExecutions,
        });
        await this.notifySessionChanged(job.session_id, "usage");
      } catch (cause) {
        this.logger.warn("turn_usage_persist_failed", { error: cause });
      }
      observer.complete({ status, inputTokens, outputTokens, toolCalls, apiCalls, ...(error === undefined ? {} : { error }) });
    };
    try {
      if (descriptor?.credentialSource === "cloud"
        && descriptor.credentialRevision
        && String(this.options.environment?.LXE_MANAGED_LLM_INVALID_REVISION ?? "").trim().toLowerCase()
          === descriptor.credentialRevision) {
        throw new RuntimeProviderError(
          "managed LLM credential revision is invalid",
          descriptor.name,
          "认证失败",
          "云端模型凭证已失效，正在尝试从公司服务器刷新。",
          false,
          401,
        );
      }
      if (job.job_kind === "turn" && job.response_route_id) {
        typingStarted = await this.typingBestEffort({
          session_id: job.session_id,
          turn_id: job.job_id,
          response_route_id: job.response_route_id,
          operation: "start",
          emit_id: randomUUID().replaceAll("-", ""),
        }, "start");
      }
      const heartbeat = job.job_kind === "heartbeat";
      const storedPendingEvents = await this.options.store.popPendingEvents(job.session_id);
      const pendingEvents = normalizePendingSystemEvents(storedPendingEvents);
      if (heartbeat) observer.pendingEvents("popped", pendingEvents.length);
      else if (pendingEvents.length > 0) observer.pendingEvents("attached", pendingEvents.length);
      if (heartbeat && pendingEvents.length === 0) {
        observer.start({
        jobKind: "heartbeat",
          provider: descriptor?.name ?? "custom",
          model: descriptor?.model ?? this.options.display?.model ?? "",
          messageTurns: 0,
          systemTokens: 0,
          messageTokens: 0,
          contextCapacity: contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
          pendingEventCount: 0,
        });
        observer.pendingEvents("noop", 0);
        await recordUsage("completed");
        return this.outcome("completed", "", inputTokens, outputTokens, toolCalls);
      }
      await finalAnswerStreamer?.startPreparingContext();
      workspaceLease = await this.options.workspaceInstances?.acquire(workspace);
      const skillSnapshot = workspaceLease?.snapshot.skills ?? this.options.skillSnapshot?.(workspace);
      const skillModule = (name: string): string => skillSnapshot
        ? skillSnapshot.modules[name]?.trim() ?? ""
        : this.options.resolveSkillMetadata?.(name)?.module.trim() ?? "";
      const exposureOptions = typeof this.options.toolExposure === "function"
        ? this.options.toolExposure()
        : this.options.toolExposure;
      const skillNames = skillSnapshot?.names
        ?? (exposureOptions?.allowedSkills ? [...exposureOptions.allowedSkills] : []);
      const toolExposure = this.options.tools.createExposureState({
        ...exposureOptions,
        ...(skillSnapshot ? { allowedSkills: new Set(skillNames) } : {}),
        ...(skillSnapshot?.disabledConnectorIds
          ? { disabledConnectors: new Set(skillSnapshot.disabledConnectorIds) }
          : {}),
        onSkillActivated: async (name) => {
          skillActivations.set(name, { skill: name, module: skillModule(name) });
          await exposureOptions?.onSkillActivated?.(name);
        },
      });
      const systemPromptContext: SystemPromptContext = {
        platform: turnPlatform,
        provider: descriptor?.name ?? "custom",
        model: descriptor?.model ?? this.options.display?.model ?? "",
        skillPrompt: skillSnapshot?.prompt ?? "",
        workspace,
        ...(workspaceLease ? { workspaceSnapshot: workspaceLease.snapshot } : {}),
      };
      const systemPrompt = typeof this.options.systemPrompt === "function"
        ? this.options.systemPrompt(systemPromptContext)
        : this.options.systemPrompt;
      const fingerprintFor = (toolSchemas: ReturnType<typeof toolExposure.schemas>, isLastStep: boolean) => contextFingerprint({
          provider: systemPromptContext.provider, model: systemPromptContext.model,
          api: descriptor?.apiStyle, endpoint: descriptor?.baseURL,
          thinkingStyle: descriptor?.thinkingStyle, thinkingEnabled: descriptor?.thinkingEnabled,
          thinkingEffort: descriptor?.thinkingEffort, thinkingBudget: descriptor?.thinkingBudgetTokens,
          thinkingDisplay: descriptor?.thinkingDisplay, supportsVision: descriptor?.supportsVision,
          maxTokens: descriptor?.maxTokens, toolStream: descriptor?.toolStream,
          system: systemPrompt, tools: toolSchemas, toolChoice: heartbeat || isLastStep ? "none" : "auto",
        });
      const turnContext: RuntimeTurnContextRecord = {
        turn_id: job.job_id,
        job_kind: heartbeat ? "heartbeat" : "turn",
        provider: descriptor?.name ?? "custom",
        model: descriptor?.model ?? this.options.display?.model ?? "",
        credential_source: descriptor?.credentialSource ?? "local",
        effort: descriptor?.thinkingEffort ?? "",
        thinking_enabled: descriptor?.thinkingEnabled ?? false,
        provider_generation: providerSnapshot?.generation ?? 0,
        context_window_tokens: contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        ts: Date.now() / 1_000,
      };
      await this.options.store.appendTurnContext(job.session_id, turnContext);
      let messages = heartbeat ? [] : await this.options.store.loadMessages(job.session_id);
      const userContent: RuntimeMessageContent = heartbeat
        ? heartbeatPrompt(pendingEvents)
        : userContentWithSystemEvents(job.user_input, job.user_content_blocks, pendingEvents);
      const userMessage: RuntimeMessage = { role: "user", content: withTurnContext(userContent, job.diagnostics) };
      messages.push(userMessage);
      const firstTools = heartbeat || (this.options.maxSteps ?? DEFAULT_MAX_STEPS) <= 1 ? [] : toolExposure.schemas();
      const initialMeasurement = contextPipeline.measure(systemPrompt, messages, firstTools,
        fingerprintFor(firstTools, (this.options.maxSteps ?? DEFAULT_MAX_STEPS) <= 1));
      observer.start({
        measurement: initialMeasurement,
        jobKind: heartbeat ? "heartbeat" : "turn",
        provider: descriptor?.name ?? "custom",
        model: descriptor?.model ?? this.options.display?.model ?? "",
        messageTurns: messages.filter((message) => message.role === "user").length,
        systemTokens: estimateTokens(systemPrompt),
        messageTokens: estimateTokens(messages),
        contextCapacity: contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        pendingEventCount: pendingEvents.length,
      });
      await this.appendMessage(job.session_id, userMessage, heartbeat ? "heartbeat" : "turn_input", job.job_id);
      await finalAnswerStreamer?.updateContext(initialMeasurement);
      if (!heartbeat && job.user_content_blocks.some((block) => block.type === "local_file")) {
        await this.notifySessionChanged(job.session_id, "attachments");
      }

      const appendSteering = async (steeringMessages = handle.drainSteering()): Promise<number> => {
        let appended = 0;
        for (const steering of steeringMessages) {
          const text = String(steering.text ?? "").trim();
          if (!text) continue;
          const message: RuntimeMessage = { role: "user", content: text };
          messages.push(message);
          await this.appendMessage(job.session_id, message, "steering", job.job_id);
          appended += 1;
        }
        return appended;
      };

      const maxSteps = Math.max(1, Math.trunc(this.options.maxSteps ?? DEFAULT_MAX_STEPS));
      await finalAnswerStreamer?.startToolPending();
      for (let step = 0; step < maxSteps; step += 1) {
        await finalAnswerStreamer?.startPreparingContext();
        if (isCancelled(handle)) {
          await finalAnswerStreamer?.cancel();
          await recordUsage("cancelled");
          return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
        }
        await appendSteering();
        const isLastStep = step === maxSteps - 1;
        const toolSchemas = heartbeat || isLastStep ? [] : toolExposure.schemas();
        const fingerprint = fingerprintFor(toolSchemas, isLastStep);
        const updateContext = async () => {
          const measurement = contextPipeline.measure(systemPrompt, messages, toolSchemas, fingerprint);
          observer.measurement(measurement);
          await finalAnswerStreamer?.updateContext(measurement);
        };
        const prepareRequestContext = async (): Promise<void> => {
          let snapshot = captureEnvironment({ ...systemPromptContext, ...(this.options.artifactRoot ? { artifactRoot: this.options.artifactRoot } : {}) });
          let environment = environmentMessage(snapshot);
          const prepared = await contextPipeline.prepare({
            sessionId: job.session_id,
            messages,
            systemPrompt,
            toolSchemas,
            signal: handle.signal,
            userIdentity,
            trigger: "pre_call",
            contextFingerprint: fingerprint,
            additionalContextTokens: estimateTokens({ role: environment.role, content: environment.content }),
          });
          accountContext(prepared);
          observer.context(prepared);
          messages = prepared.messages;
          if (prepared.failureReason) {
            throw new ContextCompactionError(prepared.failureReason, prepared.afterTokens);
          }
          if (prepared.hardLimitExceeded) {
            throw new ContextOverflowError(prepared.afterTokens, contextPipeline.hardLimitTokens);
          }
          // Summarization can span midnight; refresh the clock after it finishes.
          snapshot = captureEnvironment({ ...systemPromptContext, ...(this.options.artifactRoot ? { artifactRoot: this.options.artifactRoot } : {}) });
          environment = environmentMessage(snapshot);
          if (environmentChanged(messages, snapshot)) {
            const tokens = contextPipeline.measure(systemPrompt, [...messages, environment], toolSchemas, fingerprint).tokens;
            if (tokens > contextPipeline.hardLimitTokens) throw new ContextOverflowError(tokens, contextPipeline.hardLimitTokens);
            await this.appendMessage(job.session_id, environment, "environment_context", job.job_id);
            messages.push(environment);
            observer.context({ ...prepared, afterTokens: tokens });
          }
          await updateContext();
        };
        const providerRequest = (
          attemptObserver: ReturnType<RuntimeTurnObserver["providerAttempt"]>,
          wireTrace?: RuntimeWireTraceAttempt,
        ) => ({
          system: systemPrompt,
          messages: structuredClone(messages) as RuntimeMessage[],
          tools: toolSchemas,
          toolChoice: heartbeat || isLastStep ? "none" as const : "auto" as const,
          signal: handle.signal,
          userIdentity,
          ...(wireTrace ? { wireTrace } : {}),
          onEvent: async (event: AssistantMessageEvent) => {
            if (event.type === "done") accountMessage(event.message);
            if (event.type === "error") accountMessage(event.error);
            attemptObserver.stream(event);
            if (!isCancelled(handle)) await finalAnswerStreamer?.pushEvent(event);
          },
        });
        let providerAttemptOrdinal = 0;
        const invokeProvider = async (maximumAttempts = DEFAULT_PROVIDER_ATTEMPTS): Promise<AssistantMessage> => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            await prepareRequestContext();
            providerAttemptOrdinal += 1;
            apiCalls += 1;
            const attemptObserver = observer.providerAttempt(
              step + 1,
              providerAttemptOrdinal,
              descriptor?.name ?? "custom",
              descriptor?.model ?? this.options.display?.model ?? "",
            );
            const wireTrace = wireTraceTurn?.startProviderAttempt({
              step,
              attempt: providerAttemptOrdinal,
              provider: descriptor?.name ?? "custom",
              model: descriptor?.model ?? this.options.display?.model ?? "",
              endpoint: descriptor ? providerEndpointUrl(descriptor) : "",
              timeoutMs: descriptor?.requestIdleTimeoutMs ?? 0,
            });
            try {
              await finalAnswerStreamer?.startWaitingModel();
              const request = providerRequest(attemptObserver, wireTrace);
              const estimatedInput = requestContextTokenEstimate(request.system, request.messages, request.tools);
              const requestId = randomUUID();
              const response = structuredClone(await provider.turn(request));
              delete response.contextTokenAnchor;
              const usage = response.usage;
              const actualInput = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
              if (!isCancelled(handle) && ["stop", "length", "toolUse"].includes(response.stopReason) &&
                usage.status === "complete" && [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0]
                  .every(value => Number.isSafeInteger(value) && value >= 0) && Number.isSafeInteger(actualInput) && actualInput > 0 &&
                (!response.responseModel || response.responseModel === systemPromptContext.model)) {
                response.contextTokenAnchor = { version: 1, requestId, fingerprint, estimatedInput, actualInput };
              }
              accountMessage(response);
              attemptObserver.succeed(response);
              return response;
            } catch (error) {
              if (isCancelled(handle) || (error instanceof DOMException && error.name === "AbortError")) {
                attemptObserver.cancel();
                throw error;
              }
              if (isContextOverflowError(error)) {
                attemptObserver.fail(error, false);
                throw error;
              }
              const retryable = error instanceof RuntimeProviderError ? error.retryable : true;
              lastError = error;
              attemptObserver.fail(error, retryable && attempt < maximumAttempts);
              if (!retryable || attempt >= maximumAttempts) throw error;
            }
          }
          throw lastError ?? new Error("provider request failed");
        };
        let response;
        try {
          response = await invokeProvider();
        } catch (error) {
          if (!isContextOverflowError(error)) throw error;
          await finalAnswerStreamer?.startPreparingContext();
          const overflow = await contextPipeline.prepare({
            sessionId: job.session_id,
            messages,
            systemPrompt,
            toolSchemas,
            signal: handle.signal,
            userIdentity,
            trigger: "overflow",
            contextFingerprint: fingerprint,
          });
          accountContext(overflow);
          observer.context(overflow);
          messages = overflow.messages;
          if (overflow.failureReason) {
            throw new ContextCompactionError(overflow.failureReason, overflow.afterTokens);
          }
          if (!overflow.compacted || overflow.hardLimitExceeded) throw error;
          response = await invokeProvider(1);
        }
        const calls = response.stopReason === "toolUse" ? toolCallBlocks(response.content) : [];
        const forcedLastStepReply = isLastStep && calls.length > 0
          ? textContent(response.content) || MAX_STEP_REPLY
          : "";
        const responseText = forcedLastStepReply || textContent(response.content);
        finalAnswerStreamer?.completeModelResponse(responseText, calls.length === 0 || isLastStep);
        const assistantContent: RuntimeContentBlock[] = forcedLastStepReply
          ? [{ type: "text", text: forcedLastStepReply }]
          : response.content;
        const assistant: RuntimeMessage = forcedLastStepReply
          ? { role: "assistant", content: assistantContent, ...(response.contextTokenAnchor ? { contextTokenAnchor: response.contextTokenAnchor } : {}) }
          : response;
        messages.push(assistant);
        await this.appendMessage(job.session_id, assistant, "assistant_response", job.job_id);
        await updateContext();
        if (calls.length === 0 || isLastStep) {
          const reply = responseText;
          const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
          if (reply && job.response_route_id && !streamDelivered) {
            if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "final");
            else await this.emitBestEffort(this.finalRequest(job, reply), "final");
          }
          if (!heartbeat && !isCancelled(handle)) {
            try {
              const postTurn = await contextPipeline.postTurn({
                toolSchemas, contextFingerprint: fingerprint,
                sessionId: job.session_id,
                messages,
                systemPrompt,
                signal: handle.signal,
                userIdentity,
              });
              accountContext(postTurn);
              observer.context(postTurn);
              messages = postTurn.messages;
              await updateContext();
              if (postTurn.failureReason) {
                throw new ContextCompactionError(postTurn.failureReason, postTurn.afterTokens);
              }
              if (postTurn.hardLimitExceeded) {
                this.logger.warn("post-turn context remains over hard limit", {
                  session_id: job.session_id,
                  estimated_tokens: postTurn.afterTokens,
                });
              }
            } catch (error) {
              if (!isCancelled(handle)) this.logger.warn("post-turn context maintenance failed", {
                session_id: job.session_id,
                error,
              });
            }
          }
          await recordUsage("completed");
          return this.outcome("completed", reply, inputTokens, outputTokens, toolCalls);
        }

        const resultSlots: Array<ToolResultBlock | undefined> = new Array(calls.length);
        const orderedResults = (): ToolResultBlock[] =>
          resultSlots.filter((result): result is ToolResultBlock => result !== undefined);
        let interruptedBySteering = false;
        const executeToolCall = async (call: ToolCallBlock, callIndex: number): Promise<void> => {
          toolCalls += 1;
          const startedToolAt = Date.now();
          const definition = this.options.tools.definition(call.name);
          const invocation = definition?.classifyInvocation?.(call.arguments);
          const usageName = invocation?.usageName || call.name;
          const commandId = invocation?.commandId?.trim() ?? "";
          const usage = toolUsage.get(usageName) ?? { calls: 0, errors: 0, duration_ms: 0 };
          const executionSkill = commandId ? String(invocation?.attributionSkill ?? "").trim() : "";
          usage.calls += 1;
          toolUsage.set(usageName, usage);
          observer.toolStarted(step + 1, call.name, call.id, commandId || undefined);
          await finalAnswerStreamer?.pushToolStart(call);
          let toolStatus: "success" | "error" = "success";
          let toolDisplayStatus: import("@lxe/protocol").ToolStepStatus = "success";
          let toolDisplayOutput: { result?: unknown; error?: unknown } | undefined;
          try {
            const result = await this.options.tools.execute(call.name, call.arguments, {
              handle,
              session_id: job.session_id,
              response_route_id: job.response_route_id,
              turn_id: job.job_id,
              tool_call_id: call.id,
              exposureState: toolExposure,
              skill_names: skillNames,
              workspace,
              ...(workspaceLease ? { workspaceSearch: workspaceLease.search } : {}),
            });
            if (result.state_patch && Object.keys(result.state_patch).length > 0) {
              await this.options.store.patchSessionState(job.session_id, result.state_patch);
            }
            if (result.files?.length && job.response_route_id) {
              for (const value of result.files) {
                const path = String(value ?? "").trim();
                if (!path || emittedArtifactPaths.has(path)) continue;
                if (!isAbsolute(path)) throw new Error("tool file path must be absolute");
                await this.options.emitter.emit({
                  session_id: job.session_id,
                  turn_id: job.job_id,
                  response_route_id: job.response_route_id,
                  content: "",
                  thinking: "",
                  redacted_thinking_count: 0,
                  thinking_elapsed_ms: 0,
                  tool_pending: false,
                  tool_elapsed_ms: Date.now() - startedToolAt,
                  tool_steps: [],
                  files: [path],
                  emit_kind: "tool",
                  emit_id: randomUUID().replaceAll("-", ""),
                  stream_type: "",
                  state: "",
                  seq: 0,
                });
                await this.options.store.appendArtifact(job.session_id, {
                  artifact_id: randomUUID().replaceAll("-", ""),
                  turn_id: job.job_id,
                  tool_call_id: call.id,
                  path,
                  name: basename(path),
                  ts: Date.now() / 1_000,
                });
                emittedArtifactPaths.add(path);
                await this.notifySessionChanged(job.session_id, "artifacts");
              }
            }
            resultSlots[callIndex] = {
              type: "tool_result",
              tool_call_id: call.id,
              content: result.content,
            };
            toolDisplayStatus = result.display_status ?? toolStatus;
            toolDisplayOutput = { result: result.content };
          } catch (cause) {
            usage.errors += 1;
            toolStatus = "error";
            toolDisplayStatus = "error";
            const unknownFailure = unknownToolFailureDetails(call.name, cause);
            let displayMessage = unknownFailure.observed_message;
            let modelMessage = JSON.stringify(unknownFailure, null, 2);
            if (cause instanceof ToolExecutionError) {
              displayMessage = cause.message;
              if (cause.recoveryGroup) {
                const attempt = (toolRecoveryAttempts.get(cause.recoveryGroup) ?? 0) + 1;
                toolRecoveryAttempts.set(cause.recoveryGroup, attempt);
                modelMessage = cause.modelContent(attempt);
              } else {
                modelMessage = cause.modelContent();
              }
            }
            toolDisplayOutput = { error: displayMessage };
            resultSlots[callIndex] = {
              type: "tool_result",
              tool_call_id: call.id,
              content: modelMessage,
              is_error: true,
            };
          } finally {
            const durationMs = Date.now() - startedToolAt;
            usage.duration_ms += durationMs;
            if (executionSkill) {
              skillExecutions.push({
                skill: executionSkill,
                module: skillModule(executionSkill),
                command: commandId,
                success: toolStatus === "success",
                duration_ms: durationMs,
              });
            }
            observer.toolCompleted(step + 1, call.name, call.id, toolStatus, durationMs, commandId || undefined);
            await finalAnswerStreamer?.pushToolFinish(call, toolDisplayStatus, durationMs, toolDisplayOutput);
          }
        };

        for (let callIndex = 0; callIndex < calls.length;) {
          const steering = handle.drainSteering();
          if (steering.some((item) => String(item.text ?? "").trim())) {
            for (let pendingIndex = callIndex; pendingIndex < calls.length; pendingIndex += 1) {
              const pending = calls[pendingIndex]!;
              resultSlots[pendingIndex] = {
                type: "tool_result",
                tool_call_id: pending.id,
                content: "Tool execution skipped because the user steered the active turn before dispatch.",
                is_error: true,
              };
            }
            const steeredTools: RuntimeMessage = { role: "tool", content: orderedResults() };
            messages.push(steeredTools);
            await this.appendMessage(job.session_id, steeredTools, "tool_results_steered", job.job_id);
            await updateContext();
            await appendSteering(steering);
            interruptedBySteering = true;
            break;
          }
          if (isCancelled(handle)) {
            for (let pendingIndex = callIndex; pendingIndex < calls.length; pendingIndex += 1) {
              const pending = calls[pendingIndex]!;
              resultSlots[pendingIndex] = {
                type: "tool_result",
                tool_call_id: pending.id,
                content: "Tool execution cancelled before dispatch.",
                is_error: true,
              };
            }
            const cancelledTools: RuntimeMessage = { role: "tool", content: orderedResults() };
            messages.push(cancelledTools);
            await this.appendMessage(job.session_id, cancelledTools, "tool_results_cancelled", job.job_id);
            await updateContext();
            await finalAnswerStreamer?.cancel();
            await recordUsage("cancelled");
            return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
          }
          const parallel = this.options.tools.definition(calls[callIndex]!.name)?.supportsParallelCalls === true;
          let waveEnd = callIndex + 1;
          if (parallel) {
            while (waveEnd < calls.length
              && this.options.tools.definition(calls[waveEnd]!.name)?.supportsParallelCalls === true) {
              waveEnd += 1;
            }
          }
          await Promise.all(calls.slice(callIndex, waveEnd).map((call, offset) =>
            executeToolCall(call, callIndex + offset)));
          callIndex = waveEnd;
        }
        if (interruptedBySteering) continue;
        const trimmedResults = trimToolResultBlocks(orderedResults(), contextPipeline.toolResultMaxTokens).results;
        const toolMessage: RuntimeMessage = { role: "tool", content: trimmedResults };
        messages.push(toolMessage);
        await this.appendMessage(job.session_id, toolMessage, "tool_results", job.job_id);
        await updateContext();
      }
      const reply = MAX_STEP_REPLY;
      const terminal: RuntimeMessage = { role: "assistant", content: [{ type: "text", text: reply }] };
      messages.push(terminal);
      await this.appendMessage(job.session_id, terminal, "assistant_max_steps", job.job_id);
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
      if (job.response_route_id && !streamDelivered) {
        if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "final");
        else await this.emitBestEffort(this.finalRequest(job, reply), "final");
      }
      await recordUsage("completed");
      return this.outcome("completed", reply, inputTokens, outputTokens, toolCalls);
    } catch (cause) {
      if (isCancelled(handle) || (cause instanceof DOMException && cause.name === "AbortError")) {
        await finalAnswerStreamer?.cancel();
        await recordUsage("cancelled");
        return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
      }
      const message = cause instanceof RuntimeProviderError
        ? cause.userMessage
        : cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof RuntimeProviderError
        && cause.statusCode === 401
        && cause.category === "认证失败"
        && descriptor?.credentialSource === "cloud"
        && descriptor.credentialRevision
        && !this.reportedInvalidCredentialRevisions.has(descriptor.credentialRevision)) {
        this.reportedInvalidCredentialRevisions.add(descriptor.credentialRevision);
        try {
          await this.options.onManagedLlmAuthenticationFailure?.(
            descriptor.name,
            descriptor.model,
            descriptor.credentialRevision,
          );
        } catch (error) {
          this.logger.warn("managed_llm_authentication_failure_delivery_failed", { error });
        }
      }
      const reply = `执行失败: ${message}`;
      try {
        await this.appendTurnError(job.session_id, job.job_id, reply);
      } catch (persistError) {
        this.logger.warn("turn_error_persist_failed", { error: persistError });
      }
      await recordUsage("error", cause);
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.fail(reply) : false;
      if (job.response_route_id && !streamDelivered) {
        if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "error");
        else await this.emitBestEffort(this.finalRequest(job, reply), "error");
      }
      return this.outcome("error", reply, inputTokens, outputTokens, toolCalls);
    } finally {
      if (typingStarted) {
        await this.typingBestEffort({
          session_id: job.session_id,
          turn_id: job.job_id,
          response_route_id: job.response_route_id,
          operation: "stop",
          emit_id: randomUUID().replaceAll("-", ""),
        }, "stop");
      }
      this.active.delete(handle);
      workspaceLease?.release();
    }
  }

  private async emitBestEffort(request: EmitRequest, phase: string): Promise<boolean> {
    try {
      await this.options.emitter.emit(request);
      return true;
    } catch (error) {
      this.logger.warn("outbound delivery failed", {
        phase,
        session_id: request.session_id,
        turn_id: request.turn_id,
        response_route_id: request.response_route_id,
        emit_id: request.emit_id,
        error,
      });
      return false;
    }
  }

  private async emitDesktopStreamBestEffort(
    request: Parameters<NonNullable<RuntimeEmitter["desktopStream"]>>[0],
  ): Promise<boolean> {
    try {
      await this.options.emitter.desktopStream?.(request);
      return true;
    } catch (error) {
      this.logger.warn("desktop stream delivery failed", {
        phase: "stream_delta",
        session_id: request.session_id,
        turn_id: request.turn_id,
        response_route_id: request.response_route_id,
        emit_id: request.emit_id,
        error,
      });
      return false;
    }
  }

  private async emitStreamFallback(job: AgentJob, content: string, phase: "final" | "error"): Promise<boolean> {
    const request = this.finalRequest(job, content);
    const fields = {
      phase,
      session_id: request.session_id,
      turn_id: request.turn_id,
      response_route_id: request.response_route_id,
      emit_id: request.emit_id,
    };
    this.logger.info("stream_fallback_started", fields);
    try {
      await this.options.emitter.emit(request);
      this.logger.info("stream_fallback_completed", fields);
      return true;
    } catch (error) {
      this.logger.warn("stream_fallback_failed", { ...fields, error });
      return false;
    }
  }

  private async typingBestEffort(
    request: Parameters<RuntimeEmitter["typing"]>[0],
    phase: string,
  ): Promise<boolean> {
    try {
      await this.options.emitter.typing(request);
      return true;
    } catch (error) {
      this.logger.warn("typing delivery failed", {
        phase,
        session_id: request.session_id,
        turn_id: request.turn_id,
        response_route_id: request.response_route_id,
        emit_id: request.emit_id,
        error,
      });
      return false;
    }
  }

  private outcome(
    status: TurnOutcome["status"],
    reply: string,
    inputTokens: number,
    outputTokens: number,
    toolCalls: number,
  ): TurnOutcome {
    return { status, reply, input_tokens: inputTokens, output_tokens: outputTokens, tool_calls: toolCalls };
  }

  private finalRequest(job: AgentJob, content: string): EmitRequest {
    return {
      session_id: job.session_id,
      turn_id: job.job_id,
      response_route_id: job.response_route_id,
      content,
      thinking: "",
      redacted_thinking_count: 0,
      thinking_elapsed_ms: 0,
      tool_pending: false,
      tool_elapsed_ms: 0,
      tool_steps: [],
      files: [],
      emit_kind: "final",
      emit_id: randomUUID().replaceAll("-", ""),
      stream_type: "",
      state: "",
      seq: 0,
    };
  }
}
