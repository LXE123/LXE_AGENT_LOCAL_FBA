import { AssistantMessageAccumulator, object, string } from "../../messages/accumulator";
import type { AssistantSuccessReason } from "../../messages/assistant-message";

type ItemState = { id: string; type: string; text: Map<number, number>; thinking: Map<number, number>; tool?: number; summary: boolean };
export const responsesUsage = (value: unknown) => {
  const raw = object(value), details = object(raw.input_tokens_details);
  const count = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));
  const read = count(details.cached_tokens), write = count(details.cache_write_tokens);
  return {
    input_tokens: Math.max(0, count(raw.input_tokens) - read - write), output_tokens: count(raw.output_tokens),
    ...(details.cached_tokens !== undefined ? { cache_read_input_tokens: read } : {}),
    ...(details.cache_write_tokens !== undefined ? { cache_creation_input_tokens: write } : {}), status: "complete" as const,
  };
};
export class OpenAIResponsesStreamAdapter {
  private readonly items = new Map<string, ItemState>();
  private readonly outputs = new Map<number, string>();
  private terminalResponse: Record<string, unknown> | undefined;
  constructor(readonly accumulator: AssistantMessageAccumulator) {}
  private index(value: unknown, fallback?: number): number {
    const n = value === undefined ? fallback : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`Responses requires a valid content/output index: ${String(value)}`);
    return n;
  }
  private item(raw: Record<string, unknown>, outputIndex?: unknown): ItemState {
    const id = string(raw.id);
    if (!id) throw new Error("Responses output item requires id");
    let state = this.items.get(id);
    const type = string(raw.type);
    if (!state) {
      state = { id, type, text: new Map(), thinking: new Map(), summary: false };
      this.items.set(id, state);
    } else if (state.type && type && state.type !== type) throw new Error(`Responses item ${id} changed type`);
    else if (type) state.type = type;
    if (outputIndex !== undefined) {
      const index = this.index(outputIndex);
      const existing = this.outputs.get(index);
      if (existing && existing !== id) throw new Error(`Responses output index ${index} changed item`);
      this.outputs.set(index, id);
    }
    if (type === "function_call") {
      if (state.tool === undefined) {
        state.tool = this.accumulator.startTool({ id: string(raw.call_id), name: string(raw.name), providerItemId: id,
          ...(raw.namespace !== undefined ? { namespace: string(raw.namespace) } : {}) });
        if (raw.arguments) this.accumulator.append(state.tool, string(raw.arguments));
      } else this.accumulator.metadata(state.tool, {
        ...(raw.call_id !== undefined ? { id: string(raw.call_id) } : {}),
        ...(raw.name !== undefined ? { name: string(raw.name) } : {}),
        ...(raw.namespace !== undefined ? { namespace: string(raw.namespace) } : {}),
      });
    }
    return state;
  }
  private eventItem(event: Record<string, unknown>, type: string): ItemState {
    const mapped = event.output_index === undefined ? undefined : this.outputs.get(this.index(event.output_index));
    const id = string(event.item_id ?? mapped);
    if (!id) throw new Error(`Responses ${string(event.type)} requires item_id or known output_index`);
    if (mapped && mapped !== id) throw new Error("Responses item_id/output_index mismatch");
    return this.item({ id, type }, event.output_index);
  }
  private content(state: ItemState, kind: "text" | "thinking", wireIndex: number): number {
    const map = state[kind];
    let index = map.get(wireIndex);
    if (index === undefined) {
      index = kind === "text" ? this.accumulator.startText() : this.accumulator.startThinking();
      map.set(wireIndex, index);
    }
    return index;
  }
  streamEvent(value: unknown): void {
    const event = object(value), type = string(event.type);
    if (this.terminalResponse) {
      if (!["response.completed", "response.incomplete", "response.failed"].includes(type)) {
        throw new Error(`Responses event arrived after terminal response: ${type}`);
      }
      if (JSON.stringify(this.terminalResponse) !== JSON.stringify(event.response)) throw new Error("Conflicting Responses terminal events");
      return;
    }
    if (type === "response.created") { const r = object(event.response); this.accumulator.identity(r.id, r.model); return; }
    if (type === "response.output_item.added") { this.item(object(event.item), event.output_index); return; }
    if (type === "response.output_item.done") { this.finishItem(object(event.item), event.output_index); return; }
    if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
      this.terminalResponse = object(event.response);
      this.captureTerminal(this.terminalResponse);
      return;
    }
    if (type === "error") throw new Error(JSON.stringify({ code: event.code, message: event.message }));
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const state = this.eventItem(event, "function_call");
      if (state.tool === undefined) throw new Error("Responses tool arguments arrived before function_call identity");
      if (type.endsWith(".delta")) this.accumulator.append(state.tool, string(event.delta));
      else this.accumulator.toolArguments(state.tool, string(event.arguments));
      return;
    }
    const textEvent = type === "response.output_text.delta" || type === "response.output_text.done" || type === "response.refusal.delta" || type === "response.refusal.done";
    const thinkingEvent = ["response.reasoning_text.delta", "response.reasoning_text.done", "response.reasoning.delta", "response.reasoning.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_summary_part.done"].includes(type);
    if (!textEvent && !thinkingEvent) return;
    const state = this.eventItem(event, textEvent ? "message" : "reasoning");
    const kind = textEvent ? "text" : "thinking";
    const summary = type.includes("summary");
    if (summary) state.summary = true;
    const index = this.content(state, kind, this.index(event.content_index ?? event.summary_index, 0));
    if (type.endsWith(".delta")) this.accumulator.append(index, string(event.delta));
    else if (type === "response.reasoning_summary_part.done") {
      const part = object(event.part);
      if (part.text !== undefined) this.accumulator.end(index, string(part.text));
    } else this.accumulator.end(index, string(event.text ?? event.refusal ?? event.reasoning));
  }
  private finishItem(raw: Record<string, unknown>, outputIndex?: unknown): void {
    const state = this.item(raw, outputIndex);
    if (raw.type === "function_call") {
      this.accumulator.end(state.tool!, raw.arguments === undefined ? undefined : string(raw.arguments));
      return;
    }
    if (raw.type === "message") {
      for (const [wireIndex, partValue] of (Array.isArray(raw.content) ? raw.content : []).entries()) {
        const part = object(partValue);
        if (part.type !== "output_text" && part.type !== "refusal") throw new Error(`Unsupported Responses message content: ${JSON.stringify(part)}`);
        const index = this.content(state, "text", wireIndex);
        this.accumulator.metadata(index, { textSignature: JSON.stringify({ v: 1, id: state.id, contentIndex: wireIndex, ...(raw.phase !== undefined ? { phase: raw.phase } : {}) }) });
        this.accumulator.end(index, string(part.text ?? part.refusal));
      }
      return;
    }
    if (raw.type === "reasoning") {
      const summary = Array.isArray(raw.summary) ? raw.summary : [];
      const content = Array.isArray(raw.content) ? raw.content : [];
      const parts = state.thinking.size ? (state.summary ? summary : content) : (summary.length ? summary : content);
      for (const [wireIndex, part] of parts.entries()) {
        this.accumulator.end(this.content(state, "thinking", wireIndex), typeof part === "string" ? part : string(object(part).text));
      }
      if (!state.thinking.size) this.content(state, "thinking", 0);
      const first = state.thinking.values().next().value!;
      const block = this.accumulator.block(first);
      const previous = block.thinkingSignature ? object(JSON.parse(string(block.thinkingSignature))) : {};
      this.accumulator.metadata(first, { thinkingSignature: JSON.stringify({ ...previous, ...raw,
        ...(raw.encrypted_content || previous.encrypted_content ? { encrypted_content: raw.encrypted_content || previous.encrypted_content } : {}) }) });
      for (const index of state.thinking.values()) this.accumulator.end(index);
      return;
    }
    throw new Error(`Unsupported Responses output item: ${JSON.stringify(raw)}`);
  }
  private captureTerminal(response: Record<string, unknown>): void {
    this.accumulator.identity(response.id, response.model);
    if (response.usage) this.accumulator.usage(responsesUsage(response.usage));
    const status = string(response.status), reason = string(object(response.incomplete_details).reason);
    this.accumulator.message.rawStopReason = reason ? `${status}.${reason}` : status;
  }
  finalize(value?: unknown) {
    const final = value === undefined ? this.terminalResponse : object(value);
    if (!final) throw new Error("OpenAI Responses stream ended before a terminal response event");
    this.captureTerminal(final);
    if (this.terminalResponse && final.status !== this.terminalResponse.status) throw new Error("Responses terminal payloads disagree on status");
    const status = string(final.status), incomplete = string(object(final.incomplete_details).reason);
    if (status !== "completed" && !(status === "incomplete" && incomplete === "max_output_tokens")) {
      throw new Error(`Responses terminal failure: ${JSON.stringify({ status: final.status, error: final.error, incomplete_details: final.incomplete_details })}`);
    }
    for (const [index, item] of (Array.isArray(final.output) ? final.output : []).entries()) this.finishItem(object(item), index);
    const reason: AssistantSuccessReason = status === "incomplete" ? "length" : this.accumulator.message.content.some((b) => b.type === "tool_call") ? "toolUse" : "stop";
    return this.accumulator.complete(reason, this.accumulator.message.rawStopReason);
  }
}
