import { describe, expect, test } from "bun:test";
import { AnthropicRuntimeProvider, type AnthropicClientPort, type ProviderDescriptor } from "../../src/providers/provider";
import { CompletionsRuntimeProvider, type CompletionsClientPort } from "../../src/providers/completions-provider";
import { ResponsesRuntimeProvider, type ResponsesClientPort } from "../../src/providers/responses-provider";
import type { AssistantMessageEvent } from "../../src/messages/assistant-message";

const descriptor: ProviderDescriptor = {
  name: "test", model: "model", apiStyle: "anthropic_messages", apiKey: "fixture-secret", baseURL: "https://example.invalid",
  maxTokens: 100, defaultHeaders: {}, thinkingStyle: "", thinkingLevels: [], thinkingDefault: "off", thinkingEnabled: false,
  thinkingEffort: "off", thinkingDisplay: "omitted", contextWindowTokens: 1000, requestIdleTimeoutMs: 1000,
};
const request = (signal = new AbortController().signal) => ({ system: "test", messages: [], tools: [], toolChoice: "none" as const, signal });

describe("provider request lifecycles", () => {
  test("all protocols emit start/error on pre-cancellation without contacting the SDK", async () => {
    let calls = 0;
    const unreachable = () => { calls++; throw new Error("SDK must not be contacted"); };
    const providers = [
      new AnthropicRuntimeProvider(descriptor, { messages: { stream: unreachable } }),
      new CompletionsRuntimeProvider({ ...descriptor, apiStyle: "openai_completions" }, { chat: { completions: { create: unreachable } } }),
      new ResponsesRuntimeProvider({ ...descriptor, apiStyle: "openai_responses" }, { responses: { stream: unreachable } }),
    ];
    for (const provider of providers) {
      const controller = new AbortController(); controller.abort(new DOMException("cancelled before request", "AbortError"));
      const events: AssistantMessageEvent[] = [];
      await expect(provider.turn({ ...request(controller.signal), onEvent: (e) => { events.push(e); } })).rejects.toThrow("cancelled before request");
      expect(events.map((e) => e.type)).toEqual(["start", "error"]);
      expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted", error: { usage: { status: "unreported" } } });
    }
    expect(calls).toBe(0);
  });
  test("Completions preserves partial content and reported usage when transport breaks", async () => {
    const client: CompletionsClientPort = { chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
      throw new Error("upstream reset fixture-secret");
    })() } } };
    const events: AssistantMessageEvent[] = [];
    const provider = new CompletionsRuntimeProvider({ ...descriptor, apiStyle: "openai_completions" }, client);
    await expect(provider.turn({ ...request(), onEvent: (e) => { events.push(e); } })).rejects.toThrow("upstream reset");
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "error", reason: "error", error: { content: [{ text: "partial" }], usage: { input_tokens: 3, output_tokens: 1 } } });
    expect(JSON.stringify(terminal)).not.toContain("fixture-secret");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
  test("Responses parsing failures abort its SDK signal and cannot return success", async () => {
    let listener: ((event: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    const client: ResponsesClientPort = { responses: { stream: (_body, options) => {
      signal = options?.signal;
      return {
        on: (type, callback) => { if (type === "event") listener = callback; },
        finalResponse: async () => {
          listener?.({ type: "response.output_item.added", item: { type: "function_call" } });
          return { status: "completed", output: [] };
        },
      };
    } } };
    const events: AssistantMessageEvent[] = [];
    const provider = new ResponsesRuntimeProvider({ ...descriptor, apiStyle: "openai_responses" }, client);
    await expect(provider.turn({ ...request(), onEvent: (e) => { events.push(e); } })).rejects.toThrow("requires id");
    expect(signal?.aborted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
  });
  test("async callback failure does not retry the request or change the successful result", async () => {
    let calls = 0;
    const client: AnthropicClientPort = { messages: { stream: () => {
      calls++;
      return { finalMessage: async () => ({ content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } }) };
    } } };
    const provider = new AnthropicRuntimeProvider(descriptor, client);
    const observed = await provider.turn({ ...request(), onEvent: async () => { await Promise.resolve(); throw new Error("UI gone"); } });
    const silent = await provider.turn(request());
    expect(calls).toBe(2);
    expect(observed.content).toEqual(silent.content);
    expect(observed.usage).toEqual(silent.usage);
    expect(observed.stopReason).toBe("stop");
    expect(observed.id).not.toBe(silent.id);
  });
});
