import type { JsonObject, JsonValue } from "@lxe/protocol";
import { isAbsolute } from "node:path";
import { createLogger } from "@lxe/core";
import type {
  RuntimeMessage,
  RuntimeMessageContent,
  RuntimeProvider,
  RuntimeProviderUserIdentity,
  RuntimeStore,
  RuntimeUsage,
  ToolResultBlock,
  ToolSchema,
  ToolCallBlock,
} from "./types";
import { compactionSummaryProviderText } from "./compaction-summary";
import { RuntimeProviderError } from "../providers/provider-errors";

export const IMAGE_TOKEN_ESTIMATE = 1_600;
export const RECENT_RAW_TURN_TOKEN_LIMIT = 20_000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
export const DEFAULT_RESERVE_TOKENS = 20_000;
export const STEP_TOOL_RESULT_MAX_TOKENS = 10_000;
export const SUMMARY_COMPACTION_MAX_RETRIES = 3;
export const SUMMARY_RETRY_BASE_DELAY_MS = 2_000;
export const PRECALL_COMPACTION_USAGE_THRESHOLD = 0.9;

const MISSING_TOOL_RESULT_STUB = "[Result unavailable — see context summary above]";
const THINKING_SUMMARY_PLACEHOLDER = "[assistant thinking omitted]";
const REDACTED_THINKING_SUMMARY_PLACEHOLDER = "[assistant redacted thinking omitted]";
const PROCESSED_IMAGE_PLACEHOLDER = "[image data removed - already processed by model]";
const SPLIT_TURN_SUMMARY_SEPARATOR = "\n\n---\n\n**Turn Context (split turn):**\n\n";

export const HISTORY_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_HISTORY_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const MIDTURN_SUMMARY_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const emptyUsage = (): RuntimeUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const addUsage = (target: RuntimeUsage, source: RuntimeUsage): void => {
  target.input_tokens += Math.max(0, Math.trunc(source.input_tokens ?? 0));
  target.output_tokens += Math.max(0, Math.trunc(source.output_tokens ?? 0));
  target.cache_read_input_tokens = Math.max(0, Math.trunc(target.cache_read_input_tokens ?? 0)) +
    Math.max(0, Math.trunc(source.cache_read_input_tokens ?? 0));
  target.cache_creation_input_tokens = Math.max(0, Math.trunc(target.cache_creation_input_tokens ?? 0)) +
    Math.max(0, Math.trunc(source.cache_creation_input_tokens ?? 0));
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const jsonObject = (value: unknown): JsonObject => structuredClone(object(value)) as JsonObject;
const text = (value: unknown): string => String(value ?? "");
const blocks = (message: RuntimeMessage): Array<Record<string, unknown>> =>
  message.role !== "compactionSummary" && Array.isArray(message.content) ? message.content.map(object) : [];

const isToolCall = (value: Record<string, unknown>): value is ToolCallBlock =>
  value.type === "tool_call" && typeof value.id === "string";

const isToolResult = (value: Record<string, unknown>): value is ToolResultBlock =>
  value.type === "tool_result" && typeof value.tool_call_id === "string";

const isImageBlock = (value: unknown): boolean => object(value).type === "image";

const replaceImagesForEstimate = (value: unknown): { value: unknown; images: number } => {
  if (isImageBlock(value)) {
    return {
      value: { type: "image", source: { type: "base64", media_type: "", data: "[image omitted]" } },
      images: 1,
    };
  }
  if (Array.isArray(value)) {
    let images = 0;
    const items = value.map((item) => {
      const replaced = replaceImagesForEstimate(item);
      images += replaced.images;
      return replaced.value;
    });
    return { value: items, images };
  }
  if (value !== null && typeof value === "object") {
    let images = 0;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const replaced = replaceImagesForEstimate(item);
      images += replaced.images;
      return [key, replaced.value] as const;
    });
    return { value: Object.fromEntries(entries), images };
  }
  return { value, images: 0 };
};

const estimateTextTokens = (value: string): number => Math.ceil(Buffer.byteLength(value, "utf8") / 4);

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (isImageBlock(value)) return IMAGE_TOKEN_ESTIMATE;
  const replaced = replaceImagesForEstimate(value);
  let serialized = "";
  try { serialized = JSON.stringify(replaced.value); } catch { serialized = String(replaced.value); }
  return estimateTextTokens(serialized) + replaced.images * IMAGE_TOKEN_ESTIMATE;
}

export function requestContextTokenEstimate(
  systemPrompt: string,
  messages: readonly RuntimeMessage[],
  toolSchemas: readonly ToolSchema[] = [],
): number {
  return estimateTokens(systemPrompt) +
    messages.reduce((total, message) => total + estimateTokens(
      message.role === "compactionSummary"
        ? { role: "user", content: compactionSummaryProviderText(message.summary) }
        : message,
    ), 0) +
    estimateTokens(toolSchemas);
}

const cleanBlock = (raw: unknown, role: RuntimeMessage["role"]): JsonObject | undefined => {
  const block = object(raw);
  const type = String(block.type ?? "").trim();
  if (type === "text") return { ...jsonObject(block), type, text: text(block.text) };
  if (type === "image" && role === "user") return jsonObject(block);
  if (type === "local_file" && role === "user") {
    const path = text(block.path).trim();
    const attachmentId = text(block.attachment_id).trim();
    const turnId = text(block.turn_id).trim();
    if (!path || !isAbsolute(path) || !attachmentId || !turnId) return undefined;
    return {
      type,
      attachment_id: attachmentId,
      turn_id: turnId,
      path,
      name: text(block.name).trim(),
      size_bytes: Math.max(0, Math.trunc(Number(block.size_bytes ?? 0))),
      media_type: text(block.media_type).trim(),
      ts: Math.max(0, Number(block.ts ?? 0)),
    };
  }
  if (type === "thinking" && role === "assistant") {
    return { ...jsonObject(block), type, thinking: text(block.thinking), ...(block.signature !== undefined ? { signature: text(block.signature) } : {}) };
  }
  if (type === "redacted_thinking" && role === "assistant") {
    return { type, data: text(block.data) };
  }
  if (type === "tool_call" && role === "assistant") {
    const id = text(block.id).trim();
    const name = text(block.name).trim();
    if (!id || !name || block.arguments === undefined) return undefined;
    return { ...jsonObject(block), type, id, name, arguments: jsonObject(block.arguments) };
  }
  if (type === "tool_result" && role === "tool") {
    const toolCallId = text(block.tool_call_id).trim();
    if (!toolCallId) return undefined;
    const content = Array.isArray(block.content)
      ? block.content.map((item) => jsonObject(item))
      : text(block.content);
    return {
      type,
      tool_call_id: toolCallId,
      content,
      ...(block.is_error === true ? { is_error: true } : {}),
    };
  }
  return undefined;
};

export function cleanCanonicalMessages(messages: readonly RuntimeMessage[]): RuntimeMessage[] {
  const cleaned: RuntimeMessage[] = [];
  for (const raw of messages) {
    const role = raw?.role;
    if (role === "compactionSummary") {
      const summary = text(raw.summary).trim();
      if (!summary) continue;
      const modifiedFiles = [...new Set(raw.details.modifiedFiles.map((path) => path.trim()).filter(Boolean))].sort();
      const modified = new Set(modifiedFiles);
      const readFiles = [...new Set(raw.details.readFiles.map((path) => path.trim()).filter((path) => path && !modified.has(path)))].sort();
      cleaned.push({
        role,
        summary,
        tokensBefore: Math.max(0, Math.trunc(raw.tokensBefore)),
        details: { readFiles, modifiedFiles },
      });
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    if (role === "system") {
      const content = Array.isArray(raw.content)
        ? raw.content.map((block) => text(object(block).text)).filter(Boolean).join("\n")
        : text(raw.content);
      cleaned.push({ role, content });
      continue;
    }
    if (!Array.isArray(raw.content)) {
      if (role === "tool") continue;
      cleaned.push(role === "assistant"
        ? { role, content: [{ type: "text", text: text(raw.content) }] }
        : { ...raw, role, content: text(raw.content) });
      continue;
    }
    const content = raw.content.map((block) => cleanBlock(block, role)).filter((block): block is JsonObject => Boolean(block));
    if (content.length > 0) cleaned.push({ ...raw, role, content } as RuntimeMessage);
  }
  return cleaned;
}

export function validateToolCallClosure(messages: readonly RuntimeMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const block of blocks(message)) {
      if (isToolCall(block)) {
        if (message.role !== "assistant") throw new Error(`tool_call must be assistant content: ${block.id}`);
        pending.add(block.id);
      }
      if (isToolResult(block)) {
        if (message.role !== "tool") throw new Error(`tool_result must be tool content: ${block.tool_call_id}`);
        if (!pending.delete(block.tool_call_id)) throw new Error(`orphaned tool_result: ${block.tool_call_id}`);
      }
    }
  }
  if (pending.size > 0) throw new Error(`unclosed tool_call: ${[...pending].join(", ")}`);
}

export function sanitizeMessagesForProvider(messages: readonly RuntimeMessage[]): {
  messages: RuntimeMessage[];
  changed: boolean;
} {
  const original = JSON.stringify(messages);
  const cleaned = cleanCanonicalMessages(messages);
  const pending = new Set<string>();
  const repaired: RuntimeMessage[] = [];

  for (const message of cleaned) {
    if (message.role === "assistant") {
      for (const block of blocks(message)) if (isToolCall(block)) pending.add(block.id);
      repaired.push(message);
      continue;
    }
    if (message.role !== "tool") {
      repaired.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    const content = message.content.filter((rawBlock) => {
      const block = object(rawBlock);
      if (!isToolResult(block)) return true;
      if (!pending.has(block.tool_call_id)) return false;
      pending.delete(block.tool_call_id);
      return true;
    });
    if (content.length > 0) repaired.push({ role: "tool", content });
  }

  if (pending.size > 0) {
    const closed: RuntimeMessage[] = [];
    for (const message of repaired) {
      closed.push(message);
      if (message.role !== "assistant") continue;
      const missing = blocks(message)
        .filter(isToolCall)
        .filter((block) => pending.delete(block.id))
        .map((block): ToolResultBlock => ({
          type: "tool_result",
          tool_call_id: block.id,
          content: MISSING_TOOL_RESULT_STUB,
          is_error: true,
        }));
      if (missing.length > 0) closed.push({ role: "tool", content: missing });
    }
    validateToolCallClosure(closed);
    return { messages: closed, changed: JSON.stringify(closed) !== original };
  }

  validateToolCallClosure(repaired);
  return { messages: repaired, changed: JSON.stringify(repaired) !== original };
}

const decodeUtf8Boundary = (bytes: Uint8Array, fromEnd: boolean): string => {
  for (let trim = 0; trim <= 3 && trim <= bytes.length; trim += 1) {
    const candidate = fromEnd ? bytes.subarray(trim) : bytes.subarray(0, bytes.length - trim);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(candidate); } catch { /* try next boundary */ }
  }
  return "";
};

export function trimTextToTokenBudget(value: string, maxTokens: number): { text: string; trimmed: boolean } {
  const safeMax = Math.max(1, Math.trunc(maxTokens));
  const source = String(value ?? "");
  const bytes = Buffer.from(source, "utf8");
  const maxBytes = safeMax * 4;
  if (bytes.length <= maxBytes) return { text: source, trimmed: false };
  const removedTokens = Math.max(1, estimateTokens(source) - safeMax);
  const marker = `\n…${removedTokens} tokens truncated…\n`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const leftSize = Math.floor(budget / 2);
  const rightSize = budget - leftSize;
  const prefix = decodeUtf8Boundary(bytes.subarray(0, leftSize), false);
  const suffix = decodeUtf8Boundary(bytes.subarray(bytes.length - rightSize), true);
  return { text: `${prefix}${marker}${suffix}`, trimmed: true };
}

const trimInlineContent = (content: JsonObject[], maxTokens: number): { content: JsonObject[]; trimmed: boolean } => {
  const combined = content
    .filter((block) => block.type === "text")
    .map((block) => text(block.text))
    .filter(Boolean)
    .join("\n");
  if (!combined) return { content: structuredClone(content), trimmed: false };
  const result = trimTextToTokenBudget(combined, maxTokens);
  if (!result.trimmed) return { content: structuredClone(content), trimmed: false };
  let inserted = false;
  const next: JsonObject[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (!inserted) next.push({ type: "text", text: result.text });
      inserted = true;
    } else next.push(structuredClone(block));
  }
  if (!inserted) next.unshift({ type: "text", text: result.text });
  return { content: next, trimmed: true };
};

export function trimToolResultBlocks(
  results: readonly ToolResultBlock[],
  maxTokens = STEP_TOOL_RESULT_MAX_TOKENS,
): { results: ToolResultBlock[]; changed: boolean } {
  let changed = false;
  const next = results.map((result): ToolResultBlock => {
    if (Array.isArray(result.content)) {
      const trimmed = trimInlineContent(result.content, maxTokens);
      changed ||= trimmed.trimmed;
      return { ...result, content: trimmed.content };
    }
    const trimmed = trimTextToTokenBudget(result.content, maxTokens);
    changed ||= trimmed.trimmed;
    return { ...result, content: trimmed.text };
  });
  return { results: next, changed };
}

const replaceImages = (content: RuntimeMessageContent): { content: RuntimeMessageContent; changed: boolean } => {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const next = content.map((rawBlock): JsonObject => {
    const block = jsonObject(rawBlock);
    if (block.type === "image") {
      changed = true;
      return { type: "text", text: PROCESSED_IMAGE_PLACEHOLDER };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const nested = block.content.map((item): JsonValue => {
        const child = object(item);
        if (child.type === "image") {
          changed = true;
          return { type: "text", text: PROCESSED_IMAGE_PLACEHOLDER };
        }
        return jsonObject(child);
      });
      return { ...block, content: nested };
    }
    return block;
  });
  return { content: next, changed };
};

export function pruneProcessedHistoryImages(messages: readonly RuntimeMessage[]): {
  messages: RuntimeMessage[];
  changed: boolean;
} {
  let changed = false;
  const next = messages.map((message): RuntimeMessage => {
    if (message.role === "compactionSummary") return structuredClone(message) as RuntimeMessage;
    const replaced = replaceImages(message.content);
    changed ||= replaced.changed;
    return { ...message, content: replaced.content } as RuntimeMessage;
  });
  return { messages: next, changed };
}

interface FileInventory {
  readFiles: string[];
  modifiedFiles: string[];
}

const fileSectionPattern = (tag: "read-files" | "modified-files"): RegExp =>
  new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g");

const stripFileSections = (value: string): string => value
  .replace(fileSectionPattern("read-files"), "")
  .replace(fileSectionPattern("modified-files"), "")
  .trim();

const normalizedFileInventory = (
  readFiles: Iterable<string>,
  modifiedFiles: Iterable<string>,
): FileInventory => {
  const modified = new Set([...modifiedFiles].map((path) => path.trim()).filter(Boolean));
  const read = new Set([...readFiles].map((path) => path.trim()).filter((path) => path && !modified.has(path)));
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
  };
};

const mergeFileInventories = (...inventories: FileInventory[]): FileInventory => normalizedFileInventory(
  inventories.flatMap((inventory) => inventory.readFiles),
  inventories.flatMap((inventory) => inventory.modifiedFiles),
);

const extractFileInventory = (messages: readonly RuntimeMessage[]): FileInventory => {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (message.role === "compactionSummary") {
      message.details.readFiles.forEach((path) => read.add(path));
      message.details.modifiedFiles.forEach((path) => modified.add(path));
      continue;
    }
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (!isToolCall(block)) continue;
      const argumentsValue = object(block.arguments);
      const path = block.name === "read"
        ? text(argumentsValue.path).trim()
        : block.name === "write" || block.name === "edit"
          ? text(argumentsValue.file_path).trim()
          : "";
      if (!path) continue;
      if (block.name === "read") read.add(path);
      else modified.add(path);
    }
  }
  return normalizedFileInventory(read, modified);
};

const formatFileInventory = (inventory: FileInventory): string => {
  const sections: string[] = [];
  if (inventory.readFiles.length > 0) {
    sections.push(`<read-files>\n${inventory.readFiles.join("\n")}\n</read-files>`);
  }
  if (inventory.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${inventory.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
};

const appendFileInventory = (summary: string, inventory: FileInventory): string =>
  `${stripFileSections(summary)}${formatFileInventory(inventory)}`.trim();

const prepareSummaryMessages = (
  messages: readonly RuntimeMessage[],
  inheritedInventory: FileInventory,
): { messages: RuntimeMessage[]; fileInventory: FileInventory } => {
  const prepared = messages
    .filter((message) => message.role !== "compactionSummary")
    .map((message) => structuredClone(message) as RuntimeMessage);
  return {
    messages: prepared,
    fileInventory: mergeFileInventories(inheritedInventory, extractFileInventory(messages)),
  };
};

const isConversationUser = (message: RuntimeMessage): boolean =>
  message.role === "user" && !message.environmentContext;

const turnSpans = (messages: readonly RuntimeMessage[]): Array<[number, number]> => {
  if (messages.length === 0) return [];
  const starts: number[] = [];
  messages.forEach((message, index) => { if (isConversationUser(message)) starts.push(index); });
  if (starts.length === 0) return [[0, messages.length]];
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) => [start, starts[index + 1] ?? messages.length]);
};

const selectRecentTurns = (
  messages: readonly RuntimeMessage[],
  recentRawTokens: number,
): { compacted: RuntimeMessage[]; retained: RuntimeMessage[] } => {
  const spans = turnSpans(messages);
  let keepStart = 0;
  let consumed = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index]!;
    const size = estimateTokens(messages.slice(start, end));
    if (consumed > 0 && consumed + size > recentRawTokens) break;
    keepStart = start;
    consumed += size;
    if (consumed >= recentRawTokens) break;
  }
  return {
    compacted: structuredClone(messages.slice(0, keepStart)) as RuntimeMessage[],
    retained: structuredClone(messages.slice(keepStart)) as RuntimeMessage[],
  };
};

const latestUserStart = (messages: readonly RuntimeMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isConversationUser(messages[index]!)) return index;
  }
  return 0;
};

const stepSpans = (messages: readonly RuntimeMessage[], start: number): Array<[number, number]> => {
  const spans: Array<[number, number]> = [];
  let current: number | undefined;
  for (let index = start; index < messages.length; index += 1) {
    if (messages[index]!.role === "assistant") {
      if (current !== undefined) spans.push([current, index]);
      current = index;
    } else if (current === undefined) current = index;
  }
  if (current !== undefined) spans.push([current, messages.length]);
  return spans;
};

interface MidturnPlan {
  prefix: RuntimeMessage[];
  originalUserMessage: RuntimeMessage;
  compacted: RuntimeMessage[];
  retained: RuntimeMessage[];
}

const selectMidturnPlan = (messages: readonly RuntimeMessage[], recentRawTokens: number): MidturnPlan | undefined => {
  const userStart = latestUserStart(messages);
  const original = messages[userStart];
  if (!original || !isConversationUser(original) || userStart >= messages.length - 1) return undefined;
  const spans = stepSpans(messages, userStart + 1);
  if (spans.length === 0) return undefined;
  let keepIndex = spans.length;
  let consumed = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index]!;
    const size = estimateTokens(messages.slice(start, end));
    if (consumed > 0 && consumed + size > recentRawTokens) break;
    keepIndex = index;
    consumed += size;
    if (consumed >= recentRawTokens) break;
  }
  const compactStart = spans[0]![0];
  const retainedStart = spans[keepIndex]![0];
  return {
    prefix: structuredClone(messages.slice(0, userStart)) as RuntimeMessage[],
    originalUserMessage: structuredClone(original) as RuntimeMessage,
    compacted: structuredClone(messages.slice(compactStart, retainedStart)) as RuntimeMessage[],
    retained: structuredClone(messages.slice(retainedStart)) as RuntimeMessage[],
  };
};

interface CompactionPreparation {
  previousSummary: string;
  inheritedInventory: FileInventory;
  historyMessages: RuntimeMessage[];
  turnPrefixMessages: RuntimeMessage[];
  retained: RuntimeMessage[];
  splitTurn: boolean;
}

const prepareCompaction = (
  messages: readonly RuntimeMessage[],
  recentRawTokens: number,
): CompactionPreparation | undefined => {
  const checkpoints = messages.filter((message) => message.role === "compactionSummary");
  const latestCheckpoint = checkpoints.at(-1);
  const inheritedInventory = mergeFileInventories(
    ...checkpoints.map((message): FileInventory => message.role === "compactionSummary"
      ? message.details
      : { readFiles: [], modifiedFiles: [] }),
  );
  const conversation = messages
    .filter((message) => message.role !== "compactionSummary")
    .map((message) => structuredClone(message) as RuntimeMessage);
  const recent = selectRecentTurns(conversation, recentRawTokens);
  const userStart = latestUserStart(conversation);
  const latestTurnTokens = estimateTokens(conversation.slice(userStart));
  const shouldSplitTurn = latestTurnTokens > recentRawTokens || recent.compacted.length === 0;
  const midturn = shouldSplitTurn ? selectMidturnPlan(conversation, recentRawTokens) : undefined;
  if (midturn) {
    return {
      previousSummary: latestCheckpoint?.role === "compactionSummary"
        ? stripFileSections(latestCheckpoint.summary)
        : "",
      inheritedInventory,
      historyMessages: midturn.prefix,
      turnPrefixMessages: [midturn.originalUserMessage, ...midturn.compacted],
      retained: midturn.retained,
      splitTurn: true,
    };
  }
  if (recent.compacted.length === 0) return undefined;
  return {
    previousSummary: latestCheckpoint?.role === "compactionSummary"
      ? stripFileSections(latestCheckpoint.summary)
      : "",
    inheritedInventory,
    historyMessages: recent.compacted,
    turnPrefixMessages: [],
    retained: recent.retained,
    splitTurn: false,
  };
};

const userText = (content: RuntimeMessageContent): string => {
  if (typeof content === "string") return content.trim();
  return content.map((raw) => {
    const block = object(raw);
    if (block.type === "text") return text(block.text).trim();
    if (block.type === "image") return "[image omitted]";
    if (block.type === "local_file") {
      return `Attached local file: name=${JSON.stringify(text(block.name).trim() || "file")} path=${JSON.stringify(text(block.path).trim())}`;
    }
    return "";
  }).filter(Boolean).join("\n");
};

const renderSummaryTranscript = (messages: readonly RuntimeMessage[]): string => {
  const lines: string[] = [];
  turnSpans(messages).forEach(([start, end], turnIndex) => {
    lines.push(`### Turn ${turnIndex + 1}`);
    for (const message of messages.slice(start, end)) {
      if (message.role === "compactionSummary") {
        const value = stripFileSections(message.summary);
        if (value) lines.push(`History Summary: ${value}`);
        continue;
      }
      if (message.role === "user") {
        const value = userText(message.content);
        if (value) lines.push(`User: ${value}`);
        continue;
      }
      if (message.role === "assistant") {
        if (typeof message.content === "string") {
          if (message.content.trim()) lines.push(`Assistant: ${message.content.trim()}`);
          continue;
        }
        const textParts: string[] = [];
        for (const block of blocks(message)) {
          if (block.type === "thinking") lines.push(`Assistant Thinking: ${THINKING_SUMMARY_PLACEHOLDER}`);
          else if (block.type === "redacted_thinking") lines.push(`Assistant Thinking: ${REDACTED_THINKING_SUMMARY_PLACEHOLDER}`);
          else if (block.type === "text" && text(block.text).trim()) textParts.push(text(block.text).trim());
          else if (isToolCall(block)) lines.push(`Assistant Tool Call: ${block.name} ${JSON.stringify(block.arguments)}`);
        }
        if (textParts.length > 0) lines.push(`Assistant: ${textParts.join(" ")}`);
        continue;
      }
      for (const block of blocks(message)) {
        if (!isToolResult(block)) continue;
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        lines.push(`Tool Result: ${content}`);
      }
    }
  });
  return lines.join("\n");
};

const summaryMessage = (
  summary: string,
  tokensBefore: number,
  inventory: FileInventory,
): RuntimeMessage => ({
  role: "compactionSummary",
  summary: summary.trim(),
  tokensBefore: Math.max(0, Math.trunc(tokensBefore)),
  details: {
    readFiles: [...inventory.readFiles],
    modifiedFiles: [...inventory.modifiedFiles],
  },
});

export function isContextOverflowError(error: unknown): boolean {
  if (object(error).contextOverflow === true || object(error).context_overflow === true) return true;
  const value = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return [
    "context overflow", "context window", "maximum context", "context length", "too many tokens",
    "prompt is too long", "input is too long", "overloaded input", "model token limit",
    "exceeded model token limit", "total message size", "exceeds limit",
  ].some((indicator) => value.includes(indicator));
}

const waitForSummaryRetry = async (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export class ContextOverflowError extends Error {
  readonly contextOverflow = true;
  constructor(readonly estimatedTokens: number, readonly hardLimit: number) {
    super(`当前上下文超过模型窗口，已尝试压缩但仍无法安全发送（estimated=${estimatedTokens} limit=${hardLimit}）。请缩短输入或清理较大的工具结果后重试。`);
    this.name = "ContextOverflowError";
  }
}

export class ContextCompactionError extends Error {
  readonly contextCompaction = true;
  constructor(
    readonly reason: "no_safe_prefix" | "summary_failed" | "summary_not_smaller",
    readonly estimatedTokens: number,
  ) {
    const detail = reason === "no_safe_prefix"
      ? "没有找到可安全压缩且保持工具调用闭合的历史前缀"
      : reason === "summary_not_smaller"
        ? "摘要没有降低上下文 token 数"
        : "上下文摘要在多次尝试后仍失败或为空";
    super(`上下文已达到压缩阈值，但无法安全完成压缩：${detail}（estimated=${estimatedTokens}）。原始历史未被删除，请稍后重试。`);
    this.name = "ContextCompactionError";
  }
}

export interface ContextCompactionResult {
  messages: RuntimeMessage[];
  compacted: boolean;
  summaryText: string;
  compactedCount: number;
  beforeTokens: number;
  afterTokens: number;
  apiCalls: number;
  usage: RuntimeUsage;
  hardLimitExceeded: boolean;
  failureReason?: "no_safe_prefix" | "summary_failed" | "summary_not_smaller";
}

export interface ContextPipelineOptions {
  provider: RuntimeProvider;
  store: RuntimeStore;
  contextWindowTokens?: number;
  reserveTokens?: number;
  recentRawTokens?: number;
  toolResultMaxTokens?: number;
  preCallThreshold?: number;
  summaryMaxRetries?: number;
  summaryRetryBaseDelayMs?: number;
  summaryRetryWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export class ContextPipeline {
  private readonly logger = createLogger("runtime.context");
  private readonly contextWindowTokens: number;
  private readonly reserveTokens: number;
  private readonly recentRawTokens: number;
  readonly toolResultMaxTokens: number;
  readonly hardLimitTokens: number;
  private readonly preCallThreshold: number;
  private readonly summaryMaxRetries: number;
  private readonly summaryRetryBaseDelayMs: number;
  private readonly summaryRetryWait: (delayMs: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: ContextPipelineOptions) {
    this.contextWindowTokens = Math.max(1, Math.trunc(options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS));
    this.reserveTokens = Math.max(1, Math.trunc(options.reserveTokens ?? DEFAULT_RESERVE_TOKENS));
    this.hardLimitTokens = Math.max(1, this.contextWindowTokens - this.reserveTokens);
    this.recentRawTokens = Math.max(1, Math.trunc(options.recentRawTokens ?? RECENT_RAW_TURN_TOKEN_LIMIT));
    this.toolResultMaxTokens = Math.max(1, Math.trunc(options.toolResultMaxTokens ?? STEP_TOOL_RESULT_MAX_TOKENS));
    this.preCallThreshold = Math.min(1, Math.max(0.1, options.preCallThreshold ?? PRECALL_COMPACTION_USAGE_THRESHOLD));
    this.summaryMaxRetries = Math.max(0, Math.trunc(options.summaryMaxRetries ?? SUMMARY_COMPACTION_MAX_RETRIES));
    this.summaryRetryBaseDelayMs = Math.max(0, Math.trunc(options.summaryRetryBaseDelayMs ?? SUMMARY_RETRY_BASE_DELAY_MS));
    this.summaryRetryWait = options.summaryRetryWait ?? waitForSummaryRetry;
  }

  async prepare(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    toolSchemas: ToolSchema[];
    signal: AbortSignal;
    userIdentity?: RuntimeProviderUserIdentity;
    trigger?: "pre_call" | "overflow" | "post_turn";
    additionalContextTokens?: number;
  }): Promise<ContextCompactionResult> {
    const trigger = params.trigger ?? "pre_call";
    const sanitized = sanitizeMessagesForProvider(params.messages);
    let messages = sanitized.messages;
    if (sanitized.changed) {
      await this.options.store.replaceMessages(params.sessionId, messages, "repair", { reason: `${trigger}_repair` });
    }
    const beforeTokens = requestContextTokenEstimate(params.systemPrompt, messages, params.toolSchemas);
    const additionalTokens = Math.max(0, params.additionalContextTokens ?? 0);
    const hardLimit = this.hardLimitTokens - additionalTokens;
    const triggerLimit = trigger === "pre_call"
      ? Math.min(hardLimit, Math.max(1, Math.trunc(this.contextWindowTokens * this.preCallThreshold) - additionalTokens))
      : hardLimit;
    if (trigger !== "overflow" && beforeTokens <= triggerLimit) {
      return {
        messages,
        compacted: false,
        summaryText: "",
        compactedCount: 0,
        beforeTokens,
        afterTokens: beforeTokens,
        apiCalls: 0,
        usage: emptyUsage(),
        hardLimitExceeded: false,
      };
    }

    const compacted = await this.compact({ ...params, messages, trigger, beforeTokens });
    messages = compacted.messages;
    const afterTokens = requestContextTokenEstimate(params.systemPrompt, messages, params.toolSchemas);
    return { ...compacted, afterTokens, hardLimitExceeded: afterTokens > hardLimit };
  }

  async postTurn(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    signal: AbortSignal;
    userIdentity?: RuntimeProviderUserIdentity;
  }): Promise<ContextCompactionResult> {
    const pruned = pruneProcessedHistoryImages(params.messages);
    let messages = pruned.messages;
    if (pruned.changed) {
      await this.options.store.replaceMessages(params.sessionId, messages, "context_replacement", {
        reason: "processed_history_images",
      });
    }
    return this.prepare({
      ...params,
      messages,
      toolSchemas: [],
      trigger: "post_turn",
    });
  }

  private async compact(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    toolSchemas: ToolSchema[];
    signal: AbortSignal;
    userIdentity?: RuntimeProviderUserIdentity;
    trigger: "pre_call" | "overflow" | "post_turn";
    beforeTokens: number;
  }): Promise<ContextCompactionResult> {
    const usage = emptyUsage();
    let apiCalls = 0;
    const preparation = prepareCompaction(params.messages, this.recentRawTokens);
    if (!preparation) {
      return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "no_safe_prefix");
    }

    if (preparation.splitTurn) {
      let historyText = preparation.previousSummary || "No prior history.";
      let historyInventory = preparation.inheritedInventory;
      if (preparation.historyMessages.length > 0) {
        const history = await this.summarize(
          preparation.historyMessages,
          "history",
          params.signal,
          usage,
          {
            ...(params.userIdentity ? { userIdentity: params.userIdentity } : {}),
            previousSummary: preparation.previousSummary,
            inheritedInventory: preparation.inheritedInventory,
          },
        );
        apiCalls += history.attempts;
        if (!history.text) {
          return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_failed");
        }
        historyText = history.text;
        historyInventory = history.fileInventory;
      }

      const turnPrefix = await this.summarize(
        preparation.turnPrefixMessages,
        "midturn",
        params.signal,
        usage,
        params.userIdentity ? { userIdentity: params.userIdentity } : {},
      );
      apiCalls += turnPrefix.attempts;
      if (!turnPrefix.text) {
        return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_failed");
      }
      const inventory = mergeFileInventories(historyInventory, turnPrefix.fileInventory);
      const summaryText = appendFileInventory(
        `${stripFileSections(historyText)}${SPLIT_TURN_SUMMARY_SEPARATOR}${stripFileSections(turnPrefix.text)}`,
        inventory,
      );
      const nextMessages = [
        summaryMessage(summaryText, params.beforeTokens, inventory),
        ...preparation.retained,
      ];
      return this.persistCompaction(
        params,
        nextMessages,
        summaryText,
        preparation.historyMessages.length + preparation.turnPrefixMessages.length,
        usage,
        apiCalls,
        "midturn",
        inventory,
      );
    }

    const history = await this.summarize(
      preparation.historyMessages,
      "history",
      params.signal,
      usage,
      {
        ...(params.userIdentity ? { userIdentity: params.userIdentity } : {}),
        previousSummary: preparation.previousSummary,
        inheritedInventory: preparation.inheritedInventory,
      },
    );
    apiCalls += history.attempts;
    if (!history.text) {
      return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_failed");
    }
    const summaryText = appendFileInventory(history.text, history.fileInventory);
    const nextMessages = [
      summaryMessage(summaryText, params.beforeTokens, history.fileInventory),
      ...preparation.retained,
    ];
    return this.persistCompaction(
      params,
      nextMessages,
      summaryText,
      preparation.historyMessages.length,
      usage,
      apiCalls,
      "history",
      history.fileInventory,
    );
  }

  private async summarize(
    messages: RuntimeMessage[],
    kind: "history" | "midturn",
    signal: AbortSignal,
    usage: RuntimeUsage,
    options: {
      userIdentity?: RuntimeProviderUserIdentity;
      previousSummary?: string;
      inheritedInventory?: FileInventory;
    } = {},
  ): Promise<{ text: string; attempts: number; fileInventory: FileInventory }> {
    const prepared = prepareSummaryMessages(
      messages,
      options.inheritedInventory ?? { readFiles: [], modifiedFiles: [] },
    );
    const transcript = renderSummaryTranscript(prepared.messages);
    if (!transcript.trim()) return { text: "", attempts: 0, fileInventory: prepared.fileInventory };
    const promptParts = [`<conversation>\n${transcript}\n</conversation>`];
    const previousSummary = stripFileSections(options.previousSummary ?? "");
    if (previousSummary) {
      promptParts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
    }
    promptParts.push(kind === "history"
      ? previousSummary ? UPDATE_HISTORY_SUMMARY_PROMPT : HISTORY_SUMMARY_PROMPT
      : MIDTURN_SUMMARY_PROMPT);
    const prompt = promptParts.join("\n\n");
    const maxOutputTokens = Math.max(1, Math.floor(this.reserveTokens * (kind === "history" ? 0.8 : 0.5)));
    const maxAttempts = this.summaryMaxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      let retryable = false;
      try {
        const result = await this.options.provider.summarize({
          messages: [{ role: "user", content: prompt }],
          signal,
          kind,
          maxOutputTokens,
          ...(options.userIdentity ? { userIdentity: options.userIdentity } : {}),
        });
        addUsage(usage, result.usage);
        if (result.text.trim()) {
          return {
            text: stripFileSections(result.text),
            attempts: attempt,
            fileInventory: prepared.fileInventory,
          };
        }
        retryable = true;
        this.logger.warn("context summary returned empty", { kind, attempt, max_attempts: maxAttempts });
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        this.logger.warn("context summary failed", { kind, attempt, max_attempts: maxAttempts, error });
        if (isContextOverflowError(error)) {
          return { text: "", attempts: attempt, fileInventory: prepared.fileInventory };
        }
        retryable = error instanceof RuntimeProviderError && error.retryable;
      }
      if (!retryable || attempt >= maxAttempts) {
        return { text: "", attempts: attempt, fileInventory: prepared.fileInventory };
      }
      const retryNumber = attempt;
      const delayMs = this.summaryRetryBaseDelayMs * 2 ** (retryNumber - 1);
      this.logger.warn("context summary retry scheduled", {
        kind,
        retry: retryNumber,
        max_retries: this.summaryMaxRetries,
        delay_ms: delayMs,
      });
      await this.summaryRetryWait(delayMs, signal);
    }
    return { text: "", attempts: maxAttempts, fileInventory: prepared.fileInventory };
  }

  private async persistCompaction(
    params: {
      sessionId: string;
      messages: RuntimeMessage[];
      systemPrompt: string;
      toolSchemas: ToolSchema[];
      signal: AbortSignal;
      userIdentity?: RuntimeProviderUserIdentity;
      trigger: "pre_call" | "overflow" | "post_turn";
      beforeTokens: number;
    },
    messages: RuntimeMessage[],
    summaryText: string,
    compactedCount: number,
    usage: RuntimeUsage,
    apiCalls: number,
    kind: "history" | "midturn",
    fileInventory: FileInventory,
  ): Promise<ContextCompactionResult> {
    const sanitized = sanitizeMessagesForProvider(messages).messages;
    const afterTokens = requestContextTokenEstimate(params.systemPrompt, sanitized, params.toolSchemas);
    if (afterTokens >= params.beforeTokens) {
      this.logger.warn("context summary did not reduce tokens", {
        trigger: params.trigger,
        before_tokens: params.beforeTokens,
        after_tokens: afterTokens,
      });
      return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_not_smaller");
    }
    if (params.signal.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    await this.options.store.replaceMessages(params.sessionId, sanitized, "compaction", {
      reason: `${params.trigger}_compaction`,
      trigger: params.trigger,
      summary_kind: kind,
      summary_text: summaryText,
      compacted_count: compactedCount,
      before_tokens: params.beforeTokens,
      after_tokens: afterTokens,
      read_files: fileInventory.readFiles,
      modified_files: fileInventory.modifiedFiles,
    });
    this.logger.info("context compacted", {
      session_id: params.sessionId,
      trigger: params.trigger,
      kind,
      compacted_count: compactedCount,
      before_tokens: params.beforeTokens,
      after_tokens: afterTokens,
    });
    return {
      messages: sanitized,
      compacted: true,
      summaryText,
      compactedCount,
      beforeTokens: params.beforeTokens,
      afterTokens,
      apiCalls,
      usage,
      hardLimitExceeded: false,
    };
  }

  private noCompaction(
    messages: RuntimeMessage[],
    tokens: number,
    usage: RuntimeUsage,
    apiCalls: number,
    failureReason?: ContextCompactionResult["failureReason"],
  ): ContextCompactionResult {
    return {
      messages,
      compacted: false,
      summaryText: "",
      compactedCount: 0,
      beforeTokens: tokens,
      afterTokens: tokens,
      apiCalls,
      usage,
      hardLimitExceeded: false,
      ...(failureReason === undefined ? {} : { failureReason }),
    };
  }
}
