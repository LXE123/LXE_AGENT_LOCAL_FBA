import type { LlmProviderApiStyle } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";

export interface AssistantUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  status: "unreported" | "partial" | "complete";
}
export interface AssistantTextContent extends JsonObject {
  type: "text";
  text: string;
  textSignature?: string;
}
export interface AssistantThinkingContent extends JsonObject {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
export interface AssistantToolCall extends JsonObject {
  type: "tool_call";
  id: string;
  name: string;
  arguments?: JsonObject;
  providerItemId?: string;
  namespace?: string;
  thoughtSignature?: string;
}
export type CompletedAssistantToolCall = AssistantToolCall & { arguments: JsonObject };
export type AssistantContent = AssistantTextContent | AssistantThinkingContent | AssistantToolCall;
export type AssistantStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export type AssistantSuccessReason = "stop" | "length" | "toolUse";
export interface AssistantMessageError {
  message: string;
  category?: string;
  statusCode?: number;
  retryable?: boolean;
}
/** One local request attempt. Only its accumulator may mutate it, until terminal delivery. */
export interface AssistantMessage {
  id: string;
  role: "assistant";
  timestamp: number;
  api: LlmProviderApiStyle;
  provider: string;
  model: string;
  responseId?: string;
  responseModel?: string;
  content: AssistantContent[];
  usage: AssistantUsage;
  stopReason: AssistantStopReason;
  rawStopReason?: string;
  error?: AssistantMessageError;
}
/** partial is a shared live value, not an event-time snapshot. End payloads are stable. */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: CompletedAssistantToolCall; partial: AssistantMessage }
  | { type: "done"; reason: AssistantSuccessReason; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };
