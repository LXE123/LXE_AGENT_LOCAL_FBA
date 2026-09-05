import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  DesktopConversationActivityPayload,
  DesktopConversationSendPayload,
  DesktopConversationStopPayload,
  DesktopConversationStreamBatch,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  DesktopInputAttachmentPayload,
} from "@lxe/desktop-protocol";
import type {
  AgentJob,
  DesktopStreamBatchRequest,
  DisplayMetrics,
  JsonObject,
  SessionWorkspaceRequest,
  ToolStep,
  ToolDisplayBlock,
  TurnProcessPart,
  TurnDisplayPhase,
  WorkspaceContext,
} from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import type { ChannelAdapter } from "../channels/registry";
import type { OutboundRequest, ResponseRouteRecord } from "../state/models";
import type { SessionRuntimeState } from "../state/session-state";
import type { SchedulerJobStateEvent, SessionScheduler } from "./scheduler";

const DESKTOP_PLATFORM = "desktop";
const DESKTOP_USER_ID = "desktop-local";

const clean = (value: unknown): string => String(value ?? "").trim();
const integer = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export interface LocalConversationStorage {
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined>;
}

export class LocalConversationSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export type LocalConversationAttachment = DesktopInputAttachmentPayload & {
  path: string;
  image_block?: JsonObject;
};

interface InternalTurn {
  payload: DesktopConversationTurnPayload;
  sessionId: string;
  responseRouteId: string;
  streamEmitId?: string;
}

interface InternalActivity {
  activeTurnId: string | undefined;
  queuedTurnIds: string[];
  latestTurnId: string | undefined;
}

type BackgroundTaskChangedEvent = Extract<AgentEvent, { type: "background_task.changed" }>;

export interface LocalConversationControllerOptions {
  storage: LocalConversationStorage;
  scheduler: SessionScheduler;
  runtimeState: SessionRuntimeState;
  defaultWorkspace(): WorkspaceContext;
  onActivity?: (activity: DesktopConversationActivityPayload) => void;
  onStreamBatch?: (batch: DesktopConversationStreamBatch) => void;
  id?: () => string;
  now?: () => number;
}

export class DesktopConversationChannel implements ChannelAdapter {
  readonly platform = DESKTOP_PLATFORM;

  constructor(private readonly outbound: (request: OutboundRequest) => Promise<void> | void) {}

  async handleOutbound(request: OutboundRequest): Promise<void> {
    await this.outbound(request);
  }
}

export class LocalConversationController {
  private readonly logger = createLogger("gateway.local-conversation");
  private readonly id: () => string;
  private readonly now: () => number;
  private readonly turns = new Map<string, InternalTurn>();
  private readonly sessions = new Map<string, InternalActivity>();
  private readonly backgroundCompletions = new Map<string, BackgroundTaskChangedEvent>();

  constructor(private readonly options: LocalConversationControllerOptions) {
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
    this.now = options.now ?? Date.now;
  }

  async send(input: {
    session_id?: string;
    text: string;
    attachments?: LocalConversationAttachment[];
  }): Promise<DesktopConversationSendPayload> {
    const text = clean(input.text);
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) throw new Error("message text or attachment required");
    let sessionId = clean(input.session_id);
    if (sessionId && this.options.scheduler.isSessionDeletionFenced(sessionId)) {
      throw new Error(`session is being deleted: ${sessionId}`);
    }
    let created = false;
    let session = sessionId ? await this.options.storage.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new LocalConversationSessionNotFoundError(sessionId);
    if (!session) {
      sessionId = this.id();
      const source = this.desktopSource(sessionId);
      const workspace = this.options.defaultWorkspace();
      await this.options.storage.ensureSession({
        session_id: sessionId,
        source,
        workspace,
        entry_text: text || attachments[0]!.name,
      });
      session = { session_id: sessionId, source, workspace };
      created = true;
    }

    const turnId = this.id();
    const messageId = this.id();
    const responseRouteId = this.id();
    const source = this.desktopSource(sessionId);
    await this.options.storage.upsertResponseRoute({
      platform: DESKTOP_PLATFORM,
      user_id: DESKTOP_USER_ID,
      response_route_id: responseRouteId,
      conversation_id: sessionId,
      conversation_type: "1",
      is_group: false,
      sender_nick: "Desktop",
      source,
      extra_data: { platform: DESKTOP_PLATFORM },
    });

    const createdAtMs = this.now();
    const createdAt = Math.trunc(createdAtMs / 1_000);
    const userContentBlocks: JsonObject[] = [];
    for (const attachment of attachments) {
      userContentBlocks.push({
        type: "local_file",
        attachment_id: attachment.attachment_id,
        turn_id: turnId,
        path: attachment.path,
        name: attachment.name,
        size_bytes: attachment.size_bytes,
        media_type: attachment.media_type,
        ts: createdAt,
      });
      if (attachment.image_block) userContentBlocks.push(attachment.image_block);
    }
    if (text) userContentBlocks.push({ type: "text", text });
    const job: AgentJob = {
      job_id: turnId,
      session_id: sessionId,
      session_key: `agent:main:desktop:session:${sessionId}`,
      response_route_id: responseRouteId,
      user_id: DESKTOP_USER_ID,
      conversation_id: sessionId,
      is_group: false,
      message_id: messageId,
      user_input: text,
      job_kind: "turn",
      sender_nick: "Desktop",
      workspace: session.workspace,
      source,
      raw_data: { origin: DESKTOP_PLATFORM },
      user_content_blocks: userContentBlocks,
      diagnostics: [],
    };
    const activity = this.sessionActivity(sessionId);
    this.clearLatest(activity);
    const turn: InternalTurn = {
      sessionId,
      responseRouteId,
      payload: {
        turn_id: turnId,
        message_id: messageId,
        text,
        ...(attachments.length > 0 ? { attachments: attachments.map(publicAttachment) } : {}),
        state: "queued",
        created_at: createdAtMs,
        started_at: 0,
        user_persisted_at: 0,
        settled_at: 0,
      },
    };
    this.turns.set(turnId, turn);
    activity.queuedTurnIds.push(turnId);
    this.options.runtimeState.resumeAutonomy(sessionId);
    try {
      await this.options.scheduler.enqueue(job);
    } catch (error) {
      this.removeTurn(sessionId, turnId);
      throw error;
    }
    return {
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      created,
      state: turn.payload.state === "running" ? "running" : "queued",
    };
  }

  async stop(sessionIdInput: string): Promise<DesktopConversationStopPayload> {
    const sessionId = clean(sessionIdInput);
    const activity = this.sessions.get(sessionId);
    const localTurnIds = new Set([
      ...(activity?.activeTurnId ? [activity.activeTurnId] : []),
      ...(activity?.queuedTurnIds ?? []),
    ]);
    const cleared = this.options.scheduler.clearPendingMatching(
      sessionId,
      (job) => localTurnIds.has(clean(job.job_id)),
    );
    const activeTurnId = activity?.activeTurnId;
    let stoppedTurnId: string | null = null;
    if (activeTurnId && this.options.scheduler.activeRun(sessionId)?.jobId === activeTurnId) {
      const turn = this.turns.get(activeTurnId);
      if (turn) turn.payload.state = "stopping";
      this.publish(sessionId);
      try {
        if (await this.options.scheduler.requestStop(sessionId, activeTurnId)) {
          stoppedTurnId = activeTurnId;
          this.options.runtimeState.suspendAutonomy(sessionId);
          try {
            await this.options.storage.appendPendingEvent(sessionId, {
              event_id: this.id(),
              job_id: `desktop-stop-${this.id().slice(0, 8)}`,
              created_at: Math.trunc(Date.now() / 1_000),
              text: "用户已从桌面停止当前任务。之前未完成的计划已作废，不要继续执行或重试，除非用户重新明确要求。",
              response_route_id: turn?.responseRouteId ?? "",
            });
          } catch (error) {
            // The advisory context write must not undo a successful cancel.
            this.logger.warn("stop_pending_event_failed", { session_id: sessionId, error });
          }
        } else if (turn && this.sessions.get(sessionId)?.activeTurnId === activeTurnId) {
          turn.payload.state = "running";
          this.publish(sessionId);
        }
      } catch (error) {
        if (turn && this.sessions.get(sessionId)?.activeTurnId === activeTurnId) {
          turn.payload.state = "running";
        }
        this.publish(sessionId);
        throw error;
      }
    }
    return {
      session_id: sessionId,
      stopped_turn_id: stoppedTurnId,
      cleared_turn_ids: cleared.map((job) => job.job_id),
    };
  }

  activity(sessionIdInput: string): DesktopConversationActivityPayload {
    const sessionId = clean(sessionIdInput);
    const activity = this.sessions.get(sessionId);
    return {
      session_id: sessionId,
      active: this.publicTurn(activity?.activeTurnId),
      queued: (activity?.queuedTurnIds ?? [])
        .map((turnId) => this.publicTurn(turnId))
        .filter((turn): turn is DesktopConversationTurnPayload => Boolean(turn)),
      latest: this.publicTurn(activity?.latestTurnId),
    };
  }

  handleSchedulerEvent(event: SchedulerJobStateEvent): void {
    const turnId = clean(event.job.job_id);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const sessionId = clean(event.job.session_id);
    const activity = this.sessionActivity(sessionId);
    if (event.state === "queued") {
      turn.payload.state = "queued";
    } else if (event.state === "running") {
      activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
      activity.activeTurnId = turnId;
      turn.payload.state = "running";
      if (turn.payload.started_at <= 0) {
        turn.payload.started_at = Math.max(1, Math.trunc(this.now()));
      }
    } else {
      activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
      if (activity.activeTurnId === turnId) activity.activeTurnId = undefined;
      turn.payload.state = event.state === "cleared" ? "cancelled" : event.state;
      turn.payload.settled_at = this.now();
      if (activity.latestTurnId && activity.latestTurnId !== turnId) {
        const previous = this.turns.get(activity.latestTurnId);
        this.turns.delete(activity.latestTurnId);
        if (previous) this.forgetTurnCompletions(previous.sessionId, activity.latestTurnId);
      }
      activity.latestTurnId = turnId;
    }
    this.publish(sessionId);
  }

  handleAgentEvent(event: AgentEvent): void {
    if (event.type === "background_task.changed") {
      const turn = this.turns.get(clean(event.turn_id));
      if (!turn || turn.sessionId !== clean(event.thread_id)) return;
      this.backgroundCompletions.set(backgroundCompletionKey(event), event);
      if (this.applyBackgroundCompletions(turn)) {
        this.publish(event.thread_id);
      }
      return;
    }
    if (event.type !== "session.changed" || !event.payload.changes.includes("messages")) return;
    const activity = this.sessions.get(clean(event.thread_id));
    const turn = activity?.activeTurnId ? this.turns.get(activity.activeTurnId) : undefined;
    if (!turn || turn.payload.user_persisted_at > 0) return;
    turn.payload.user_persisted_at = this.now();
    this.publish(event.thread_id);
  }

  handleOutbound(request: OutboundRequest): void {
    const turn = this.turns.get(clean(request.turn_id));
    if (!turn) return;
    if (request.action === "send_file") {
      // Files are rendered from durable transcript artifacts. The desktop
      // adapter still acknowledges the outbound action, but never forwards a
      // local path into Renderer-owned activity state.
      return;
    }
    if (request.action === "stream_message") {
      const stream = sanitizeStream(request.payload);
      if (!stream || (turn.payload.stream && stream.seq <= turn.payload.stream.seq)) return;
      turn.payload.stream = stream;
    } else if (request.action === "send_message") {
      const markdown = clean(request.payload.markdown);
      if (!markdown) return;
      turn.payload.stream = fallbackStream(markdown, (turn.payload.stream?.seq ?? 0) + 1);
    } else {
      return;
    }
    this.applyBackgroundCompletions(turn);
    this.publish(request.session_id);
  }

  handleStreamBatch(request: DesktopStreamBatchRequest): boolean {
    const turn = this.turns.get(clean(request.turn_id));
    if (!turn || turn.responseRouteId !== clean(request.response_route_id)) return false;
    const sessionId = clean(request.session_id);
    const emitId = clean(request.emit_id);
    const currentSequence = turn.payload.stream?.seq ?? 0;
    if (!sessionId || sessionId !== turn.sessionId || !emitId ||
      (turn.streamEmitId && turn.streamEmitId !== emitId) ||
      request.seq !== currentSequence + 1) return false;

    const previous = turn.payload.stream;
    const parts = previous?.process_parts.map(cloneProcessPart) ?? [];
    const indexes = new Map(parts.map((part, index) => [part.part_id, index]));
    let state: DesktopConversationStreamPayload["state"] = previous?.state ?? "delta";
    let metrics = previous?.display_metrics ? { ...previous.display_metrics } : undefined;
    for (const mutation of request.mutations) {
      if (mutation.kind === "part_delta") {
        const index = indexes.get(clean(mutation.part_id));
        const part = index === undefined ? undefined : parts[index];
        if (!part || (part.type !== "thinking" && part.type !== "text") || !mutation.delta) return false;
        part.text += mutation.delta;
        continue;
      }
      if (mutation.kind === "stream_updated") {
        state = mutation.state;
        metrics = { ...mutation.display_metrics };
        continue;
      }
      const incoming = cloneProcessPart(mutation.part);
      const index = indexes.get(incoming.part_id);
      if (index === undefined) {
        const previousPart = parts.at(-1);
        if (previousPart && incoming.sequence <= previousPart.sequence) return false;
        indexes.set(incoming.part_id, parts.length);
        parts.push(incoming);
        continue;
      }
      const current = parts[index];
      if (!current || current.type !== incoming.type || current.sequence !== incoming.sequence) return false;
      parts[index] = incoming;
    }
    if (!metrics) return false;
    const toolSteps = parts
      .filter((part): part is Extract<TurnProcessPart, { type: "tool" }> => part.type === "tool")
      .map((part) => cloneToolStep(part.tool_step));
    turn.payload.stream = {
      seq: request.seq,
      state,
      content: parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
      thinking: parts.filter((part) => part.type === "thinking").map((part) => part.text).join(""),
      redacted_thinking_count: parts
        .filter((part): part is Extract<TurnProcessPart, { type: "thinking" }> => part.type === "thinking")
        .reduce((total, part) => total + part.redacted_count, 0),
      thinking_elapsed_ms: previous?.thinking_elapsed_ms ?? 0,
      tool_pending: false,
      tool_elapsed_ms: toolSteps.reduce((total, step) => total + step.duration_ms, 0),
      tool_steps: toolSteps,
      process_parts: parts,
      display_metrics: metrics,
    };
    turn.streamEmitId = emitId;
    const completionChanged = this.applyBackgroundCompletions(turn);
    this.options.onStreamBatch?.({
      session_id: sessionId,
      turn_id: request.turn_id,
      emit_id: request.emit_id,
      seq: request.seq,
      mutations: request.mutations.map(cloneStreamMutation),
    });
    if (completionChanged) this.publish(sessionId);
    return true;
  }

  dispose(): void {
    this.sessions.clear();
    this.turns.clear();
    this.backgroundCompletions.clear();
  }

  forgetSession(sessionId: string): void {
    const safe = clean(sessionId);
    const activity = this.sessions.get(safe);
    for (const turnId of [
      ...(activity?.activeTurnId ? [activity.activeTurnId] : []),
      ...(activity?.queuedTurnIds ?? []),
      ...(activity?.latestTurnId ? [activity.latestTurnId] : []),
    ]) {
      this.turns.delete(turnId);
      this.forgetTurnCompletions(safe, turnId);
    }
    this.sessions.delete(safe);
  }

  private desktopSource(sessionId: string): JsonObject {
    return {
      platform: DESKTOP_PLATFORM,
      chat_id: sessionId,
      chat_type: "dm",
      user_id: DESKTOP_USER_ID,
      user_name: "Desktop",
    };
  }

  private sessionActivity(sessionId: string): InternalActivity {
    let activity = this.sessions.get(sessionId);
    if (!activity) {
      activity = {
        activeTurnId: undefined,
        queuedTurnIds: [],
        latestTurnId: undefined,
      };
      this.sessions.set(sessionId, activity);
    }
    return activity;
  }

  private publicTurn(turnId: string | undefined): DesktopConversationTurnPayload | null {
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn) return null;
    return {
      ...turn.payload,
      ...(turn.payload.stream ? {
        stream: {
          ...turn.payload.stream,
          tool_steps: turn.payload.stream.tool_steps.map(cloneToolStep),
          process_parts: turn.payload.stream.process_parts.map((part) => part.type === "tool"
            ? { ...part, tool_step: cloneToolStep(part.tool_step) }
            : { ...part }),
          display_metrics: { ...turn.payload.stream.display_metrics },
        },
      } : {}),
      ...(turn.payload.attachments ? {
        attachments: turn.payload.attachments.map((attachment) => ({ ...attachment })),
      } : {}),
    };
  }

  private publish(sessionIdInput: string): void {
    const sessionId = clean(sessionIdInput);
    if (sessionId) this.options.onActivity?.(this.activity(sessionId));
  }

  private removeTurn(sessionId: string, turnId: string): void {
    this.turns.delete(turnId);
    this.forgetTurnCompletions(sessionId, turnId);
    const activity = this.sessions.get(sessionId);
    if (!activity) return;
    activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
    if (activity.activeTurnId === turnId) activity.activeTurnId = undefined;
    if (activity.latestTurnId === turnId) activity.latestTurnId = undefined;
  }

  private clearLatest(activity: InternalActivity): void {
    if (activity.latestTurnId) {
      const turn = this.turns.get(activity.latestTurnId);
      this.turns.delete(activity.latestTurnId);
      if (turn) this.forgetTurnCompletions(turn.sessionId, activity.latestTurnId);
    }
    activity.latestTurnId = undefined;
  }

  private applyBackgroundCompletions(turn: InternalTurn): boolean {
    const stream = turn.payload.stream;
    if (!stream) return false;
    let changed = false;
    for (const event of this.backgroundCompletions.values()) {
      if (clean(event.thread_id) !== turn.sessionId || clean(event.turn_id) !== turn.payload.turn_id) continue;
      const displayStatus: ToolStep["status"] = event.payload.task.status === "completed" ? "success" : "error";
      const content = [
        `status: ${event.payload.task.status}`,
        `exec_id: ${event.payload.task.exec_id}`,
        event.payload.task.exit_code === null ? "" : `exit_code: ${event.payload.task.exit_code}`,
        `duration_sec: ${event.payload.task.duration_sec}`,
        event.payload.task.output_tail ? `output:\n${event.payload.task.output_tail}` : "output: (no output)",
      ].filter(Boolean).join("\n").slice(0, 4_000);
      const update = (step: ToolStep): boolean => {
        if (step.id !== event.payload.tool_call_id) return false;
        const durationMs = Math.max(step.duration_ms, Math.trunc(event.payload.task.duration_sec * 1_000));
        const currentBlock = displayStatus === "success" ? step.result_block : step.error_block;
        if (step.status === displayStatus && step.duration_ms === durationMs && currentBlock?.content === content) {
          return false;
        }
        step.status = displayStatus;
        step.duration_ms = durationMs;
        delete step.result_block;
        delete step.error_block;
        const block: ToolDisplayBlock = { language: "text", content };
        if (displayStatus === "success") step.result_block = block;
        else step.error_block = block;
        return true;
      };
      for (const step of stream.tool_steps) changed = update(step) || changed;
      for (const part of stream.process_parts) {
        if (part.type === "tool") changed = update(part.tool_step) || changed;
      }
    }
    return changed;
  }

  private forgetTurnCompletions(sessionId: string, turnId: string): void {
    const prefix = `${sessionId}\u0000${turnId}\u0000`;
    for (const key of this.backgroundCompletions.keys()) {
      if (key.startsWith(prefix)) this.backgroundCompletions.delete(key);
    }
  }
}

function backgroundCompletionKey(event: BackgroundTaskChangedEvent): string {
  return `${clean(event.thread_id)}\u0000${clean(event.turn_id)}\u0000${event.payload.tool_call_id}`;
}

function publicAttachment(attachment: LocalConversationAttachment): DesktopInputAttachmentPayload {
  return {
    attachment_id: attachment.attachment_id,
    name: attachment.name,
    size_bytes: attachment.size_bytes,
    media_type: attachment.media_type,
  };
}

function sanitizeStream(payload: JsonObject): DesktopConversationStreamPayload | undefined {
  const state = clean(payload.state);
  if (state !== "delta" && state !== "final" && state !== "error") return undefined;
  const seq = integer(payload.seq);
  if (seq < 1) return undefined;
  const metrics = sanitizeMetrics(payload.display_metrics);
  if (!metrics) return undefined;
  const processParts = sanitizeProcessParts(payload.process_parts);
  if (!processParts) return undefined;
  return {
    seq,
    state,
    content: String(payload.content ?? ""),
    thinking: String(payload.thinking ?? ""),
    redacted_thinking_count: integer(payload.redacted_thinking_count),
    thinking_elapsed_ms: integer(payload.thinking_elapsed_ms),
    tool_pending: payload.tool_pending === true,
    tool_elapsed_ms: integer(payload.tool_elapsed_ms),
    tool_steps: Array.isArray(payload.tool_steps)
      ? payload.tool_steps.map(sanitizeToolStep).filter((step): step is ToolStep => Boolean(step))
      : [],
    process_parts: processParts,
    display_metrics: metrics,
  };
}

function cloneProcessPart(part: TurnProcessPart): TurnProcessPart {
  return part.type === "tool"
    ? { ...part, tool_step: cloneToolStep(part.tool_step) }
    : { ...part };
}

function cloneStreamMutation(
  mutation: DesktopStreamBatchRequest["mutations"][number],
): DesktopConversationStreamBatch["mutations"][number] {
  if (mutation.kind === "part_updated") return { ...mutation, part: cloneProcessPart(mutation.part) };
  if (mutation.kind === "stream_updated") {
    return { ...mutation, display_metrics: { ...mutation.display_metrics } };
  }
  return { ...mutation };
}

function sanitizeProcessParts(value: unknown): TurnProcessPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TurnProcessPart[] = [];
  const ids = new Set<string>();
  let lastSequence = 0;
  for (const valuePart of value) {
    const part = record(valuePart);
    if (!part) return undefined;
    const type = clean(part.type);
    const partId = clean(part.part_id);
    const sequence = Math.trunc(Number(part.sequence));
    if (!partId || ids.has(partId) || !Number.isSafeInteger(sequence) || sequence <= lastSequence) return undefined;
    ids.add(partId);
    lastSequence = sequence;
    if (type === "thinking") {
      const status = clean(part.status);
      if (status !== "streaming" && status !== "completed" && status !== "error") return undefined;
      const redactedCount = Math.trunc(Number(part.redacted_count));
      if (!Number.isSafeInteger(redactedCount) || redactedCount < 0) return undefined;
      result.push({
        type,
        part_id: partId,
        sequence,
        status,
        text: String(part.text ?? ""),
        redacted_count: redactedCount,
      });
      continue;
    }
    if (type === "text") {
      const status = clean(part.status);
      const presentation = clean(part.presentation);
      if ((status !== "streaming" && status !== "completed" && status !== "error") ||
        (presentation !== "process" && presentation !== "final")) return undefined;
      result.push({
        type,
        part_id: partId,
        sequence,
        status,
        presentation,
        text: String(part.text ?? ""),
      });
      continue;
    }
    if (type === "tool") {
      const toolStep = sanitizeToolStep(part.tool_step);
      if (!toolStep) return undefined;
      result.push({ type, part_id: partId, sequence, tool_step: toolStep });
      continue;
    }
    return undefined;
  }
  return result;
}

function sanitizeToolStep(value: unknown): ToolStep | undefined {
  const step = record(value);
  if (!step) return undefined;
  const status = clean(step.status);
  const name = clean(step.name);
  const title = clean(step.title);
  const iconToken = clean(step.icon_token);
  if (!name || !title || !iconToken || (status !== "running" && status !== "success" && status !== "error")) {
    return undefined;
  }
  const resultBlock = sanitizeToolDisplayBlock(step.result_block);
  const errorBlock = sanitizeToolDisplayBlock(step.error_block);
  return {
    id: clean(step.id),
    name,
    title,
    // Paths reach the desktop window intact. Shortening them here hid the
    // reader's own filesystem from them, made a path read one way live and
    // another in history, and rewrote paths inside real error text.
    detail: String(step.detail ?? ""),
    icon_token: iconToken,
    status,
    duration_ms: integer(step.duration_ms),
    ...(resultBlock ? { result_block: resultBlock } : {}),
    ...(errorBlock ? { error_block: errorBlock } : {}),
  };
}

function sanitizeToolDisplayBlock(value: unknown): ToolDisplayBlock | undefined {
  const block = record(value);
  if (!block) return undefined;
  const language = clean(block.language);
  if (language !== "json" && language !== "text") return undefined;
  return { language, content: String(block.content ?? "") };
}

function cloneToolStep(step: ToolStep): ToolStep {
  return {
    ...step,
    ...(step.result_block ? { result_block: { ...step.result_block } } : {}),
    ...(step.error_block ? { error_block: { ...step.error_block } } : {}),
  };
}

function sanitizeMetrics(value: unknown): DisplayMetrics | undefined {
  const metrics = record(value);
  if (!metrics) return undefined;
  const status = clean(metrics.status);
  if (status !== "running" && status !== "completed" && status !== "error" && status !== "cancelled") {
    return undefined;
  }
  const phase = clean(metrics.phase) as TurnDisplayPhase;
  if (phase !== "preparing_context" && phase !== "waiting_model" && phase !== "thinking"
    && phase !== "running_tool" && phase !== "generating_answer") return undefined;
  return {
    status,
    phase,
    elapsed_ms: integer(metrics.elapsed_ms),
    model: String(metrics.model ?? ""),
    input_tokens: integer(metrics.input_tokens),
    output_tokens: integer(metrics.output_tokens),
    cache_read_input_tokens: integer(metrics.cache_read_input_tokens),
    cache_creation_input_tokens: integer(metrics.cache_creation_input_tokens),
    context_tokens: integer(metrics.context_tokens),
    context_window_tokens: integer(metrics.context_window_tokens),
  };
}

function fallbackStream(content: string, seq: number): DesktopConversationStreamPayload {
  return {
    seq,
    state: "final",
    content,
    thinking: "",
    redacted_thinking_count: 0,
    thinking_elapsed_ms: 0,
    tool_pending: false,
    tool_elapsed_ms: 0,
    tool_steps: [],
    process_parts: content ? [{
      type: "text",
      part_id: randomUUID(),
      sequence: 1,
      status: "completed",
      presentation: "final",
      text: content,
    }] : [],
    display_metrics: {
      status: "completed",
      phase: "generating_answer",
      elapsed_ms: 0,
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      context_tokens: 0,
      context_window_tokens: 0,
    },
  };
}
