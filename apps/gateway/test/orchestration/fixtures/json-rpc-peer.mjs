// Deliberately independent wire peer: no shared codec, SDK, database or model calls.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const mode = process.env.RPC_FIXTURE_MODE;
if (process.env.RPC_STARTS_PATH) appendFileSync(process.env.RPC_STARTS_PATH, "start\n");
const event = (n) => ({ jsonrpc: "2.0", method: "session.changed", params: { thread_id: `session-${n}`, payload: { changes: ["messages"] } } });
let readCount = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.jsonrpc !== "2.0" || "command" in request || "version" in request) process.exit(91);
  if (request.method === "initialize") {
    if (request.params.protocol_version !== 18) process.exit(92);
    if (mode === "version-error") { write({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "expected version 19", data: { code: "version_mismatch" } } }); continue; }
    write({ jsonrpc: "2.0", id: request.id, result: { ready: true, protocol_version: mode === "version-result" ? 17 : 18 } });
    continue;
  }
  if (request.method === "shutdown") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopped: true } })}\n`, () => process.exit(0));
    continue;
  }
  const response = { jsonrpc: "2.0", id: request.id, result: { found: true, path: request.params.artifact_id ?? "ok" } };
  switch (mode) {
    case "business-error": write({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "actual vendor error", data: { code: "vendor_failed" } } }); break;
    case "broken-response": write({ ...response, error: { code: -32000, message: "bad" } }); break;
    case "bad-notification": write({ jsonrpc: "2.0", method: "session.changed", params: { thread_id: "s", payload: { changes: [] } } }); break;
    case "null-error": write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "actual parse failure" } }); break;
    case "slow-events": write([event(1), event(2)]); write(response); break;
    case "reordered": {
      const delay = readCount++ === 0 ? 60 : 0;
      setTimeout(() => write(response), delay);
      break;
    }
    case "late": setTimeout(() => { write(response); write(response); }, readCount++ === 0 ? 100 : 0); break;
    case "fragmented": {
      const text = JSON.stringify({ ...response, result: { found: true, path: "你好\n第二行" } });
      process.stdout.write(text.slice(0, 12));
      setTimeout(() => process.stdout.write(text.slice(12) + "\r\n"), 10);
      break;
    }
    case "metrics": {
      const source = process.env.RPC_CONTEXT_SOURCE;
      write({ jsonrpc: "2.0", method: "conversation.stream.delta", params: {
        thread_id: "session-1", turn_id: "turn-1", payload: {
          session_id: "session-1", turn_id: "turn-1", response_route_id: "route-1", emit_id: "emit-1", seq: 1,
          mutations: [{ kind: "stream_updated", state: "delta", display_metrics: {
            status: "running", phase: "waiting_model", elapsed_ms: 10, model: "fixture",
            input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            context_tokens: 100, context_window_tokens: 1000,
            ...(source ? { context_source: source } : {}),
          } }],
        },
      } });
      write(response);
      break;
    }
    default: write(response);
  }
}
