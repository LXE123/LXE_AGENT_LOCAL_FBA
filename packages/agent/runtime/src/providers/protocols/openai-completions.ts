import type { AssistantSuccessReason } from "../../messages/assistant-message";
import { AssistantMessageAccumulator, object, string } from "../../messages/accumulator";

export const completionUsage = (value: unknown) => {
  const usage = object(value), details = object(usage.prompt_tokens_details);
  const count = (v: unknown): number => Math.max(0, Math.trunc(Number(v) || 0));
  const cacheRead = count(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  const cacheWrite = count(details.cache_write_tokens);
  return {
    input_tokens: Math.max(0, count(usage.prompt_tokens) - cacheRead - cacheWrite),
    output_tokens: count(usage.completion_tokens),
    ...(details.cached_tokens !== undefined || usage.prompt_cache_hit_tokens !== undefined || usage.cached_tokens !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(details.cache_write_tokens !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
    status: "complete" as const,
  };
};
const stopReason = (raw: string): AssistantSuccessReason => {
  if (raw === "stop" || raw === "end") return "stop";
  if (raw === "tool_calls" || raw === "function_call") return "toolUse";
  if (raw === "length") return "length";
  throw new Error(`Provider finish_reason: ${raw || "missing"}`);
};

/** Completions has no explicit text-block lifecycle; this adapter supplies it. */
export class OpenAICompletionsStreamAdapter {
  private readonly tools = new Map<number, number>();
  private readonly toolsById = new Map<string, number>();
  private activeContent: { index: number; kind: "text" | "thinking"; source: string } | undefined;
  private rawFinishReason = "";
  private readonly reasoningDetails: Record<string, unknown>[] = [];
  private reasoningIndex: number | undefined;
  constructor(readonly accumulator: AssistantMessageAccumulator) {}

  streamEvent(value: unknown): void {
    const chunk = object(value);
    if (chunk.error) throw new Error(JSON.stringify(chunk.error));
    this.accumulator.identity(chunk.id, chunk.model);
    if (chunk.usage) this.accumulator.usage(completionUsage(chunk.usage));
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (!choices.length) return;
    const choice = object(choices[0]), delta = object(choice.delta);
    if (this.rawFinishReason && Object.entries(delta).some(([key, value]) => key !== "role" && value !== null && value !== "")) {
      throw new Error(`Chat Completions content arrived after finish_reason: ${JSON.stringify(delta)}`);
    }
    if (!chunk.usage && choice.usage) this.accumulator.usage(completionUsage(choice.usage));
    const source = ["reasoning_content", "reasoning", "reasoning_text"].find((key) => typeof delta[key] === "string" && delta[key]);
    if (source) this.contentDelta("thinking", string(delta[source]), source);
    if (typeof delta.content === "string" && delta.content) this.contentDelta("text", delta.content, "content");
    if (Array.isArray(delta.reasoning_details)) {
      for (const raw of delta.reasoning_details) {
        const detail = object(raw);
        if (!["reasoning.text", "reasoning.summary", "reasoning.encrypted"].includes(string(detail.type))) continue;
        if (this.reasoningIndex === undefined) this.reasoningIndex = this.accumulator.startThinking();
        const last = this.reasoningDetails.at(-1);
        const field = detail.type === "reasoning.text" ? "text" : "summary";
        const metadata = (v: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([k]) => k !== field).sort(([a], [b]) => a.localeCompare(b))));
        if (detail.type !== "reasoning.encrypted" && last && metadata(last) === metadata(detail) && typeof detail[field] === "string") last[field] = string(last[field]) + detail[field];
        else this.reasoningDetails.push(structuredClone(detail));
        this.accumulator.metadata(this.reasoningIndex, { thinkingSignature: JSON.stringify(this.reasoningDetails) });
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      this.closeContent();
      for (const raw of delta.tool_calls) this.toolDelta(object(raw));
    }
    if (choice.finish_reason != null && string(choice.finish_reason)) {
      const raw = string(choice.finish_reason);
      if (this.rawFinishReason && this.rawFinishReason !== raw) throw new Error(`Conflicting finish_reason: ${this.rawFinishReason}, ${raw}`);
      this.rawFinishReason = raw;
      this.accumulator.message.rawStopReason = raw;
      this.closeContent();
    }
  }
  private contentDelta(kind: "text" | "thinking", delta: string, source: string): void {
    if (this.activeContent?.kind !== kind || this.activeContent.source !== source) {
      this.closeContent();
      const index = kind === "text" ? this.accumulator.startText() : this.accumulator.startThinking({ thinkingSignature: source });
      this.activeContent = { kind, index, source };
      if (kind === "thinking" && this.reasoningIndex === undefined) this.reasoningIndex = index;
    }
    this.accumulator.append(this.activeContent!.index, delta);
  }
  private closeContent(): void {
    if (this.activeContent) this.accumulator.end(this.activeContent.index);
    this.activeContent = undefined;
  }
  private toolDelta(delta: Record<string, unknown>): void {
    const wireIndex = Number(delta.index);
    if (!Number.isSafeInteger(wireIndex) || wireIndex < 0) throw new Error("Chat Completions tool delta requires index");
    const fn = object(delta.function);
    const id = string(delta.id), name = string(fn.name);
    let index = this.tools.get(wireIndex) ?? (id ? this.toolsById.get(id) : undefined);
    if (index === undefined) index = this.accumulator.startTool({ id, name });
    this.tools.set(wireIndex, index);
    const block = this.accumulator.block(index);
    // Providers can repeat the full identity or stream subsequent fragments.
    const merge = (old: string, next: string): string => !next || next === old ? old : !old || next.startsWith(old) ? next : old + next;
    const nextId = merge(string(block.id), id), nextName = merge(string(block.name), name);
    this.accumulator.metadata(index, { id: nextId, name: nextName });
    if (nextId) this.toolsById.set(nextId, index);
    if (typeof fn.arguments === "string") this.accumulator.append(index, fn.arguments);
  }
  finish(): void { this.closeContent(); }
  result() {
    if (!this.rawFinishReason) throw new Error("Chat Completions stream ended without finish_reason");
    return this.accumulator.complete(stopReason(this.rawFinishReason), this.rawFinishReason);
  }
}
