import type { RuntimeMessage } from "../engine/types";
import { object, string, type MessageOrigin } from "./accumulator";

export const canReplayMetadata = (message: RuntimeMessage, target?: MessageOrigin): boolean =>
  !!target && "api" in message && message.api === target.apiStyle && message.provider === target.name && message.model === target.model;
export const legacyMessage = (message: RuntimeMessage): boolean => !("api" in message);
export const completeTool = (block: Record<string, unknown>): boolean =>
  block.type !== "tool_call" || (!!block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments));
export const replaySignature = (signature: unknown): Record<string, unknown> | undefined => {
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try { return object(JSON.parse(signature)); } catch { return undefined; }
};
export const replayReasoningDetails = (signature: unknown): unknown[] | undefined => {
  if (typeof signature !== "string" || !signature.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((v) => ["reasoning.text", "reasoning.summary", "reasoning.encrypted"].includes(string(object(v).type)));
  } catch { return undefined; }
};
