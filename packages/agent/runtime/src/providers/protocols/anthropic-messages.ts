import { AssistantMessageAccumulator, object, string, parseArguments } from "../../messages/accumulator";
import type { AssistantSuccessReason } from "../../messages/assistant-message";

export class AnthropicMessagesStreamAdapter {
  private readonly blocks = new Map<number, number>();
  private readonly initialInputs = new Map<number, Record<string, unknown>>();
  private readonly inputDeltas = new Map<number, string>();
  private readonly stopped = new Set<number>();
  constructor(readonly accumulator: AssistantMessageAccumulator) {}
  private wireIndex(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Anthropic stream event requires a valid block index");
    return value;
  }
  private start(index: number, block: Record<string, unknown>): number | undefined {
    const existing = this.blocks.get(index);
    if (existing !== undefined) return existing;
    let local: number;
    if (block.type === "text") local = this.accumulator.startText();
    else if (block.type === "thinking" || block.type === "redacted_thinking") local = this.accumulator.startThinking({
      ...(block.type === "redacted_thinking" ? { redacted: true, thinkingSignature: string(block.data) } : { thinkingSignature: string(block.signature) }),
    });
    else if (block.type === "tool_use") {
      local = this.accumulator.startTool({ id: string(block.id), name: string(block.name) });
      this.initialInputs.set(index, object(block.input));
    } else throw new Error(`Unsupported Anthropic content block: ${JSON.stringify(block)}`);
    this.blocks.set(index, local);
    if (block.type === "text" && block.text) this.accumulator.append(local, string(block.text));
    if (block.type === "thinking" && block.thinking) this.accumulator.append(local, string(block.thinking));
    return local;
  }
  streamEvent(value: unknown): void {
    const event = object(value);
    if (event.type === "error") throw new Error(JSON.stringify(event.error));
    if (event.type === "message_start") {
      const message = object(event.message);
      this.accumulator.identity(message.id, message.model);
      this.usage(message.usage, "partial");
      return;
    }
    if (event.type === "message_delta") {
      const delta = object(event.delta);
      if (delta.stop_reason) this.accumulator.message.rawStopReason = string(delta.stop_reason);
      this.usage(event.usage, "partial");
      return;
    }
    if (event.type === "content_block_start") { this.start(this.wireIndex(event.index), object(event.content_block)); return; }
    if (event.type !== "content_block_delta" && event.type !== "content_block_stop") return;
    const index = this.wireIndex(event.index), local = this.blocks.get(index);
    if (local === undefined) throw new Error(`Anthropic ${string(event.type)} arrived before content_block_start for index ${index}`);
    if (event.type === "content_block_stop") {
      // Tool end waits for the terminal payload, which can contain complete input.
      if (this.accumulator.block(local).type !== "tool_call") this.accumulator.end(local);
      this.stopped.add(index);
      return;
    }
    if (this.stopped.has(index)) throw new Error(`Anthropic delta after block stop: ${index}`);
    const delta = object(event.delta), block = this.accumulator.block(local);
    if (delta.type === "signature_delta") {
      if (block.type !== "thinking") throw new Error(`Anthropic signature delta does not match block ${index}`);
      this.accumulator.metadata(local, { thinkingSignature: string(block.thinkingSignature) + string(delta.signature) });
    } else if (delta.type === "input_json_delta") {
      if (block.type !== "tool_call") throw new Error(`Anthropic input_json_delta does not match block ${index}`);
      const fragment = string(delta.partial_json);
      this.inputDeltas.set(index, (this.inputDeltas.get(index) ?? "") + fragment);
      this.accumulator.append(local, fragment);
    } else if (delta.type === "text_delta" || delta.type === "thinking_delta") {
      const expected = delta.type === "text_delta" ? "text" : "thinking";
      if (block.type !== expected) throw new Error(`Anthropic ${delta.type} does not match block ${index}`);
      this.accumulator.append(local, string(delta[expected]));
    } else throw new Error(`Unsupported Anthropic block delta: ${JSON.stringify(delta)}`);
  }
  private usage(value: unknown, status: "partial" | "complete"): void {
    if (!value || typeof value !== "object") return;
    const raw = object(value), usage: Record<string, number> = {};
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      if (raw[key] !== undefined) usage[key] = Math.max(0, Math.trunc(Number(raw[key]) || 0));
    }
    this.accumulator.usage({ ...usage, status });
  }
  finalize(value: unknown) {
    const message = object(value);
    this.accumulator.identity(message.id, message.model);
    this.usage(message.usage, "complete");
    const raw = string(message.stop_reason || this.accumulator.message.rawStopReason);
    this.accumulator.message.rawStopReason = raw;
    const reason: AssistantSuccessReason = raw === "end_turn" || raw === "stop_sequence" ? "stop" : raw === "tool_use" ? "toolUse" : raw === "max_tokens" ? "length" : (() => { throw new Error(`Anthropic stop_reason: ${raw || "missing"}`); })();
    for (const [index, rawBlock] of (Array.isArray(message.content) ? message.content : []).entries()) {
      const block = object(rawBlock), local = this.start(index, block);
      if (local === undefined) continue;
      if (block.type === "text") this.accumulator.end(local, string(block.text));
      else if (block.type === "thinking" || block.type === "redacted_thinking") {
        this.accumulator.metadata(local, { ...(block.signature !== undefined || block.data !== undefined ? { thinkingSignature: string(block.signature ?? block.data) } : {}), ...(block.type === "redacted_thinking" ? { redacted: true } : {}) });
        this.accumulator.end(local, string(block.thinking));
      } else {
        // The SDK's completed input is authoritative; a truncated streamed input stays a draft.
        const delta = this.inputDeltas.get(index);
        if (reason === "length" && delta) {
          try { parseArguments(delta); } catch { continue; }
        }
        const initial = this.initialInputs.get(index) ?? {};
        const full = block.input !== undefined ? JSON.stringify(block.input) : delta ? JSON.stringify({ ...initial, ...parseArguments(delta) }) : JSON.stringify(initial);
        this.accumulator.end(local, full);
      }
    }
    this.usage(message.usage, "complete");
    return this.accumulator.complete(reason, raw);
  }
}
