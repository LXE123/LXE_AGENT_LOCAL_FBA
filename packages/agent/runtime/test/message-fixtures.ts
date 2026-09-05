import { beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, AssistantUsage } from "../src/messages/assistant-message";

export function messageFixture(patch: Partial<Omit<AssistantMessage, "usage">> & { usage?: Partial<AssistantUsage> } = {}): AssistantMessage {
  return { id: randomUUID(), role: "assistant", timestamp: 1000, api: "anthropic_messages", provider: "test", model: "test",
    content: [], stopReason: "stop", ...patch,
    usage: { input_tokens: 0, output_tokens: 0, status: "complete", ...patch.usage },
  };
}
const bodies = new Map<string, string>();
beforeEach(() => bodies.clear());
/** Synthetic consumer events; adapter tests instead feed actual SDK-shaped frames. */
export function eventFixture(type: AssistantMessageEvent["type"], id: string, delta = "", redacted = false): AssistantMessageEvent {
  const thinking = type.startsWith("thinking");
  const key = `${id}:${thinking}`;
  if (type.endsWith("_start")) bodies.set(key, "");
  if (type.endsWith("_delta")) bodies.set(key, (bodies.get(key) ?? "") + delta);
  const content = bodies.get(key) ?? delta;
  const partial = messageFixture({ id, content: thinking ? [{ type: "thinking", thinking: content, ...(redacted ? { redacted: true } : {}) }] : [{ type: "text", text: content }] });
  if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") return { type, contentIndex: 0, partial };
  if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") return { type, contentIndex: 0, partial, delta };
  if (type === "text_end" || type === "thinking_end") return { type, contentIndex: 0, partial, content };
  throw new Error(`Unsupported fixture event ${type}`);
}
