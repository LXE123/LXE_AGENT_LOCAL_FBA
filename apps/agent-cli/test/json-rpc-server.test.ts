import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION, type AgentServerOutput, type AgentResponse } from "@lxe/desktop-protocol";
import { AgentProtocolServer, type AgentProtocolServerOptions } from "../src/server";

const initialize = {
  protocol_version: AGENT_PROTOCOL_VERSION,
  agent_soul_path: "/soul", skills_root: "/skills", user_skills_root: "/user-skills",
  lxeskill_catalog_path: "/catalog", llm_config_root: "/llm", data_root: process.cwd(),
  legacy_workspace: { directory: process.cwd(), worktree: process.cwd() },
};
const servers: AgentProtocolServer[] = [];
const setup = (host: Record<string, unknown> = {}) => {
  const output: AgentServerOutput[] = [];
  let creates = 0;
  const server = new AgentProtocolServer({
    write: (message) => { output.push(message); },
    environment: { LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR" },
    createHost: (() => {
      creates += 1;
      return { start: async () => {}, stop: async () => {}, health: () => ({ ready: true }), ...host };
    }) as unknown as NonNullable<AgentProtocolServerOptions["createHost"]>,
  });
  servers.push(server);
  const call = (method: string, params?: unknown, id: unknown = "request") => server.accept(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  const responses = (): AgentResponse[] => output.flatMap((item) => Array.isArray(item) ? item : "id" in item ? [item] : []);
  return { server, output, call, responses, creates: () => creates };
};
afterEach(async () => { for (const server of servers.splice(0)) await server.shutdown(); });

describe("JSON-RPC server semantics", () => {
  test.each(["request", "", 0, 1.5, null])("returns original ID %s", async (id) => {
    const { call, responses } = setup();
    await call("initialize", initialize, id);
    expect(responses()[0]).toMatchObject({ jsonrpc: "2.0", id, result: { protocol_version: 18 } });
  });

  test("returns protocol-specific codes and preserves identity after parameter validation fails", async () => {
    const { server, call, responses } = setup();
    await server.accept("{");
    await server.accept("[]");
    await server.accept(JSON.stringify({ jsonrpc: "2.0", id: false, method: "shutdown" }));
    await call("missing_method", {}, "missing");
    await call("cancel_turn", {}, "params");
    await call("cancel_turn", { run_id: "run" }, "not-ready");
    await call("initialize", { ...initialize, protocol_version: 17 }, "version");
    const { protocol_version: _version, ...missingVersion } = initialize;
    await call("initialize", missingVersion, "missing-version");
    expect(responses().map((response) => [response.id, "error" in response ? response.error.code : 0])).toEqual([
      [null, -32700], [null, -32600], [null, -32600], ["missing", -32601],
      ["params", -32602], ["not-ready", -32001], ["version", -32002], ["missing-version", -32602],
    ]);
  });

  test("initialization is shared, repeatable, and validates version before reusing a host", async () => {
    let started!: () => void;
    const startGate = new Promise<void>((resolve) => { started = resolve; });
    const { call, responses, creates } = setup({ start: () => startGate });
    const first = call("initialize", initialize, "first");
    const second = call("initialize", initialize, "second");
    expect(creates()).toBe(1);
    await call("cancel_turn", { run_id: "run" }, "early");
    started();
    await Promise.all([first, second]);
    await call("initialize", initialize, "repeat");
    await call("initialize", { ...initialize, protocol_version: 17 }, "wrong-version");
    expect(creates()).toBe(1);
    expect(responses().find((r) => r.id === "early")).toMatchObject({ error: { code: -32001 } });
    for (const id of ["first", "second", "repeat"]) expect(responses().find((r) => r.id === id)).toMatchObject({ result: { protocol_version: 18 } });
    expect(responses().find((r) => r.id === "wrong-version")).toMatchObject({ error: { code: -32002 } });
  });

  test("batch combines responses, excludes notifications, and continues past invalid entries", async () => {
    const { server, output, call } = setup();
    await call("initialize", initialize);
    output.length = 0;
    await server.accept(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "cancel_turn", params: { run_id: "run" } },
      { jsonrpc: "2.0", method: "cancel_turn", params: { run_id: "run" } },
      { jsonrpc: "2.0", method: "unknown" },
      { jsonrpc: "2.0", method: "cancel_turn", params: null },
      { jsonrpc: "2.0", id: 2, method: "cancel_turn", params: [] },
      42,
    ]));
    expect(output).toEqual([[
      { jsonrpc: "2.0", id: 1, result: { cancelled: false } },
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32602 }) }),
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }),
    ]]);
    output.length = 0;
    await server.accept(JSON.stringify([{ jsonrpc: "2.0", method: "unknown" }]));
    expect(output).toEqual([]);
  });

  test("business errors retain text and code while credentials and oversized text are removed", async () => {
    const { call, responses } = setup({ dashboardCall: async () => {
      throw Object.assign(new Error(`HTTP 401: Bearer secret-value api_key=secret-key "api_key":"quoted-secret" ${"错".repeat(9_000)}`), { code: "provider_rejected" });
    } });
    await call("initialize", initialize);
    await call("dashboard_call", { operation: "models.list", input: {} }, "failure");
    const failure = responses().find((r) => r.id === "failure");
    expect(failure).toMatchObject({ error: { code: -32000, data: { code: "provider_rejected" } } });
    if (!failure || !("error" in failure)) throw new Error("Expected error response");
    expect(failure.error.message).toContain("HTTP 401");
    expect(failure.error.message).not.toContain("secret-value");
    expect(failure.error.message).not.toContain("secret-key");
    expect(failure.error.message).not.toContain("quoted-secret");
    expect(failure.error.message).toContain("[truncated]");
    expect(Buffer.byteLength(failure.error.message)).toBeLessThanOrEqual(8192);
    expect(Object.keys(failure.error.data as object)).toEqual(["code"]);
  });

  test("concurrent shutdown calls wait for the same host cleanup before responding", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stops = 0;
    const { call, responses } = setup({ stop: async () => { stops += 1; await gate; } });
    await call("initialize", initialize);
    const first = call("shutdown", {}, "stop-1");
    const second = call("shutdown", {}, "stop-2");
    expect(responses().some((r) => r.id === "stop-1" || r.id === "stop-2")).toBe(false);
    release(); await Promise.all([first, second]);
    expect(stops).toBe(1);
    for (const id of ["stop-1", "stop-2"]) expect(responses().find((r) => r.id === id)).toMatchObject({ result: { stopped: true } });
  });

  test("shutdown waits for initializing host cleanup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stops = 0;
    const { call, responses } = setup({ start: () => gate, stop: async () => { stops += 1; } });
    const init = call("initialize", initialize, "init");
    const shutdown = call("shutdown", {}, "stop");
    release();
    await Promise.all([init, shutdown]);
    expect(stops).toBe(1);
    expect(responses().find((r) => r.id === "init")).toMatchObject({ error: { message: "agent-cli shut down during initialization" } });
    expect(responses().find((r) => r.id === "stop")).toMatchObject({ result: { stopped: true } });
  });
});
