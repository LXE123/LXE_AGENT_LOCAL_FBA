import { describe, expect, test } from "bun:test";
import type { DesktopStreamBatchRequest } from "@lxe/protocol";
import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  isAgentResponse,
  decodeAgentEvent,
  encodeAgentEvent,
  type AgentEvent,
  type AgentNotification,
  parseAgentRunTurnResult,
  parseAgentWireMessage,
  parseDashboardRpcCall,
  type ExecTaskSnapshotPayload,
} from "../src";

const roundTripEvent = (event: unknown): AgentEvent => decodeAgentEvent(
  parseAgentWireMessage(JSON.stringify(encodeAgentEvent(event as AgentEvent))) as AgentNotification,
);

describe("desktop agent protocol", () => {
  test("parses a valid response envelope", () => {
    const message = parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      result: { ready: true },
    }));
    expect(isAgentResponse(message)).toBe(true);
  });

  test("rejects old wire envelopes and unsupported JSON-RPC versions", () => {
    for (const message of [
      { version: 17, id: "old", ok: true, result: null },
      { jsonrpc: "1.0", id: "wrong-version", result: null },
    ]) expect(() => parseAgentWireMessage(JSON.stringify(message))).toThrow("jsonrpc must equal 2.0");
  });

  test("strictly parses session change events", () => {
    expect(roundTripEvent({
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages", "usage", "artifacts", "messages"] },
    })).toEqual({
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages", "usage", "artifacts"] },
    });

    for (const payload of [
      { changes: [] },
      { changes: ["metadata"] },
      { changes: ["messages"], message: { role: "user", content: "must not cross the boundary" } },
    ]) {
      expect(() => roundTripEvent({
          type: "session.changed",
        thread_id: "session-1",
        payload,
      })).toThrow("session.changed");
    }
  });

  test("strictly parses terminal exec UI events", () => {
    const task = {
      exec_id: "exec_1234abcd",
      session_id: "session-1",
      origin_turn_id: "turn-1",
      status: "completed",
      pid: 123,
      command: "echo ok",
      cwd: "/work",
      started_at: 1,
      ended_at: 2,
      duration_sec: 1,
      exit_code: 0,
      truncated: false,
      output_tail: "ok",
    } satisfies ExecTaskSnapshotPayload;
    const event = {
      type: "background_task.changed",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: { tool_call_id: "tool-1", task },
    } as const;
    expect(roundTripEvent(event)).toEqual(event);
    expect(() => roundTripEvent({ ...event, thread_id: "session-2" }))
      .toThrow("payload is invalid");
    expect(() => roundTripEvent({
      ...event,
      payload: { ...event.payload, task: { ...task, status: "running" } },
    })).toThrow("payload is invalid");
    expect(() => roundTripEvent({
      ...event,
      payload: { ...event.payload, task: { ...task, task_id: task.exec_id } },
    })).toThrow("payload is invalid");
    const { output_tail: _outputTail, ...incompleteTask } = task;
    expect(() => roundTripEvent({
      ...event,
      payload: { ...event.payload, task: incompleteTask },
    })).toThrow("payload is invalid");
  });

  test.each([undefined, "estimated", "usage_calibrated"] as const)("strictly parses desktop stream batches with context source %s and matching envelopes", (context_source) => {
    const payload: DesktopStreamBatchRequest = {
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
      mutations: [{
        kind: "stream_updated",
        state: "delta",
        display_metrics: {
          status: "running",
          phase: "waiting_model",
          elapsed_ms: 10,
          model: "model",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          context_tokens: 0,
          context_window_tokens: 100,
          ...(context_source === undefined ? {} : { context_source }),
        },
      }],
    };
    const event = {
      type: "conversation.stream.delta",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload,
    } as const;
    expect(roundTripEvent(event)).toEqual(event);
    expect(() => roundTripEvent({ ...event, turn_id: "turn-other" }))
      .toThrow("envelope does not match");
    expect(() => roundTripEvent({ ...event, payload: { ...payload, seq: 0 } }))
      .toThrow("payload is invalid");
    const mutation = payload.mutations[0]!;
    if (mutation.kind !== "stream_updated") throw new Error("Expected stream_updated fixture");
    for (const invalidSource of ["unknown", null]) {
      expect(() => roundTripEvent({
        ...event,
        payload: {
          ...payload,
          mutations: [{ ...mutation, display_metrics: { ...mutation.display_metrics, context_source: invalidSource } }],
        },
      })).toThrow("payload is invalid");
    }
  });

  test("strictly parses run_turn results", () => {
    expect(parseAgentRunTurnResult({
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [
        { text: "  follow up  ", response_route_id: " route-2 ", message_id: " m-2 " },
      ],
    })).toEqual({
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [
        { text: "follow up", response_route_id: "route-2", message_id: "m-2" },
      ],
    });
  });

  test("rejects incomplete or malformed run_turn results", () => {
    const valid = {
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [],
    };
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: undefined }))
      .toThrow(AgentProtocolError);
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: {} }))
      .toThrow("remaining_steering must be an array");
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: [{ text: " " }] }))
      .toThrow("text must be a non-empty string");
    expect(() => parseAgentRunTurnResult({
      ...valid,
      remaining_steering: [{ text: "follow up", response_route_id: 1 }],
    })).toThrow("response_route_id must be a string");
    for (const counter of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(() => parseAgentRunTurnResult({ ...valid, input_tokens: counter }))
        .toThrow("input_tokens must be a non-negative safe integer");
    }
  });

  test("rejects non-object payloads", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      method: "shutdown",
      params: null,
    }))).toThrow("params must be an object");
  });

  test("strictly validates hot Skill permission updates", () => {
    const request = {
      jsonrpc: "2.0",
      id: "permission-1",
      method: "update_skill_permissions",
      params: { allowed_skill_types: ["amazon_fba", "default"] as string[] },
    } as const;
    expect(parseAgentWireMessage(JSON.stringify(request))).toEqual(request);
    for (const allowedSkillTypes of ["*", ["default", 1], null]) {
      expect(() => parseAgentWireMessage(JSON.stringify({
        ...request,
        params: { allowed_skill_types: allowedSkillTypes },
      }))).toThrow("must be a string array");
    }
  });

  test("strictly validates secret-bearing managed credential updates and public auth events", () => {
    const revision = "e".repeat(64);
    const request = {
      jsonrpc: "2.0",
      id: "managed-credential-1",
      method: "update_managed_llm_credential",
      params: {
        target: { provider: "kimi_coding", model: "kimi-for-coding" },
        credential: {
          provider: "kimi_coding",
          model: "kimi-for-coding",
          api_key: "secret",
          credential_revision: revision,
          fetched_at: 123,
          invalid_revision: "",
        },
      },
    } as const;
    expect(parseAgentWireMessage(JSON.stringify(request))).toEqual(request);
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      params: { credential: { ...request.params.credential, api_key: "" } },
    }))).toThrow("credential is invalid");
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      params: { ...request.params, target: { provider: "https://attacker.example", model: "x" } },
    }))).toThrow("target is invalid");

    const event = {
      type: "managed_llm.authentication_failed",
      payload: {
        provider: "kimi_coding",
        model: "kimi-for-coding",
        credential_revision: revision,
      },
    } as const;
    expect(roundTripEvent(event)).toEqual(event);
    expect(() => roundTripEvent({
      ...event,
      payload: { ...event.payload, api_key: "must-not-appear" },
    })).toThrow("authentication event is invalid");
    expect(() => roundTripEvent({
      ...event,
      payload: { ...event.payload, provider: "https://attacker.example" },
    })).toThrow("authentication event is invalid");
  });

  test("accepts only directory and worktree in workspace payloads", () => {
    const request = {
      jsonrpc: "2.0",
      id: "request-workspace",
      method: "initialize",
      params: {
        protocol_version: AGENT_PROTOCOL_VERSION,
        agent_soul_path: "/runtime/resources/agent/SOUL.md",
        skills_root: "/runtime/resources/skills",
        user_skills_root: "/home/tester/.agents/skills",
        lxeskill_catalog_path: "/runtime/resources/lxeskill/catalog.json",
        llm_config_root: "/runtime/resources/config/llm",
        data_root: "/runtime/data",
        legacy_workspace: { directory: "/workspace/project", worktree: "/workspace" },
      },
    };
    expect(parseAgentWireMessage(JSON.stringify(request))).toMatchObject(request);

    const retiredField = ["server", "scope"].join("_");
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      params: {
        ...request.params,
        legacy_workspace: { ...request.params.legacy_workspace, [retiredField]: "local" },
      },
    }))).toThrow("unsupported fields");
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      params: { ...request.params, legacy_workspace: { directory: "/workspace" } },
    }))).toThrow("worktree must be a non-empty string");
  });

  test("rejects unknown commands and incomplete command payloads", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      method: "run_everything",
      params: {},
    }))).toThrow("Unknown method:");
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-2",
      method: "cancel_turn",
      params: {},
    }))).toThrow("cancel_turn.run_id");
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-3",
      method: "resolve_artifact",
      params: { session_id: "session-1" },
    }))).toThrow("resolve_artifact.artifact_id");
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-4",
      method: "resolve_attachment",
      params: { session_id: "session-1" },
    }))).toThrow("resolve_attachment.attachment_id");
  });

  test("normalizes typed Dashboard RPC inputs", () => {
    expect(parseDashboardRpcCall({
      operation: "sessions.list",
      input: { query: "  order  ", limit: 999, offset: -5 },
    })).toEqual({
      operation: "sessions.list",
      input: { query: "order", limit: 200, offset: 0 },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_before: " cursor-2 " },
    })).toEqual({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_limit: 10, message_before: "cursor-2" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { session_id: " session-1 ", text: "  hello  " },
    })).toEqual({
      operation: "sessions.send",
      input: { session_id: "session-1", text: "hello" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: " first message " },
    })).toEqual({ operation: "sessions.send", input: { text: "first message" } });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: [" file-1 "] },
    })).toEqual({ operation: "sessions.send", input: { text: "", attachment_ids: ["file-1"] } });
    expect(parseDashboardRpcCall({
      operation: "sessions.file.open",
      input: { session_id: " session-1 ", artifact_id: " artifact-1 " },
    })).toEqual({
      operation: "sessions.file.open",
      input: { session_id: "session-1", artifact_id: "artifact-1" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.attachment.open",
      input: { session_id: " session-1 ", attachment_id: " attachment-1 " },
    })).toEqual({
      operation: "sessions.attachment.open",
      input: { session_id: "session-1", attachment_id: "attachment-1" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.pin",
      input: { session_id: " session-1 ", pinned: true },
    })).toEqual({ operation: "sessions.pin", input: { session_id: "session-1", pinned: true } });
    expect(parseDashboardRpcCall({
      operation: "sessions.delete",
      input: { session_id: " session-1 " },
    })).toEqual({ operation: "sessions.delete", input: { session_id: "session-1" } });
    expect(parseDashboardRpcCall({
      operation: "models.update",
      input: {
        provider: " deepseek ",
        model: " deepseek-v4-flash ",
        credential_source: "cloud",
      },
    })).toEqual({
      operation: "models.update",
      input: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        credential_source: "cloud",
      },
    });
  });

  test("rejects malformed and agent-local Dashboard RPC calls", () => {
    expect(() => parseDashboardRpcCall({ operation: "backgroundTasks.list", input: {} }))
      .toThrow("unsupported Dashboard RPC operation");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_page: 2 },
    })).toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "kimi_coding", enabled: true },
    })).toThrow("unsupported fields");
    expect(() => parseAgentWireMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-dashboard",
      method: "dashboard_call",
      params: { operation: "channels.health", input: {} },
    }))).toThrow("owned by Electron Main");
    const mainOwnedInput: Record<string, unknown> = {
      "sessions.send": { text: "hello" },
      "sessions.file.open": { session_id: "session-1", artifact_id: "artifact-1" },
      "sessions.file.reveal": { session_id: "session-1", artifact_id: "artifact-1" },
      "sessions.attachment.open": { session_id: "session-1", attachment_id: "attachment-1" },
    };
    for (const operation of [
      "sessions.send", "sessions.stop", "sessions.activity", "sessions.file.open",
      "sessions.file.reveal", "sessions.attachment.open",
    ]) {
      expect(() => parseAgentWireMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: `request-${operation}`,
        method: "dashboard_call",
        params: { operation, input: mainOwnedInput[operation] ?? { session_id: "session-1" } },
      }))).toThrow("owned by Electron Main");
    }
    expect(() => parseDashboardRpcCall({ operation: "sessions.file.open", input: { session_id: "s" } }))
      .toThrow("sessions.file.open.artifact_id must be a string");
    expect(() => parseDashboardRpcCall({ operation: "sessions.file.reveal", input: { session_id: "s" } }))
      .toThrow("sessions.file.reveal.artifact_id must be a string");
    expect(parseDashboardRpcCall({
      operation: "sessions.file.reveal",
      input: { session_id: "s", artifact_id: "a" },
    })).toEqual({ operation: "sessions.file.reveal", input: { session_id: "s", artifact_id: "a" } });
    expect(() => parseDashboardRpcCall({
      operation: "sessions.file.open",
      input: { session_id: "s", artifact_id: "artifact-1", reveal: true },
    })).toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({ operation: "sessions.send", input: { text: " " } }))
      .toThrow("requires text or an attachment");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: ["same", "same"] },
    })).toThrow("duplicate IDs");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: ["1", "2", "3", "4", "5", "6"] },
    })).toThrow("at most 5");
    expect(() => parseDashboardRpcCall({ operation: "sessions.send", input: { text: "x".repeat(8_193) } }))
      .toThrow("too long");
    expect(() => parseDashboardRpcCall({ operation: "sessions.stop", input: { session_id: "s", all: true } }))
      .toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({ operation: "sessions.pin", input: { session_id: "s", pinned: "yes" } }))
      .toThrow("sessions.pin.pinned must be a boolean");
    expect(() => parseDashboardRpcCall({ operation: "sessions.delete", input: { session_id: "s", force: true } }))
      .toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.search",
      input: {},
    })).toThrow("unsupported Dashboard RPC operation");
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "x".repeat(1_000_001) },
    })).toThrow("too large");
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "界".repeat(400_000) },
    })).toThrow("too large");
  });
});

test("conversation identity and bidirectional cursor inputs are explicit", () => {
  expect(parseDashboardRpcCall({operation:"sessions.send",input:{text:"hello",client_message_id:"client-1"}})).toEqual({operation:"sessions.send",input:{text:"hello",client_message_id:"client-1"}});
  expect(parseDashboardRpcCall({operation:"sessions.detail",input:{session_id:"s",message_after:"cursor"}})).toEqual({operation:"sessions.detail",input:{session_id:"s",message_limit:10,message_after:"cursor"}});
  expect(()=>parseDashboardRpcCall({operation:"sessions.detail",input:{session_id:"s",message_before:"a",message_after:"b"}})).toThrow("mutually exclusive");
});
