import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const protocolVersion = 18;
const event = ({ type, ...params }) => write({ jsonrpc: "2.0", method: type, params });
let activeRunRequest;
let steered = [];
let cancelCount = 0;
let allowedSkillTypes = [];
let loggingStatus = {
  local_file_enabled: true,
  file_path: "/tmp/runtime.log",
  disabled_reason: "",
  last_error: "",
  console_level: "info",
  file_level: "info",
};

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    allowedSkillTypes = request.params.allowed_skill_types ?? [];
    if (process.env.FAKE_SKILL_PERMISSION_PATH) {
      writeFileSync(process.env.FAKE_SKILL_PERMISSION_PATH, JSON.stringify(allowedSkillTypes), "utf8");
    }
    const lxeskillAvailable = process.env.FAKE_LXESKILL_UNAVAILABLE !== "1";
    event({ type: "system.ready", payload: { state: "ready", logging: loggingStatus } });
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocol_version: protocolVersion,
        ready: true,
        lxeskill_available: lxeskillAvailable,
        lxeskill_message: lxeskillAvailable ? "" : "No module named lxeskill",
        logging: loggingStatus,
      },
    });
    if (process.env.FAKE_SESSION_CHANGE_EVENT === "1") {
      setTimeout(() => event({
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["messages"] },
      }), 10);
    }
    if (process.env.FAKE_DESKTOP_STREAM_EVENT === "1") {
      setTimeout(() => event({
        type: "conversation.stream.delta",
        thread_id: "session-1",
        turn_id: "turn-1",
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          response_route_id: "route-1",
          emit_id: "emit-1",
          seq: 1,
          mutations: [{
            kind: "part_updated",
            part: {
              type: "text",
              part_id: "part-1",
              sequence: 1,
              status: "streaming",
              presentation: "process",
              text: "hello",
            },
          }],
        },
      }), 10);
    }
    continue;
  }
  if (request.method === "update_skill_permissions") {
    allowedSkillTypes = request.params.allowed_skill_types;
    if (process.env.FAKE_SKILL_PERMISSION_PATH) {
      writeFileSync(process.env.FAKE_SKILL_PERMISSION_PATH, JSON.stringify(allowedSkillTypes), "utf8");
    }
    write({ jsonrpc: "2.0", id: request.id, result: { updated: true } });
    continue;
  }
  if (request.method === "update_managed_llm_credential") {
    write({ jsonrpc: "2.0", id: request.id, result: { updated: true } });
    continue;
  }
  if (request.method === "run_turn") {
    const resultMode = process.env.FAKE_RUN_TURN_RESULT;
    if (resultMode) {
      const result = {
        status: "completed",
        reply: "done",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 0,
        remaining_steering: [],
      };
      if (resultMode === "missing_steering") delete result.remaining_steering;
      if (resultMode === "malformed_steering") result.remaining_steering = [{ text: "follow up", message_id: 42 }];
      if (resultMode === "negative_counter") result.input_tokens = -1;
      write({ jsonrpc: "2.0", id: request.id, result });
      continue;
    }
    activeRunRequest = request;
    continue;
  }
  if (request.method === "dashboard_call") {
    const crashMarker = process.env.FAKE_AGENT_CRASH_MARKER;
    if (request.params.operation === "models.list" && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, "crashed", "utf8");
      process.exit(23);
    }
    if (process.env.FAKE_LOGGING_FAILURE_EVENT === "1") {
      loggingStatus = {
        ...loggingStatus,
        local_file_enabled: false,
        disabled_reason: "sink_failed",
        last_error: "disk unavailable",
      };
      event({
        type: "system.status",
        payload: { state: "ready", logging: loggingStatus },
      });
    }
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: { items: [], total: 0 },
    });
    continue;
  }
  if (request.method === "resolve_artifact") {
    const found = request.params.session_id === "session-1" && request.params.artifact_id === "artifact-1";
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: found ? { found: true, path: "/tmp/report.xlsx" } : { found: false },
    });
    continue;
  }
  if (request.method === "resolve_attachment") {
    write({ jsonrpc: "2.0", id: request.id, result: { found: false } });
    continue;
  }
  if (request.method === "cancel_turn") {
    cancelCount += 1;
    const active = activeRunRequest;
    activeRunRequest = undefined;
    write({ jsonrpc: "2.0", id: request.id, result: { cancelled: Boolean(active) } });
    if (active) {
      setTimeout(() => write({
        jsonrpc: "2.0",
        id: active.id,
          result: {
          status: "cancelled",
          reply: "",
          input_tokens: 0,
          output_tokens: 0,
          tool_calls: cancelCount,
          remaining_steering: steered,
        },
      }), 25);
    }
    continue;
  }
  if (request.method === "steer_turn") {
    if (activeRunRequest) {
      steered.push({
        text: request.params.text,
        response_route_id: request.params.response_route_id,
        message_id: request.params.message_id,
      });
    }
    write({ jsonrpc: "2.0", id: request.id, result: { accepted: Boolean(activeRunRequest) } });
    continue;
  }
  if (request.method === "shutdown") {
    event({ type: "system.status", payload: { state: "stopped" } });
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopped: true },
    })}\n`, () => process.exit(0));
    continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result: {} });
}
