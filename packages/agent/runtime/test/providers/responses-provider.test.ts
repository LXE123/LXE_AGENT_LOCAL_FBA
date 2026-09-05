import { describe, expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import {
  AnthropicRuntimeProvider,
  loadProviderDescriptor,
  providerEndpointUrl,
  providerUserIdentifier,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderDescriptor,
} from "../../src/providers/provider";
import { createRuntimeProvider } from "../../src/providers/provider-factory";
import {
  adaptMessagesForResponses,
  buildResponsesRequest,
  ResponsesRuntimeProvider,
  type ResponsesClientPort,
} from "../../src/providers/responses-provider";
import type { RuntimeMessage, AssistantMessageEvent } from "../../src/engine/types";

const descriptor = (patch: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  name: "deepseek",
  model: "deepseek-v4-flash",
  apiStyle: "openai_responses",
  baseURL: "https://example.invalid",
  apiKey: "key",
  maxTokens: 1024,
  defaultHeaders: {},
  thinkingStyle: "anthropic-effort",
  thinkingLevels: ["off", "low", "high", "max"],
  thinkingDefault: "low",
  thinkingEnabled: true,
  thinkingEffort: "high",
  thinkingDisplay: "omitted",
  contextWindowTokens: 1_000,
  requestIdleTimeoutMs: 1_000,
  ...patch,
});

/** Replays a scripted event list, then resolves with the terminal payload. */
const fakeClient = (events: Array<[string, unknown]>, final: unknown, captured?: {
  body?: Record<string, unknown>;
}): ResponsesClientPort => ({
  responses: {
    stream(body) {
      if (captured) captured.body = body;
      const listeners = new Map<string, (payload: unknown) => void>();
      return {
        on(event, listener) {
          listeners.set(event, listener);
          return this;
        },
        finalResponse() {
          for (const [name, payload] of events) {
            // The SDK fans every frame out to both the catch-all and the
            // per-type listener, and the adapter relies on that.
            listeners.get("event")?.({ ...(payload as object), type: name });
            listeners.get(name)?.(payload);
          }
          return Promise.resolve(final);
        },
      };
    },
  },
});

describe("DeepSeek Responses provider", () => {
  test("expands one assistant message into sibling call items and matches results by call id", () => {
    const messages: RuntimeMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" } as never,
          { type: "text", text: "reading it" },
          { type: "tool_call", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call_1", content: [{ type: "text", text: "file body" }] } as never],
      },
    ];

    expect(adaptMessagesForResponses(messages)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "message",
        role: "assistant",
        id: "msg_replay_1_1",
        status: "completed",
        content: [{ type: "output_text", text: "reading it", annotations: [] }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: JSON.stringify({ path: "a.txt" }),
      },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  test("projects structured compaction checkpoints as pi-style user input", () => {
    const input = adaptMessagesForResponses([{
      role: "compactionSummary",
      summary: "checkpoint body",
      tokensBefore: 12_345,
      details: { readFiles: [], modifiedFiles: ["src/changed.ts"] },
    }]);
    expect(input).toEqual([{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ncheckpoint body\n</summary>",
      }],
    }]);
    expect(JSON.stringify(input)).not.toContain("compactionSummary");
  });

  test("sends local attachment names and absolute paths with the user's text", () => {
    const messages: RuntimeMessage[] = [{
      role: "user",
      content: [
        {
          type: "local_file",
          attachment_id: "attachment-1",
          turn_id: "turn-1",
          path: "/Users/llxx/Downloads/SP260805023.xls",
          name: "SP260805023.xls",
          size_bytes: 14_955_520,
          media_type: "application/vnd.ms-excel",
          ts: 1,
        },
        { type: "text", text: "预览并上传这份装箱数据到 ERP" },
      ],
    }];

    expect(adaptMessagesForResponses(messages)).toEqual([{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "# Files mentioned by the user:",
          "",
          'Local file name: "SP260805023.xls"',
          'Absolute path: "/Users/llxx/Downloads/SP260805023.xls"',
          "",
          "This is a user-selected local file reference. Read the current file at this exact path with the appropriate tool.",
          "预览并上传这份装箱数据到 ERP",
        ].join("\n"),
      }],
    }]);
  });

  test("forwards user and tool-result images only when the selected model supports vision", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    };
    const messages: RuntimeMessage[] = [
      { role: "user", content: [{ type: "text", text: "inspect" }, image] as never },
      {
        role: "tool",
        content: [{
          type: "tool_result",
          tool_call_id: "call_image",
          content: [{ type: "text", text: "preview" }, image],
        }] as never,
      },
    ];

    expect(adaptMessagesForResponses(messages, true)).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [
          { type: "input_text", text: "preview" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ]);
    expect(JSON.stringify(adaptMessagesForResponses(messages, false)))
      .toContain("the selected model does not support image content");
  });

  test("rejects malformed image MIME types and base64 before making a Responses request", () => {
    expect(() => adaptMessagesForResponses([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "text/plain", data: "aGVsbG8=" },
      }] as never,
    }], true)).toThrow("invalid Responses image media type");
    expect(() => adaptMessagesForResponses([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "not base64!" },
      }] as never,
    }], true)).toThrow("invalid Responses image base64 data");
  });

  test("spells thinking the way this wire does, with none as the off switch", () => {
    const enabled = buildResponsesRequest(descriptor(), {
      system: " you are helpful ",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "reads", input_schema: { type: "object" } }],
      toolChoice: "auto",
    });
    expect(enabled).toEqual(expect.objectContaining({
      model: "deepseek-v4-flash",
      instructions: "you are helpful",
      stream: true,
      max_output_tokens: 1024,
      tool_choice: "auto",
      reasoning: { effort: "high" },
    }));
    // The Anthropic-compatible pair means nothing on this wire, and DeepSeek
    // drops unknown parameters silently - sending them looks like it worked.
    expect(enabled.thinking).toBeUndefined();
    expect(enabled.output_config).toBeUndefined();
    expect(enabled.tools).toEqual([
      { type: "function", name: "read", description: "reads", parameters: { type: "object" } },
    ]);

    const off = buildResponsesRequest(descriptor({ thinkingEffort: "off" }), {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
    });
    expect(off.reasoning).toEqual({ effort: "none" });
    expect(off.thinking).toBeUndefined();
    expect(off.output_config).toBeUndefined();
    expect(off.tools).toBeUndefined();

    // "max" is a level this wire accepts, so it must not be folded into "high".
    const max = buildResponsesRequest(descriptor({ thinkingEffort: "max" }), {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
    });
    expect(max.reasoning).toEqual({ effort: "max" });
  });

  test("streams events and maps the terminal payload into runtime blocks and usage", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const client = fakeClient([
      ["response.created", {}],
      ["response.reasoning_text.delta", { item_id: "rs_1", content_index: 0, delta: "thinking" }],
      ["response.reasoning_text.done", { item_id: "rs_1", content_index: 0, text: "thinking" }],
      ["response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "hello" }],
      ["response.output_text.done", { item_id: "msg_1", content_index: 0, text: "hello" }],
      ["response.output_item.added", {
        item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: "" },
      }],
      ["response.function_call_arguments.delta", { item_id: "fc_2", delta: "{\"path\":" }],
      ["response.function_call_arguments.delta", { item_id: "fc_2", delta: "\"a\"}" }],
      ["response.function_call_arguments.done", { item_id: "fc_2", arguments: "{\"path\":\"a\"}" }],
      ["response.output_item.done", {
        item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: "{\"path\":\"a\"}" },
      }],
      ["response.completed", { response: { status: "completed" } }],
    ], {
      status: "completed",
      output: [
        { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: "{\"path\":\"a\"}" },
      ],
      usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
    }, captured);

    const seen: AssistantMessageEvent[] = [];
    const deliveryOrder: string[] = [];
    const traced: string[] = [];
    const provider = new ResponsesRuntimeProvider(descriptor(), client);
    const result = await provider.turn({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onEvent: async (event) => {
        await Promise.resolve();
        seen.push(event);
        deliveryOrder.push(event.type);
      },
      wireTrace: {
        requestStart: () => {},
        responseStart: () => {},
        event: (name) => { traced.push(name); },
        parseError: () => {},
        end: () => {},
      },
    });

    // Diagnostics keep the frames this adapter does not read, so a failure or
    // lifecycle frame is still there to look at afterwards.
    expect(traced).toContain("response.created");
    expect(traced).toContain("response.completed");

    expect(seen.map((event) => event.type)).toEqual([
      "start", "thinking_start", "thinking_delta", "thinking_end",
      "text_start", "text_delta", "text_end",
      "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
    ]);
    expect(seen.filter((event) => event.type === "toolcall_delta")).toMatchObject([
      { contentIndex: 2, delta: '{"path":' }, { contentIndex: 2, delta: '"a"}' },
    ]);
    deliveryOrder.push("turn_resolved");
    expect(deliveryOrder.at(-2)).toBe("done");
    expect(deliveryOrder.at(-1)).toBe("turn_resolved");
    expect(result.content).toMatchObject([
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "hello" },
      { type: "tool_call", id: "call_2", name: "read", arguments: { path: "a" } },
    ]);
    // A response carrying a call is not the end of the turn, and the runtime
    // decides whether to keep stepping from exactly this.
    expect(result.stopReason).toBe("toolUse");
    // This wire's `input_tokens` already contains the cached reads, and the
    // runtime sizes context by adding the fields together - so the fresh count
    // handed over must exclude them: 12 total - 4 cached = 8 fresh.
    expect(result.usage).toEqual({
      input_tokens: 8,
      output_tokens: 5,
      cache_read_input_tokens: 4,
      status: "complete",
    });
    expect(captured.body?.instructions).toBe("sys");
  });

  test("reports why an unfinished response stopped instead of calling it a normal end", async () => {
    const provider = new ResponsesRuntimeProvider(descriptor(), fakeClient([], {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: {},
    }));
    const result = await provider.turn({
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("length");
  });

  test("picks the adapter from the spec's declared wire, defaulting to Anthropic Messages", () => {
    expect(createRuntimeProvider(descriptor())).toBeInstanceOf(ResponsesRuntimeProvider);
    expect(createRuntimeProvider(descriptor({ apiStyle: "anthropic_messages" })))
      .toBeInstanceOf(AnthropicRuntimeProvider);

    const projectRoot = repositoryRoot(import.meta.dir);
    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-flash",
      DEEPSEEK_API: "secret-key",
    });
    // The shipped spec must actually reach the new adapter, and its base URL
    // must drop the Anthropic-compatible suffix the other wire needed.
    expect(deepseek.apiStyle).toBe("openai_responses");
    expect(deepseek.baseURL).toBe("https://api.deepseek.com");
    expect(createRuntimeProvider(deepseek)).toBeInstanceOf(ResponsesRuntimeProvider);

    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(kimi.apiStyle).toBe("anthropic_messages");
    expect(createRuntimeProvider(kimi)).toBeInstanceOf(AnthropicRuntimeProvider);
  });

  test("carries the same person id both wires rate-limit against", () => {
    const identity = { platform: "feishu", userId: "ou_alice" };
    const withUser = buildResponsesRequest(descriptor(), {
      system: "", messages: [], tools: [], toolChoice: "auto", userIdentity: identity,
    });
    // `metadata` is dropped by this wire; `user` is the field it isolates on.
    expect(withUser.user).toBe(providerUserIdentifier(identity));
    expect(String(withUser.user)).toMatch(/^lxe_[a-f0-9]{64}$/u);
    expect(withUser.metadata).toBeUndefined();

    // Two people must not collapse into one bucket, and a turn with no identity
    // must not invent one.
    expect(withUser.user).not.toBe(
      providerUserIdentifier({ platform: "feishu", userId: "ou_bob" }),
    );
    const anonymous = buildResponsesRequest(descriptor(), {
      system: "", messages: [], tools: [], toolChoice: "auto",
    });
    expect(anonymous.user).toBeUndefined();
  });

  test("never lets a cache-heavy report drive the fresh count negative", async () => {
    const provider = new ResponsesRuntimeProvider(descriptor(), fakeClient([], {
      status: "completed",
      output: [],
      // A provider reporting more cache than input is a bug on their side; it
      // must not become a negative token count on ours.
      usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 140 } },
    }));
    const result = await provider.turn({
      system: "", messages: [], tools: [], toolChoice: "auto",
      signal: new AbortController().signal,
    });
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.cache_read_input_tokens).toBe(140);
  });

  test("uses the requested summary budget and active Responses reasoning effort", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const provider = new ResponsesRuntimeProvider(descriptor({ thinkingEffort: "low" }), fakeClient([], {
      status: "completed",
      output: [{ type: "message", id: "msg_summary", content: [{ type: "output_text", text: "summary" }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }, captured));
    const result = await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "history",
      maxOutputTokens: 800,
    });
    expect(captured.body).toEqual(expect.objectContaining({
      instructions: SUMMARY_SYSTEM_PROMPT,
      max_output_tokens: 800,
      reasoning: { effort: "low" },
    }));
    expect(result.text).toBe("summary");

    const offCaptured: { body?: Record<string, unknown> } = {};
    const offProvider = new ResponsesRuntimeProvider(descriptor({
      thinkingEnabled: false,
      thinkingEffort: "off",
    }), fakeClient([], {
      status: "completed",
      output: [{ type: "message", id: "msg_summary", content: [{ type: "output_text", text: "summary" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, offCaptured));
    await offProvider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "midturn",
      maxOutputTokens: 500,
    });
    expect(offCaptured.body).toEqual(expect.objectContaining({
      max_output_tokens: 500,
      reasoning: { effort: "none" },
    }));
  });

  test("names the address the request actually goes to, per wire", () => {
    // Traces were reporting the Anthropic path for every provider, which reads
    // as "this spoke Messages" to anyone debugging a Responses turn.
    expect(providerEndpointUrl(descriptor({ baseURL: "https://api.deepseek.com" })))
      .toBe("https://api.deepseek.com/responses");
    expect(providerEndpointUrl(descriptor({
      apiStyle: "anthropic_messages",
      baseURL: "https://api.deepseek.com/anthropic/",
    }))).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(providerEndpointUrl(descriptor({ baseURL: "" }))).toBe("");
  });
});
