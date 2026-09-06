import type {
  ConversationArtifactGroup,
  ConversationRenderItem,
  ConversationResponseGroup,
  ConversationTimelineItem,
  ConversationToolGroup,
  SessionArtifactPayload,
  SessionMessage,
  DesktopConversationStreamPayload,
} from "../../api/payloads";
import { isRecord } from "../../shared/content";

export function roleLabel(role: string): string {
  const normalized = String(role || "unknown").toLowerCase();
  return ["user", "assistant", "tool", "system"].includes(normalized) ? normalized : "unknown";
}

export function blockType(block: unknown): string {
  return isRecord(block) ? String(block.type || "") : "";
}

export function isToolCallBlock(block: unknown): boolean {
  const type = blockType(block);
  return type === "tool_use" || type === "tool_call";
}

export function isToolResultBlock(block: unknown): boolean {
  return blockType(block) === "tool_result";
}

export function toolCallBlocks(message: SessionMessage): unknown[] {
  return Array.isArray(message.content) ? message.content.filter(isToolCallBlock) : [];
}

export function toolResultBlocks(message: SessionMessage): unknown[] {
  return Array.isArray(message.content) ? message.content.filter(isToolResultBlock) : [];
}

function isReaderFacingTextBlock(block: unknown): boolean {
  return blockType(block) === "text" && Boolean(isRecord(block) && String(block.text ?? "").trim());
}

/**
 * Whether the message says anything the reader is meant to read. Thinking and
 * tool calls do not count: a message made only of those is how the answer was
 * reached, and the view strips it of the card chrome an actual reply gets.
 */
export function hasReaderFacingText(message: SessionMessage): boolean {
  if (typeof message.content === "string") return Boolean(message.content.trim());
  if (!Array.isArray(message.content)) return false;
  return message.content.some(isReaderFacingTextBlock);
}

/** Copy the answer the reader can see, never its hidden thinking or tool calls. */
export function readerFacingMessageText(message: SessionMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(isReaderFacingTextBlock)
    .map((block) => isRecord(block) ? String(block.text ?? "") : "")
    .join("\n\n");
}

function isPureToolAssistantMessage(message: SessionMessage): boolean {
  if (roleLabel(message.role) !== "assistant") return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every(isToolCallBlock);
}

function isToolGroupMessage(message: SessionMessage): boolean {
  return isPureToolAssistantMessage(message) || roleLabel(message.role) === "tool";
}

export function hasToolError(messages: SessionMessage[]): boolean {
  return messages.some((message) =>
    toolResultBlocks(message).some((result) => isRecord(result) && result.is_error));
}

export function toolGroupArtifacts(messages: SessionMessage[]): SessionArtifactPayload[] {
  const artifacts = messages.flatMap((message) => Array.isArray(message.artifacts) ? message.artifacts : []);
  return [...new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact])).values()];
}

function renderItemArtifacts(item: ConversationRenderItem): SessionArtifactPayload[] {
  if (item.type === "artifact_group") return item.group.files;
  if (item.type === "tool_group") return toolGroupArtifacts(item.group.messages);
  if (item.type === "response_group") return toolGroupArtifacts(item.group.messages);
  return toolGroupArtifacts([
    item.message,
    ...item.toolGroups.flatMap((group) => group.messages),
  ]);
}

/**
 * Artifacts are persisted on the exact display message that was current when
 * the file was sent. A single turn can therefore expose the same artifact on
 * both sides of a tool result, or expose several batches across multiple tool
 * groups. The conversation presents one durable file section per turn, placed
 * after that turn's last artifact-bearing render item.
 */
function appendArtifactGroups(items: ConversationRenderItem[]): ConversationRenderItem[] {
  const aggregates = new Map<string, {
    group: ConversationArtifactGroup;
    ids: Set<string>;
    lastIndex: number;
  }>();

  items.forEach((item, index) => {
    for (const artifact of renderItemArtifacts(item)) {
      const turnId = String(artifact.turn_id || "").trim();
      if (!turnId) continue;
      let aggregate = aggregates.get(turnId);
      if (!aggregate) {
        aggregate = {
          group: { turnId, files: [], key: `artifacts-${turnId}` },
          ids: new Set<string>(),
          lastIndex: index,
        };
        aggregates.set(turnId, aggregate);
      }
      aggregate.lastIndex = index;
      if (!aggregate.ids.has(artifact.artifact_id)) {
        aggregate.ids.add(artifact.artifact_id);
        aggregate.group.files.push(artifact);
      }
    }
  });

  if (!aggregates.size) return items;
  const groupsAfter = new Map<number, ConversationArtifactGroup[]>();
  for (const aggregate of aggregates.values()) {
    const groups = groupsAfter.get(aggregate.lastIndex) ?? [];
    groups.push(aggregate.group);
    groupsAfter.set(aggregate.lastIndex, groups);
  }

  return items.flatMap((item, index) => [
    item,
    ...(groupsAfter.get(index) ?? []).map((group): ConversationRenderItem => ({
      type: "artifact_group",
      group,
    })),
  ]);
}

export interface ToolOperation {
  key: string;
  name: string;
  argument: string;
  action: ToolAction;
  target: string;
  status: "running" | "success" | "error";
  expandable?: boolean;
  call: unknown;
  result: unknown;
}

/** A live row is expandable when it can reveal its input, output, or error. */
export function hasLiveToolOperationDetails(step: unknown): boolean {
  if (!isRecord(step)) return false;
  const detail = String(step.detail ?? "").trim();
  const result = isRecord(step.result_block) ? String(step.result_block.content ?? "").trim() : "";
  const error = isRecord(step.error_block) ? String(step.error_block.content ?? "").trim() : "";
  return Boolean(detail || result || error);
}

export type ToolAction =
  | "read"
  | "edit"
  | "write"
  | "search"
  | "list"
  | "run"
  | "send"
  | "web"
  | "tool";

export type ToolActionLabels = Record<ToolAction, string>;

export interface ToolBatchSummaryLabels {
  actions: ToolActionLabels;
  more: (count: number) => string;
  failures: (count: number) => string;
}

export interface ToolBatchSummary {
  text: string;
  errorCount: number;
  operationCount: number;
}

const TOOL_ACTIONS: Record<string, ToolAction> = {
  read: "read",
  read_file: "read",
  edit: "edit",
  edit_file: "edit",
  write: "write",
  write_file: "write",
  grep: "search",
  find: "search",
  search: "search",
  tool_search: "search",
  ls: "list",
  list: "list",
  list_files: "list",
  exec: "run",
  process: "run",
  send_file: "send",
  send_files: "send",
  web_search: "web",
  web_fetch: "web",
};

const fileBasename = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) || normalized;
};

export function toolOperationPresentation(name: string, argument: string): {
  action: ToolAction;
  target: string;
} {
  const normalizedName = name.trim().toLowerCase();
  const action = TOOL_ACTIONS[normalizedName] ?? "tool";
  if (action === "tool") return { action, target: name.trim() || "tool" };
  if (["read", "edit", "write", "list", "send"].includes(action)) {
    return { action, target: fileBasename(argument) };
  }
  return { action, target: argument.trim() };
}

/** Build a stable, local summary without asking the model to narrate its own tools. */
export function summarizeToolOperations(
  operations: ToolOperation[],
  labels: ToolBatchSummaryLabels,
): ToolBatchSummary {
  const grouped = new Map<ToolAction, { action: ToolAction; count: number; targets: Set<string> }>();
  for (const operation of operations) {
    const current = grouped.get(operation.action);
    if (current) {
      current.count += 1;
      if (operation.target) current.targets.add(operation.target);
    } else {
      grouped.set(operation.action, {
        action: operation.action,
        count: 1,
        targets: new Set(operation.target ? [operation.target] : []),
      });
    }
  }

  const groups = [...grouped.values()];
  const shown = groups.slice(0, 3);
  const segments = shown.map((group) => {
    const oneTarget = group.targets.size === 1 ? [...group.targets][0] : "";
    const target = group.count === 1 || oneTarget ? oneTarget : "";
    return [labels.actions[group.action], target, group.count > 1 ? `×${group.count}` : ""]
      .filter(Boolean).join(" ");
  });
  const hiddenCount = groups.slice(3).reduce((total, group) => total + group.count, 0);
  if (hiddenCount > 0) segments.push(labels.more(hiddenCount));
  const errorCount = operations.filter((operation) => operation.status === "error").length;
  if (errorCount > 0) segments.push(labels.failures(errorCount));
  return {
    text: segments.join(" · "),
    errorCount,
    operationCount: operations.length,
  };
}

/**
 * Keys that usually carry the one value identifying what a call did, ordered to
 * match how the runtime's own tool descriptors rank them: a search is described
 * by what it looked for, not by where it looked.
 */
const OPERATION_ARGUMENT_KEYS = [
  "command", "pattern", "query", "url", "path", "file_path", "action", "name",
];

const scalarText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : "";

function operationArgument(call: unknown): string {
  if (!isRecord(call)) return "";
  const input = call.input ?? call.arguments;
  if (!isRecord(input)) return scalarText(input);
  for (const key of OPERATION_ARGUMENT_KEYS) {
    const value = scalarText(input[key]);
    if (value) return value;
  }
  for (const value of Object.values(input)) {
    const text = scalarText(value);
    if (text) return text;
  }
  return "";
}

/**
 * Splits a call's input into the one value that describes it — the command, the
 * path, the query — and everything else, so the detail view can lead with the
 * former instead of printing the whole input object as JSON.
 */
export function splitCallArguments(call: unknown): { primary: string; rest: Record<string, unknown> } {
  if (!isRecord(call)) return { primary: "", rest: {} };
  const input = call.input ?? call.arguments;
  if (!isRecord(input)) return { primary: scalarText(input), rest: {} };
  const keys = Object.keys(input);
  const primaryKey = OPERATION_ARGUMENT_KEYS.find((key) => scalarText(input[key]))
    ?? keys.find((key) => scalarText(input[key]))
    ?? "";
  const rest: Record<string, unknown> = {};
  for (const key of keys) {
    if (key !== primaryKey) rest[key] = input[key];
  }
  return { primary: primaryKey ? scalarText(input[primaryKey]) : "", rest };
}

/** Live tool steps do not carry the transcript's full call object, so their
 * display detail is the fallback source for the primary argument. */
export function toolOperationArguments(
  operation: Pick<ToolOperation, "argument" | "call">,
): { primary: string; rest: Record<string, unknown> } {
  const { primary, rest } = splitCallArguments(operation.call);
  return { primary: primary || operation.argument.trim(), rest };
}

const blockId = (block: unknown, keys: string[]): string => {
  if (!isRecord(block)) return "";
  for (const key of keys) {
    const value = scalarText(block[key]);
    if (value) return value;
  }
  return "";
};

const toolResultStatus = (result: unknown): ToolOperation["status"] => {
  if (!isRecord(result)) return "success";
  const displayStatus = scalarText(result.display_status);
  if (displayStatus === "running" || displayStatus === "success" || displayStatus === "error") {
    return displayStatus;
  }
  return result.is_error ? "error" : "success";
};

/**
 * Pairs each call in a group with the result it produced so the expanded group
 * can list one line per operation instead of dumping every message in full.
 * Results that match no call still get a line - dropping them would hide a
 * failure.
 */
export function toolOperations(messages: SessionMessage[]): ToolOperation[] {
  const calls: unknown[] = [];
  const results: unknown[] = [];
  for (const message of messages) {
    calls.push(...toolCallBlocks(message));
    const own = toolResultBlocks(message);
    if (own.length) results.push(...own);
    else if (roleLabel(message.role) === "tool") results.push({ type: "tool_result", ...message });
  }

  const unclaimed = [...results];
  const take = (callId: string): unknown => {
    const index = callId
      ? unclaimed.findIndex((result) => blockId(result, ["tool_call_id", "tool_use_id"]) === callId)
      : -1;
    const at = index >= 0 ? index : (callId ? -1 : 0);
    if (at < 0 || at >= unclaimed.length) return undefined;
    return unclaimed.splice(at, 1)[0];
  };

  const operations: ToolOperation[] = calls.map((call, index) => {
    const callId = blockId(call, ["id", "tool_call_id", "tool_use_id"]);
    const result = take(callId);
    const name = (isRecord(call) ? scalarText(call.name) : "") || "tool";
    const argument = operationArgument(call);
    return {
      key: callId || `call-${index}`,
      name,
      argument,
      ...toolOperationPresentation(name, argument),
      status: toolResultStatus(result),
      call,
      result,
    };
  });
  unclaimed.forEach((result, index) => {
    const name = (isRecord(result) ? scalarText(result.tool_name) : "") || "tool";
    operations.push({
      key: blockId(result, ["tool_call_id", "tool_use_id"]) || `result-${index}`,
      name,
      argument: "",
      ...toolOperationPresentation(name, ""),
      status: toolResultStatus(result),
      call: undefined,
      result,
    });
  });
  return operations;
}

const hasRenderableContent = (message: SessionMessage): boolean => {
  if (typeof message.content === "string") return Boolean(message.content.trim());
  if (Array.isArray(message.content)) return message.content.length > 0;
  return message.content !== undefined;
};

const containsToolCall = (message: SessionMessage): boolean =>
  toolCallBlocks(message).length > 0
  || (message.tool_calls !== undefined
    && message.tool_calls !== null
    && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0));

export function fallbackToolCallBlocks(value: unknown): unknown[] {
  const calls = Array.isArray(value) ? value : [value];
  return calls.map((call) => {
    if (isToolCallBlock(call)) return call;
    if (!isRecord(call)) return { type: "tool_call", name: "__tool_calls__", input: call };
    const fn = isRecord(call.function) ? call.function : {};
    return {
      type: "tool_call",
      ...(call.id === undefined ? {} : { id: call.id }),
      name: call.name ?? fn.name ?? "__tool_calls__",
      arguments: call.arguments ?? fn.arguments ?? call.input ?? call,
    };
  });
}

type ToolResultCandidate = {
  block: unknown;
  claimed: boolean;
  message: SessionMessage;
  messageIndex: number;
  ordinal: number;
};

function resultCandidates(messages: SessionMessage[]): ToolResultCandidate[] {
  return messages.flatMap((message, messageIndex) => {
    const blocks = toolResultBlocks(message);
    const results = blocks.length
      ? blocks
      : roleLabel(message.role) === "tool"
        ? [{ type: "tool_result", ...message }]
        : [];
    return results.map((block, ordinal) => ({
      block,
      claimed: false,
      message,
      messageIndex,
      ordinal,
    }));
  });
}

function timelineMessage(
  source: SessionMessage,
  content: SessionMessage["content"],
): SessionMessage {
  const message = { ...source, content };
  delete message.tool_calls;
  return message;
}

function toolTimelineItem(
  messages: SessionMessage[],
  displayGroupId: string,
  startIndex: number,
  keySuffix: string,
): Extract<ConversationTimelineItem, { type: "tool" }> {
  const key = `tool-${displayGroupId}-${keySuffix}`;
  return {
    type: "tool",
    key,
    group: { messages, startIndex, key },
    presentation: "process",
  };
}

export function finalResponseIndex(messages: SessionMessage[], status?: string | null): number {
  const terminalIsReply = status !== "error" && status !== "cancelled";
  return terminalIsReply
    ? messages.reduce((candidate, message, index) =>
      roleLabel(message.role) === "assistant" && hasReaderFacingText(message) && !containsToolCall(message)
        ? index
        : candidate, -1)
    : -1;
}

function buildResponseGroup(
  messages: SessionMessage[],
  displayGroupId: string,
  startIndex: number,
): ConversationResponseGroup {
  const turn = messages.find((message) => message.turn)?.turn;
  const finalIndex = finalResponseIndex(messages, turn?.status);
  const results = resultCandidates(messages);
  const timeline: ConversationTimelineItem[] = [];
  const takeResult = (call: unknown): ToolResultCandidate | undefined => {
    const callId = blockId(call, ["id", "tool_call_id", "tool_use_id"]);
    const result = callId
      ? results.find((candidate) => !candidate.claimed
          && blockId(candidate.block, ["tool_call_id", "tool_use_id"]) === callId)
      : results.find((candidate) => !candidate.claimed);
    if (result) result.claimed = true;
    return result;
  };
  const resultMessage = (candidate: ToolResultCandidate): SessionMessage =>
    timelineMessage(candidate.message, [candidate.block]);
  const addTool = (call: unknown, source: SessionMessage, messageIndex: number, keySuffix: string): void => {
    const result = takeResult(call);
    timeline.push(toolTimelineItem([
      timelineMessage(source, [call]),
      ...(result ? [resultMessage(result)] : []),
    ], displayGroupId, startIndex + messageIndex, keySuffix));
  };
  const addOrphanResult = (candidate: ToolResultCandidate): void => {
    candidate.claimed = true;
    timeline.push(toolTimelineItem(
      [resultMessage(candidate)],
      displayGroupId,
      startIndex + candidate.messageIndex,
      `result-${candidate.messageIndex}-${candidate.ordinal}`,
    ));
  };

  messages.forEach((message, messageIndex) => {
    if (roleLabel(message.role) === "tool") {
      results.filter((candidate) => candidate.messageIndex === messageIndex && !candidate.claimed)
        .forEach(addOrphanResult);
      return;
    }

    if (!Array.isArray(message.content)) {
      if (hasRenderableContent(message)) {
        timeline.push({
          type: "message",
          message: timelineMessage(message, message.content),
          presentation: messageIndex === finalIndex ? "final" : "process",
          key: `message-${displayGroupId}-${messageIndex}`,
        });
      }
    } else {
      let pendingBlocks: unknown[] = [];
      let pendingPresentation: "process" | "final" = "process";
      let messageOrdinal = 0;
      const flushMessage = (): void => {
        if (!pendingBlocks.length) return;
        timeline.push({
          type: "message",
          message: timelineMessage(message, pendingBlocks),
          presentation: pendingPresentation,
          key: `message-${displayGroupId}-${messageIndex}-${messageOrdinal}`,
        });
        pendingBlocks = [];
        messageOrdinal += 1;
      };
      message.content.forEach((block, blockIndex) => {
        if (isToolCallBlock(block)) {
          flushMessage();
          addTool(block, message, messageIndex, `call-${messageIndex}-${blockIndex}`);
          return;
        }
        if (isToolResultBlock(block)) {
          flushMessage();
          const candidate = results.find((entry) => entry.messageIndex === messageIndex
            && entry.block === block && !entry.claimed);
          if (candidate) addOrphanResult(candidate);
          return;
        }
        const presentation = messageIndex === finalIndex && isReaderFacingTextBlock(block)
          ? "final"
          : "process";
        if (pendingBlocks.length && presentation !== pendingPresentation) flushMessage();
        pendingPresentation = presentation;
        pendingBlocks.push(block);
      });
      flushMessage();
    }

    if (!toolCallBlocks(message).length && message.tool_calls !== undefined && message.tool_calls !== null) {
      fallbackToolCallBlocks(message.tool_calls).forEach((call, fallbackIndex) => {
        addTool(call, message, messageIndex, `fallback-${messageIndex}-${fallbackIndex}`);
      });
    }
  });

  return {
    displayGroupId,
    messages,
    timeline,
    ...(finalIndex >= 0 ? { metadataMessage: messages[finalIndex] } : {}),
    ...(turn ? { turn } : {}),
    key: `response-${displayGroupId}`,
  };
}

export function buildConversationItems(messages: SessionMessage[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const displayGroupId = String(message.display_group_id || `legacy-${index}`);
    let end = index + 1;
    while (end < messages.length && messages[end]?.display_group_id === message.display_group_id) end += 1;
    const displayMessages = messages.slice(index, end);
    const roles = displayMessages.map((entry) => roleLabel(entry.role));
    if (roles.some((role) => role === "assistant") && roles.every((role) => role === "assistant" || role === "tool")) {
      items.push({ type: "response_group", group: buildResponseGroup(displayMessages, displayGroupId, index) });
    } else if (displayMessages.every(isToolGroupMessage)) {
      items.push({
        type: "tool_group",
        group: { messages: displayMessages, startIndex: index, key: `tools-${displayGroupId}` },
      });
    } else {
      displayMessages.forEach((entry, offset) => {
        items.push({ type: "message", message: entry, index: index + offset, toolGroups: [] });
      });
    }
    index = end;
  }
  return appendArtifactGroups(items);
}

export type LiveTimelineItem = {
  type: "text" | "thinking" | "tool";
  partId: string;
  key: string;
  presentation: "process" | "final";
};

/** Preserve the runtime's ordered Part list. The phase may change how the
 * latest text looks, but never removes or relocates that Part. */
export function buildLiveTimeline(
  parts: DesktopConversationStreamPayload["process_parts"],
  phase: DesktopConversationStreamPayload["display_metrics"]["phase"] | undefined,
): LiveTimelineItem[] {
  const ordered = [...parts].sort((left, right) => left.sequence - right.sequence);
  const latestToolSequence = ordered.reduce(
    (sequence, part) => part.type === "tool" ? Math.max(sequence, part.sequence) : sequence,
    Number.NEGATIVE_INFINITY,
  );
  return ordered.map((part) => ({
    type: part.type,
    partId: part.part_id,
    key: `live-${part.part_id}`,
    presentation: part.type === "text" && (
      part.presentation === "final"
      || (phase === "generating_answer" && part.sequence > latestToolSequence)
    ) ? "final" : "process",
  }));
}
