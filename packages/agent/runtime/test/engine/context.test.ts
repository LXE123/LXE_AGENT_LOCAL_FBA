import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JsonObject } from "@lxe/protocol";
import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import {
  ContextPipeline,
  HISTORY_SUMMARY_PROMPT,
  IMAGE_TOKEN_ESTIMATE,
  MIDTURN_SUMMARY_PROMPT,
  estimateTokens,
  pruneProcessedHistoryImages,
  requestContextTokenEstimate,
  sanitizeMessagesForProvider,
  trimTextToTokenBudget,
  trimToolResultBlocks,
  UPDATE_HISTORY_SUMMARY_PROMPT,
  validateToolCallClosure,
} from "../../src/engine/context";
import { RuntimeProviderError } from "../../src/providers/provider-errors";
import type {
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  RuntimeSummaryRequest,
  RuntimeSummaryResult,
  ToolResultBlock,
} from "../../src/engine/types";

const workspace = resolveWorkspaceContext(repositoryRoot(import.meta.dir));

class MemoryStore implements RuntimeStore {
  messages: RuntimeMessage[] = [];
  replacements: Array<{ kind: string; messages: RuntimeMessage[]; metadata: JsonObject }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(): Promise<{ session_id: string; source: JsonObject; workspace: typeof workspace }> {
    return { session_id: "s1", source: {}, workspace };
  }
  async popPendingEvents(): Promise<JsonObject[]> { return []; }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendTurnContext(): Promise<void> {}
  async appendArtifact(): Promise<void> {}
  async appendTurnError(): Promise<void> {}
  async resolveArtifact(): Promise<undefined> { return undefined; }
  async resolveAttachment(): Promise<undefined> { return undefined; }
  async attachmentPaths(): Promise<string[]> { return []; }
  async appendMessage(_sessionId: string, message: RuntimeMessage): Promise<void> { this.messages.push(message); }
  async replaceMessages(_sessionId: string, messages: RuntimeMessage[], kind: "compaction" | "repair" | "history_limit" | "context_replacement", metadata: JsonObject = {}): Promise<void> {
    this.messages = structuredClone(messages);
    this.replacements.push({ kind, messages: structuredClone(messages), metadata: structuredClone(metadata) });
  }
  async patchSessionState(): Promise<void> {}
  async recordTurn(): Promise<void> {}
}

class SummaryProvider implements RuntimeProvider {
  requests: RuntimeSummaryRequest[] = [];
  summaries: Array<string | Error> = ["compact summary"];
  async turn(): Promise<never> { throw new Error("turn not expected"); }
  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    this.requests.push(request);
    const value = this.summaries.shift() ?? "compact summary";
    if (value instanceof Error) throw value;
    return { text: value, usage: { input_tokens: 7, output_tokens: 3 } };
  }
}

const summaryProviderError = (retryable: boolean, message = "summary unavailable"): RuntimeProviderError =>
  new RuntimeProviderError(message, "test", "测试错误", message, retryable);

const closedTurn = (label: string, size = 0): RuntimeMessage[] => [
  { role: "user", content: `${label} request ${"u".repeat(size)}` },
  { role: "assistant", content: [{ type: "text", text: `${label} answer ${"a".repeat(size)}` }] },
];

const checkpoint = (
  summary: string,
  details: { readFiles: string[]; modifiedFiles: string[] } = { readFiles: [], modifiedFiles: [] },
): RuntimeMessage => ({ role: "compactionSummary", summary, tokensBefore: 1_000, details });

const summaryPrompt = (provider: SummaryProvider, index = 0): string => {
  const message = provider.requests[index]?.messages[0];
  return message?.role === "user" ? String(message.content) : "";
};

describe("token-aware runtime context", () => {
  test("reserves pending environment tokens before deciding whether compaction is necessary", async () => {
    const messages = [...closedTurn("old", 1000), { role: "user" as const, content: "next" }];
    const tokens = requestContextTokenEstimate("", messages);
    const pipeline = new ContextPipeline({ store: new MemoryStore(), provider: new SummaryProvider(), contextWindowTokens: tokens + 200, reserveTokens: 100, preCallThreshold: 1, recentRawTokens: 50 });
    const params = { sessionId: "s1", messages, systemPrompt: "", toolSchemas: [], signal: new AbortController().signal };
    expect((await pipeline.prepare(params)).compacted).toBe(false);
    const prepared = await pipeline.prepare({ ...params, additionalContextTokens: 150 });
    expect(prepared.compacted).toBe(true);
    expect(prepared.afterTokens + 150).toBeLessThanOrEqual(pipeline.hardLimitTokens);
  });

  test("pins pi's history, update, and turn-prefix prompts byte-for-byte", () => {
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    expect(hash(HISTORY_SUMMARY_PROMPT)).toBe("9b00aa68df1a64279bc36e9093367f638701d48ec82e3d08436f65092a515f9b");
    expect(hash(UPDATE_HISTORY_SUMMARY_PROMPT)).toBe("240c52982209146eae47d73c7172f6ba1dab60f44520bcb6a6ec1a883fef2ec7");
    expect(hash(MIDTURN_SUMMARY_PROMPT)).toBe("9aeeb36ea731a8497d38abb03c2da351d81bcade4b2ae389bb6ae74300cf6ba5");
  });

  test("estimates UTF-8, JSON, schemas and images without counting base64 bytes", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(70_000) } };
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("中文")).toBe(2);
    expect(estimateTokens(image)).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(estimateTokens([image])).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
    const messages: RuntimeMessage[] = [{ role: "user", content: "hello" }];
    const withoutTools = requestContextTokenEstimate("system", messages);
    const withTools = requestContextTokenEstimate("system", messages, [{
      name: "search",
      description: "search a catalog",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    }]);
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  test("repairs closure while preserving signed and redacted canonical thinking", () => {
    const messages: RuntimeMessage[] = [
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "orphan", content: "drop" }] },
      { role: "user", content: "run" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "reason", signature: "signed" },
        { type: "redacted_thinking", data: "encrypted" },
        { type: "tool_call", id: "t1", name: "exec", arguments: { command: "date" } },
      ] },
    ];
    const repaired = sanitizeMessagesForProvider(messages);
    expect(repaired.changed).toBe(true);
    expect(JSON.stringify(repaired.messages)).toContain("signed");
    expect(JSON.stringify(repaired.messages)).toContain("encrypted");
    expect(JSON.stringify(repaired.messages)).not.toContain("orphan");
    expect(repaired.messages.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool_result",
        tool_call_id: "t1",
        content: "[Result unavailable — see context summary above]",
        is_error: true,
      }],
    });
    expect(() => validateToolCallClosure(repaired.messages)).not.toThrow();
  });

  test("never sends thinking signatures or encrypted redacted data to the summarizer", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages: RuntimeMessage[] = [
      { role: "user", content: `old request ${"x".repeat(2_000)}` },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning", signature: "signed-secret" },
        { type: "redacted_thinking", data: "encrypted-secret" },
        { type: "text", text: `old answer ${"y".repeat(2_000)}` },
      ] },
      ...closedTurn("recent", 400),
    ];
    const result = await pipeline.prepare({
      sessionId: "s1",
      messages,
      systemPrompt: "system",
      toolSchemas: [],
      signal: new AbortController().signal,
      userIdentity: { platform: "feishu", userId: "user-123" },
    });
    expect(result.compacted).toBe(true);
    const request = JSON.stringify(provider.requests[0]?.messages);
    expect(request).toContain("assistant thinking omitted");
    expect(request).toContain("assistant redacted thinking omitted");
    expect(request).not.toContain("signed-secret");
    expect(request).not.toContain("encrypted-secret");
    expect(request).not.toContain("private reasoning");
    expect(provider.requests[0]?.userIdentity).toEqual({ platform: "feishu", userId: "user-123" });
  });

  test("trims tool text on UTF-8 boundaries, shares inline budget, and preserves images", () => {
    const source = `开头🙂${"中".repeat(50_000)}结尾🙂`;
    const trimmed = trimTextToTokenBudget(source, 1_000);
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.text.startsWith("开头🙂")).toBe(true);
    expect(trimmed.text.endsWith("结尾🙂")).toBe(true);
    expect(trimmed.text).toContain("tokens truncated");
    expect(estimateTokens(trimmed.text)).toBeLessThanOrEqual(1_000);

    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000) } };
    const results: ToolResultBlock[] = [{
      type: "tool_result",
      tool_call_id: "t1",
      content: [{ type: "text", text: source }, image, { type: "text", text: source }],
    }];
    const blocks = trimToolResultBlocks(results, 1_000);
    expect(blocks.changed).toBe(true);
    const content = blocks.results[0]!.content as JsonObject[];
    expect(content.filter((block) => block.type === "text")).toHaveLength(1);
    expect(content.filter((block) => block.type === "image")).toEqual([image]);
    expect(estimateTokens(String(content.find((block) => block.type === "text")?.text))).toBeLessThanOrEqual(1_000);
  });

  test("does nothing below the soft threshold", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({ provider, store, contextWindowTokens: 10_000, reserveTokens: 1_000 });
    const messages = closedTurn("short");
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(store.replacements).toHaveLength(0);
  });

  test("retains hundreds of small messages when they fit the token budget", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({ provider, store, contextWindowTokens: 1_000_000, reserveTokens: 20_000 });
    const messages = Array.from({ length: 250 }, (_, index) => closedTurn(`turn-${index}`)).flat();
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(500);
    expect(provider.requests).toHaveLength(0);
  });

  test("stores one structured checkpoint and retains recent complete turns", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 50)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toEqual(expect.objectContaining({
      role: "compactionSummary",
      summary: "compact summary",
      tokensBefore: result.beforeTokens,
      details: { readFiles: [], modifiedFiles: [] },
    }));
    expect(JSON.stringify(result.messages)).toContain("recent request");
    expect(JSON.stringify(result.messages)).not.toContain("old request");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    const prompt = summaryPrompt(provider);
    expect(prompt.startsWith("<conversation>\n")).toBe(true);
    expect(prompt.endsWith(HISTORY_SUMMARY_PROMPT)).toBe(true);
    expect(prompt).not.toContain("<previous-summary>");
    expect(provider.requests[0]?.maxOutputTokens).toBe(80);
    expect(store.replacements.at(-1)).toEqual(expect.objectContaining({
      kind: "compaction",
      metadata: expect.objectContaining({ trigger: "pre_call", before_tokens: result.beforeTokens }),
    }));
  });

  test("updates a previous summary and deterministically carries pi-style file lists", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = ["updated checkpoint\n\n<read-files>\nbogus.ts\n</read-files>"];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100, preCallThreshold: 0.5,
    });
    const previous = checkpoint(`previous checkpoint

<read-files>
src/a.ts
</read-files>

<modified-files>
src/b.ts
</modified-files>`, { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });
    const messages: RuntimeMessage[] = [
      previous,
      { role: "user", content: `continue work ${"x".repeat(2_000)}` },
      { role: "assistant", content: [
        { type: "tool_call", id: "read-b", name: "read", arguments: { path: "src/b.ts" } },
        { type: "tool_call", id: "read-c", name: "read", arguments: { path: "src/c.ts" } },
        { type: "tool_call", id: "edit-a", name: "edit", arguments: { file_path: "src/a.ts" } },
        { type: "tool_call", id: "write-d", name: "write", arguments: { file_path: "src/d.ts" } },
        { type: "text", text: "work in progress" },
      ] },
      { role: "tool", content: [
        { type: "tool_result", tool_call_id: "read-b", content: "ok" },
        { type: "tool_result", tool_call_id: "read-c", content: "ok" },
        { type: "tool_result", tool_call_id: "edit-a", content: "ok" },
        { type: "tool_result", tool_call_id: "write-d", content: "failed", is_error: true },
      ] },
      ...closedTurn("recent", 50),
    ];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    const prompt = summaryPrompt(provider);
    expect(prompt).toContain("<previous-summary>\nprevious checkpoint\n</previous-summary>");
    expect(prompt).not.toContain("The conversation history before this point was compacted");
    expect(prompt).not.toContain("bogus.ts");
    expect(prompt).not.toContain("<read-files>");
    expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("<previous-summary>"));
    expect(prompt.endsWith(UPDATE_HISTORY_SUMMARY_PROMPT)).toBe(true);
    expect(result.messages[0]?.role).toBe("compactionSummary");
    if (result.messages[0]?.role !== "compactionSummary") throw new Error("missing compaction checkpoint");
    expect(result.messages[0].summary).toContain("<read-files>\nsrc/c.ts\n</read-files>");
    expect(result.messages[0].summary).toContain("<modified-files>\nsrc/a.ts\nsrc/b.ts\nsrc/d.ts\n</modified-files>");
    expect(result.messages[0].summary).not.toContain("bogus.ts");
    expect(result.messages[0].details).toEqual({
      readFiles: ["src/c.ts"],
      modifiedFiles: ["src/a.ts", "src/b.ts", "src/d.ts"],
    });
    expect(store.replacements.at(-1)?.metadata).toEqual(expect.objectContaining({
      read_files: ["src/c.ts"],
      modified_files: ["src/a.ts", "src/b.ts", "src/d.ts"],
    }));
  });

  test("treats legacy summary prefixes as ordinary user text", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100, preCallThreshold: 0.5,
    });
    const historyPrefix = "The conversation history before this point was compacted into the following summary: old history";
    const midturnPrefix = "The intermediate steps of the current task were compacted into the following checkpoint summary: old turn";
    const messages: RuntimeMessage[] = [
      { role: "user", content: `${historyPrefix} ${"x".repeat(1_000)}` },
      { role: "assistant", content: "old answer" },
      { role: "user", content: `${midturnPrefix} ${"y".repeat(1_000)}` },
      { role: "assistant", content: "old answer" },
      ...closedTurn("recent", 50),
    ];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    const prompt = summaryPrompt(provider);
    expect(prompt).toContain(historyPrefix);
    expect(prompt).toContain(midturnPrefix);
    expect(prompt).not.toContain("<previous-summary>");
  });

  test("uses a mid-turn checkpoint when one tool-heavy turn exceeds the budget", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_200, reserveTokens: 100, recentRawTokens: 120,
    });
    const messages: RuntimeMessage[] = [{ role: "user", content: "original request" }];
    for (let index = 0; index < 4; index += 1) {
      messages.push(
        { role: "assistant", content: [{ type: "tool_call", id: `t${index}`, name: "exec", arguments: { command: "x".repeat(500) } }] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: `t${index}`, content: "y".repeat(500) }] },
      );
    }
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]?.role).toBe("compactionSummary");
    if (result.messages[0]?.role !== "compactionSummary") throw new Error("missing compaction checkpoint");
    expect(result.messages[0].summary).toBe([
      "No prior history.",
      "---",
      "**Turn Context (split turn):**",
      "compact summary",
    ].join("\n\n"));
    expect(JSON.stringify(result.messages)).not.toContain("original request");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(JSON.stringify(result.messages.slice(1))).toContain('"id":"t3"');
    expect(JSON.stringify(result.messages.slice(1))).not.toContain('"id":"t2"');
    expect(provider.requests[0]?.kind).toBe("midturn");
    expect(provider.requests[0]?.maxOutputTokens).toBe(50);
    const prompt = summaryPrompt(provider);
    expect(prompt.startsWith("<conversation>\n")).toBe(true);
    expect(prompt).toContain("User: original request");
    expect(prompt.endsWith(MIDTURN_SUMMARY_PROMPT)).toBe(true);
    expect(JSON.stringify(provider.requests[0])).not.toContain("encrypted");
    expect(() => validateToolCallClosure(result.messages)).not.toThrow();
  });

  test("reuses a previous checkpoint when the next compaction splits a turn", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = ["updated turn prefix"];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_200, reserveTokens: 100, recentRawTokens: 120,
    });
    const messages: RuntimeMessage[] = [
      checkpoint("earlier checkpoint"),
      { role: "user", content: "original request" },
    ];
    for (let index = 0; index < 4; index += 1) {
      messages.push(
        { role: "assistant", content: [{ type: "tool_call", id: `t${index}`, name: "exec", arguments: { command: "x".repeat(500) } }] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: `t${index}`, content: "y".repeat(500) }] },
      );
    }
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]?.role).toBe("compactionSummary");
    if (result.messages[0]?.role !== "compactionSummary") throw new Error("missing compaction checkpoint");
    expect(result.messages[0].summary).toBe([
      "earlier checkpoint",
      "---",
      "**Turn Context (split turn):**",
      "updated turn prefix",
    ].join("\n\n"));
    expect(result.messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("original request");
    const prompt = summaryPrompt(provider);
    expect(prompt).toContain("User: original request");
    expect(prompt).not.toContain("<previous-summary>");
    expect(prompt.endsWith(MIDTURN_SUMMARY_PROMPT)).toBe(true);
  });

  test("emits one globally normalized file list after history plus mid-turn compaction", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = ["history checkpoint", "turn checkpoint"];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 120,
    });
    const messages: RuntimeMessage[] = [
      { role: "user", content: `old request ${"x".repeat(2_000)}` },
      { role: "assistant", content: [{ type: "tool_call", id: "old-read", name: "read", arguments: { path: "src/a.ts" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "old-read", content: "y".repeat(2_000) }] },
      { role: "user", content: "current request" },
    ];
    const calls = [
      { id: "edit-a", name: "edit", arguments: { file_path: "src/a.ts" } },
      { id: "read-c", name: "read", arguments: { path: "src/c.ts" } },
      { id: "exec-2", name: "exec", arguments: { command: "x".repeat(500) } },
      { id: "exec-3", name: "exec", arguments: { command: "x".repeat(500) } },
    ];
    calls.forEach((call) => {
      messages.push(
        { role: "assistant", content: [{ type: "tool_call", ...call }] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: call.id, content: "z".repeat(500) }] },
      );
    });
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.apiCalls).toBe(2);
    const summaries = result.messages.filter((message) => message.role === "compactionSummary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.role).toBe("compactionSummary");
    if (summaries[0]?.role !== "compactionSummary") throw new Error("missing compaction checkpoint");
    expect(summaries[0].summary).toContain(
      "history checkpoint\n\n---\n\n**Turn Context (split turn):**\n\nturn checkpoint",
    );
    expect(summaries[0].summary).toContain("<read-files>\nsrc/c.ts\n</read-files>");
    expect(summaries[0].summary).toContain("<modified-files>\nsrc/a.ts\n</modified-files>");
    expect(summaries[0].details).toEqual({ readFiles: ["src/c.ts"], modifiedFiles: ["src/a.ts"] });
    expect(store.replacements.at(-1)?.metadata).toEqual(expect.objectContaining({
      read_files: ["src/c.ts"],
      modified_files: ["src/a.ts"],
    }));
  });

  test("performs maintenance compaction after a completed turn crosses the hard limit", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const result = await pipeline.postTurn({
      sessionId: "s1",
      messages: [...closedTurn("old", 2_000), ...closedTurn("recent", 400)],
      systemPrompt: "system",
      signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(store.replacements.at(-1)?.metadata).toEqual(expect.objectContaining({ trigger: "post_turn" }));
  });

  test("uses pi retry delays for retryable errors and empty summaries", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = [summaryProviderError(true, "offline"), "", summaryProviderError(true, "reset"), "compact summary"];
    const delays: number[] = [];
    const pipeline = new ContextPipeline({
      provider,
      store,
      contextWindowTokens: 1_000,
      reserveTokens: 100,
      recentRawTokens: 100,
      summaryRetryWait: async (delayMs) => { delays.push(delayMs); },
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 50)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.apiCalls).toBe(4);
    expect(delays).toEqual([2_000, 4_000, 8_000]);
  });

  test("fails fast for non-retryable summary errors without replacing history", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = [summaryProviderError(false, "invalid credentials"), "must not run"];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.apiCalls).toBe(1);
    expect(result.failureReason).toBe("summary_failed");
    expect(provider.requests).toHaveLength(1);
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
    expect(result.messages).toEqual(messages);
  });

  test("preserves history after exhausting all summary retries", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = Array.from({ length: 4 }, () => summaryProviderError(true));
    const pipeline = new ContextPipeline({
      provider,
      store,
      contextWindowTokens: 1_000,
      reserveTokens: 100,
      recentRawTokens: 100,
      summaryRetryWait: async () => {},
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.apiCalls).toBe(4);
    expect(result.failureReason).toBe("summary_failed");
    expect(result.messages).toEqual(messages);
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("aborts while waiting to retry a summary", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = [summaryProviderError(true)];
    const controller = new AbortController();
    const pipeline = new ContextPipeline({
      provider,
      store,
      contextWindowTokens: 1_000,
      reserveTokens: 100,
      recentRawTokens: 100,
      summaryRetryBaseDelayMs: 60_000,
    });
    const pending = pipeline.prepare({
      sessionId: "s1",
      messages: [...closedTurn("old", 2_000), ...closedTurn("recent", 400)],
      systemPrompt: "system",
      toolSchemas: [],
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort(new DOMException("Aborted", "AbortError")));
    await expect(pending).rejects.toThrow("Aborted");
    expect(provider.requests).toHaveLength(1);
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("rejects a summary that does not reduce tokens", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = ["z".repeat(20_000)];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.failureReason).toBe("summary_not_smaller");
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("aborts summary without writing a compaction checkpoint", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pipeline.prepare({
      sessionId: "s1",
      messages: [...closedTurn("old", 2_000), ...closedTurn("recent", 400)],
      systemPrompt: "system",
      toolSchemas: [],
      signal: controller.signal,
    })).rejects.toThrow("Aborted");
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("replaces processed images with placeholders", () => {
    const messages: RuntimeMessage[] = [{
      role: "user",
      content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", data: "secret-base64" } }],
    }];
    const result = pruneProcessedHistoryImages(messages);
    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("already processed");
    expect(JSON.stringify(result.messages)).not.toContain("secret-base64");
  });
});
