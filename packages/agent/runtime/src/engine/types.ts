import type { AssistantMessage, AssistantMessageEvent } from "../messages/assistant-message";
export type { AssistantMessage, AssistantMessageEvent } from "../messages/assistant-message";
import type {
  AgentJob,
  DesktopStreamBatchRequest,
  EmitRequest,
  JsonObject,
  JsonValue,
  ToolStepStatus,
  WorkspaceContext,
} from "@lxe/protocol";
import type { RuntimeWireTraceAttempt } from "../providers/wire-trace";
import type { WorkspaceLease, WorkspaceSnapshot } from "../workspace/instance-manager";

export interface TextBlock extends JsonObject {
  type: "text";
  text: string;
}

export interface ToolCallBlock extends JsonObject {
  type: "tool_call";
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolResultBlock extends JsonObject {
  type: "tool_result";
  tool_call_id: string;
  content: string | JsonObject[];
  is_error?: boolean;
}

export type RuntimeContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | JsonObject;

export type RuntimeMessageContent = string | RuntimeContentBlock[];

export interface RuntimeEnvironmentSnapshot {
  current_date: string;
  timezone: string;
  cwd: string;
  worktree: string;
  artifact_root?: string;
  os: string;
  bun_version: string;
  platform: string;
  provider: string;
  model: string;
}

export interface RuntimeConversationMessage {
  environmentContext?: RuntimeEnvironmentSnapshot;
  role: "user" | "assistant" | "tool" | "system";
  content: RuntimeMessageContent;
}

export interface RuntimeCompactionSummaryMessage {
  role: "compactionSummary";
  content?: never;
  summary: string;
  tokensBefore: number;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}

export type RuntimeMessage = RuntimeConversationMessage | RuntimeCompactionSummaryMessage | AssistantMessage;

export interface RuntimeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface RuntimeProviderUserIdentity {
  platform: string;
  userId: string;
}

export interface RuntimeSummaryRequest {
  messages: RuntimeMessage[];
  signal: AbortSignal;
  kind: "history" | "midturn";
  maxOutputTokens: number;
  userIdentity?: RuntimeProviderUserIdentity;
}

export interface RuntimeSummaryResult {
  text: string;
  usage: RuntimeUsage;
}

export interface RuntimeProviderRequest {
  system: string;
  messages: RuntimeMessage[];
  tools: ToolSchema[];
  toolChoice: "auto" | "none";
  signal: AbortSignal;
  userIdentity?: RuntimeProviderUserIdentity;
  onEvent?: (event: AssistantMessageEvent) => Promise<void> | void;
  wireTrace?: RuntimeWireTraceAttempt;
}

export interface RuntimeProvider {
  turn(request: RuntimeProviderRequest): Promise<AssistantMessage>;
  summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult>;
}

export interface RuntimeHandle {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  drainSteering(): Array<{ text: string; response_route_id?: string; message_id?: string }>;
  registerProcess(process: { kill(): void | Promise<void>; forceKill(): void | Promise<void> }): () => void;
}

export interface RuntimeSessionRecord {
  session_id: string;
  source: JsonObject;
  workspace: WorkspaceContext;
}

export interface ToolTurnUsage extends JsonObject {
  name: string;
  calls: number;
  errors: number;
  duration_ms: number;
}

export interface SkillActivationUsage extends JsonObject {
  skill: string;
  module: string;
}

export interface SkillExecutionUsage extends JsonObject {
  skill: string;
  module: string;
  command: string;
  success: boolean;
  duration_ms: number;
}

export interface RuntimeTurnUsageRecord extends JsonObject {
  turn_id: string;
  started_at: number;
  platform?: string;
  bot_app_id?: string;
  bot_id?: string;
  bot_name?: string;
  provider?: string;
  model?: string;
  status: string;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  tool_calls: number;
  api_calls: number;
  tools: ToolTurnUsage[];
  activations: SkillActivationUsage[];
  executions: SkillExecutionUsage[];
}

export interface RuntimeTurnContextRecord extends JsonObject {
  turn_id: string;
  job_kind: "turn" | "heartbeat";
  provider: string;
  model: string;
  credential_source?: "local" | "cloud";
  effort: string;
  thinking_enabled: boolean;
  provider_generation: number;
  context_window_tokens: number;
  ts: number;
}

export interface RuntimeArtifactRecord extends JsonObject {
  artifact_id: string;
  turn_id: string;
  tool_call_id: string;
  path: string;
  name: string;
  ts: number;
}

export interface RuntimeAttachmentRecord extends JsonObject {
  attachment_id: string;
  turn_id: string;
  path: string;
  name: string;
  size_bytes: number;
  media_type: string;
  ts: number;
}

export interface RuntimeSkillSnapshot {
  readonly names: readonly string[];
  readonly prompt: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly disabledConnectorIds?: readonly string[];
}

export interface RuntimeStore {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined>;
  popPendingEvents(sessionId: string): Promise<JsonObject[]>;
  loadMessages(sessionId: string): Promise<RuntimeMessage[]>;
  appendTurnContext(sessionId: string, context: RuntimeTurnContextRecord): Promise<void>;
  appendArtifact(sessionId: string, artifact: RuntimeArtifactRecord): Promise<void>;
  appendTurnError(sessionId: string, turnId: string, message: string): Promise<void>;
  resolveArtifact(sessionId: string, artifactId: string): Promise<RuntimeArtifactRecord | undefined>;
  resolveAttachment(sessionId: string, attachmentId: string): Promise<RuntimeAttachmentRecord | undefined>;
  attachmentPaths(sessionId: string): Promise<string[]>;
  appendMessage(sessionId: string, message: RuntimeMessage, reason?: string, turnId?: string): Promise<void>;
  replaceMessages(
    sessionId: string,
    messages: RuntimeMessage[],
    replacementKind: "compaction" | "repair" | "history_limit" | "context_replacement",
    metadata?: JsonObject,
  ): Promise<void>;
  patchSessionState(sessionId: string, patch: JsonObject): Promise<void>;
  recordTurn(sessionId: string, metrics: RuntimeTurnUsageRecord): Promise<void>;
}

export interface SystemPromptContext {
  platform: string;
  provider: string;
  model: string;
  skillPrompt: string;
  workspace: WorkspaceContext;
  workspaceSnapshot?: WorkspaceSnapshot;
}

export interface RuntimeWorkspaceInstanceProvider {
  acquire(workspace: WorkspaceContext): Promise<WorkspaceLease>;
  disposeAll(reason: string): Promise<void>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonObject;
}

export interface ToolExecutionResult {
  content: JsonObject[];
  state_patch?: JsonObject;
  files?: string[];
  /** Allows a yielded tool call to remain visually running after its handler returns. */
  display_status?: ToolStepStatus;
}

export interface RuntimeEmitter {
  emit(request: EmitRequest): Promise<void>;
  desktopStream?(request: DesktopStreamBatchRequest): Promise<void>;
  typing(request: {
    session_id: string;
    turn_id: string;
    response_route_id: string;
    operation: "start" | "stop";
    emit_id: string;
  }): Promise<void>;
}

export interface TurnOutcome {
  status: "completed" | "cancelled" | "error";
  reply: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
}

export interface AgentRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome>;
}

export const objectValue = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
