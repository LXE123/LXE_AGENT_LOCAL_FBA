import { describe, expect, test } from "bun:test";
import { AssistantMessageAccumulator } from "../../src/messages/accumulator";
import type { AssistantMessageEvent } from "../../src/messages/assistant-message";
import { OpenAICompletionsStreamAdapter } from "../../src/providers/protocols/openai-completions";
import { OpenAIResponsesStreamAdapter } from "../../src/providers/protocols/openai-responses";
import { AnthropicMessagesStreamAdapter } from "../../src/providers/protocols/anthropic-messages";
import { adaptMessagesForResponses } from "../../src/providers/responses-provider";
import { adaptMessagesForCompletions } from "../../src/providers/completions-provider";
import { cleanCanonicalMessages, pruneProcessedHistoryImages } from "../../src/engine/context";
import { normalizeTranscriptMessage } from "../../src/state/transcript";
import type { ProviderDescriptor } from "../../src/providers/provider";

const origin = { name: "test", apiStyle: "openai_responses", model: "test", apiKey: "secret-test-key" };
const setup = (apiStyle = origin.apiStyle) => {
  const events: AssistantMessageEvent[] = [];
  const accumulator = new AssistantMessageAccumulator({ ...origin, apiStyle }, (event) => { events.push(event); });
  return { accumulator, events };
};

describe("assistant request contract", () => {
  test("uses a shared live partial, stable ends and one immutable terminal result", async () => {
    const { accumulator: a, events } = setup();
    const text = a.startText(), thought = a.startThinking();
    a.append(text, "old"); a.append(thought, "plan"); a.end(text, "corrected");
    const result = a.complete("stop", "completed");
    await a.drain();
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop", message: result });
    expect(events.filter((e) => "partial" in e).every((e) => "partial" in e && e.partial === result)).toBe(true);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ content: "corrected" });
    expect(Object.isFrozen(result.content[0])).toBe(true);
    expect(() => a.append(text, "late")).toThrow("terminal");
  });
  test("rejects conflicting ended content, but accepts signature backfill", () => {
    const { accumulator: a } = setup();
    const index = a.startThinking(); a.append(index, "body"); a.end(index);
    a.metadata(index, { thinkingSignature: "late-signature" });
    a.end(index, "body");
    expect(() => a.end(index, "changed")).toThrow("Conflicting");
  });
  test("isolates a failing async consumer and does not stop generation", async () => {
    let calls = 0;
    const a = new AssistantMessageAccumulator(origin, async () => { calls++; throw new Error("consumer"); });
    const index = a.startText(); a.append(index, "answer");
    const result = a.complete("stop"); await a.drain();
    expect(calls).toBe(1); expect(result.stopReason).toBe("stop");
  });
  test("keeps truncated tool JSON as a draft and strictly rejects malformed successful tools", async () => {
    const { accumulator: a, events } = setup();
    const index = a.startTool({ id: "call", name: "read" }); a.append(index, '{"path":');
    const result = a.complete("length", "max_output_tokens"); await a.drain();
    expect(result.content[0]?.arguments).toBeUndefined();
    expect(events.some((e) => e.type === "toolcall_end")).toBe(false);
    expect(result.error?.message).toContain("Invalid tool arguments");
    const b = new AssistantMessageAccumulator(origin);
    b.append(b.startTool({ id: "call", name: "read" }), "[]");
    expect(() => b.complete("toolUse")).toThrow("JSON object");
  });
  test("redacts known credentials and explicitly truncates terminal diagnostics", async () => {
    const { accumulator: a, events } = setup();
    a.fail("error", new Error(`secret-test-key ${"x".repeat(12_000)} actual ending`)); await a.drain();
    expect(a.message.error?.message).not.toContain("secret-test-key");
    expect(a.message.error?.message).toContain("omitted");
    expect(a.message.error?.message).toContain("actual ending");
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
  });
});

describe("Completions message translation", () => {
  test("interleaves tools, fills fragmented identities, ignores repeats and reads usage-only tail", async () => {
    const { accumulator: a, events } = setup("openai_completions");
    const adapter = new OpenAICompletionsStreamAdapter(a);
    adapter.streamEvent({ id: "response-1", model: "routed", choices: [{ delta: { reasoning_content: "plan", reasoning: "plan" } }] });
    adapter.streamEvent({ choices: [{ delta: { content: "checking" } }] });
    adapter.streamEvent({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_", function: { name: "rea", arguments: '{"path":' } },
      { index: 1, id: "call_2", function: { name: "write", arguments: '{"text":"x"}' } },
    ] } }] });
    adapter.streamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "d", arguments: '"a.ts"}' } }] } }] });
    adapter.streamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] }, finish_reason: "tool_calls" }] });
    adapter.streamEvent({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, cached_tokens: 5 } });
    const result = adapter.result(); await a.drain();
    expect(result).toMatchObject({ responseId: "response-1", responseModel: "routed", stopReason: "toolUse", usage: { input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 5, status: "complete" } });
    expect(result.content).toMatchObject([
      { type: "thinking", thinking: "plan", thinkingSignature: "reasoning_content" },
      { type: "text", text: "checking" },
      { type: "tool_call", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool_call", id: "call_2", name: "write", arguments: { text: "x" } },
    ]);
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(2);
  });
  test("requires finish reason and preserves structured reasoning replay order", () => {
    const { accumulator: a } = setup("openai_completions");
    const adapter = new OpenAICompletionsStreamAdapter(a);
    for (const delta of ["one", " two"]) adapter.streamEvent({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", id: "r", text: delta }] } }] });
    adapter.streamEvent({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] } }] });
    expect(() => adapter.result()).toThrow("without finish_reason");
    adapter.streamEvent({ choices: [{ delta: {}, finish_reason: "stop" }] });
    const result = adapter.result();
    const details = [{ type: "reasoning.text", id: "r", text: "one two" }, { type: "reasoning.encrypted", data: "opaque" }];
    expect(JSON.parse(String(result.content[0]?.thinkingSignature))).toEqual(details);
    const replay = adaptMessagesForCompletions([result], false, { ...origin, apiStyle: "openai_completions" } as ProviderDescriptor);
    expect(replay[0]?.reasoning_details).toEqual(details);
  });
});

describe("Responses message translation", () => {
  test("corrects arguments, preserves content indices, refusal and late encrypted replay data", async () => {
    const { accumulator: a, events } = setup(); const adapter = new OpenAIResponsesStreamAdapter(a);
    adapter.streamEvent({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "plan" });
    adapter.streamEvent({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }] } });
    adapter.streamEvent({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" } });
    adapter.streamEvent({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"path":"old"}' });
    adapter.streamEvent({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: '{"path":"new"}' });
    const tool = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"new"}', namespace: "files" };
    adapter.streamEvent({ type: "response.output_item.done", output_index: 1, item: tool });
    adapter.streamEvent({ type: "response.output_item.done", output_index: 1, item: tool });
    const result = adapter.finalize({ id: "response", status: "completed", output: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "encrypted" }, tool,
      { type: "message", id: "msg_1", content: [{ type: "output_text", text: "a" }, { type: "refusal", refusal: "b" }] },
    ] });
    await a.drain();
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
    expect(result.content[1]).toMatchObject({ id: "call_1", providerItemId: "fc_1", arguments: { path: "new" }, namespace: "files" });
    expect(result.content.slice(2).map((b) => b.text)).toEqual(["a", "b"]);
    const restored = normalizeTranscriptMessage(JSON.parse(JSON.stringify(result)))!;
    const cleaned = pruneProcessedHistoryImages(cleanCanonicalMessages([restored])).messages;
    expect(cleaned[0]).toEqual(result);
    const replay = adaptMessagesForResponses(cleaned, false, origin as ProviderDescriptor);
    expect(replay[0]).toMatchObject({ type: "reasoning", encrypted_content: "encrypted" });
    expect(replay[1]).toMatchObject({ id: "fc_1", call_id: "call_1", namespace: "files" });
    expect((replay[2]?.content as unknown[]).length).toBe(2);
    const foreign = adaptMessagesForResponses(cleaned, false, { ...origin, model: "other" } as ProviderDescriptor);
    expect(foreign.some((i) => i.type === "reasoning")).toBe(false);
    expect(foreign.find((i) => i.type === "function_call")?.id).toBeUndefined();
  });
  test("handles done-only text and OpenRouter reasoning without a content index", async () => {
    const { accumulator: a, events } = setup(); const adapter = new OpenAIResponsesStreamAdapter(a);
    adapter.streamEvent({ type: "response.reasoning.delta", item_id: "rs", delta: "plan" });
    adapter.streamEvent({ type: "response.reasoning.done", item_id: "rs", reasoning: "plan" });
    adapter.streamEvent({ type: "response.output_text.done", item_id: "msg", content_index: 0, text: "whole answer" });
    const result = adapter.finalize({ status: "completed" }); await a.drain();
    expect(result.content.map((b) => b.text ?? b.thinking)).toEqual(["plan", "whole answer"]);
    expect(events.filter((e) => e.type === "text_end")).toHaveLength(1);
  });
  test("rejects missing terminals, filtering, unknown and failed statuses", () => {
    for (const response of [undefined, { status: "in_progress" }, { status: "incomplete", incomplete_details: { reason: "content_filter" } }, { status: "failed", error: { code: "bad", message: "actual" } }]) {
      const adapter = new OpenAIResponsesStreamAdapter(new AssistantMessageAccumulator(origin));
      expect(() => adapter.finalize(response)).toThrow();
    }
    const adapter = new OpenAIResponsesStreamAdapter(new AssistantMessageAccumulator(origin));
    expect(adapter.finalize({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }).stopReason).toBe("length");
  });
});

describe("Anthropic message translation", () => {
  test("accumulates block signatures, redaction and final tool input", async () => {
    const { accumulator: a, events } = setup("anthropic_messages"); const adapter = new AnthropicMessagesStreamAdapter(a);
    adapter.streamEvent({ type: "message_start", message: { id: "a", usage: { input_tokens: 7 } } });
    adapter.streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "plan" } });
    adapter.streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    adapter.streamEvent({ type: "content_block_stop", index: 0 });
    adapter.streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "list", input: {} } });
    adapter.streamEvent({ type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "opaque" } });
    const result = adapter.finalize({ id: "a", stop_reason: "tool_use", content: [
      { type: "thinking", thinking: "plan", signature: "sig" },
      { type: "tool_use", id: "call", name: "list", input: { path: "a" } },
      { type: "redacted_thinking", data: "opaque" },
    ], usage: { output_tokens: 5 } }); await a.drain();
    expect(result.usage).toMatchObject({ input_tokens: 7, output_tokens: 5, status: "complete" });
    expect(result.content[0]?.thinkingSignature).toBe("sig");
    expect(result.content[1]?.arguments).toEqual({ path: "a" });
    expect(result.content[2]).toMatchObject({ type: "thinking", redacted: true, thinkingSignature: "opaque" });
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
  });
});
