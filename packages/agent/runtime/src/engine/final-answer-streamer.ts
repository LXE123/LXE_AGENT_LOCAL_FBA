import { randomUUID } from "node:crypto";
import type {
  DesktopStreamBatchRequest,
  DesktopStreamMutation,
  DisplayMetrics,
  EmitRequest,
  ToolStep,
  TurnDisplayPhase,
  TurnProcessPart,
} from "@lxe/protocol";
import { buildToolDisplayStep } from "../tooling/tool-display";
import type { AssistantMessageEvent, ToolCallBlock } from "./types";

interface StreamSnapshot {
  content: string;
  thinking: string;
  redactedThinkingCount: number;
  thinkingElapsedMs: number;
  toolPending: boolean;
  toolElapsedMs: number;
  toolSteps: ToolStep[];
  processParts: TurnProcessPart[];
  displayMetrics: DisplayMetrics;
}

export interface FinalAnswerStreamerOptions {
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  emit(request: EmitRequest): Promise<boolean>;
  emitDesktopBatch?(request: DesktopStreamBatchRequest): Promise<boolean>;
  emitId?: string;
  minIntervalMs?: number;
  desktopBatchIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  model?: string;
  contextWindowTokens?: number;
  toolUseMode?: "off" | "on" | "full";
  showFullPaths?: boolean;
}

const cloneStep = (step: ToolStep): ToolStep => ({
  ...step,
  ...(step.result_block ? { result_block: { ...step.result_block } } : {}),
  ...(step.error_block ? { error_block: { ...step.error_block } } : {}),
});
const cloneSteps = (steps: ToolStep[]): ToolStep[] => steps.map(cloneStep);
const cloneProcessParts = (parts: TurnProcessPart[]): TurnProcessPart[] => parts.map((part) =>
  part.type === "tool"
    ? { ...part, tool_step: cloneStep(part.tool_step) }
    : { ...part });

export class FinalAnswerStreamer {
  private readonly emitId: string;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly desktopBatchIntervalMs: number;
  private content = "";
  private thinking = "";
  private redactedThinkingCount = 0;
  private thinkingStartedAt = 0;
  private thinkingElapsedMs = 0;
  private toolPending = false;
  private readonly activeToolStartedAt = new Map<string, number>();
  private toolElapsedMs = 0;
  private toolSteps: ToolStep[] = [];
  private readonly detachedToolIds = new Set<string>();
  private processParts: TurnProcessPart[] = [];
  private readonly processPartIndexes = new Map<string, number>();
  private readonly toolPartIds = new Map<string, string>();
  private activeTextPartId = "";
  private activeThinkingPartId = "";
  private generationPartIds: string[] = [];
  private lastSent = "";
  private lastSentContent = "";
  private sequence = 0;
  private lastAttemptAt = 0;
  private delivered = false;
  private deltaFailed = false;
  private terminal = false;
  private pending: Promise<void> | undefined;
  private batchDirty = false;
  private queuedMutations: DesktopStreamMutation[] = [];
  private readonly startedAt: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private terminalUsageDirty = false;
  private contextTokens = 0;
  private contextSource?: "estimated" | "usage_calibrated";
  private displayStatus: DisplayMetrics["status"] = "running";
  private displayPhase: TurnDisplayPhase = "preparing_context";

  constructor(private readonly options: FinalAnswerStreamerOptions) {
    this.emitId = String(options.emitId ?? "").trim() || randomUUID().replaceAll("-", "");
    this.minIntervalMs = Math.max(0, Math.trunc(options.minIntervalMs ?? 150));
    this.desktopBatchIntervalMs = Math.max(0, Math.trunc(options.desktopBatchIntervalMs ?? 16));
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.startedAt = this.now();
  }

  async pushEvent(event: AssistantMessageEvent): Promise<void> {
    if (this.terminal) return;
    if (event.type === "start") {
      await this.startWaitingModel();
      this.content = "";
      return;
    }
    if (event.type === "error") {
      for (const id of this.generationPartIds) {
        const part = this.processPart(id);
        if (part && part.type !== "tool") {
          part.status = "error";
          this.queuePartUpdated(part);
        }
      }
      this.activeTextPartId = "";
      this.activeThinkingPartId = "";
      this.scheduleDelta();
      return;
    }
    if (event.type === "done") {
      for (const [index, block] of event.message.content.entries()) {
        if (block.type === "text" || block.type === "thinking") {
          this.reconcilePart(block.type, `${event.message.id}:${index}`, block.type === "text" ? block.text : block.thinking);
        }
      }
      return;
    }
    const id = `${event.partial.id}:${event.contentIndex}`;
    switch (event.type) {
      case "text_start": this.startPart("text", id); return;
      case "thinking_start": {
        this.startPart("thinking", id);
        if (event.partial.content[event.contentIndex]?.redacted === true) {
          const part = this.processPart(id);
          if (part?.type === "thinking" && !part.redacted_count) {
            part.redacted_count = 1;
            this.redactedThinkingCount += 1;
            this.queuePartUpdated(part);
          }
        }
        return;
      }
      case "text_delta":
        this.appendPartText("text", id, event.delta);
        return this.pushDelta({ text: event.delta });
      case "thinking_delta":
        this.appendPartText("thinking", id, event.delta);
        return this.pushDelta({ thinking: event.delta });
      case "text_end": this.reconcilePart("text", id, event.content); return;
      case "thinking_end": this.reconcilePart("thinking", id, event.content); return;
      case "toolcall_start": case "toolcall_delta": case "toolcall_end": return;
    }
  }

  private reconcilePart(kind: "text" | "thinking", id: string, full: string): void {
    this.startPart(kind, id);
    const part = this.processPart(id);
    if (!part || part.type !== kind) return;
    part.text = full;
    this.endPart(kind, id);
    this.content = this.generationPartIds.map((key) => this.processPart(key))
      .filter((p) => p?.type === "text").map((p) => p && "text" in p ? p.text : "").join("");
    this.thinking = this.processParts.filter((p) => p.type === "thinking")
      .map((p) => p.type === "thinking" ? p.text : "").join("");
  }

  async updateContext(measurement: import("./context-meter").ContextMeasurement): Promise<void> {
    if (this.deltaFailed || (!this.terminalUsageDirty && this.contextTokens === measurement.tokens && this.contextSource === measurement.source)) return;
    this.contextTokens = measurement.tokens;
    this.contextSource = measurement.source;
    this.terminalUsageDirty = false;
    if (this.terminal) {
      await this.pending;
      await this.emitFrame(this.displayStatus === "error" ? "error" : "final");
    } else this.scheduleDelta();
  }

  updateUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    const input = Math.max(0, Math.trunc(usage.input_tokens ?? 0));
    const cacheRead = Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
    const cacheCreation = Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
    if (this.terminal) this.terminalUsageDirty = true;
    this.inputTokens += input;
    this.outputTokens += Math.max(0, Math.trunc(usage.output_tokens ?? 0));
    this.cacheReadInputTokens += cacheRead;
    this.cacheCreationInputTokens += cacheCreation;

    // Legacy cumulative channels historically pick usage up with the next
    // content/lifecycle frame. Only Desktop needs a metrics-only mutation.
    if (this.options.emitDesktopBatch) this.scheduleDelta();
  }

  async pushDelta(delta: { text?: string; thinking?: string }): Promise<void> {
    if (this.terminal) return;
    const text = String(delta.text ?? "");
    const thinking = String(delta.thinking ?? "");
    if (text) this.displayPhase = "generating_answer";
    else if (thinking) this.displayPhase = "thinking";
    if (thinking && !this.content && !this.thinkingStartedAt) this.thinkingStartedAt = this.now();
    if (text && this.thinkingStartedAt && !this.thinkingElapsedMs) {
      this.thinkingElapsedMs = Math.max(0, this.now() - this.thinkingStartedAt);
    }
    this.content += text;
    this.thinking += thinking;
    this.scheduleDelta();
  }

  async startPreparingContext(): Promise<void> {
    this.setDisplayPhase("preparing_context");
  }

  async startWaitingModel(): Promise<void> {
    this.completeOpenParts();
    this.generationPartIds = [];
    this.setDisplayPhase("waiting_model");
  }

  completeModelResponse(content: string, terminal: boolean): void {
    if (this.terminal) return;
    this.completeOpenParts();
    const textParts = this.generationPartIds
      .map((partId) => this.processPart(partId))
      .filter((part): part is Extract<TurnProcessPart, { type: "text" }> => part?.type === "text");
    const canonical = String(content ?? "");
    if (canonical && textParts.length === 0) {
      const partId = randomUUID();
      this.addPart({
        type: "text",
        part_id: partId,
        sequence: this.processParts.length + 1,
        status: "completed",
        presentation: terminal ? "final" : "process",
        text: canonical,
      });
      this.generationPartIds.push(partId);
    } else if (terminal) {
      for (const part of textParts) {
        part.presentation = "final";
        this.queuePartUpdated(part);
      }
    }
    this.scheduleDelta();
  }

  async startToolPending(): Promise<void> {
    if (this.terminal || this.toolSteps.length > 0 || this.options.toolUseMode === "off") return;
    this.toolPending = true;
    this.scheduleDelta();
  }

  async pushToolStart(call: ToolCallBlock): Promise<void> {
    if (this.terminal || this.options.toolUseMode === "off") return;
    this.displayPhase = "running_tool";
    this.activeToolStartedAt.set(call.id, this.now());
    this.toolPending = false;
    // Same path treatment as the finished step, or the path visibly changes
    // under the reader the moment the call completes.
    const step = buildToolDisplayStep(call.id, call.name, call.arguments, "running", 0, {
      ...(this.options.showFullPaths === undefined ? {} : { showFullPaths: this.options.showFullPaths }),
    });
    this.upsertTool(step);
    const partId = `tool:${call.id}`;
    this.toolPartIds.set(call.id, partId);
    this.addPart({
      type: "tool",
      part_id: partId,
      sequence: this.processParts.length + 1,
      tool_step: { ...step },
    });
    this.scheduleDelta();
  }

  async pushToolFinish(
    call: ToolCallBlock,
    status: ToolStep["status"],
    durationMs: number,
    output?: { result?: unknown; error?: unknown },
  ): Promise<void> {
    if (this.terminal || this.options.toolUseMode === "off") return;
    this.toolPending = false;
    this.toolElapsedMs += Math.max(0, Math.trunc(durationMs));
    this.activeToolStartedAt.delete(call.id);
    if (status === "running") this.detachedToolIds.add(call.id);
    else this.detachedToolIds.delete(call.id);
    const step = buildToolDisplayStep(call.id, call.name, call.arguments, status, durationMs, {
      ...(this.options.showFullPaths === undefined ? {} : { showFullPaths: this.options.showFullPaths }),
      showResultDetails: this.options.toolUseMode === "full",
      result: output?.result,
      error: output?.error,
    });
    this.upsertTool(step);
    const part = this.processPart(this.toolPartIds.get(call.id) ?? "");
    if (part?.type === "tool") {
      part.tool_step = { ...step };
      this.queuePartUpdated(part);
    }
    this.scheduleDelta();
  }

  async finish(content: string): Promise<boolean> {
    const finalContent = String(content ?? "").trim();
    this.completeModelResponse(finalContent, true);
    if (finalContent) {
      this.displayPhase = "generating_answer";
      if (finalContent.length >= this.content.length) this.content = finalContent;
    }
    this.displayStatus = "completed";
    return this.close("final");
  }

  async fail(content: string): Promise<boolean> {
    if (!this.content) this.content = String(content ?? "").trim();
    this.displayStatus = "error";
    return this.close("error");
  }

  async cancel(): Promise<boolean> {
    this.completeOpenParts();
    this.displayStatus = "cancelled";
    if (!this.options.emitDesktopBatch) {
      this.terminal = true;
      await this.pending;
      if (!this.delivered) return false;
      this.content = this.lastSentContent;
      return this.emitFrame("final");
    }
    return this.close("final");
  }

  private async close(state: "final" | "error"): Promise<boolean> {
    this.completeOpenParts();
    this.terminal = true;
    this.finishTimers();
    this.finalizeRunningTools();
    await this.pending;
    if (this.options.emitDesktopBatch) {
      if (!this.deltaFailed && (this.batchDirty || this.queuedMutations.length > 0)) {
        await this.emitDesktopBatch(state);
      }
    } else if (!this.deltaFailed && this.snapshotKey() !== this.lastSent) {
      await this.emitFrame("delta");
    }
    if (!this.options.emitDesktopBatch && this.deltaFailed && !this.delivered) return false;
    return this.emitFrame(state);
  }

  private scheduleDelta(): void {
    if (this.terminal || this.deltaFailed) return;
    if (this.options.emitDesktopBatch) {
      this.batchDirty = true;
      this.scheduleDesktopBatch();
      return;
    }
    if (this.pending || this.snapshotKey() === this.lastSent) return;
    const elapsed = this.lastAttemptAt ? this.now() - this.lastAttemptAt : this.minIntervalMs;
    const waitMs = Math.max(0, this.minIntervalMs - elapsed);
    this.pending = (async () => {
      if (waitMs > 0) await this.delay(waitMs);
      if (!this.terminal && !this.deltaFailed && this.snapshotKey() !== this.lastSent) {
        await this.emitFrame("delta");
      }
    })().finally(() => {
      this.pending = undefined;
      if (!this.terminal && !this.deltaFailed && this.snapshotKey() !== this.lastSent) this.scheduleDelta();
    });
  }

  private scheduleDesktopBatch(): void {
    if (this.terminal || this.deltaFailed || this.pending || !this.batchDirty) return;
    const elapsed = this.lastAttemptAt ? this.now() - this.lastAttemptAt : 0;
    const waitMs = Math.max(0, this.desktopBatchIntervalMs - elapsed);
    this.pending = (async () => {
      if (waitMs > 0) await this.delay(waitMs);
      if (!this.terminal && !this.deltaFailed && this.batchDirty) await this.emitDesktopBatch("delta");
    })().finally(() => {
      this.pending = undefined;
      if (!this.terminal && !this.deltaFailed && this.batchDirty) this.scheduleDesktopBatch();
    });
  }

  private async emitDesktopBatch(state: "delta" | "final" | "error"): Promise<boolean> {
    const mutations = this.queuedMutations;
    this.queuedMutations = [];
    this.batchDirty = false;
    mutations.push({
      kind: "stream_updated",
      state,
      display_metrics: { ...this.snapshot().displayMetrics },
    });
    this.sequence += 1;
    this.lastAttemptAt = this.now();
    let ok = false;
    try {
      ok = await this.options.emitDesktopBatch?.({
        session_id: this.options.sessionId,
        turn_id: this.options.turnId,
        response_route_id: this.options.responseRouteId,
        emit_id: this.emitId,
        seq: this.sequence,
        mutations,
      }) ?? false;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.deltaFailed = true;
      return false;
    }
    this.delivered = true;
    return true;
  }

  private async emitFrame(state: "delta" | "final" | "error"): Promise<boolean> {
    const snapshot = this.snapshot();
    const key = JSON.stringify(snapshot);
    this.sequence += 1;
    this.lastAttemptAt = this.now();
    let ok = false;
    try {
      ok = await this.options.emit({
        session_id: this.options.sessionId,
        turn_id: this.options.turnId,
        response_route_id: this.options.responseRouteId,
        content: snapshot.content,
        thinking: snapshot.thinking,
        redacted_thinking_count: snapshot.redactedThinkingCount,
        thinking_elapsed_ms: snapshot.thinkingElapsedMs,
        tool_pending: snapshot.toolPending,
        tool_elapsed_ms: snapshot.toolElapsedMs,
        tool_steps: cloneSteps(snapshot.toolSteps),
        process_parts: cloneProcessParts(snapshot.processParts),
        files: [],
        emit_kind: "stream",
        emit_id: this.emitId,
        stream_type: "final_answer",
        state,
        seq: this.sequence,
        display_metrics: { ...snapshot.displayMetrics },
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      if (state === "delta") this.deltaFailed = true;
      return false;
    }
    this.delivered = true;
    this.lastSent = key;
    this.lastSentContent = snapshot.content;
    return true;
  }

  private snapshot(): StreamSnapshot {
    const now = this.now();
    const activeElapsed = [...this.activeToolStartedAt.values()]
      .reduce((total, startedAt) => total + Math.max(0, now - startedAt), 0);
    const elapsed = this.toolElapsedMs + activeElapsed;
    return {
      content: this.content,
      thinking: this.thinking,
      redactedThinkingCount: this.redactedThinkingCount,
      thinkingElapsedMs: Math.max(0, Math.trunc(this.thinkingElapsedMs)),
      toolPending: this.toolPending && this.toolSteps.length === 0,
      toolElapsedMs: Math.max(0, Math.trunc(elapsed)),
      toolSteps: cloneSteps(this.toolSteps),
      processParts: cloneProcessParts(this.processParts),
      displayMetrics: {
        status: this.displayStatus,
        phase: this.displayPhase,
        elapsed_ms: Math.max(0, Math.trunc(this.now() - this.startedAt)),
        model: String(this.options.model ?? ""),
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cache_read_input_tokens: this.cacheReadInputTokens,
        cache_creation_input_tokens: this.cacheCreationInputTokens,
        context_tokens: this.contextTokens,
        ...(this.contextSource ? { context_source: this.contextSource } : {}),
        context_window_tokens: Math.max(0, Math.trunc(this.options.contextWindowTokens ?? 0)),
      },
    };
  }

  private snapshotKey(): string {
    return JSON.stringify(this.snapshot());
  }

  private setDisplayPhase(phase: TurnDisplayPhase): void {
    if (this.terminal) return;
    this.displayPhase = phase;
    this.scheduleDelta();
  }

  private upsertTool(step: ToolStep): void {
    const index = this.toolSteps.findIndex((current) => current.id && current.id === step.id);
    if (index >= 0) this.toolSteps[index] = step;
    else this.toolSteps.push(step);
  }

  private startPart(type: "text" | "thinking", partIdInput: string): void {
    const partId = String(partIdInput ?? "").trim() || randomUUID();
    if (!this.processPart(partId)) {
      this.addPart(type === "text"
        ? {
            type: "text",
            part_id: partId,
            sequence: this.processParts.length + 1,
            status: "streaming",
            presentation: "process",
            text: "",
          }
        : {
            type: "thinking",
            part_id: partId,
            sequence: this.processParts.length + 1,
            status: "streaming",
            text: "",
            redacted_count: 0,
          });
      this.generationPartIds.push(partId);
    }
    if (type === "text") this.activeTextPartId = partId;
    else this.activeThinkingPartId = partId;
    this.scheduleDelta();
  }

  private appendPartText(type: "text" | "thinking", partId: string, value: string): void {
    this.startPart(type, partId);
    const part = this.processPart(partId);
    if (!part || part.type !== type) return;
    const delta = String(value ?? "");
    part.text += delta;
    if (delta) this.queuePartDelta(part.part_id, delta);
  }

  private endPart(type: "text" | "thinking", partId: string): void {
    const part = this.processPart(partId);
    if (part?.type === type) {
      part.status = "completed";
      this.queuePartUpdated(part);
    }
    if (type === "text" && this.activeTextPartId === partId) this.activeTextPartId = "";
    if (type === "thinking" && this.activeThinkingPartId === partId) this.activeThinkingPartId = "";
    this.scheduleDelta();
  }

  private completeOpenParts(): void {
    if (this.activeThinkingPartId) this.endPart("thinking", this.activeThinkingPartId);
    if (this.activeTextPartId) this.endPart("text", this.activeTextPartId);
  }

  private addPart(part: TurnProcessPart): void {
    if (this.processPartIndexes.has(part.part_id)) return;
    this.processPartIndexes.set(part.part_id, this.processParts.length);
    this.processParts.push(part);
    this.queuePartUpdated(part);
  }

  private processPart(partId: string): TurnProcessPart | undefined {
    const index = this.processPartIndexes.get(partId);
    return index === undefined ? undefined : this.processParts[index];
  }

  private finishTimers(): void {
    if (this.thinkingStartedAt && !this.thinkingElapsedMs) {
      this.thinkingElapsedMs = Math.max(0, this.now() - this.thinkingStartedAt);
    }
    if (this.activeToolStartedAt.size > 0) {
      const now = this.now();
      for (const [toolId, startedAt] of this.activeToolStartedAt) {
        const elapsed = Math.max(0, now - startedAt);
        this.toolElapsedMs += elapsed;
        const step = this.toolSteps.find((candidate) => candidate.id === toolId);
        if (step) step.duration_ms = Math.max(step.duration_ms, elapsed);
        const part = this.processPart(this.toolPartIds.get(toolId) ?? "");
        if (part?.type === "tool") part.tool_step.duration_ms = Math.max(part.tool_step.duration_ms, elapsed);
      }
      this.activeToolStartedAt.clear();
    }
    this.toolPending = false;
  }

  private finalizeRunningTools(): void {
    this.toolSteps = this.toolSteps.map((step) => step.status === "running" && !this.detachedToolIds.has(step.id)
      ? { ...step, status: "error" }
      : step);
    for (const part of this.processParts) {
      if (part.type === "tool" && part.tool_step.status === "running"
        && !this.detachedToolIds.has(part.tool_step.id)) {
        part.tool_step = {
          ...part.tool_step,
          status: "error",
        };
        this.queuePartUpdated(part);
      }
    }
  }

  private queuePartDelta(partId: string, delta: string): void {
    if (!this.options.emitDesktopBatch || !delta) return;
    const previous = this.queuedMutations.at(-1);
    if (previous?.kind === "part_delta" && previous.part_id === partId && previous.field === "text") {
      previous.delta += delta;
      return;
    }
    this.queuedMutations.push({ kind: "part_delta", part_id: partId, field: "text", delta });
  }

  private queuePartUpdated(part: TurnProcessPart): void {
    if (!this.options.emitDesktopBatch) return;
    const clone = cloneProcessParts([part])[0];
    if (!clone) return;
    const previous = this.queuedMutations.at(-1);
    if (previous?.kind === "part_updated" && previous.part.part_id === part.part_id) {
      previous.part = clone;
      return;
    }
    this.queuedMutations.push({ kind: "part_updated", part: clone });
  }
}
