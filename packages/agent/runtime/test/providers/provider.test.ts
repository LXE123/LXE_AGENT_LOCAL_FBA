import { messageFixture } from "../message-fixtures";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import providerCases from "./provider-cases.json";
import {
  adaptMessagesForProvider,
  AnthropicRuntimeProvider,
  AtomicRuntimeProviderManager,
  buildProviderRequest,
  buildSummaryThinkingPayload,
  buildSystemPayload,
  buildThinkingPayload,
  loadProviderDescriptor,
  normalizeThinkingEffort,
  normalizeProviderError,
  ProviderIdleWatchdog,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderMessage,
} from "../../src/providers/provider";
import { providerErrorStatusCode } from "../../src/providers/provider-errors";
import type { RuntimeContentBlock, RuntimeMessage, AssistantMessageEvent } from "../../src/engine/types";

describe("Anthropic-compatible provider", () => {
  test("loads the existing provider catalog and auth profile without changing env names", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi-coding",
      AGENT_LLM_MODEL: "kimi-code",
      AGENT_LLM_MAX_TOKENS: "1",
      AGENT_LLM_THINKING_DISPLAY: "summarized",
      LLM_REQUEST_TIMEOUT_S: "1",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(descriptor).toEqual(expect.objectContaining({
      name: "kimi_coding",
      model: "kimi-for-coding",
      baseURL: "https://api.kimi.com/coding/",
      apiKey: "secret-key",
      maxTokens: 32768,
      defaultHeaders: expect.objectContaining({ "User-Agent": `pi (${platform()} ${release()}; ${arch()})` }),
      thinkingStyle: "anthropic-budget",
      thinkingBudgetTokens: 16_000,
      thinkingLevels: ["low", "high", "max"],
      thinkingDefault: "high",
      thinkingEnabled: true,
      thinkingEffort: "high",
      thinkingDisplay: "omitted",
      contextWindowTokens: 262_144,
      requestIdleTimeoutMs: 120_000,
    }));
  });

  test("defaults to DeepSeek Flash low when no runtime model preference exists", () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      DEEPSEEK_API: "secret-key",
    });
    expect(descriptor).toEqual(expect.objectContaining({
      name: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      thinkingEffort: "low",
      thinkingDefault: "low",
    }));
  });

  test("loads OpenRouter ox-alpha through the shared Responses adapter", () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "open-router",
      AGENT_LLM_THINKING_EFFORT: "medium",
      OPENROUTER_API_KEY: "openrouter-secret",
    });
    expect(descriptor).toEqual(expect.objectContaining({
      name: "openrouter",
      model: "stealth/ox-alpha",
      apiStyle: "openai_responses",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "openrouter-secret",
      maxTokens: 131_072,
      contextWindowTokens: 1_048_576,
      supportsVision: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      thinkingEffort: "medium",
    }));
    expect(normalizeThinkingEffort("minimal", descriptor.thinkingLevels, descriptor.thinkingDefault))
      .toBe("minimal");
  });

  test("selects generic managed credentials only for the published local provider model and revision", () => {
    const revision = "b".repeat(64);
    const environment = {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-flash",
      AGENT_LLM_CREDENTIAL_SOURCE: "cloud",
      LXE_MANAGED_LLM_PROVIDER: "deepseek",
      LXE_MANAGED_LLM_MODEL: "deepseek-v4-flash",
      LXE_MANAGED_LLM_API_KEY: "managed-secret",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: revision,
      LXE_MANAGED_LLM_INVALID_REVISION: "",
    };
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), environment);
    expect(descriptor).toEqual(expect.objectContaining({
      name: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "managed-secret",
      credentialSource: "cloud",
      credentialRevision: revision,
    }));
    expect(() => loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      ...environment,
      LXE_MANAGED_LLM_INVALID_REVISION: revision,
    })).toThrow("managed LLM credential is unavailable");
    expect(() => loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      ...environment,
      AGENT_LLM_MODEL: "deepseek-v4-pro",
    })).toThrow("managed LLM credential is unavailable");

    const kimi = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      AGENT_LLM_CREDENTIAL_SOURCE: "cloud",
      LXE_MANAGED_LLM_PROVIDER: "kimi_coding",
      LXE_MANAGED_LLM_MODEL: "kimi-for-coding",
      LXE_MANAGED_LLM_API_KEY: "managed-kimi-secret",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: revision,
      LXE_MANAGED_LLM_INVALID_REVISION: "",
    });
    expect(kimi).toEqual(expect.objectContaining({
      name: "kimi_coding",
      model: "kimi-for-coding",
      apiKey: "managed-kimi-secret",
      credentialSource: "cloud",
    }));
  });

  test("builds fixed-budget K2.7 and output-effort-only K3 request controls", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    for (const effort of ["low", "high", "max"] as const) {
      expect(buildThinkingPayload({ ...kimi, thinkingEffort: effort })).toEqual({
        thinking: { type: "enabled", budget_tokens: 16_000 },
      });
    }
    expect(buildThinkingPayload({ ...kimi, thinkingEffort: "wild" })).toEqual({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    });
    expect(buildSummaryThinkingPayload(kimi)).toEqual({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    });

    const k3 = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "0",
      AGENT_LLM_THINKING_EFFORT: "off",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(k3).toEqual(expect.objectContaining({
      model: "k3",
      maxTokens: 131_072,
      contextWindowTokens: 262_144,
      thinkingStyle: "anthropic-output-effort",
      thinkingLevels: ["low", "high", "max"],
      thinkingDefault: "high",
      thinkingEnabled: true,
      thinkingEffort: "high",
    }));
    expect(buildThinkingPayload(k3)).toEqual({ output_config: { effort: "high" } });
    expect(buildSummaryThinkingPayload(k3)).toEqual({ output_config: { effort: "high" } });

    for (const effort of ["low", "high", "max"] as const) {
      const payload = buildThinkingPayload({ ...k3, thinkingEffort: effort });
      expect(payload).toEqual({ output_config: { effort } });
      expect(payload).not.toHaveProperty("thinking");
    }

    const standardRequest = buildProviderRequest(kimi, {
      system: "system", messages: [], tools: [], toolChoice: "none",
    });
    expect(standardRequest).toEqual(expect.objectContaining({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    }));
    expect(standardRequest).not.toHaveProperty("output_config");
    expect(standardRequest).not.toHaveProperty("temperature");
    const k3Request = buildProviderRequest({ ...k3, thinkingEffort: "low" }, {
      system: "system", messages: [], tools: [], toolChoice: "none",
    });
    expect(k3Request).toEqual(expect.objectContaining({ output_config: { effort: "low" } }));
    expect(k3Request).not.toHaveProperty("thinking");
    expect(k3Request).not.toHaveProperty("temperature");

    for (const [legacy, normalized] of [
      ["low", "low"], ["minimal", "low"], ["minimum", "low"], ["light", "low"],
      ["high", "high"], ["medium", "high"], ["max", "max"], ["xhigh", "max"], ["ultra", "max"],
      ["off", "high"], ["none", "high"], ["wild", "high"],
    ] as const) {
      expect(normalizeThinkingEffort(legacy, ["low", "high", "max"], "high")).toBe(normalized);
    }

    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API: "secret-key",
    });
    const deepseekFlash = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-flash",
      DEEPSEEK_API: "secret-key",
    });
    expect(deepseek).toEqual(expect.objectContaining({
      thinkingLevels: ["off", "high", "max"],
      thinkingDefault: "high",
      requestIdleTimeoutMs: 660_000,
    }));
    expect(deepseekFlash).toEqual(expect.objectContaining({
      thinkingLevels: ["off", "low", "high", "max"],
      thinkingDefault: "low",
      requestIdleTimeoutMs: 660_000,
    }));
    for (const [configured, expected] of [
      ["low", "high"], ["medium", "high"], ["high", "high"],
      ["xhigh", "max"], ["max", "max"], ["wild", "high"],
    ] as const) {
      expect(buildThinkingPayload({ ...deepseek, thinkingEffort: configured })).toEqual({
        thinking: { type: "enabled" },
        output_config: { effort: expected },
      });
    }
    expect(buildThinkingPayload({ ...deepseek, thinkingEffort: "off" })).toEqual({ thinking: { type: "disabled" } });
    expect(buildSummaryThinkingPayload({
      ...deepseek,
      thinkingEnabled: false,
      thinkingEffort: "off",
    }, 16_000)).toEqual({ thinking: { type: "disabled" } });
    expect(buildThinkingPayload({ ...deepseekFlash, thinkingEffort: "low" })).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "low" },
    });

    expect(buildProviderRequest(deepseek, {
      system: " stable \n\n<<system-prompt-cache-breakpoint>>\n\n volatile ",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    })).toEqual(expect.objectContaining({
      system: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: "volatile" },
      ],
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "none" },
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
      stream: true,
    }));
    expect(buildProviderRequest(deepseek, {
      system: "system",
      messages: [],
      tools: [],
      toolChoice: "none",
    })).not.toHaveProperty("tools");
    expect(buildSystemPayload(" system ")).toBe("system");
  });

  test("adds a stable opaque DeepSeek user id to turns and summaries only", async () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-flash",
      DEEPSEEK_API: "secret-key",
    });
    const identity = { platform: "feishu", userId: "user-123" };
    const expectedMetadata = {
      user_id: "lxe_b944e0a0e53aa6b3b7d408c97f7b483f0859c9b25c0114673b2c98e0c57cb1f3",
    };
    const turn = buildProviderRequest(deepseek, {
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
      userIdentity: identity,
    });
    expect(turn.metadata).toEqual(expectedMetadata);
    expect(JSON.stringify(turn)).not.toContain("user-123");
    expect(buildProviderRequest(deepseek, {
      system: "system",
      messages: [],
      tools: [],
      toolChoice: "none",
      userIdentity: { ...identity, platform: "desktop" },
    }).metadata).not.toEqual(expectedMetadata);
    expect(buildProviderRequest(deepseek, {
      system: "system",
      messages: [],
      tools: [],
      toolChoice: "none",
      userIdentity: { ...identity, userId: "user-123 " },
    }).metadata).not.toEqual(expectedMetadata);

    let captured: Record<string, unknown> = {};
    const provider = new AnthropicRuntimeProvider(deepseek, {
      messages: {
        stream: (parameters) => {
          captured = parameters;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: "summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          };
        },
      },
    });
    await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "history",
      maxOutputTokens: 16_000,
      userIdentity: identity,
    });
    expect(captured.metadata).toEqual(expectedMetadata);
    expect(JSON.stringify(captured)).not.toContain("user-123");

    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(buildProviderRequest(kimi, {
      system: "system",
      messages: [],
      tools: [],
      toolChoice: "none",
      userIdentity: identity,
    })).not.toHaveProperty("metadata");
  });

  test("uses the active K3 output effort and requested budget during summaries", async () => {
    const configured = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_EFFORT: "low",
      KIMI_CODE_API_KEY: "secret-key",
    });
    const descriptor = { ...configured, thinkingEffort: "low" };
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicRuntimeProvider(descriptor, {
      messages: {
        stream: (parameters) => {
          captured = parameters;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: "summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          };
        },
      },
    });

    await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "history",
      maxOutputTokens: 16_000,
    });

    expect(captured).toEqual(expect.objectContaining({
      model: "k3",
      max_tokens: 16_000,
      output_config: { effort: "low" },
      system: SUMMARY_SYSTEM_PROMPT,
    }));
    expect(SUMMARY_SYSTEM_PROMPT).toBe(`You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`);
    expect(captured).not.toHaveProperty("thinking");
    expect(captured).not.toHaveProperty("temperature");
  });

  test("clamps the fixed K2.7 thinking budget below the summary output budget", async () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      AGENT_LLM_THINKING_EFFORT: "max",
      KIMI_CODE_API_KEY: "secret-key",
    });
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicRuntimeProvider(descriptor, {
      messages: {
        stream: (parameters) => {
          captured = parameters;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: "summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          };
        },
      },
    });

    await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "midturn",
      maxOutputTokens: 10_000,
    });

    expect(captured).toEqual(expect.objectContaining({
      model: "kimi-for-coding",
      max_tokens: 10_000,
      thinking: { type: "enabled", budget_tokens: 8_976 },
    }));
    expect(captured).not.toHaveProperty("output_config");
    expect(captured).not.toHaveProperty("temperature");
  });

  test("restores provider preferences and ignores an invalid remembered model", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const restored = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL_KIMI_CODING: "k3",
      AGENT_LLM_THINKING_ENABLED_KIMI_CODING: "0",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "off",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(restored).toEqual(expect.objectContaining({
      model: "k3",
      thinkingEnabled: true,
      thinkingEffort: "high",
    }));

    const fallback = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "retired-model",
      AGENT_LLM_MODEL_KIMI_CODING: "retired-model",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "retired-effort",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(fallback).toEqual(expect.objectContaining({
      model: "kimi-for-coding",
      thinkingEffort: "high",
    }));
    expect(() => loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "retired-model",
      KIMI_CODE_API_KEY: "secret-key",
    })).toThrow("unsupported LLM model: kimi_coding/retired-model");
  });

  test("records the headers the SDK actually sends", async () => {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const body = [
      frame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1", type: "message", role: "assistant", model: "model-1",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");

    let received: Headers | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (incoming) => {
        received = incoming.headers;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const wireCalls: Array<{ kind: string; payload?: unknown }> = [];
    try {
      const provider = new AnthropicRuntimeProvider({
        name: "test",
        model: "model-1",
        apiStyle: "anthropic_messages",
        baseURL: server.url.origin,
        apiKey: "key",
        maxTokens: 1024,
        defaultHeaders: {},
        thinkingStyle: "anthropic-effort",
        thinkingLevels: ["off", "high", "max"],
        thinkingDefault: "high",
        thinkingEnabled: false,
        thinkingEffort: "off",
        thinkingDisplay: "omitted",
        contextWindowTokens: 200_000,
        requestIdleTimeoutMs: 30_000,
      });
      const result = await provider.turn({
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        toolChoice: "auto",
        signal: new AbortController().signal,
        wireTrace: {
          requestStart: (headers, payload) => wireCalls.push({ kind: "request_start", payload: { headers, payload } }),
          responseStart: (status, headers) => wireCalls.push({ kind: "response_start", payload: { status, headers } }),
          event: (event, payload) => wireCalls.push({ kind: "wire_event", payload: { event, payload } }),
          parseError: (event, data, error) => wireCalls.push({ kind: "parse_error", payload: { event, data, error } }),
          end: (ok, error) => wireCalls.push({ kind: "request_end", payload: { ok, error } }),
        },
      });
      expect(result.stopReason).toBe("stop");

      const start = wireCalls.find((call) => call.kind === "request_start")?.payload as
        { headers: Record<string, string> } | undefined;
      const headers = start?.headers ?? {};

      // Headers the SDK adds on its own. A reconstruction assembled before the
      // SDK merges its defaults cannot see any of these.
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["user-agent"]).toBeTruthy();
      expect(headers["x-api-key"]).toBe("key");

      // What was recorded is what the server received, field for field. An absent
      // header normalizes to "", which no assertion above accepts.
      const sent = (name: string): string => received?.get(name) ?? "";
      expect(headers["anthropic-version"]).toBe(sent("anthropic-version"));
      expect(headers["user-agent"]).toBe(sent("user-agent"));
      expect(headers["x-api-key"]).toBe(sent("x-api-key"));
    } finally {
      server.stop(true);
    }
  });

  test("uses SDK streaming and maps text and tool blocks into runtime types", async () => {
    let captured: Record<string, unknown> = {};
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wireCalls: Array<{ kind: string; payload?: unknown }> = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test",
        model: "model-1",
        apiStyle: "anthropic_messages",
        baseURL: "https://example.invalid",
        apiKey: "key",
        maxTokens: 1024,
        defaultHeaders: {},
        thinkingStyle: "anthropic-effort",
        thinkingLevels: ["off", "high", "max"],
        thinkingDefault: "high",
        thinkingEnabled: true,
        thinkingEffort: "max",
        thinkingDisplay: "omitted",
        contextWindowTokens: 200_000,
        requestIdleTimeoutMs: 30_000,
      },
      {
        messages: {
          stream: (parameters) => {
            captured = parameters;
            let response: Response | undefined;
            const stream = {
              on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
              get response() { return response; },
              get request_id() { return "req-1"; },
              finalMessage: async () => ({
                content: [
                  { type: "thinking", thinking: "reason", signature: "signed-reason" },
                  { type: "redacted_thinking", data: "encrypted-secret" },
                  { type: "text", text: "done" },
                  { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 3, output_tokens: 4 },
              }),
            };
            queueMicrotask(() => {
              response = new Response(null, {
                status: 200,
                headers: { "content-type": "text/event-stream", "request-id": "req-1" },
              });
              listeners.get("connect")?.();
              const events = [
                { type: "message_start", message: { id: "msg-1" } },
                { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
                { type: "content_block_stop", index: 0 },
                { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "encrypted-secret" } },
                { type: "content_block_stop", index: 1 },
                { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" } },
                { type: "content_block_stop", index: 2 },
                { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } },
                { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"text\":" } },
                { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "\"hi\"}" } },
                { type: "content_block_stop", index: 3 },
              ];
              for (const event of events) listeners.get("streamEvent")?.(event, {});
            });
            return stream;
          },
        },
      },
    );
    const deltas: unknown[] = [];
    const result = await provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "echo", description: "echo", input_schema: { type: "object" } }],
      toolChoice: "auto",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: (headers, payload) => wireCalls.push({ kind: "request_start", payload: { headers, payload } }),
        responseStart: (status, headers) => wireCalls.push({ kind: "response_start", payload: { status, headers } }),
        event: (event, payload) => wireCalls.push({ kind: "wire_event", payload: { event, payload } }),
        parseError: (event, data, error) => wireCalls.push({ kind: "parse_error", payload: { event, data, error } }),
        end: (ok, error) => wireCalls.push({ kind: "request_end", payload: { ok, error } }),
      },
      onEvent: async (event) => { deltas.push(event); },
    });
    expect(captured).toEqual(expect.objectContaining({
      model: "model-1",
      stream: true,
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    }));
    expect(result).toMatchObject({
      content: [
        { type: "thinking", thinking: "reason", thinkingSignature: "signed-reason" },
        { type: "thinking", redacted: true, thinkingSignature: "encrypted-secret" },
        { type: "text", text: "done" },
        { type: "tool_call", id: "t1", name: "echo", arguments: { text: "hi" } },
      ], stopReason: "toolUse", usage: { input_tokens: 3, output_tokens: 4, status: "complete" },
    });
    expect(deltas.map((event) => (event as { type: string }).type)).toEqual([
      "start", "thinking_start", "thinking_delta", "thinking_end", "thinking_start", "thinking_end", "text_start", "text_delta",
      "text_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
    ]);
    expect(deltas.filter((event) => (event as { type: string }).type === "text_delta"))
      .toMatchObject([{ type: "text_delta", contentIndex: 2, delta: "done" }]);

    expect(deltas.filter((event) => (event as { type: string }).type === "toolcall_delta"))
      .toMatchObject([{ contentIndex: 3, delta: '{"text":' }, { contentIndex: 3, delta: '"hi"}' }]);
    expect(wireCalls.filter((call) => call.kind === "wire_event")).toHaveLength(13);
    // An injected client never reaches the fetch boundary, so this turn sends no
    // HTTP request and there are no request headers to record. Recording a
    // reconstructed request_start here would put a guess in the trace; the real
    // headers are covered by "records the headers the SDK actually sends" below.
    expect(wireCalls.map((call) => call.kind).filter((kind) => kind !== "wire_event")).toEqual([
      "response_start", "request_end",
    ]);
    expect(wireCalls[0]?.payload).toEqual({
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req-1" },
    });
    expect(wireCalls.at(-1)?.payload).toEqual({ ok: true, error: "" });

    const summary = await provider.summarize({
      messages: [{ role: "user", content: "summarize this" }],
      signal: new AbortController().signal,
      kind: "history",
      maxOutputTokens: 16_000,
    });
    expect(captured).toEqual(expect.objectContaining({
      model: "model-1",
      max_tokens: 1024,
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "summarize this" }],
    }));
    expect(captured).not.toHaveProperty("tools");
    expect(summary).toEqual({
      text: "done",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  test("adapts unsupported DeepSeek blocks and classifies provider failures", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API: "secret-key",
    });
    const adapted = adaptMessagesForProvider([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", signature: "provider-signature" },
        { type: "redacted_thinking", data: "encrypted" },
        { type: "text", text: "answer" },
        { type: "unknown-provider-block", secret: "must-not-cross" },
      ],
    }, {
      role: "user",
      content: [
        { type: "text", text: "see attached" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "base64-secret" } },
        { type: "document", data: "unsupported-document" },
      ],
    }, {
      role: "tool",
      content: [{
        type: "tool_result",
        tool_call_id: "tool-1",
        content: [
          { type: "text", text: "ok" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "tool-image" } },
          { type: "document", data: "tool-document" },
        ],
      }],
    }], descriptor);
    expect(adapted).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "[redacted thinking omitted: DeepSeek Anthropic API does not support redacted_thinking content]" },
          { type: "text", text: "answer" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "text", text: "[image omitted: the selected model does not support image content]" },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "ok\n[image omitted: the selected model does not support image content]",
        }],
      },
    ]);
    expect(JSON.stringify(adapted)).not.toContain("signature");
    expect(JSON.stringify(adapted)).not.toContain("must-not-cross");
    expect(JSON.stringify(adapted)).not.toContain("unsupported-document");
    expect(JSON.stringify(adapted)).not.toContain("tool-document");
    expect(normalizeProviderError({ status: 401, message: "Invalid Authentication" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: false, category: "认证失败" }));
    expect(normalizeProviderError({ status: 503, message: "Server overloaded" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: true, category: "服务器繁忙" }));
  });

  test("projects structured compaction checkpoints as pi-style user messages", () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API: "secret-key",
    });
    const adapted = adaptMessagesForProvider([{
      role: "compactionSummary",
      summary: "checkpoint body",
      tokensBefore: 12_345,
      details: { readFiles: ["src/read.ts"], modifiedFiles: [] },
    }], descriptor);
    expect(adapted).toEqual([{
      role: "user",
      content: [{
        type: "text",
        text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ncheckpoint body\n</summary>",
      }],
    }]);
    expect(JSON.stringify(adapted)).not.toContain("compactionSummary");
  });

  test("adapts local-file blocks into exact-path model instructions while retaining image input", () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    const adapted = adaptMessagesForProvider([{
      role: "user",
      content: [
        {
          type: "local_file",
          attachment_id: "attachment-1",
          turn_id: "turn-1",
          path: "/private/input/report.csv",
          name: "report.csv",
          size_bytes: 10,
          media_type: "text/csv",
          ts: 1,
        },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "encoded" } },
        { type: "text", text: "analyze it" },
      ],
    }], descriptor);
    expect(adapted).toEqual([{
      role: "user",
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('Absolute path: "/private/input/report.csv"'),
        }),
        expect.objectContaining({ type: "image" }),
        { type: "text", text: "analyze it" },
      ],
    }]);
  });

  test("maps canonical tool and system messages only at the Provider boundary", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(adaptMessagesForProvider([
      { role: "system", content: "background event" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "exec", arguments: { command: "pwd" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok", is_error: true }],
      },
    ], descriptor)).toEqual([
      { role: "user", content: "[System Message]\nbackground event" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "exec", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: true }],
      },
    ]);
  });

  test("resets the idle watchdog on activity without imposing a total duration limit", async () => {
    const parent = new AbortController();
    const watchdog = new ProviderIdleWatchdog(parent.signal, 30);
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(15);
      expect(watchdog.signal.aborted).toBe(false);
      watchdog.activity();
    }
    expect(watchdog.signal.aborted).toBe(false);
    await Bun.sleep(45);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut()).toBe(true);
    watchdog.cleanup();
  });

  test("keeps parent cancellation distinct from an idle timeout", () => {
    const parent = new AbortController();
    const watchdog = new ProviderIdleWatchdog(parent.signal, 1_000);
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut()).toBe(false);
    watchdog.cleanup();
  });

  test("uses provider-specific body classification instead of a generic status regex", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(normalizeProviderError({ status: 402, error: { message: "unable to verify membership benefits" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: true, category: "会员权益异常" }));
    for (const message of [
      "Your current subscription does not have access to k3.",
      "Your current plan supports only kimi-k3 up to 256K context.",
      "Your current subscription does not have access to kimi-for-coding-highspeed.",
    ]) {
      expect(normalizeProviderError({ status: 401, error: { message } }, kimi))
        .toEqual(expect.objectContaining({ retryable: false, category: "权限错误" }));
    }
    expect(normalizeProviderError({ status: 401, error: { message: "The API Key appears to be invalid" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, category: "认证错误" }));
    expect(normalizeProviderError({ status: 429, body: { message: "kimi monthly usage limit" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: true, category: "限流与配额" }));
    expect(normalizeProviderError({ status: 400, body: { message: "input is too long" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, contextOverflow: true }));
  });

  test("matches Kimi and DeepSeek request and error expectations", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding", AGENT_LLM_MODEL: "kimi-for-coding", KIMI_CODE_API_KEY: "secret-key",
    });
    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-pro", DEEPSEEK_API: "secret-key",
    });
    const deepseekFlash = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash", DEEPSEEK_API: "secret-key",
    });
    for (const fixture of providerCases.kimi_thinking_cases) {
      expect(buildThinkingPayload({
        ...kimi,
        thinkingEnabled: fixture.enabled,
        thinkingEffort: fixture.effort,
        maxTokens: fixture.max_tokens,
      })).toEqual(fixture.expected);
    }
    for (const fixture of providerCases.deepseek_effort_cases) {
      const descriptor = fixture.model === "deepseek-v4-flash" ? deepseekFlash : deepseek;
      expect(buildThinkingPayload({ ...descriptor, thinkingEffort: fixture.configured })).toEqual({
        thinking: { type: "enabled" }, output_config: { effort: fixture.expected },
      });
    }
    expect(adaptMessagesForProvider(
      providerCases.deepseek_history.canonical as RuntimeMessage[],
      deepseek,
    )).toEqual(providerCases.deepseek_history.expected as ProviderMessage[]);
    for (const fixture of providerCases.nested_error_cases) {
      const descriptor = fixture.provider === "deepseek" ? deepseek : kimi;
      const source = { error: { type: "error", error: { message: "request failed", status_code: fixture.status } } };
      expect(providerErrorStatusCode(source)).toBe(fixture.status);
      expect(normalizeProviderError(source, descriptor)).toEqual(expect.objectContaining({
        statusCode: fixture.status,
        category: fixture.category,
        retryable: fixture.retryable,
      }));
    }
    for (const fixture of providerCases.context_error_cases) {
      const descriptor = fixture.provider === "deepseek" ? deepseek : kimi;
      expect(normalizeProviderError({
        error: { error: { status_code: fixture.status, message: fixture.message } },
      }, descriptor)).toEqual(expect.objectContaining({
        statusCode: fixture.status,
        category: fixture.category,
        contextOverflow: true,
        retryable: false,
      }));
    }
  });

  test("restores initial stream blocks without duplicating redacted thinking", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fixture = providerCases.stream;
    const parseErrors: unknown[] = [];
    const runtimeEvents: AssistantMessageEvent[] = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "kimi_coding", model: "fixture", baseURL: "https://example.invalid", apiKey: "secret",
        apiStyle: "anthropic_messages",
        maxTokens: 4_096, defaultHeaders: {}, thinkingStyle: "anthropic-adaptive",
        thinkingLevels: ["off", "low", "medium", "high"], thinkingDefault: "medium", thinkingEnabled: true,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 256_000, requestIdleTimeoutMs: 120_000,
      },
      { messages: { stream: () => {
        const stream = {
          on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
          finalMessage: async () => fixture.final_message,
        };
        queueMicrotask(() => {
          for (const event of fixture.events) {
            listeners.get("streamEvent")?.(event, {});
            if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
              listeners.get("thinking")?.(event.delta.thinking, event.delta.thinking);
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              listeners.get("text")?.(event.delta.text, event.delta.text);
            }
            if (event.type === "content_block_stop" && event.index === 2) {
              listeners.get("contentBlock")?.(fixture.redacted_completion);
            }
          }
        });
        return stream;
      } } },
    );
    const response = await provider.turn({
      system: "system", messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none",
      signal: new AbortController().signal,
      onEvent: (event) => { runtimeEvents.push(event); },
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: (...values) => { parseErrors.push(values); },
        end: () => undefined,
      },
    });

    expect(runtimeEvents[0]?.type).toBe("start");
    expect(runtimeEvents.at(-1)).toEqual({ type: "done", reason: "toolUse", message: response });
    expect(runtimeEvents.filter((event) => event.type === "thinking_delta").map((event) => "delta" in event ? event.delta : ""))
      .toEqual(["plan", " more"]);
    expect(runtimeEvents.filter((event) => event.type === "text_delta").map((event) => "delta" in event ? event.delta : ""))
      .toEqual(["Hello", " world"]);
    expect(response.content.filter((block) => block.type === "thinking" && block.redacted)).toHaveLength(1);
    expect(parseErrors).toEqual([]);
    expect(response).toMatchObject({ stopReason: "toolUse", usage: { input_tokens: 3, output_tokens: 7, status: "complete" } });

  });

  test("closes wire attempts on transport failure without letting diagnostics replace the Provider error", async () => {
    const terminal: Array<{ ok: boolean; error?: string }> = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test",
        model: "model-1",
        apiStyle: "anthropic_messages",
        baseURL: "https://example.invalid",
        apiKey: "key",
        maxTokens: 1024,
        defaultHeaders: {},
        thinkingStyle: "none",
        thinkingLevels: ["off"],
        thinkingDefault: "off",
        thinkingEnabled: false,
        thinkingEffort: "low",
        thinkingDisplay: "omitted",
        contextWindowTokens: 200_000,
        requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => { throw new Error("transport failed token=private"); } } },
    );
    await expect(provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: () => undefined,
        end: (ok, error) => terminal.push({ ok, ...(error === undefined ? {} : { error }) }),
      },
    })).rejects.toThrow("transport failed");
    expect(terminal).toEqual([{ ok: false, error: "transport failed token=private" }]);
  });

  test("ignores wire listener registration failures while preserving the Provider result", async () => {
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test", model: "model-1", baseURL: "https://example.invalid", apiKey: "key",
        apiStyle: "anthropic_messages",
        maxTokens: 1024, defaultHeaders: {}, thinkingStyle: "none",
        thinkingLevels: ["off"], thinkingDefault: "off", thinkingEnabled: false,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 200_000, requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => ({
        on: (event: string) => {
          if (event === "streamEvent") throw new Error("diagnostic listener rejected");
          return undefined;
        },
        finalMessage: async () => ({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }) } },
    );
    const result = await provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: () => undefined,
        end: () => undefined,
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("fails requests on stream conversion errors while retaining wire diagnostics", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const parseErrors: Array<{ event: string; error: unknown }> = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test", model: "model-1", baseURL: "https://example.invalid", apiKey: "key",
        apiStyle: "anthropic_messages",
        maxTokens: 1_024, defaultHeaders: {}, thinkingStyle: "none",
        thinkingLevels: ["off"], thinkingDefault: "off", thinkingEnabled: false,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 200_000, requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => {
        const stream = {
          on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
          finalMessage: async () => ({
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        };
        queueMicrotask(() => listeners.get("streamEvent")?.({
          type: "content_block_start",
          index: 0,
          get content_block() { throw new Error("malformed block"); },
        }));
        return stream;
      } } },
    );
    await expect(provider.turn({
      system: "system", messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: (event, _data, error) => { parseErrors.push({ event, error }); },
        end: () => undefined,
      },
    })).rejects.toThrow("malformed block");
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.event).toBe("content_block_start");
    expect(String(parseErrors[0]?.error)).toContain("malformed block");
  });

  test("atomically reconfigures the provider for the next turn", async () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const environment: Record<string, string> = {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "kimi-key",
      DEEPSEEK_API: "deepseek-key",
    };
    const created: string[] = [];
    const persisted: Array<Record<string, string>> = [];
    const manager = new AtomicRuntimeProviderManager(projectRoot, environment, (descriptor) => {
      created.push(`${descriptor.name}/${descriptor.model}`);
      return {
        summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async () => messageFixture(),
      };
    });
    const first = manager.acquire();
    await first.provider.turn({
      system: "",
      messages: [],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
    });
    const next = await manager.reconfigure({ provider: "deepseek", model: "deepseek-v4-flash" }, (patch) => {
      persisted.push(patch);
    });
    await next.provider.turn({
      system: "",
      messages: [],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
    });
    expect(first.descriptor.name).toBe("kimi_coding");
    expect(next).toEqual(expect.objectContaining({ generation: 2 }));
    expect(next.descriptor).toEqual(expect.objectContaining({ name: "deepseek", model: "deepseek-v4-flash" }));
    expect(environment.AGENT_LLM_PROVIDER).toBe("deepseek");
    expect(persisted).toEqual([expect.objectContaining({ AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash" })]);
    expect(created).toEqual(["kimi_coding/kimi-for-coding", "deepseek/deepseek-v4-flash"]);
  });

  test("keeps the managed target and key frozen in an acquired turn snapshot", async () => {
    const environment: Record<string, string> = {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      AGENT_LLM_CREDENTIAL_SOURCE: "cloud",
      LXE_MANAGED_LLM_PROVIDER: "kimi_coding",
      LXE_MANAGED_LLM_MODEL: "kimi-for-coding",
      LXE_MANAGED_LLM_API_KEY: "old-kimi-key",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: "a".repeat(64),
      LXE_MANAGED_LLM_INVALID_REVISION: "",
    };
    const used: string[] = [];
    const manager = new AtomicRuntimeProviderManager(
      repositoryRoot(import.meta.dir),
      environment,
      (descriptor) => ({
        summarize: async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async () => {
          used.push(`${descriptor.name}/${descriptor.model}/${descriptor.apiKey}`);
          return messageFixture();
        },
      }),
    );
    const activeTurnSnapshot = manager.acquire();
    Object.assign(environment, {
      LXE_MANAGED_LLM_PROVIDER: "deepseek",
      LXE_MANAGED_LLM_MODEL: "deepseek-v4-flash",
      LXE_MANAGED_LLM_API_KEY: "new-deepseek-key",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: "b".repeat(64),
    });
    const nextTurnSnapshot = await manager.reconfigure({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      credentialSource: "cloud",
    });
    const request = {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "none" as const,
      signal: new AbortController().signal,
    };
    await activeTurnSnapshot.provider.turn(request);
    await nextTurnSnapshot.provider.turn(request);
    expect(used).toEqual([
      "kimi_coding/kimi-for-coding/old-kimi-key",
      "deepseek/deepseek-v4-flash/new-deepseek-key",
    ]);
  });

  test("loads without a key and resolves auth.json for each provider call", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-provider-auth-"));
    const authPath = join(root, "config", "auth.json");
    mkdirSync(join(root, "config"), { recursive: true });
    const observedKeys: string[] = [];
    const manager = new AtomicRuntimeProviderManager(
      repositoryRoot(import.meta.dir),
      { AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash" },
      (descriptor) => {
        observedKeys.push(descriptor.apiKey);
        return {
          summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
          turn: async () => messageFixture(),
        };
      },
      undefined,
      authPath,
    );
    const provider = manager.acquire().provider;
    const request = {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "none" as const,
      signal: new AbortController().signal,
    };

    expect(manager.acquire().descriptor.apiKey).toBe("");
    await expect(provider.turn(request)).rejects.toMatchObject({
      category: "模型未配置",
      userMessage: expect.stringContaining("API Key"),
    });
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "local-one" } }));
    await provider.turn(request);
    writeFileSync(authPath, JSON.stringify({}));
    await expect(provider.turn(request)).rejects.toMatchObject({ category: "模型未配置" });
    expect(observedKeys).toEqual(["local-one"]);
    rmSync(root, { recursive: true, force: true });
  });
});
