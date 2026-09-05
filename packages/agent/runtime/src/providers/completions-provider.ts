import { canReplayMetadata, legacyMessage, completeTool, replayReasoningDetails } from "../messages/replay";
import { AssistantMessageAccumulator } from "../messages/accumulator";
import OpenAI from "openai";
import type { JsonObject } from "@lxe/protocol";
import type {
  RuntimeMessage,
  RuntimeMessageContent,
  RuntimeProvider,
  RuntimeProviderRequest,
  RuntimeSummaryRequest,
  RuntimeSummaryResult,
  AssistantMessage,
  ToolSchema,
} from "../engine/types";
import { compactionSummaryProviderText } from "../engine/compaction-summary";
import {
  localFileReferenceText,
  normalizeProviderError,
  normalizeThinkingEffort,
  ProviderIdleWatchdog,
  requestHeaders,
  RuntimeProviderError,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderDescriptor,
} from "./provider";
import { OpenAICompletionsStreamAdapter } from "./protocols/openai-completions";


const IMAGE_PLACEHOLDER = "[image omitted: the selected model does not support image content]";
const OPENAI_REASONING_FIELDS = new Set(["reasoning_content", "reasoning", "reasoning_text"]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => String(value ?? "");

const imagePart = (block: Record<string, unknown>, supportsVision: boolean): JsonObject => {
  if (!supportsVision) return { type: "text", text: IMAGE_PLACEHOLDER };
  const source = record(block.source);
  const mediaType = text(source.media_type ?? source.mimeType ?? block.mimeType).toLowerCase();
  const data = text(source.data ?? block.data);
  if (!/^image\/[a-z0-9.+-]+$/u.test(mediaType)) {
    throw new Error(`invalid Chat Completions image media type: ${mediaType || "missing"}`);
  }
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || data.length % 4 === 1) {
    throw new Error("invalid Chat Completions image base64 data");
  }
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
};

const userContent = (content: RuntimeMessageContent, supportsVision: boolean): string | JsonObject[] => {
  if (!Array.isArray(content)) return text(content);
  const parts: JsonObject[] = [];
  let hasImage = false;
  for (const raw of content) {
    const block = record(raw);
    if (block.type === "text") parts.push({ type: "text", text: text(block.text) });
    else if (block.type === "local_file") parts.push({ type: "text", text: localFileReferenceText(block) });
    else if (block.type === "image") {
      hasImage = true;
      parts.push(imagePart(block, supportsVision));
    }
  }
  if (hasImage) return parts;
  return parts.map((part) => text(part.text)).join("\n").trim();
};

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content.map((raw) => {
    const block = record(raw);
    if (block.type === "text") return text(block.text);
    if (block.type === "image") return "(see attached image)";
    return JSON.stringify(raw);
  }).filter(Boolean).join("\n");
};

export function adaptMessagesForCompletions(
  messages: RuntimeMessage[],
  supportsVision = false,
  descriptor?: ProviderDescriptor,
): JsonObject[] {
  const result: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "compactionSummary") {
      result.push({ role: "user", content: compactionSummaryProviderText(message.summary) });
      continue;
    }
    if (message.role === "user") {
      result.push({ role: "user", content: userContent(message.content, supportsVision) });
      continue;
    }
    if (message.role === "system") {
      result.push({ role: "system", content: text(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content)
        ? message.content.map(record).filter(completeTool)
        : [{ type: "text", text: text(message.content) }];
      const content = blocks.filter((block) => block.type === "text").map((block) => text(block.text)).join("");
      const assistant: Record<string, unknown> = { role: "assistant", content: content || null };
      for (const field of OPENAI_REASONING_FIELDS) {
        const reasoning = blocks
          .filter((block) => block.type === "thinking" && (canReplayMetadata(message, descriptor) || legacyMessage(message)) && text(block.thinkingSignature ?? block.signature) === field)
          .map((block) => text(block.thinking))
          .join("");
        if (reasoning) assistant[field] = reasoning;
      }
      if (canReplayMetadata(message, descriptor)) {
        const details = blocks.flatMap((block) => block.type === "thinking" ? replayReasoningDetails(block.thinkingSignature) ?? [] : []);
        if (details.length) assistant.reasoning_details = details;
      }
      const calls = blocks.filter((block) => block.type === "tool_call").map((block) => ({
        id: text(block.id),
        type: "function",
        function: {
          name: text(block.name),
          arguments: JSON.stringify(record(block.arguments)),
        },
      }));
      if (calls.length > 0) assistant.tool_calls = calls;
      if (content || calls.length > 0 || assistant.reasoning_details) result.push(assistant as JsonObject);
      continue;
    }
    if (message.role !== "tool") continue;
    const images: JsonObject[] = [];
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = record(raw);
      if (block.type !== "tool_result") continue;
      result.push({
        role: "tool",
        tool_call_id: text(block.tool_call_id),
        content: toolResultText(block.content),
      });
      if (!Array.isArray(block.content)) continue;
      for (const rawContent of block.content) {
        const contentBlock = record(rawContent);
        if (contentBlock.type === "image" && supportsVision) images.push(imagePart(contentBlock, true));
      }
    }
    if (images.length > 0) {
      result.push({
        role: "user",
        content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images],
      });
    }
  }
  return result;
}

export const adaptToolsForCompletions = (tools: ToolSchema[]): JsonObject[] => tools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));

export const buildCompletionsThinkingPayload = (descriptor: ProviderDescriptor): Record<string, unknown> => {
  if (descriptor.thinkingStyle !== "zai") return {};
  const effort = normalizeThinkingEffort(
    descriptor.thinkingEffort,
    descriptor.thinkingLevels,
    descriptor.thinkingDefault,
  );
  return {
    thinking: { type: "enabled", clear_thinking: false },
    reasoning_effort: effort,
  };
};

export function buildCompletionsRequest(
  descriptor: ProviderDescriptor,
  request: Pick<RuntimeProviderRequest, "system" | "messages" | "tools" | "toolChoice">,
): Record<string, unknown> {
  const toolsEnabled = request.toolChoice !== "none" && request.tools.length > 0;
  return {
    model: descriptor.model,
    messages: [
      ...(request.system.trim() ? [{ role: "system", content: request.system.trim() }] : []),
      ...adaptMessagesForCompletions(request.messages, descriptor.supportsVision === true, descriptor),
    ],
    max_tokens: descriptor.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(toolsEnabled ? {
      tools: adaptToolsForCompletions(request.tools),
      tool_choice: "auto",
      ...(descriptor.toolStream ? { tool_stream: true } : {}),
    } : {}),
    ...buildCompletionsThinkingPayload(descriptor),
  };
}

export interface CompletionsClientPort {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
    };
  };
}

export class CompletionsRuntimeProvider implements RuntimeProvider {
  constructor(
    private readonly descriptor: ProviderDescriptor,
    private readonly injectedClient?: CompletionsClientPort,
  ) {}

  private clientFor(
    onRequest?: (headers: JsonObject) => void,
    onResponse?: (response: Response) => void,
  ): CompletionsClientPort {
    if (this.injectedClient) return this.injectedClient;
    return new OpenAI({
      apiKey: this.descriptor.apiKey,
      maxRetries: 0,
      baseURL: this.descriptor.baseURL,
      defaultHeaders: this.descriptor.defaultHeaders,
      fetch: async (input, init) => {
        onRequest?.(requestHeaders(input, init));
        const response = await fetch(input, init);
        onResponse?.(response);
        return response;
      },
    }) as unknown as CompletionsClientPort;
  }

  async turn(request: RuntimeProviderRequest): Promise<AssistantMessage> {
    const accumulator = new AssistantMessageAccumulator(this.descriptor, request.onEvent);
    let parseFailure: unknown;
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    let wireOk = false;
    let wireError = "";
    const wire = (operation: () => void): void => {
      try { operation(); } catch { /* Diagnostics must not affect Provider execution. */ }
    };
    try {
      request.signal.throwIfAborted();
      const body = buildCompletionsRequest(this.descriptor, request);
      const client = this.clientFor(
        (headers) => wire(() => request.wireTrace?.requestStart(headers, body as JsonObject)),
        (response) => wire(() => request.wireTrace?.responseStart(
          response.status,
          Object.fromEntries(response.headers.entries()),
        )),
      );
      const normalizer = new OpenAICompletionsStreamAdapter(accumulator);
      const stream = await client.chat.completions.create(body, { signal: watchdog.signal });
      for await (const chunk of stream) {
        watchdog.activity();
        wire(() => request.wireTrace?.event("chat.completion.chunk", chunk));
        try {
          normalizer.streamEvent(chunk);
        } catch (error) {
          wire(() => request.wireTrace?.parseError(
            "chat.completion.chunk",
            JSON.stringify(chunk ?? null),
            error,
          ));
          throw error;
        }
      }
      normalizer.finish();
      request.signal.throwIfAborted();
      const response = normalizer.result();
      await accumulator.drain();
      wireOk = true;
      return response;
    } catch (error) {
      const failure = parseFailure ?? error;
      const classified = request.signal.aborted
        ? request.signal.reason ?? new DOMException("Aborted", "AbortError")
        : watchdog.timedOut()
          ? new RuntimeProviderError(
              `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
              this.descriptor.name, "请求超时", `${this.descriptor.name} 请求超时，请稍后重试。`, true,
            )
          : normalizeProviderError(failure, this.descriptor);
      wireError = String(classified instanceof Error ? classified.message : classified);
      accumulator.fail(request.signal.aborted ? "aborted" : "error", classified);
      await accumulator.drain();
      throw classified;
    } finally {
      wire(() => request.wireTrace?.end(wireOk, wireError));
      watchdog.cleanup();
    }
  }

  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    try {
      const maxOutputTokens = Math.max(
        1,
        Math.min(32_768, this.descriptor.maxTokens, Math.trunc(request.maxOutputTokens)),
      );
      const body = {
        model: this.descriptor.model,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          ...adaptMessagesForCompletions(request.messages, this.descriptor.supportsVision === true, this.descriptor),
        ],
        max_tokens: maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...buildCompletionsThinkingPayload(this.descriptor),
      };
      const stream = await this.clientFor().chat.completions.create(body, { signal: watchdog.signal });
      const normalizer = new OpenAICompletionsStreamAdapter(new AssistantMessageAccumulator(this.descriptor));
      for await (const chunk of stream) {
        watchdog.activity();
        normalizer.streamEvent(chunk);
      }
      normalizer.finish();
      const response = normalizer.result();
      const { status: _status, ...usage } = response.usage;
      return {
        text: response.content
          .filter((block) => record(block).type === "text")
          .map((block) => text(record(block).text))
          .join("")
          .trim(),
        usage,
      };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (watchdog.timedOut()) {
        throw new RuntimeProviderError(
          `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name,
          "请求超时",
          `${this.descriptor.name} 请求超时，请稍后重试。`,
          true,
        );
      }
      throw normalizeProviderError(error, this.descriptor);
    } finally {
      watchdog.cleanup();
    }
  }
}
