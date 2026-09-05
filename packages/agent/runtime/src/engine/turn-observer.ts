import { createLogger, type Logger } from "@lxe/core";
import type { AssistantMessageEvent, AssistantMessage } from "./types";

const PROVIDER_STREAM_HEARTBEAT_MS = 1_000;
const PROVIDER_STREAM_HEARTBEAT_CHARS = 300;

export interface TurnStartObservation {
  measurement?: import("./context-meter").ContextMeasurement;
  jobKind: "turn" | "heartbeat";
  provider: string;
  model: string;
  messageTurns: number;
  systemTokens: number;
  messageTokens: number;
  contextCapacity: number;
  pendingEventCount: number;
}

export interface TurnCompletionObservation {
  status: "completed" | "cancelled" | "error";
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  apiCalls: number;
  error?: unknown;
}

interface ContextObservation {
  beforeTokens: number;
  afterTokens: number;
  compacted: boolean;
  compactedCount: number;
}

interface StreamSnapshot {
  eventCount: number;
  textChars: number;
  thinkingChars: number;
  redactedThinkingBlocks: number;
  toolUseCount: number;
}

const streamFields = (snapshot: StreamSnapshot): Record<string, number> => ({
  event_count: snapshot.eventCount,
  text_chars: snapshot.textChars,
  thinking_chars: snapshot.thinkingChars,
  redacted_thinking_blocks: snapshot.redactedThinkingBlocks,
  tool_use_count: snapshot.toolUseCount,
});

export class RuntimeProviderAttemptObserver {
  private readonly startedAt: number;
  private lastHeartbeatAt: number;
  private lastHeartbeatChars = 0;
  private completed = false;
  private readonly snapshot: StreamSnapshot = {
    eventCount: 0,
    textChars: 0,
    thinkingChars: 0,
    redactedThinkingBlocks: 0,
    toolUseCount: 0,
  };

  constructor(
    private readonly owner: RuntimeTurnObserver,
    readonly step: number,
    readonly attempt: number,
  ) {
    this.startedAt = owner.now();
    this.lastHeartbeatAt = this.startedAt;
  }

  stream(event: AssistantMessageEvent): void {
    this.snapshot.eventCount += 1;
    if (event.type === "text_delta") this.snapshot.textChars += event.delta.length;
    else if (event.type === "thinking_delta") this.snapshot.thinkingChars += event.delta.length;
    else if (event.type === "thinking_start" && event.partial.content[event.contentIndex]?.redacted === true) this.snapshot.redactedThinkingBlocks += 1;
    const now = this.owner.now();
    const visibleChars = this.snapshot.textChars + this.snapshot.thinkingChars;
    if (
      now - this.lastHeartbeatAt < this.owner.heartbeatMs &&
      visibleChars - this.lastHeartbeatChars < this.owner.heartbeatChars
    ) return;
    this.owner.logger.debug("provider_stream_heartbeat", {
      step: this.step,
      attempt: this.attempt,
      elapsed_ms: Math.max(0, now - this.startedAt),
      ...streamFields(this.snapshot),
    });
    this.lastHeartbeatAt = now;
    this.lastHeartbeatChars = visibleChars;
  }

  succeed(response: AssistantMessage): void {
    if (this.completed) return;
    this.completed = true;
    this.snapshot.toolUseCount = response.content.filter((block) => block.type === "tool_call").length;
    this.owner.logger.debug("provider_attempt_completed", {
      step: this.step,
      attempt: this.attempt,
      latency_ms: Math.max(0, this.owner.now() - this.startedAt),
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      stop_reason: response.stopReason,
      ...streamFields(this.snapshot),
    });
  }

  fail(error: unknown, retryable: boolean): void {
    if (this.completed) return;
    this.completed = true;
    this.owner.logger.warn("provider_attempt_failed", {
      step: this.step,
      attempt: this.attempt,
      latency_ms: Math.max(0, this.owner.now() - this.startedAt),
      retryable,
      error,
      ...streamFields(this.snapshot),
    });
  }

  cancel(): void {
    if (this.completed) return;
    this.completed = true;
    this.owner.logger.debug("provider_attempt_cancelled", {
      step: this.step,
      attempt: this.attempt,
      latency_ms: Math.max(0, this.owner.now() - this.startedAt),
      ...streamFields(this.snapshot),
    });
  }
}

export class RuntimeTurnObserver {
  readonly logger: Logger;
  readonly heartbeatMs: number;
  readonly heartbeatChars: number;
  private readonly startedAt: number;
  private terminal = false;
  private started = false;
  private steps = 0;
  private initialContextTokens = 0;
  private latestContextTokens = 0;
  private compacted = false;
  private compactedCount = 0;
  private readonly tools = new Set<string>();

  constructor(options: {
    logger?: Logger;
    now?: () => number;
  } = {}) {
    this.logger = options.logger ?? createLogger("runtime.turn");
    this.now = options.now ?? Date.now;
    this.heartbeatMs = PROVIDER_STREAM_HEARTBEAT_MS;
    this.heartbeatChars = PROVIDER_STREAM_HEARTBEAT_CHARS;
    this.startedAt = this.now();
  }

  readonly now: () => number;

  start(observation: TurnStartObservation): void {
    if (this.started) return;
    this.started = true;
    const totalTokens = observation.measurement?.tokens ?? observation.systemTokens + observation.messageTokens;
    this.initialContextTokens = totalTokens;
    this.latestContextTokens = totalTokens;
    const usage = observation.contextCapacity > 0 ? totalTokens / observation.contextCapacity : 0;
    this.logger.info("turn_started", {
      job_kind: observation.jobKind,
      provider: observation.provider,
      model: observation.model,
      message_turns: observation.messageTurns,
      system_tokens: observation.systemTokens,
      message_tokens: observation.messageTokens,
      context_tokens: totalTokens,
      ...(observation.measurement ? { context_source: observation.measurement.source, estimated_tokens: observation.measurement.estimatedTokens } : {}),
      context_capacity: observation.contextCapacity,
      context_usage: usage,
      pending_event_count: observation.pendingEventCount,
    });
  }

  measurement(measurement: import("./context-meter").ContextMeasurement): void {
    this.latestContextTokens = measurement.tokens;
    this.logger.debug("context_measured", {
      context_tokens: measurement.tokens, estimated_tokens: measurement.estimatedTokens,
      context_source: measurement.source, context_capacity: measurement.contextWindowTokens,
    });
  }

  context(observation: ContextObservation): void {
    if (this.initialContextTokens === 0) this.initialContextTokens = observation.beforeTokens;
    this.latestContextTokens = observation.afterTokens;
    this.compacted ||= observation.compacted;
    this.compactedCount += Math.max(0, observation.compactedCount);
  }

  providerAttempt(step: number, attempt: number, provider: string, model: string): RuntimeProviderAttemptObserver {
    this.steps = Math.max(this.steps, step);
    this.logger.debug("provider_attempt_started", { step, attempt, provider, model });
    return new RuntimeProviderAttemptObserver(this, step, attempt);
  }

  toolStarted(step: number, name: string, toolUseId: string, commandId?: string): void {
    this.steps = Math.max(this.steps, step);
    this.tools.add(name);
    this.logger.info("tool_started", {
      step,
      tool: name,
      tool_use_id: toolUseId,
      ...(commandId ? { command_id: commandId } : {}),
    });
  }

  toolCompleted(step: number, name: string, toolUseId: string, status: "success" | "error", durationMs: number, commandId?: string): void {
    this.logger.info("tool_completed", {
      step, tool: name, tool_use_id: toolUseId, status, duration_ms: Math.max(0, durationMs),
      ...(commandId ? { command_id: commandId } : {}),
    });
  }

  pendingEvents(event: "popped" | "attached" | "noop", count: number): void {
    this.logger.debug(event === "noop" ? "heartbeat_noop" : `pending_events_${event}`, { event_count: count });
  }

  complete(observation: TurnCompletionObservation): void {
    if (this.terminal) return;
    this.terminal = true;
    const fields = {
      status: observation.status,
      elapsed_ms: Math.max(0, this.now() - this.startedAt),
      steps: this.steps,
      llm_calls: observation.apiCalls,
      tool_calls: observation.toolCalls,
      input_tokens: observation.inputTokens,
      output_tokens: observation.outputTokens,
      tools: [...this.tools].sort(),
      context_before_tokens: this.initialContextTokens,
      context_after_tokens: this.latestContextTokens,
      context_delta_tokens: this.latestContextTokens - this.initialContextTokens,
      compacted: this.compacted,
      compacted_count: this.compactedCount,
      ...(observation.error === undefined ? {} : { error: observation.error }),
    };
    if (observation.status === "error") this.logger.error("turn_completed", fields);
    else this.logger.info("turn_completed", fields);
  }
}
