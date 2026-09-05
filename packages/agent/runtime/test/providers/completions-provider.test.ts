import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadLlmProviderCatalog, repositoryRoot } from "@lxe/core";
import type { RuntimeMessage, AssistantMessageEvent } from "../../src/engine/types";
import {
  adaptMessagesForCompletions,
  buildCompletionsRequest,
  CompletionsRuntimeProvider,
  type CompletionsClientPort,
} from "../../src/providers/completions-provider";
import { createRuntimeProvider } from "../../src/providers/provider-factory";
import {
  adaptMessagesForProvider,
  loadProviderDescriptor,
  normalizeProviderError,
  providerEndpointUrl,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderDescriptor,
} from "../../src/providers/provider";

const descriptor = (patch: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  name: "zhipuai_coding_plan",
  model: "glm-5.3-flash",
  apiStyle: "openai_completions",
  baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "key",
  maxTokens: 131_072,
  defaultHeaders: {},
  thinkingStyle: "zai",
  toolStream: true,
  thinkingLevels: ["low", "high", "max"],
  thinkingDefault: "max",
  thinkingEnabled: true,
  thinkingEffort: "max",
  thinkingDisplay: "omitted",
  contextWindowTokens: 1_000_000,
  supportsVision: true,
  requestIdleTimeoutMs: 1_000,
  ...patch,
});

const fakeClient = (
  chunks: unknown[],
  captured?: { body?: Record<string, unknown> },
): CompletionsClientPort => ({
  chat: {
    completions: {
      create(body) {
        if (captured) captured.body = body;
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        };
      },
    },
  },
});

describe("ZhipuAI Chat Completions provider", () => {
  test("loads both domestic providers with separate credentials and duplicate model ids", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = loadLlmProviderCatalog(join(root, "config", "llm"));
    for (const provider of ["zhipuai", "zhipuai_coding_plan"]) {
      const spec = catalog.requireProvider(provider);
      expect(Object.values(spec.models).map((model) => model.supportsTemperature)).toEqual([false, false]);
    }
    const coding = loadProviderDescriptor(root, {
      AGENT_LLM_PROVIDER: "zhipuai-coding-plan",
      ZHIPUAI_CODING_PLAN_API_KEY: "coding-key",
    });
    expect(coding).toEqual(expect.objectContaining({
      name: "zhipuai_coding_plan",
      model: "glm-5.3-flash",
      apiStyle: "openai_completions",
      baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "coding-key",
      contextWindowTokens: 1_000_000,
      maxTokens: 131_072,
      supportsVision: true,
      thinkingLevels: ["low", "high", "max"],
      thinkingDefault: "max",
      thinkingEnabled: true,
      thinkingEffort: "max",
      toolStream: true,
    }));
    expect(providerEndpointUrl(coding)).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
    expect(createRuntimeProvider(coding)).toBeInstanceOf(CompletionsRuntimeProvider);

    const standard = loadProviderDescriptor(root, {
      AGENT_LLM_PROVIDER: "zhipuai",
      AGENT_LLM_MODEL: "glm-5.3",
      ZHIPUAI_API_KEY: "metered-key",
    });
    expect(standard).toEqual(expect.objectContaining({
      name: "zhipuai",
      model: "glm-5.3",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "metered-key",
      supportsVision: false,
    }));
    expect(providerEndpointUrl(standard)).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");

    expect(loadProviderDescriptor(root, {
      AGENT_LLM_PROVIDER: "zhipuai_coding_plan",
      ZAI_CODING_CN_API_KEY: "legacy-coding-key",
    }).apiKey).toBe("legacy-coding-key");
    expect(loadProviderDescriptor(root, {
      AGENT_LLM_PROVIDER: "zhipuai",
      ZHIPU_API_KEY: "legacy-metered-key",
    }).apiKey).toBe("legacy-metered-key");
  });

  test("builds the ZAI body without Responses or Anthropic-only fields", () => {
    const history: RuntimeMessage[] = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "keep exactly", signature: "reasoning_content" },
        { type: "thinking", thinking: "do not cross", signature: "anthropic-signature" },
        { type: "text", text: "checking" },
        { type: "tool_call", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      ],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "call_1", content: "ok" }],
    }, {
      role: "user",
      content: [
        { type: "text", text: "continue" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ],
    }];
    for (const effort of ["low", "high", "max"]) {
      const body = buildCompletionsRequest(descriptor({ thinkingEffort: effort }), {
        system: " system prompt ",
        messages: history,
        tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
        toolChoice: "auto",
      });
      expect(body).toEqual(expect.objectContaining({
        model: "glm-5.3-flash",
        max_tokens: 131_072,
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "enabled", clear_thinking: false },
        reasoning_effort: effort,
        tool_choice: "auto",
        tool_stream: true,
      }));
      expect(body.messages).toEqual([
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: "checking",
          reasoning_content: "keep exactly",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "{\"path\":\"a.ts\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        {
          role: "user",
          content: [
            { type: "text", text: "continue" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
      ]);
      expect(body.tools).toEqual([{
        type: "function",
        function: { name: "read", description: "Read a file", parameters: { type: "object" } },
      }]);
      expect(body).not.toHaveProperty("instructions");
      expect(body).not.toHaveProperty("input");
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(body).not.toHaveProperty("store");
      expect(body).not.toHaveProperty("temperature");
    }

    const withoutTools = buildCompletionsRequest(descriptor(), {
      system: "",
      messages: [],
      tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
      toolChoice: "none",
    });
    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.tool_choice).toBeUndefined();
    expect(withoutTools.tool_stream).toBeUndefined();
  });

  test("omits images for the text model and keeps protocol reasoning isolated", () => {
    expect(adaptMessagesForCompletions([{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
    }], false)).toEqual([{
      role: "user",
      content: [{ type: "text", text: "[image omitted: the selected model does not support image content]" }],
    }]);

    const kimi = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      KIMI_CODE_API_KEY: "key",
    });
    expect(adaptMessagesForProvider([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "glm thought", signature: "reasoning_content" },
        { type: "thinking", thinking: "kimi thought", signature: "kimi-signature" },
        { type: "text", text: "answer" },
      ],
    }], kimi)).toEqual([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "kimi thought", signature: "kimi-signature" },
        { type: "text", text: "answer" },
      ],
    }]);
  });

  test("runs normal and summary streams through the same Chat Completions wire", async () => {
    const turnBody: { body?: Record<string, unknown> } = {};
    const provider = new CompletionsRuntimeProvider(descriptor({ thinkingEffort: "high" }), fakeClient([
      { choices: [{ delta: { reasoning_content: "why" }, finish_reason: null }] },
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ], turnBody));
    const seen: AssistantMessageEvent[] = [];
    const turn = await provider.turn({
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onEvent: async (event) => { seen.push(event); },
    });
    expect(turn.stopReason).toBe("stop");
    expect(turn.content).toEqual([
      { type: "thinking", thinking: "why", thinkingSignature: "reasoning_content" },
      { type: "text", text: "done" },
    ]);
    expect(seen.at(-1)?.type).toBe("done");
    expect(turnBody.body).toEqual(expect.objectContaining({ reasoning_effort: "high" }));

    const summaryBody: { body?: Record<string, unknown> } = {};
    const summarizer = new CompletionsRuntimeProvider(descriptor({ thinkingEffort: "low" }), fakeClient([
      { choices: [{ delta: { reasoning_content: "condense" }, finish_reason: null }] },
      { choices: [{ delta: { content: "summary" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ], summaryBody));
    const summary = await summarizer.summarize({
      messages: [{ role: "user", content: "long history" }],
      signal: new AbortController().signal,
      kind: "history",
      maxOutputTokens: 700,
    });
    expect(summary.text).toBe("summary");
    expect(summaryBody.body).toEqual(expect.objectContaining({
      max_tokens: 700,
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: "low",
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: "long history" },
      ],
    }));
    expect(summaryBody.body).not.toHaveProperty("tools");
  });

  test("uses the OpenAI SDK against the Chat Completions endpoint", async () => {
    let received: { authorization: string; body: Record<string, unknown>; pathname: string } | undefined;
    const chunks = [
      { id: "chat_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { id: "chat_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chat_1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received = {
          authorization: request.headers.get("authorization") ?? "",
          body: await request.json() as Record<string, unknown>,
          pathname: new URL(request.url).pathname,
        };
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider = new CompletionsRuntimeProvider(descriptor({
        baseURL: `${server.url.origin}/api/paas/v4`,
        apiKey: "sdk-test-key",
      }));
      expect(await provider.turn({
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        toolChoice: "auto",
        signal: new AbortController().signal,
      })).toEqual(expect.objectContaining({ stopReason: "stop" }));
      expect(received).toEqual(expect.objectContaining({
        authorization: "Bearer sdk-test-key",
        pathname: "/api/paas/v4/chat/completions",
        body: expect.objectContaining({
          model: "glm-5.3-flash",
          stream: true,
          stream_options: { include_usage: true },
        }),
      }));
    } finally {
      server.stop(true);
    }
  });

  test("classifies official Zhipu business codes before their shared HTTP status", () => {
    const target = descriptor();
    const cases = [
      [401, "1000", "认证失败", false, false],
      [401, "1005", "账号安全限制", false, false],
      [429, "1113", "余额不足", false, false],
      [400, "1211", "模型不存在", false, false],
      [400, "1261", "上下文超限", false, true],
      [429, "1302", "请求限流", true, false],
      [429, "1304", "套餐额度限制", false, false],
      [429, "1305", "服务繁忙", true, false],
      [429, "1311", "权限错误", false, false],
      [429, "1317", "套餐额度限制", false, false],
      [500, "1230", "服务端错误", true, false],
    ] as const;
    for (const [status, code, category, retryable, contextOverflow] of cases) {
      expect(normalizeProviderError({ status, error: { code, message: "actual provider message" } }, target))
        .toEqual(expect.objectContaining({ statusCode: status, category, retryable, contextOverflow }));
    }
  });
});
