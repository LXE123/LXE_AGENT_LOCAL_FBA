export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface WorkspaceContext extends JsonObject {
  directory: string;
  worktree: string;
}

export type AgentDiagnostic = JsonObject & {
  type: "operation_failure";
  provider: string;
  operation: string;
  stage: string;
  error_name: string;
  observed_error: string;
  redacted: boolean;
  truncated: boolean;
  cause_known: boolean;
  verified_reason?: string;
  mapping_id?: string;
  http_status?: number;
  provider_code?: number | string;
  provider_subcode?: number | string;
  log_id?: string;
  endpoint?: string;
};

export interface SessionWorkspaceRequest {
  session_id: string;
  source: JsonObject;
  workspace: WorkspaceContext;
  entry_text?: string;
}
export interface InboundEvent {
  platform: string;
  event_type: string;
  user_input: string;
  user_id: string;
  conversation_id: string;
  is_group: boolean;
  message_id: string;
  sender_nick: string;
  response_route_id: string;
  union_id: string;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentJob {
  job_id: string;
  session_id: string;
  session_key: string;
  response_route_id: string;
  user_id: string;
  conversation_id: string;
  is_group: boolean;
  message_id: string;
  user_input: string;
  job_kind: string;
  sender_nick: string;
  workspace: WorkspaceContext;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
  diagnostics: AgentDiagnostic[];
}

export type PendingSystemEvent = JsonObject & {
  event_id: string;
  job_id: string;
  created_at: number;
  text: string;
  response_route_id?: string;
};

export type ToolStepStatus = "running" | "success" | "error";

export interface ToolDisplayBlock extends JsonObject {
  language: "json" | "text";
  content: string;
}

export interface ToolStep {
  id: string;
  name: string;
  title: string;
  detail: string;
  icon_token: string;
  status: ToolStepStatus;
  duration_ms: number;
  result_block?: ToolDisplayBlock;
  error_block?: ToolDisplayBlock;
}

export type TurnProcessPart =
  | {
      type: "thinking";
      part_id: string;
      sequence: number;
      status: "streaming" | "completed" | "error";
      text: string;
      redacted_count: number;
    }
  | {
      type: "text";
      part_id: string;
      sequence: number;
      status: "streaming" | "completed" | "error";
      presentation: "process" | "final";
      text: string;
    }
  | {
      type: "tool";
      part_id: string;
      sequence: number;
      tool_step: ToolStep;
    };

export type TurnDisplayStatus = "running" | "completed" | "error" | "cancelled";

export type TurnDisplayPhase =
  | "preparing_context"
  | "waiting_model"
  | "thinking"
  | "running_tool"
  | "generating_answer";

export interface DisplayMetrics extends JsonObject {
  status: TurnDisplayStatus;
  phase: TurnDisplayPhase;
  elapsed_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  context_tokens: number;
  context_window_tokens: number;
}

export type DesktopStreamMutation =
  | {
      kind: "part_updated";
      part: TurnProcessPart;
    }
  | {
      kind: "part_delta";
      part_id: string;
      field: "text";
      delta: string;
    }
  | {
      kind: "stream_updated";
      state: "delta" | "final" | "error";
      display_metrics: DisplayMetrics;
    };

/** Runtime-to-Gateway request. The response route is removed before Renderer IPC. */
export interface DesktopStreamBatchRequest {
  session_id: string;
  turn_id: string;
  response_route_id: string;
  emit_id: string;
  seq: number;
  mutations: DesktopStreamMutation[];
}

interface EmitRequestPayload {
  session_id: string;
  turn_id: string;
  response_route_id: string;
  content: string;
  thinking: string;
  redacted_thinking_count: number;
  thinking_elapsed_ms: number;
  tool_pending: boolean;
  tool_elapsed_ms: number;
  tool_steps: ToolStep[];
  files: string[];
  emit_id: string;
}

export type EmitRequest = EmitRequestPayload & (
  | {
      emit_kind: "stream";
      stream_type: "final_answer";
      state: "delta" | "final" | "error";
      seq: number;
      display_metrics: DisplayMetrics;
      process_parts: TurnProcessPart[];
    }
  | {
      emit_kind: "final" | "tool" | "progress";
      stream_type: "";
      state: "";
      seq: 0;
      display_metrics?: never;
      process_parts?: never;
    }
);
