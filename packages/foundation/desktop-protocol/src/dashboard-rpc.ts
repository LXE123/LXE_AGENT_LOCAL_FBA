import type { DesktopStreamMutation, DisplayMetrics, ToolStep, TurnProcessPart } from "@lxe/protocol";
export type { TurnProcessPart } from "@lxe/protocol";

export type CapabilityPayload = {
  provider: string;
  model: string;
  context_window_tokens: number;
  max_tokens: number;
  max_output_tokens?: number;
  supports_vision: boolean;
  supports_thinking: boolean;
  supports_temperature: boolean;
};

export type ThinkingStatePayload = {
  enabled: boolean;
  level: string;
  editable: boolean;
};

export type ModelOptionPayload = {
  model: string;
  thinking_request_style: string;
  thinking_levels: string[];
  thinking_level_labels: Record<string, string>;
  thinking_default: string;
  capabilities: CapabilityPayload;
};

export type ModelPayload = {
  provider: string;
  credential_source: "local" | "cloud";
  label: string;
  api_style: string;
  model: string;
  configured: boolean;
  selectable: boolean;
  disabled_reason: string;
  model_options: ModelOptionPayload[];
  thinking_request_style: string;
  thinking_levels: string[];
  thinking_level_labels: Record<string, string>;
  thinking_default: string;
  thinking_state: ThinkingStatePayload;
  capabilities: CapabilityPayload;
};

export type ModelMutationPayload = ModelPayload & {
  generation: number;
  effective_from: "next_turn";
};

export type WorkspacePayload = {
  directory: string;
  worktree: string;
};

export type SourceSummary = {
  platform: string;
  chat_type: string;
};

export type SessionPayload = {
  session_id: string;
  title: string;
  pinned_at: number;
  source: Record<string, unknown>;
  source_summary: SourceSummary;
  workspace: WorkspacePayload;
  model: string;
  reasoning_effort: string;
  model_config: Record<string, unknown>;
  created_at: number;
  last_active_at: number;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  api_call_count: number;
};

export type SessionMessage = {
  display_group_id: string;
  display_id?: string;
  client_message_id?: string;
  message_id?: string;
  source_reason?: string;
  role: string;
  /** Epoch seconds from the immutable transcript event. */
  created_at?: number;
  content?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: unknown;
  turn?: SessionTurnDisplayPayload;
  artifacts?: SessionArtifactPayload[];
  attachments?: DesktopInputAttachmentPayload[];
  [key: string]: unknown;
};

export type SessionTurnDisplayPayload = {
  turn_id: string;
  status: "completed" | "cancelled" | "error" | null;
  elapsed_ms: number | null;
};

export type DesktopInputAttachmentPayload = {
  attachment_id: string;
  name: string;
  size_bytes: number;
  media_type: string;
};

export type SessionArtifactPayload = {
  artifact_id: string;
  turn_id: string;
  tool_call_id: string;
  name: string;
};

export type DashboardContentTruncationPayload = {
  truncated: true;
  original_bytes: number;
  preview_bytes: number;
};

export type MessagesPagePayload = {
  /** Epoch milliseconds at which this page was read from the transcript. */
  fetched_at: number;
  total: number;
  raw_message_total: number;
  limit: number;
  oldest_cursor: string | null;
  newest_cursor: string | null;
  previous_cursor: string | null;
  has_previous: boolean;
  next_cursor?: string | null;
  has_next?: boolean;
  group_cursors?: string[];
};

export type SessionDetailPayload = {
  session: SessionPayload;
  messages: SessionMessage[];
  messages_page: MessagesPagePayload;
};

export type DesktopConversationTurnState =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "cancelled"
  | "error";

export type DesktopConversationStreamPayload = {
  seq: number;
  state: "delta" | "final" | "error";
  content: string;
  thinking: string;
  redacted_thinking_count: number;
  thinking_elapsed_ms: number;
  tool_pending: boolean;
  tool_elapsed_ms: number;
  tool_steps: ToolStep[];
  process_parts: TurnProcessPart[];
  display_metrics: DisplayMetrics;
};

/** Persistence timestamps are informational; display handoff uses message identity. */
export type DesktopConversationTurnPayload = {
  turn_id: string;
  message_id: string;
  client_message_id?: string;
  text: string;
  attachments?: DesktopInputAttachmentPayload[];
  state: DesktopConversationTurnState;
  /** Epoch milliseconds captured when the desktop message was created. */
  created_at?: number;
  /** Epoch milliseconds; zero until the scheduler starts this turn. */
  started_at: number;
  user_persisted_at: number;
  settled_at: number;
  stream?: DesktopConversationStreamPayload;
};

export type DesktopConversationActivityPayload = {
  session_id: string;
  active: DesktopConversationTurnPayload | null;
  queued: DesktopConversationTurnPayload[];
  latest: DesktopConversationTurnPayload | null;
};

export type DesktopConversationEvent = {
  activity: DesktopConversationActivityPayload;
};

export type DesktopConversationStreamBatch = {
  session_id: string;
  turn_id: string;
  emit_id: string;
  seq: number;
  mutations: DesktopStreamMutation[];
};

export type DesktopConversationStreamEvent = {
  batch: DesktopConversationStreamBatch;
};

export type DesktopConversationSendPayload = {
  session_id: string;
  turn_id: string;
  message_id: string;
  client_message_id?: string;
  created: boolean;
  state: "running" | "queued";
};

export type DesktopConversationStopPayload = {
  session_id: string;
  stopped_turn_id: string | null;
  cleared_turn_ids: string[];
};

/** `error` carries the operating system's own failure text, never a stand-in. */
export type DesktopConversationFileOpenPayload = {
  opened: boolean;
  error: string;
};

/**
 * `error` carries the operating system's own failure text where one exists.
 * shell.showItemInFolder reports nothing back, so a reveal can only speak for
 * the steps that do report: resolving the artifact, and confirming the file is
 * still on disk. Past that point `revealed` means the request was made, and the
 * payload says nothing it cannot know.
 */
export type DesktopConversationFileRevealPayload = {
  revealed: boolean;
  error: string;
};

export type SessionSummaryPayload = {
  total_sessions: number;
  tool_call_count: number;
  token_count: number;
};

export type ApiList<T> = {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
};

export type SessionListPayload = ApiList<SessionPayload> & {
  summary: SessionSummaryPayload;
};

export type WorkspaceReloadPayload = {
  changed: boolean;
  generation: number;
  loaded_at: number;
  instruction_count: number;
  skill_count: number;
};

export type SkillReferencePayload = {
  path: string;
  description: string;
};

export type SkillPayload = {
  name: string;
  type: string;
  description: string;
  commands: string[];
  location: string;
  references: SkillReferencePayload[];
  source?: "repository" | "user";
  diagnostics?: Array<{
    code: "user_skill_shadowed";
    message: string;
    skill_name: string;
    repository_path: string;
    user_path: string;
  }>;
};

export type SkillContentPayload = SkillPayload & {
  content: string;
};

export type SkillReferenceContentPayload = {
  skill_name: string;
  path: string;
  description: string;
  location: string;
  content: string;
};

export type CliCommandPayload = {
  command: string;
  name: string;
  visibility: "business" | "browser" | "maintenance" | "internal";
  ownerSkills: string[];
};

export type ConnectorPayload = {
  id: string;
  name: string;
  description: string;
  kind: string;
  enabled: boolean;
  everConnected: boolean;
  userDisabled: boolean;
  skill_names: string[];
  skill_count: number;
};

export type ToolPayload = {
  name: string;
  raw_name: string;
  description: string;
  parameters: Record<string, unknown>;
  requires_resource: string | null;
  source: string;
  exposure: string;
  connector_name: string;
};

export type McpServerPayload = {
  name: string;
  enabled: boolean;
  transport: string;
  status: string;
  tool_count: number;
  error: string;
  server_title: string;
  connector_id: string;
  connector_name: string;
  connector_description: string;
  exposure: string;
  tools: Array<{ rawName: string; modelName: string }>;
};

export type ToolsetPayload = {
  name: string;
  label: string;
  enabled: boolean;
  tools: ToolPayload[];
  servers?: McpServerPayload[];
};

export type McpServerListPayload = ApiList<McpServerPayload> & {
  tool_total: number;
};

export type ChannelHealthPayload = {
  ready?: boolean;
  running?: boolean;
  thread_alive?: boolean;
  connection_alive?: boolean;
  connection_state?: string;
  restart_monitor_alive?: boolean;
  restart_in_progress?: boolean;
  next_restart_at?: string;
  last_restart_at?: string;
  last_restart_error?: string;
  last_connected_at?: string;
  last_disconnected_at?: string;
  last_error?: string;
};

export type ChannelHealthList = {
  items: Record<string, ChannelHealthPayload>;
  total: number;
};

export type SkillStatPayload = {
  name: string;
  module: string;
  activations: number;
  executions: number;
  failures: number;
  execution_turns: number;
  duration_ms: number;
  last_used_at: number;
};

export type SkillUsageDetailPayload = {
  name: string;
  days: number;
  daily: Array<{
    day: string;
    activations: number;
    executions: number;
    failures: number;
  }>;
  recent_failures: Array<{
    turn_id: string;
    session_id: string;
    started_at: number;
    command: string;
  }>;
};

export type ToolStatPayload = {
  name: string;
  calls: number;
  errors: number;
  duration_ms: number;
  turns: number;
  last_used_at: number;
};

export type StatsOverviewPayload = {
  days: number;
  /** Local hour of day the operator is busiest in, or null when nothing ran. */
  peak_hour: number | null;
  totals: {
    turns: number;
    error_turns: number;
    tool_calls: number;
    llm_calls: number;
    input_tokens: number;
    output_tokens: number;
    skill_executions: number;
    skill_failures: number;
  };
  modules: Array<{
    module: string;
    skills: number;
    turns: number;
    executions: number;
    failures: number;
    duration_ms: number;
  }>;
  daily: Array<{
    day: string;
    turns: number;
    tool_calls: number;
    executions: number;
    failures: number;
  }>;
};

export type DashboardRpcEmptyInput = Record<string, never>;

export interface DashboardRpcSpec {
  "sessions.list": {
    input: { query?: string; limit?: number; offset?: number };
    result: SessionListPayload;
  };
  "sessions.detail": {
    input: { session_id: string; message_limit?: number; message_before?: string; message_after?: string };
    result: SessionDetailPayload;
  };
  "sessions.pin": {
    input: { session_id: string; pinned: boolean };
    result: SessionPayload;
  };
  "sessions.delete": {
    input: { session_id: string };
    result: { session_id: string; deleted: true };
  };
  "sessions.send": {
    input: { session_id?: string; text: string; attachment_ids?: string[]; client_message_id?: string };
    result: DesktopConversationSendPayload;
  };
  "sessions.stop": {
    input: { session_id: string };
    result: DesktopConversationStopPayload;
  };
  "sessions.activity": {
    input: { session_id: string };
    result: DesktopConversationActivityPayload;
  };
  "sessions.file.open": {
    input: { session_id: string; artifact_id: string };
    result: DesktopConversationFileOpenPayload;
  };
  "sessions.file.reveal": {
    input: { session_id: string; artifact_id: string };
    result: DesktopConversationFileRevealPayload;
  };
  "sessions.attachment.open": {
    input: { session_id: string; attachment_id: string };
    result: DesktopConversationFileOpenPayload;
  };
  "sessions.workspace.reload": {
    input: { session_id: string };
    result: WorkspaceReloadPayload;
  };
  "skills.list": { input: DashboardRpcEmptyInput; result: ApiList<SkillPayload> };
  "skills.content": { input: { name: string }; result: SkillContentPayload };
  "skills.reference": {
    input: { name: string; path: string };
    result: SkillReferenceContentPayload;
  };
  "commands.list": { input: DashboardRpcEmptyInput; result: ApiList<CliCommandPayload> };
  "connectors.list": { input: DashboardRpcEmptyInput; result: ApiList<ConnectorPayload> };
  "connectors.update": { input: { id: string; enabled: boolean }; result: ConnectorPayload };
  "toolsets.list": { input: DashboardRpcEmptyInput; result: ApiList<ToolsetPayload> };
  "mcp.servers.list": { input: DashboardRpcEmptyInput; result: McpServerListPayload };
  "mcp.servers.update": { input: { name: string; enabled: boolean }; result: McpServerPayload };
  "channels.health": { input: DashboardRpcEmptyInput; result: ChannelHealthList };
  "stats.overview": { input: { days?: number }; result: StatsOverviewPayload };
  "stats.skills.list": { input: { days?: number }; result: ApiList<SkillStatPayload> & { days: number } };
  "stats.skills.detail": { input: { name: string; days?: number }; result: SkillUsageDetailPayload };
  "stats.tools.list": { input: { days?: number }; result: ApiList<ToolStatPayload> & { days: number } };
  "models.list": { input: DashboardRpcEmptyInput; result: ApiList<ModelPayload> };
  "models.current": { input: DashboardRpcEmptyInput; result: ModelPayload };
  "models.update": {
    input: { provider: string; model?: string; credential_source?: "local" | "cloud" };
    result: ModelMutationPayload;
  };
  "models.thinking.update": { input: { level: string }; result: ModelMutationPayload };
}

export type DashboardRpcOperation = keyof DashboardRpcSpec;

export type DashboardRpcCall<
  O extends DashboardRpcOperation = DashboardRpcOperation,
> = O extends DashboardRpcOperation
  ? { operation: O; input: DashboardRpcSpec[O]["input"] }
  : never;

export type DashboardRpcResult<O extends DashboardRpcOperation> =
  DashboardRpcSpec[O]["result"];

export type AgentDashboardRpcOperation = Exclude<
  DashboardRpcOperation,
  "channels.health" | "sessions.send" | "sessions.stop" | "sessions.activity"
    | "sessions.file.open" | "sessions.file.reveal" | "sessions.attachment.open"
>;

export type AgentDashboardRpcCall<
  O extends AgentDashboardRpcOperation = AgentDashboardRpcOperation,
> = DashboardRpcCall<O>;

export type AgentDashboardRpcHandlers = {
  [O in AgentDashboardRpcOperation]: (
    input: DashboardRpcSpec[O]["input"],
  ) => DashboardRpcSpec[O]["result"] | Promise<DashboardRpcSpec[O]["result"]>;
};

export interface DashboardTransport {
  call<O extends DashboardRpcOperation>(
    call: DashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>>;
}

export type DashboardRpcErrorCode =
  | "invalid_request"
  | "invalid_argument"
  | "not_found"
  | "failed_precondition"
  | "unavailable";

export class DashboardRpcError extends Error {
  override readonly name = "DashboardRpcError";

  constructor(
    readonly code: DashboardRpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_INPUT_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 8_192;
const MAX_ATTACHMENTS = 5;

const rpcError = (message: string): never => {
  throw new DashboardRpcError("invalid_request", message);
};

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return rpcError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unsupported.length > 0) rpcError(`${label} has unsupported fields: ${unsupported.join(", ")}`);
};

const textValue = (
  value: unknown,
  label: string,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined => {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new DashboardRpcError("invalid_request", `${label} must be a string`);
  if (value.length > MAX_TEXT_LENGTH) rpcError(`${label} is too long`);
  const normalized = value.trim();
  if (!normalized && !options.allowEmpty) rpcError(`${label} must be a non-empty string`);
  return normalized;
};

const integerValue = (
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DashboardRpcError("invalid_request", `${label} must be a safe integer`);
  }
  return Math.max(minimum, Math.min(value, maximum));
};

const booleanValue = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") {
    throw new DashboardRpcError("invalid_request", `${label} must be a boolean`);
  }
  return value;
};

const attachmentIdsValue = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return rpcError(`${label} must be an array`);
  if (value.length > MAX_ATTACHMENTS) rpcError(`${label} must contain at most ${MAX_ATTACHMENTS} items`);
  const ids = value.map((item, index) => textValue(item, `${label}[${index}]`)!);
  if (new Set(ids).size !== ids.length) rpcError(`${label} must not contain duplicate IDs`);
  return ids.length > 0 ? ids : undefined;
};

const emptyInput = (input: Record<string, unknown>, operation: string): DashboardRpcEmptyInput => {
  exactKeys(input, [], `${operation}.input`);
  return {};
};

export function parseDashboardRpcCall(value: unknown): DashboardRpcCall {
  const call = objectValue(value, "Dashboard RPC call");
  exactKeys(call, ["operation", "input"], "Dashboard RPC call");
  if (typeof call.operation !== "string") rpcError("Dashboard RPC operation must be a string");
  const operation = call.operation;
  const input = objectValue(call.input, `${operation}.input`);
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return rpcError("Dashboard RPC input must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_INPUT_BYTES) {
    rpcError("Dashboard RPC input is too large");
  }

  switch (operation) {
    case "sessions.list":
      exactKeys(input, ["query", "limit", "offset"], `${operation}.input`);
      return { operation, input: {
        query: textValue(input.query, `${operation}.query`, { optional: true, allowEmpty: true }) ?? "",
        limit: integerValue(input.limit, `${operation}.limit`, 50, 1, 200),
        offset: integerValue(input.offset, `${operation}.offset`, 0, 0, Number.MAX_SAFE_INTEGER),
      } };
    case "sessions.detail": {
      exactKeys(input, ["session_id", "message_limit", "message_before", "message_after"], `${operation}.input`);
      if (input.message_before !== undefined && input.message_after !== undefined) rpcError("before and after are mutually exclusive");
      const messageAfter = textValue(input.message_after, `${operation}.message_after`, { optional: true });
      const messageBefore = textValue(input.message_before, `${operation}.message_before`, { optional: true });
      return { operation, input: {
        session_id: textValue(input.session_id, `${operation}.session_id`)!,
        message_limit: integerValue(input.message_limit, `${operation}.message_limit`, 10, 1, 200),
        ...(messageBefore === undefined ? {} : { message_before: messageBefore }),
        ...(messageAfter === undefined ? {} : { message_after: messageAfter }),
      } };
    }
    case "sessions.pin":
      exactKeys(input, ["session_id", "pinned"], `${operation}.input`);
      return { operation, input: {
        session_id: textValue(input.session_id, `${operation}.session_id`)!,
        pinned: booleanValue(input.pinned, `${operation}.pinned`),
      } };
    case "sessions.delete":
      exactKeys(input, ["session_id"], `${operation}.input`);
      return { operation, input: { session_id: textValue(input.session_id, `${operation}.session_id`)! } };
    case "sessions.send": {
      exactKeys(input, ["session_id", "text", "attachment_ids", "client_message_id"], `${operation}.input`);
      const text = textValue(input.text, `${operation}.text`, { allowEmpty: true })!;
      const attachmentIds = attachmentIdsValue(input.attachment_ids, `${operation}.attachment_ids`);
      if (!text && !attachmentIds?.length) rpcError(`${operation} requires text or an attachment`);
      return { operation, input: {
        ...(input.session_id === undefined
          ? {}
          : { session_id: textValue(input.session_id, `${operation}.session_id`)! }),
        text,
        ...(attachmentIds ? { attachment_ids: attachmentIds } : {}),
        ...(input.client_message_id === undefined ? {} : { client_message_id: textValue(input.client_message_id, `${operation}.client_message_id`)! }),
      } };
    }
    case "sessions.stop":
    case "sessions.activity":
      exactKeys(input, ["session_id"], `${operation}.input`);
      return { operation, input: { session_id: textValue(input.session_id, `${operation}.session_id`)! } };
    case "sessions.file.open":
    case "sessions.file.reveal":
      exactKeys(input, ["session_id", "artifact_id"], `${operation}.input`);
      return { operation, input: {
        session_id: textValue(input.session_id, `${operation}.session_id`)!,
        artifact_id: textValue(input.artifact_id, `${operation}.artifact_id`)!,
      } };
    case "sessions.attachment.open":
      exactKeys(input, ["session_id", "attachment_id"], `${operation}.input`);
      return { operation, input: {
        session_id: textValue(input.session_id, `${operation}.session_id`)!,
        attachment_id: textValue(input.attachment_id, `${operation}.attachment_id`)!,
      } };
    case "sessions.workspace.reload":
      exactKeys(input, ["session_id"], `${operation}.input`);
      return { operation, input: { session_id: textValue(input.session_id, `${operation}.session_id`)! } };
    case "skills.list":
    case "commands.list":
    case "connectors.list":
    case "toolsets.list":
    case "mcp.servers.list":
    case "channels.health":
    case "models.list":
    case "models.current":
      return { operation, input: emptyInput(input, operation) } as DashboardRpcCall;
    case "skills.content":
      exactKeys(input, ["name"], `${operation}.input`);
      return { operation, input: { name: textValue(input.name, `${operation}.name`)! } };
    case "skills.reference":
      exactKeys(input, ["name", "path"], `${operation}.input`);
      return { operation, input: {
        name: textValue(input.name, `${operation}.name`)!,
        path: textValue(input.path, `${operation}.path`)!,
      } };
    case "connectors.update":
      exactKeys(input, ["id", "enabled"], `${operation}.input`);
      return { operation, input: {
        id: textValue(input.id, `${operation}.id`)!,
        enabled: booleanValue(input.enabled, `${operation}.enabled`),
      } };
    case "mcp.servers.update":
      exactKeys(input, ["name", "enabled"], `${operation}.input`);
      return { operation, input: {
        name: textValue(input.name, `${operation}.name`)!,
        enabled: booleanValue(input.enabled, `${operation}.enabled`),
      } };
    case "stats.overview":
    case "stats.skills.list":
    case "stats.tools.list":
      exactKeys(input, ["days"], `${operation}.input`);
      return { operation, input: { days: integerValue(input.days, `${operation}.days`, 30, 1, 365) } } as DashboardRpcCall;
    case "stats.skills.detail":
      exactKeys(input, ["name", "days"], `${operation}.input`);
      return { operation, input: {
        name: textValue(input.name, `${operation}.name`)!,
        days: integerValue(input.days, `${operation}.days`, 30, 1, 365),
      } };
    case "models.update":
      exactKeys(input, ["provider", "model", "credential_source"], `${operation}.input`);
      if (input.credential_source !== undefined
        && input.credential_source !== "local"
        && input.credential_source !== "cloud") {
        return rpcError(`${operation}.credential_source must be local or cloud`);
      }
      return { operation, input: {
        provider: textValue(input.provider, `${operation}.provider`)!,
        ...(input.model === undefined ? {} : { model: textValue(input.model, `${operation}.model`, { allowEmpty: true })! }),
        ...(input.credential_source === undefined ? {} : { credential_source: input.credential_source }),
      } };
    case "models.thinking.update":
      exactKeys(input, ["level"], `${operation}.input`);
      return { operation, input: { level: textValue(input.level, `${operation}.level`)! } };
    default:
      return rpcError(`unsupported Dashboard RPC operation: ${operation}`);
  }
}

export function parseAgentDashboardRpcCall(value: unknown): AgentDashboardRpcCall {
  const call = parseDashboardRpcCall(value);
  if (call.operation === "channels.health"
    || call.operation === "sessions.send"
    || call.operation === "sessions.stop"
    || call.operation === "sessions.activity"
    || call.operation === "sessions.file.open"
    || call.operation === "sessions.file.reveal"
    || call.operation === "sessions.attachment.open") {
    return rpcError(`${call.operation} is owned by Electron Main`);
  }
  return call;
}
