import { describe, expect, test } from "bun:test";
import job from "../../protocol/fixtures/valid-agent-job.json";
import emit from "../../protocol/fixtures/valid-emit-request.json";
import {
  AGENT_PROTOCOL_VERSION, decodeAgentEvent, encodeAgentEvent, parseAgentCall,
  parseAgentWireMessage, parseJsonRpcEnvelope, JsonRpcError,
  type AgentCommandPayloads, type AgentEvent,
} from "../src";

const initialize = {
  protocol_version: AGENT_PROTOCOL_VERSION,
  agent_soul_path: "/soul", skills_root: "/skills", user_skills_root: "/user-skills",
  lxeskill_catalog_path: "/catalog", llm_config_root: "/llm", data_root: "/data",
  legacy_workspace: { directory: "/work", worktree: "/work" },
};
const methods = {
  initialize,
  update_skill_permissions: { allowed_skill_types: [] },
  update_managed_llm_credential: { credential: null },
  run_turn: { job },
  cancel_turn: { run_id: "run" },
  steer_turn: { run_id: "run", text: "follow up", response_route_id: "route", message_id: "message" },
  ensure_session: { request: { session_id: "session", source: {}, workspace: initialize.legacy_workspace } },
  append_pending_event: { session_id: "session", event: {} },
  has_pending_events: { session_id: "session" },
  resolve_artifact: { session_id: "session", artifact_id: "file" },
  resolve_attachment: { session_id: "session", attachment_id: "file" },
  dashboard_call: { operation: "models.list", input: {} },
  shutdown: {},
};

describe("JSON-RPC boundary", () => {
  test("all 13 command names remain reachable with their business payloads", () => {
    const names: Array<keyof AgentCommandPayloads> = Object.keys(methods) as Array<keyof AgentCommandPayloads>;
    expect(names).toHaveLength(13);
    for (const method of names) {
      const request = { jsonrpc: "2.0", id: method, method, params: methods[method] };
      expect(parseAgentCall(request)).toEqual(expect.objectContaining(request));
    }
  });

  test.each(["", "request", 0, 123, 1.5, null])("preserves valid request ID %s", (id) => {
    expect(parseAgentCall({ jsonrpc: "2.0", id, method: "shutdown" })).toEqual({ jsonrpc: "2.0", id, method: "shutdown", params: {} });
    expect(parseJsonRpcEnvelope({ jsonrpc: "2.0", id, result: null })).toEqual({ jsonrpc: "2.0", id, result: null });
  });

  test("rejects malformed responses, IDs and envelopes", () => {
    for (const message of [
      {}, [], null, 1,
      { jsonrpc: "2.0", id: true, method: "shutdown" },
      { jsonrpc: "2.0", id: [], result: null },
      { jsonrpc: "2.0", id: Infinity, result: null },
      { jsonrpc: "2.0", result: null },
      { jsonrpc: "2.0", id: "x" },
      { jsonrpc: "2.0", id: "x", result: null, error: { code: -1, message: "bad" } },
      { jsonrpc: "2.0", id: "x", error: { code: "wrong", message: "bad" } },
      { jsonrpc: "2.0", id: "x", error: { code: -1, message: null } },
      { jsonrpc: "2.0", id: "x", method: "shutdown", result: null },
    ]) expect(() => parseJsonRpcEnvelope(message)).toThrow(JsonRpcError);
    expect(() => parseAgentCall({ jsonrpc: "2.0", method: "shutdown", params: [] })).toThrow("params must be an object");
    expect(() => parseAgentWireMessage("{" )).toThrow(JsonRpcError);
  });

  test("all 13 domain events round trip as notifications without wire IDs or versions", () => {
    const scope = { thread_id: "s", turn_id: "t" };
    const events: AgentEvent[] = [
      { type: "item.completed", thread_id: emit.session_id, turn_id: emit.turn_id, payload: emit as unknown as Extract<AgentEvent, { type: "item.completed" }>["payload"] },
      { type: "conversation.stream.delta", ...scope, payload: {
        session_id: "s", turn_id: "t", response_route_id: "r", emit_id: "e", seq: 1,
        mutations: [{ kind: "part_delta", part_id: "p", field: "text", delta: "你好\n世界" }],
      } },
      { type: "typing.changed", ...scope, payload: { session_id: "s", turn_id: "t", response_route_id: "r", operation: "start", emit_id: "e" } },
      { type: "agent.wake", payload: {} },
      { type: "background_task.changed", ...scope, payload: { tool_call_id: "tool", task: {
        exec_id: "exec-1", session_id: "s", origin_turn_id: "t", status: "completed", pid: null,
        command: "echo ok", cwd: "/work", started_at: 1, ended_at: 2, duration_sec: 1,
        exit_code: 0, truncated: false, output_tail: "ok",
      } } },
      { type: "managed_llm.authentication_failed", payload: { provider: "test", model: "model", credential_revision: "a".repeat(64) } },
      { type: "session.changed", thread_id: "s", payload: { changes: ["messages"] } },
      { type: "system.ready", payload: { state: "ready" } },
      { type: "system.status", payload: { state: "stopped" } },
      { type: "thread.started", thread_id: "s", payload: {} },
      { type: "turn.started", ...scope, payload: {} },
      { type: "turn.completed", ...scope, payload: {} },
      { type: "turn.failed", ...scope, payload: { error: "actual failure" } },
    ];
    expect(new Set(events.map((event) => event.type)).size).toBe(13);
    for (const event of events) {
      const wire = encodeAgentEvent(event);
      expect(Object.keys(wire).sort()).toEqual(["jsonrpc", "method", "params"]);
      expect(parseAgentWireMessage(JSON.stringify(wire))).toEqual(wire);
      expect(decodeAgentEvent(wire)).toEqual(event);
    }
  });
});
