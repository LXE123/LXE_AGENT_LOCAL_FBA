import { canReplayMetadata, completeTool, replaySignature } from "../messages/replay";
import { AssistantMessageAccumulator } from "../messages/accumulator";
import OpenAI from "openai";
import type { JsonObject } from "@lxe/protocol";
import type {
  RuntimeContentBlock,
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
  providerUserIdentifier,
  requestHeaders,
  RuntimeProviderError,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderDescriptor,
} from "./provider";
import { OpenAIResponsesStreamAdapter } from "./protocols/openai-responses";

const IMAGE_PLACEHOLDER = "[image omitted: the selected model does not support image content]";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string => String(value ?? "");

const imageInputPart = (block: Record<string, unknown>, supportsVision: boolean): JsonObject => {
  if (!supportsVision) return { type: "input_text", text: IMAGE_PLACEHOLDER };
  const source = record(block.source);
  const mediaType = text(source.media_type ?? source.mimeType ?? block.mimeType).toLowerCase();
  const data = text(source.data ?? block.data);
  if (!/^image\/[a-z0-9.+-]+$/u.test(mediaType)) {
    throw new Error(`invalid Responses image media type: ${mediaType || "missing"}`);
  }
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || data.length % 4 === 1) {
    throw new Error("invalid Responses image base64 data");
  }
  return { type: "input_image", image_url: `data:${mediaType};base64,${data}` };
};

const inputContent = (content: RuntimeMessageContent, supportsVision: boolean): JsonObject[] => {
  if (!Array.isArray(content)) return [{ type: "input_text", text: text(content) }];
  const parts: JsonObject[] = [];
  const textParts: string[] = [];
  let hasImage = false;
  for (const raw of content) {
    const block = record(raw);
    if (block.type === "text") {
      const value = text(block.text);
      textParts.push(value);
      parts.push({ type: "input_text", text: value });
    }
    else if (block.type === "local_file") {
      const value = localFileReferenceText(block);
      textParts.push(value);
      parts.push({ type: "input_text", text: value });
    } else if (block.type === "image") {
      hasImage = true;
      parts.push(imageInputPart(block, supportsVision));
    }
  }
  return hasImage ? parts : [{ type: "input_text", text: textParts.join("\n").trim() }];
};

const toolResultOutput = (content: unknown, supportsVision: boolean): string | JsonObject[] => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  const hasImage = content.some((raw) => record(raw).type === "image");
  if (!hasImage) {
    return content.map((raw) => {
      const block = record(raw);
      return block.type === "text" ? text(block.text) : JSON.stringify(raw);
    }).join("\n");
  }
  return content.map((raw): JsonObject => {
    const block = record(raw);
    if (block.type === "text") return { type: "input_text", text: text(block.text) };
    if (block.type === "image") return imageInputPart(block, supportsVision);
    return { type: "input_text", text: JSON.stringify(raw) };
  });
};

/**
 * Responses carries assistant tool calls and their outputs as sibling top-level
 * items rather than as content blocks inside a message, so one RuntimeMessage
 * can expand into several input items.
 */
export function adaptMessagesForResponses(messages: RuntimeMessage[], supportsVision = false, descriptor?: ProviderDescriptor): JsonObject[] {
  const input: JsonObject[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "compactionSummary") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: compactionSummaryProviderText(message.summary) }],
      });
      continue;
    }
    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: inputContent(message.content, supportsVision),
      });
      continue;
    }
    if (message.role === "system") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[System Message]\n${text(message.content)}` }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const source = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: text(message.content) }];
      const replay = canReplayMetadata(message, descriptor);
      const grouped = new Map<string, JsonObject>();
      const emittedReasoning = new Set<string>();
      for (const [blockIndex, raw] of source.entries()) {
        const block = record(raw);
        if (!completeTool(block)) continue;
        if (block.type === "thinking") {
          const item = replay ? replaySignature(block.thinkingSignature) : undefined;
          if (item?.type === "reasoning" && typeof item.id === "string" && !emittedReasoning.has(item.id)) {
            input.push(item as JsonObject);
            emittedReasoning.add(item.id);
          }
        } else if (block.type === "text") {
          const signature = replay ? replaySignature(block.textSignature) : undefined;
          const id = typeof signature?.id === "string" ? signature.id : `msg_replay_${messageIndex}_${blockIndex}`;
          let item = grouped.get(id);
          if (!item) {
            item = { type: "message", role: "assistant", id, status: "completed", content: [],
              ...(typeof signature?.phase === "string" ? { phase: signature.phase } : {}) };
            grouped.set(id, item);
            input.push(item);
          }
          (item.content as JsonObject[]).push({ type: "output_text", text: text(block.text), annotations: [] });
        } else if (block.type === "tool_call") {
          input.push({ type: "function_call", call_id: text(block.id), name: text(block.name),
            arguments: JSON.stringify(block.arguments),
            ...(replay && typeof block.providerItemId === "string" ? { id: block.providerItemId } : {}),
            ...(replay && typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
          });
        }
      }
      continue;
    }
    if (message.role !== "tool") continue;
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = record(raw);
      if (block.type !== "tool_result") continue;
      input.push({
        type: "function_call_output",
        call_id: text(block.tool_call_id),
        output: toolResultOutput(block.content, supportsVision),
      });
    }
  }
  return input;
}

export const adaptToolsForResponses = (tools: ToolSchema[]): JsonObject[] => tools.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.input_schema,
}));

/**
 * Responses spells thinking differently from the Anthropic-compatible wire:
 * `reasoning.effort` over none/low/high/max, where "none" is what switches it
 * off. The other wire's `thinking` + `output_config` pair means nothing here,
 * and DeepSeek ignores parameters it does not recognise instead of rejecting
 * them - so the wrong shape leaves reasoning running at its default rather than
 * failing where anyone would notice.
 */
export const buildResponsesThinkingPayload = (descriptor: ProviderDescriptor): Record<string, unknown> => {
  if (descriptor.thinkingStyle === "provider-managed") return {};
  if (!descriptor.thinkingEnabled || descriptor.thinkingEffort === "off") {
    return { reasoning: { effort: "none" } };
  }
  return {
    reasoning: {
      effort: normalizeThinkingEffort(
        descriptor.thinkingEffort,
        descriptor.thinkingLevels.filter((level) => level !== "off"),
        descriptor.thinkingDefault,
      ),
    },
  };
};

/** Summaries follow the active session's thinking setting. */
export const buildResponsesSummaryThinkingPayload = (
  descriptor: ProviderDescriptor,
): Record<string, unknown> => buildResponsesThinkingPayload(descriptor);

export function buildResponsesRequest(
  descriptor: ProviderDescriptor,
  request: Pick<RuntimeProviderRequest, "system" | "messages" | "tools" | "toolChoice" | "userIdentity">,
): Record<string, unknown> {
  // This wire drops `metadata`, but takes `user` - which is the field DeepSeek
  // rate-limits and isolates against. A shared Feishu bot would otherwise put
  // everyone in one bucket.
  const user = providerUserIdentifier(request.userIdentity);
  return {
    ...(user ? { user } : {}),
    model: descriptor.model,
    instructions: request.system.trim(),
    input: adaptMessagesForResponses(request.messages, descriptor.supportsVision === true, descriptor),
    max_output_tokens: descriptor.maxTokens,
    stream: true,
    ...(request.tools.length > 0
      ? { tools: adaptToolsForResponses(request.tools), tool_choice: request.toolChoice }
      : {}),
    ...buildResponsesThinkingPayload(descriptor),
  };
}

export interface ResponsesClientPort {
  responses: {
    stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }): {
      on?(event: string, listener: (payload: unknown) => void): unknown;
      finalResponse(): Promise<unknown>;
    };
  };
}

export class ResponsesRuntimeProvider implements RuntimeProvider {
  constructor(
    private readonly descriptor: ProviderDescriptor,
    private readonly injectedClient?: ResponsesClientPort,
  ) {}

  /** Per call for the same reason as the Anthropic provider; see clientFor there. */
  private clientFor(onRequest?: (headers: JsonObject) => void): ResponsesClientPort {
    if (this.injectedClient) return this.injectedClient;
    return new OpenAI({
      apiKey: this.descriptor.apiKey,
      maxRetries: 0,
      baseURL: this.descriptor.baseURL,
      defaultHeaders: this.descriptor.defaultHeaders,
      fetch: (input, init) => {
        onRequest?.(requestHeaders(input, init));
        return fetch(input, init);
      },
    }) as unknown as ResponsesClientPort;
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
      const parameters = buildResponsesRequest(this.descriptor, request);
      const client = this.clientFor((headers) => {
        wire(() => request.wireTrace?.requestStart(headers, parameters as unknown as JsonObject));
      });
      const normalizer = new OpenAIResponsesStreamAdapter(accumulator);
      const stream = client.responses.stream(parameters, { signal: watchdog.signal });
      // Every frame is traced from one catch-all listener, so the diagnostics
      // keep the events this adapter does not map - lifecycle and failure
      // frames included - instead of only the four it reads.
      wire(() => {
        stream.on?.("event", (payload) => {
          watchdog.activity();
          const name = text(record(payload).type) || "event";
          wire(() => request.wireTrace?.event(name, payload));
          try {
            if (parseFailure) return;
            normalizer.streamEvent(payload);
          } catch (error) {
            parseFailure = error;
            watchdog.abort(error);
            wire(() => request.wireTrace?.parseError(name, JSON.stringify(payload ?? null), error));
          }
        });
      });
      const response = record(await stream.finalResponse());
      if (parseFailure) throw parseFailure;
      request.signal.throwIfAborted();
      const result = normalizer.finalize(response);
      await accumulator.drain();
      wireOk = true;
      return result;
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
      const stream = this.clientFor().responses.stream({
        model: this.descriptor.model,
        instructions: SUMMARY_SYSTEM_PROMPT,
        input: adaptMessagesForResponses(request.messages, this.descriptor.supportsVision === true, this.descriptor),
        max_output_tokens: maxOutputTokens,
        stream: true,
        ...(providerUserIdentifier(request.userIdentity)
          ? { user: providerUserIdentifier(request.userIdentity) }
          : {}),
        ...buildResponsesSummaryThinkingPayload(this.descriptor),
      }, { signal: watchdog.signal });
      try {
        stream.on?.("response.output_text.delta", () => watchdog.activity());
        stream.on?.("response.reasoning_text.delta", () => watchdog.activity());
        stream.on?.("response.reasoning.delta", () => watchdog.activity());
        stream.on?.("response.output_item.done", () => watchdog.activity());
      } catch { /* Diagnostics/activity hooks must not replace Provider behavior. */ }
      const response = record(await stream.finalResponse());
      const result = new OpenAIResponsesStreamAdapter(new AssistantMessageAccumulator(this.descriptor)).finalize(response);
      const summary = result.content
        .filter((block) => record(block).type === "text")
        .map((block) => text(record(block).text))
        .join("")
        .trim();
      const { status: _status, ...usage } = result.usage;
      return { text: summary, usage };
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
