import { createHash } from "node:crypto";
import type { RuntimeMessage } from "./types";

export interface ContextTokenAnchor {
  version: 1;
  requestId: string;
  fingerprint: string;
  estimatedInput: number;
  actualInput: number;
}
export interface ContextMeasurement {
  tokens: number;
  estimatedTokens: number;
  source: "estimated" | "usage_calibrated";
  contextWindowTokens: number;
}
export function validContextAnchor(value: unknown): value is ContextTokenAnchor {
  if (!value || typeof value !== "object") return false;
  const a = value as ContextTokenAnchor;
  return a.version === 1 && typeof a.requestId === "string" && a.requestId.length > 0 &&
    typeof a.fingerprint === "string" && /^[a-f0-9]{64}$/.test(a.fingerprint) &&
    Number.isSafeInteger(a.estimatedInput) && a.estimatedInput >= 0 &&
    Number.isSafeInteger(a.actualInput) && a.actualInput > 0;
}
export function latestContextAnchor(messages: readonly RuntimeMessage[]): ContextTokenAnchor | undefined {
  for (const message of [...messages].reverse()) {
    if ((message.role === "assistant" || message.role === "compactionSummary") &&
      validContextAnchor(message.contextTokenAnchor)) return message.contextTokenAnchor;
  }
  return undefined;
}
export function contextFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function measureContext(
  messages: readonly RuntimeMessage[], estimatedTokens: number,
  fingerprint: string | undefined, contextWindowTokens: number,
): ContextMeasurement {
  const anchor = latestContextAnchor(messages);
  const calibrated = anchor !== undefined && fingerprint !== undefined && anchor.fingerprint === fingerprint;
  return {
    tokens: calibrated ? Math.max(0, anchor.actualInput + estimatedTokens - anchor.estimatedInput) : estimatedTokens,
    estimatedTokens, source: calibrated ? "usage_calibrated" : "estimated", contextWindowTokens,
  };
}
