import { randomUUID } from "node:crypto";
import { createLogger, type LlmProviderApiStyle } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import { sanitizeWireTraceValue } from "../providers/wire-trace";
import type {
  AssistantContent, AssistantMessage, AssistantMessageEvent, AssistantSuccessReason,
  AssistantToolCall, AssistantUsage, CompletedAssistantToolCall,
} from "./assistant-message";

const logger = createLogger("runtime.message");
export const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const string = (v: unknown): string => String(v ?? "");
export const parseArguments = (raw: string): JsonObject => {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new Error(`Invalid tool arguments: ${cause instanceof Error ? cause.message : String(cause)}; arguments=${raw}`, { cause }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Tool arguments must be a JSON object: ${raw}`);
  return parsed as JsonObject;
};
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const left = object(a), right = object(b);
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((k) => k in right && equal(left[k], right[k]));
};
export interface MessageOrigin { name: string; model: string; apiStyle: string; apiKey?: string }

export class AssistantMessageAccumulator {
  readonly message: AssistantMessage;
  private readonly ended = new Set<number>();
  private readonly arguments = new Map<number, string>();
  private readonly argumentErrors = new Map<number, unknown>();
  private terminal = false;
  private delivery = Promise.resolve();
  private consumerFailed = false;

  constructor(private readonly origin: MessageOrigin, private readonly onEvent?: (event: AssistantMessageEvent) => void | Promise<void>) {
    this.message = {
      id: randomUUID(), role: "assistant", timestamp: Date.now(), api: origin.apiStyle as LlmProviderApiStyle,
      provider: origin.name, model: origin.model, content: [],
      usage: { input_tokens: 0, output_tokens: 0, status: "unreported" }, stopReason: "pending",
    };
    this.emit({ type: "start", partial: this.message });
  }
  private active(): void { if (this.terminal) throw new Error("Assistant message is already terminal"); }
  private emit(event: AssistantMessageEvent): void {
    if (!this.onEvent) return;
    this.delivery = this.delivery.then(async () => {
      if (this.consumerFailed) return;
      try { await this.onEvent!(event); }
      catch (error) {
        this.consumerFailed = true;
        logger.warn("assistant_event_consumer_failed", { message_id: this.message.id, error: this.diagnostic(error) });
      }
    });
  }
  drain(): Promise<void> { return this.delivery; }
  block(index: number): AssistantContent {
    const block = this.message.content[index];
    if (!block) throw new Error(`Unknown assistant content index ${index}`);
    return block;
  }
  startText(): number { return this.add({ type: "text", text: "" }); }
  startThinking(metadata: { thinkingSignature?: string; redacted?: boolean } = {}): number {
    return this.add({ type: "thinking", thinking: "", ...metadata });
  }
  startTool(metadata: Omit<AssistantToolCall, "type" | "arguments">): number {
    return this.add({ ...metadata, type: "tool_call", id: string(metadata.id), name: string(metadata.name) });
  }
  private add(block: AssistantContent): number {
    this.active();
    const contentIndex = this.message.content.push(block) - 1;
    this.emit({ type: block.type === "tool_call" ? "toolcall_start" : `${block.type}_start`, contentIndex, partial: this.message });
    return contentIndex;
  }
  append(index: number, delta: string): void {
    this.active();
    if (this.ended.has(index)) throw new Error(`Delta after content end: ${index}`);
    if (!delta) return;
    const block = this.block(index);
    if (block.type === "text") block.text += delta;
    else if (block.type === "thinking") block.thinking += delta;
    else this.arguments.set(index, (this.arguments.get(index) ?? "") + delta);
    this.emit({ type: block.type === "tool_call" ? "toolcall_delta" : `${block.type}_delta`, contentIndex: index, delta, partial: this.message });
  }
  metadata(index: number, values: Partial<AssistantContent>): void {
    this.active();
    const block = this.block(index);
    // Only replay/identity metadata may arrive after body completion.
    for (const [key, value] of Object.entries(values)) {
      if (["textSignature", "thinkingSignature", "redacted", "providerItemId", "namespace", "thoughtSignature", "id", "name"].includes(key) && value !== undefined) {
        if (this.ended.has(index) && ["id", "name", "namespace", "providerItemId"].includes(key) && block[key] !== value) {
          throw new Error(`Conflicting completed content ${index} metadata: ${key}`);
        }
        block[key] = value as never;
      }
    }
  }
  identity(id: unknown, model?: unknown): void {
    this.active();
    if (id) {
      if (this.message.responseId && this.message.responseId !== string(id)) throw new Error("Conflicting provider response IDs");
      this.message.responseId = string(id);
    }
    if (model && model !== this.message.model) this.message.responseModel = string(model);
  }
  usage(usage: Partial<AssistantUsage>): void {
    this.active();
    this.message.usage = { ...this.message.usage, ...usage };
  }
  end(index: number, full?: string): void {
    this.active();
    const block = this.block(index);
    if (block.type === "tool_call") { this.endTool(index, full); return; }
    const old = block.type === "text" ? block.text : block.thinking;
    if (this.ended.has(index)) {
      if (full !== undefined && full !== old) throw new Error(`Conflicting completed ${block.type} content at ${index}`);
      return;
    }
    const content = full ?? old;
    if (block.type === "text") block.text = content;
    else block.thinking = content;
    this.ended.add(index);
    this.emit({ type: `${block.type}_end`, contentIndex: index, content, partial: this.message });
  }
  toolArguments(index: number, full: string): void {
    this.active();
    const block = this.block(index);
    if (block.type !== "tool_call") throw new Error(`Not a tool block: ${index}`);
    if (this.ended.has(index)) {
      if (!equal(block.arguments, parseArguments(full))) throw new Error(`Conflicting completed tool arguments at ${index}`);
      return;
    }
    this.arguments.set(index, full);
  }
  private endTool(index: number, full?: string): void {
    if (full !== undefined) this.toolArguments(index, full);
    if (this.ended.has(index)) return;
    const block = this.block(index) as AssistantToolCall;
    try {
      if (!block.id || !block.name) throw new Error(`Tool call ${index} ended without id or name`);
      block.arguments = parseArguments(this.arguments.get(index) ?? "{}");
    } catch (error) { this.argumentErrors.set(index, error); return; }
    this.argumentErrors.delete(index);
    this.ended.add(index);
    this.arguments.delete(index);
    this.emit({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block) as CompletedAssistantToolCall, partial: this.message });
  }
  complete(reason: AssistantSuccessReason, rawStopReason?: string): AssistantMessage {
    this.active();
    if (rawStopReason !== undefined) this.message.rawStopReason = rawStopReason;
    for (const [index] of this.message.content.entries()) this.end(index);
    if (reason !== "length" && this.argumentErrors.size) throw this.argumentErrors.values().next().value;
    if (reason === "length" && this.argumentErrors.size) {
      this.message.error = { message: this.diagnostic(this.argumentErrors.values().next().value) };
    }
    this.message.stopReason = reason;
    this.finish();
    this.emit({ type: "done", reason, message: this.message });
    return this.message;
  }
  fail(reason: "error" | "aborted", error: unknown): AssistantMessage {
    if (this.terminal) return this.message;
    const details = object(error);
    this.message.stopReason = reason;
    this.message.error = {
      message: this.diagnostic(error),
      ...(typeof details.category === "string" ? { category: details.category } : {}),
      ...(typeof details.statusCode === "number" ? { statusCode: details.statusCode } : {}),
      ...(typeof details.retryable === "boolean" ? { retryable: details.retryable } : {}),
    };
    this.finish();
    this.emit({ type: "error", reason, error: this.message });
    return this.message;
  }
  private diagnostic(error: unknown): string {
    let text = error instanceof Error ? error.message : String(error);
    if (this.origin.apiKey) text = text.split(this.origin.apiKey).join("***");
    return String(sanitizeWireTraceValue(text));
  }
  private finish(): void {
    this.terminal = true;
    this.arguments.clear();
    this.argumentErrors.clear();
    const freeze = (v: unknown): void => {
      if (!v || typeof v !== "object" || Object.isFrozen(v)) return;
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    };
    freeze(this.message);
  }
}
