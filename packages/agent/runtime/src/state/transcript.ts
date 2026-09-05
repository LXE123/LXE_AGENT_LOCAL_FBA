import { validContextAnchor } from "../engine/context-meter";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeConversationMessage, RuntimeMessage } from "../engine/types";

import { environmentMetadata } from "../engine/environment-context";

export const TRANSCRIPT_VERSION = 2;

export const replacementKinds = new Set([
  "compaction",
  "context_reset",
  "memory_clear",
  "legacy_import",
  "repair",
  "history_limit",
  "context_replacement",
]);

const text = (value: unknown): string => String(value ?? "").trim();

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export const legacyTranscriptMigrationHint =
  "migrate this session first with scripts/migrate-transcripts-v2.ts";

const normalizeLegacyBlock = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = { ...(value as JsonObject) };
  const type = text(block.type);
  if (type === "tool_use" || (type === "tool_result" && text(block.tool_use_id))) {
    throw new Error(`transcript contains a legacy v1 "${type}" block; ${legacyTranscriptMigrationHint}`);
  }
  if (type === "tool_call") {
    return {
      ...block,
      type: "tool_call",
      id: text(block.id),
      name: text(block.name),
      ...(block.arguments === undefined ? {} : { arguments: object(block.arguments) }),
    };
  }
  if (type === "tool_result") {
    return { ...block, type: "tool_result", tool_call_id: text(block.tool_call_id) };
  }
  return block;
};

const anchorMetadata = (value: unknown) => {
  const source = value as { role?: unknown; contextTokenAnchor?: unknown };
  return (source.role === "assistant" || source.role === "compactionSummary") && validContextAnchor(source.contextTokenAnchor)
    ? { contextTokenAnchor: source.contextTokenAnchor } : {};
};
export const normalizeTranscriptMessage = (value: unknown): RuntimeMessage | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { role?: unknown; content?: unknown; summary?: unknown; tokensBefore?: unknown; details?: unknown };
  const legacyRole = text(candidate.role);
  if (legacyRole === "compactionSummary") {
    const summary = String(candidate.summary ?? "").trim();
    const tokensBefore = Number(candidate.tokensBefore);
    const details = object(candidate.details);
    if (!summary || !Number.isSafeInteger(tokensBefore) || tokensBefore < 0 ||
      !Array.isArray(details.readFiles) || !Array.isArray(details.modifiedFiles) ||
      !details.readFiles.every((path) => typeof path === "string") ||
      !details.modifiedFiles.every((path) => typeof path === "string")) return undefined;
    const modifiedFiles = [...new Set(details.modifiedFiles.map((path) => path.trim()).filter(Boolean))].sort();
    const modified = new Set(modifiedFiles);
    const readFiles = [...new Set(details.readFiles.map((path) => path.trim()).filter((path) => path && !modified.has(path)))].sort();
    return { ...anchorMetadata(value), role: "compactionSummary", summary, tokensBefore, details: { readFiles, modifiedFiles } };
  }
  if (!new Set(["user", "assistant", "tool", "system"]).has(legacyRole)) return undefined;
  let role = legacyRole as RuntimeConversationMessage["role"];
  const identity = Object.fromEntries(["message_id", "client_message_id"].flatMap((key) => typeof (value as Record<string, unknown>)[key] === "string" ? [[key, (value as Record<string, unknown>)[key]]] : []));
  if (!Array.isArray(candidate.content)) return { ...identity, ...environmentMetadata(value), ...anchorMetadata(value), role, content: String(candidate.content ?? "") };
  const content = candidate.content.map(normalizeLegacyBlock)
    .filter((block): block is JsonObject => Boolean(block));
  // Early Bun transcripts persisted Anthropic wire messages directly. Recover
  // them only for model replay; the immutable display reader preserves disk semantics.
  if (role === "user" && content.length > 0 && content.every((block) => block.type === "tool_result")) {
    role = "tool";
  }
  const metadata: Record<string, unknown> = {};
  if (role === "assistant") {
    const source = value as Record<string, unknown>;
    for (const key of ["id", "timestamp", "api", "provider", "model", "responseId", "responseModel", "usage", "stopReason", "rawStopReason", "error"]) {
      if (source[key] !== undefined) metadata[key] = source[key];
    }
  }
  return { ...identity, ...environmentMetadata(value), ...anchorMetadata(value), ...metadata, role, content } as RuntimeMessage;
};

export const normalizeTranscriptMessages = (values: unknown[]): RuntimeMessage[] =>
  values.map(normalizeTranscriptMessage)
    .filter((message): message is RuntimeMessage => Boolean(message));

export const transcriptReplacementKind = (event: JsonObject): string => {
  const kind = text(event.kind);
  if (kind === "context_patch") return text(event.patch_kind);
  return kind === "replacement" ? text(event.replacement_kind) : kind;
};

export const transcriptDisplayMarker = (event: JsonObject): JsonObject | undefined => {
  const kind = transcriptReplacementKind(event);
  if (kind === "compaction") {
    const count = Math.max(0, Math.trunc(Number(event.compacted_count ?? 0)));
    return { role: "system", content: `[上下文已压缩：${count} 条消息 → 摘要]` };
  }
  if (kind === "context_reset") return { role: "system", content: "[上下文已重置]" };
  if (kind === "memory_clear") return { role: "system", content: "[上下文记忆已清空]" };
  return undefined;
};

const patchInteger = (value: unknown, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid transcript context_patch ${name}`);
  return parsed;
};

export const applyTranscriptEvent = (
  previous: RuntimeMessage[],
  event: JsonObject,
): RuntimeMessage[] => {
  if (text(event.kind) === "message") {
    const message = normalizeTranscriptMessage(event.message);
    return message ? [...previous, message] : previous;
  }
  if (text(event.kind) === "context_patch") {
    const start = patchInteger(event.start, "start");
    const deleteCount = patchInteger(event.delete_count, "delete_count");
    if (start > previous.length || start + deleteCount > previous.length) {
      throw new Error("transcript context_patch is outside the current model view");
    }
    if (!Array.isArray(event.insert_messages)) {
      throw new Error("transcript context_patch insert_messages must be an array");
    }
    const inserted = normalizeTranscriptMessages(event.insert_messages);
    if (inserted.length !== event.insert_messages.length) {
      throw new Error("transcript context_patch contains an invalid message");
    }
    return [...previous.slice(0, start), ...inserted, ...previous.slice(start + deleteCount)];
  }
  const kind = text(event.kind);
  if (kind === "replacement" || replacementKinds.has(kind)) {
    throw new Error(`transcript contains a legacy v1 "${kind}" event; ${legacyTranscriptMigrationHint}`);
  }
  return previous;
};

const sameMessage = (left: RuntimeMessage, right: RuntimeMessage): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createContextPatchEvent = (
  previous: readonly RuntimeMessage[],
  next: readonly RuntimeMessage[],
  patchKind: string,
  metadata: JsonObject = {},
  timestamp = Date.now() / 1_000,
): JsonObject => {
  let prefix = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefix < sharedLength && sameMessage(previous[prefix]!, next[prefix]!)) prefix += 1;
  let suffix = 0;
  while (
    suffix < sharedLength - prefix &&
    sameMessage(previous[previous.length - suffix - 1]!, next[next.length - suffix - 1]!)
  ) suffix += 1;
  return {
    ...metadata,
    kind: "context_patch",
    start: prefix,
    delete_count: previous.length - prefix - suffix,
    insert_messages: next.slice(prefix, next.length - suffix) as unknown as JsonObject[],
    patch_kind: patchKind,
    ts: timestamp,
  };
};

export const transcriptHeader = (sessionId: string, createdAt = new Date().toISOString()): JsonObject => ({
  kind: "transcript_header",
  version: TRANSCRIPT_VERSION,
  session_id: sessionId,
  created_at: createdAt,
});

export interface TranscriptByteLine {
  event: JsonObject;
  byteStart: number;
  byteEnd: number;
}

export interface ScannedTranscriptBuffer {
  lines: TranscriptByteLine[];
  completeBytes: number;
}

const parseEvent = (raw: string, lineNumber?: number): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const location = lineNumber === undefined ? "" : ` at line ${lineNumber}`;
    throw new Error(`invalid transcript JSON${location}`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`transcript event must be an object${lineNumber === undefined ? "" : ` at line ${lineNumber}`}`);
  }
  return parsed as JsonObject;
};

export const tryParseTranscriptEvent = (raw: string): JsonObject | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as JsonObject
    : undefined;
};

export const scanTranscriptBuffer = (
  buffer: Uint8Array,
  baseOffset = 0,
  includeFinalLine = false,
): ScannedTranscriptBuffer => {
  const decoder = new TextDecoder();
  const lines: TranscriptByteLine[] = [];
  let lineStart = 0;
  let lineNumber = 0;
  const appendLine = (lineEnd: number, byteEnd: number): void => {
    lineNumber += 1;
    const raw = decoder.decode(buffer.subarray(lineStart, lineEnd)).trim();
    if (raw) lines.push({ event: parseEvent(raw, lineNumber), byteStart: baseOffset + lineStart, byteEnd: baseOffset + byteEnd });
    lineStart = byteEnd;
  };
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) appendLine(index, index + 1);
  }
  if (includeFinalLine && lineStart < buffer.length) {
    // The final line has no terminating newline, so it may be the torn tail
    // of an append interrupted by a crash. Keep terminated lines strict, but
    // exclude an unparseable unterminated tail instead of failing the scan.
    const raw = decoder.decode(buffer.subarray(lineStart)).trim();
    const event = raw ? tryParseTranscriptEvent(raw) : undefined;
    if (event) {
      lines.push({ event, byteStart: baseOffset + lineStart, byteEnd: baseOffset + buffer.length });
      lineStart = buffer.length;
    } else if (!raw) {
      lineStart = buffer.length;
    }
  }
  return { lines, completeBytes: baseOffset + lineStart };
};

export const parseTranscriptText = (raw: string): JsonObject[] => raw.split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => parseEvent(line, index + 1));
