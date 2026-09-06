import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
import type { DesktopStreamBatchRequest } from "@lxe/protocol";
import {
  AGENT_PROTOCOL_VERSION,
  DashboardRpcError,
  decodeAgentEvent,
  type AgentServerOutput,
  type AgentEvent,
  type AgentResponse,
} from "@lxe/desktop-protocol";
import { AgentProtocolServer, type AgentProtocolServerOptions } from "../src/server";

const collect = (output: Array<AgentResponse | AgentEvent>, message: AgentServerOutput): void => {
  for (const item of Array.isArray(message) ? message : [message]) {
    output.push("method" in item ? decodeAgentEvent(item) : item);
  }
};

type CreateHost = NonNullable<AgentProtocolServerOptions["createHost"]>;

const workspace = (root: string) => ({
  directory: root,
  worktree: root,
});

const initializePayload = (root: string) => ({
  protocol_version: AGENT_PROTOCOL_VERSION,
  agent_soul_path: join(root, "SOUL.md"),
  skills_root: join(root, "skills"),
  user_skills_root: join(root, "user-skills"),
  lxeskill_catalog_path: join(root, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
  llm_config_root: join(root, "config", "llm"),
  data_root: root,
  legacy_workspace: workspace(root),
});

const turnJob = (root: string) => ({
  job_id: "job-1",
  session_id: "session-1",
  session_key: "session-1",
  response_route_id: "route-1",
  user_id: "user-1",
  conversation_id: "conversation-1",
  is_group: false,
  message_id: "message-1",
  user_input: "hello",
  job_kind: "turn",
  sender_nick: "tester",
  source: {},
  raw_data: {},
  user_content_blocks: [],
  diagnostics: [],
  workspace: workspace(root),
});

const fakeHost: CreateHost = (() => ({
  start: async () => {
    createLogger("runtime.maintenance").info("data_sync_uploaded", {
      target: "cloud",
      api_key: "must-not-appear",
    });
  },
  stop: async () => undefined,
  health: () => ({ ready: true }),
  dashboardCall: async () => {
    throw new DashboardRpcError("not_found", "dashboard item not found");
  },
})) as unknown as CreateHost;

describe("AgentProtocolServer", () => {
  test("emits async exec completion as UI state without an agent wake", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let notify: NonNullable<Parameters<CreateHost>[0]["onBackgroundTaskChanged"]> | undefined;
    const createHost = ((options: Parameters<CreateHost>[0]) => {
      notify = options.onBackgroundTaskChanged;
      return { start: async () => undefined, stop: async () => undefined, health: () => ({ ready: true }) };
    }) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-background-event",
      method: "initialize",
      params: initializePayload(root),
    }));
    await notify?.({
      exec_id: "exec_1234abcd",
      tool_call_id: "tool-1",
      session_id: "session-1",
      origin_turn_id: "turn-1",
      status: "completed",
      pid: 123,
      command: "echo ok",
      cwd: root,
      started_at: 1,
      ended_at: 2,
      duration_sec: 1,
      exit_code: 0,
      truncated: false,
      output_tail: "ok",
    });
    expect(output).toContainEqual(expect.objectContaining({
      type: "background_task.changed",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: expect.objectContaining({ tool_call_id: "tool-1" }),
    }));
    expect(output.some((message) => "type" in message && message.type === "agent.wake")).toBe(false);
    await server.shutdown();
  });

  test("writes Desktop stream batches as dedicated agent events", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let emitDesktop: ((batch: DesktopStreamBatchRequest) => Promise<void>) | undefined;
    const createHost = ((options: Parameters<CreateHost>[0]) => {
      emitDesktop = options.emitter.desktopStream;
      return {
        start: async () => undefined,
        stop: async () => undefined,
        health: () => ({ ready: true }),
      };
    }) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-desktop-stream",
      method: "initialize",
      params: initializePayload(root),
    }));
    const batch: DesktopStreamBatchRequest = {
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
      mutations: [{
        kind: "part_delta",
        part_id: "part-1",
        field: "text",
        delta: "hello",
      }],
    };
    await emitDesktop?.(batch);

    expect(output).toContainEqual({
      type: "conversation.stream.delta",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: batch,
    });
    await server.shutdown();
  });

  test("wraps persisted session changes in content-free protocol events", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let notify: NonNullable<Parameters<CreateHost>[0]["onSessionChanged"]> | undefined;
    const createHost = ((options: Parameters<CreateHost>[0]) => {
      const callback = options.onSessionChanged;
      notify = callback;
      return {
        start: async () => undefined,
        stop: async () => undefined,
        health: () => ({ ready: true }),
      };
    }) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-session-change",
      method: "initialize",
      params: initializePayload(root),
    }));
    await notify?.("session-1", "messages");
    await notify?.("session-1", "usage");
    await notify?.("session-1", "artifacts");
    await notify?.("session-1", "attachments");

    const changes = output.filter((message): message is Extract<AgentEvent, { type: "session.changed" }> =>
      "type" in message && message.type === "session.changed");
    expect(changes).toEqual([
      {
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["messages"] },
      },
      {
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["usage"] },
      },
      {
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["artifacts"] },
      },
      {
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["attachments"] },
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain("content");
    await server.shutdown();
  });

  test("resolves artifact paths only through the Main-facing agent command", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      resolveArtifact: async (sessionId: string, artifactId: string) =>
        sessionId === "session-1" && artifactId === "artifact-1"
          ? { path: "/private/artifacts/report.xlsx" }
          : undefined,
      resolveAttachment: async (sessionId: string, attachmentId: string) =>
        sessionId === "session-1" && attachmentId === "attachment-1"
          ? { path: "/private/input/orders.csv" }
          : undefined,
    })) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-artifact",
      method: "initialize",
      params: initializePayload(root),
    }));
    for (const [id, sessionId, artifactId] of [
      ["artifact-found", "session-1", "artifact-1"],
      ["artifact-cross-session", "session-2", "artifact-1"],
      ["artifact-unknown", "session-1", "artifact-2"],
    ]) {
      await server.accept(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "resolve_artifact",
        params: { session_id: sessionId, artifact_id: artifactId },
      }));
    }

    expect(output.find((message) => !("type" in message) && message.id === "artifact-found"))
      .toMatchObject({ result: { found: true, path: "/private/artifacts/report.xlsx" } });
    expect(output.find((message) => !("type" in message) && message.id === "artifact-cross-session"))
      .toMatchObject({ result: { found: false } });
    expect(output.find((message) => !("type" in message) && message.id === "artifact-unknown"))
      .toMatchObject({ result: { found: false } });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "attachment-found",
      method: "resolve_attachment",
      params: { session_id: "session-1", attachment_id: "attachment-1" },
    }));
    expect(output.find((message) => !("type" in message) && message.id === "attachment-found"))
      .toMatchObject({ result: { found: true, path: "/private/input/orders.csv" } });
    await server.shutdown();
  });

  test("forwards hot Skill permission updates to the initialized runtime", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const updates: string[][] = [];
    const credentialRevisions: string[] = [];
    const managedTargets: unknown[] = [];
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      updateSkillPermissions: (allowed: readonly string[]) => { updates.push([...allowed]); },
      updateManagedLlmCredential: async (
        credential: { credential_revision: string } | null,
        target: unknown,
      ) => {
        if (credential) credentialRevisions.push(credential.credential_revision);
        managedTargets.push(target);
        return { cancelActiveTurns: false };
      },
    })) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-permission",
      method: "initialize",
      params: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-update",
      method: "update_skill_permissions",
      params: { allowed_skill_types: ["shopee_operations", "default"] },
    }));
    const revision = "a".repeat(64);
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "managed-credential-update",
      method: "update_managed_llm_credential",
      params: {
        target: { provider: "kimi_coding", model: "kimi-for-coding" },
        credential: {
          provider: "kimi_coding",
          model: "kimi-for-coding",
          api_key: "managed-secret",
          credential_revision: revision,
          fetched_at: 123,
          invalid_revision: "",
        },
      },
    }));

    expect(updates).toEqual([["shopee_operations", "default"]]);
    expect(output.find((message) => !("type" in message) && message.id === "permission-update"))
      .toMatchObject({ result: { updated: true } });
    expect(credentialRevisions).toEqual([revision]);
    expect(managedTargets).toEqual([{ provider: "kimi_coding", model: "kimi-for-coding" }]);
    expect(output.find((message) => !("type" in message) && message.id === "managed-credential-update"))
      .toMatchObject({ result: { updated: true } });
    expect(JSON.stringify(output)).not.toContain("managed-secret");
    await server.shutdown();
  });

  test("cancels active turns when the current cloud credential is revoked", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      runTurn: async (_job: unknown, handle: { signal: AbortSignal }) => {
        started();
        await new Promise<void>((resolve) => handle.signal.addEventListener("abort", () => resolve(), { once: true }));
        return {
          status: "cancelled",
          reply: "",
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
        };
      },
      updateManagedLlmCredential: async () => ({ cancelActiveTurns: true }),
    })) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-revocation",
      method: "initialize",
      params: initializePayload(root),
    }));
    const run = server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "run-before-revocation",
      method: "run_turn",
      params: { job: turnJob(root) },
    }));
    await turnStarted;
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "revoke-managed-credential",
      method: "update_managed_llm_credential",
      params: { credential: null },
    }));
    await run;

    expect(output.find((message) => !("type" in message) && message.id === "revoke-managed-credential"))
      .toMatchObject({ result: { updated: true, cancelled_active_turns: true } });
    expect(output.find((message) => !("type" in message) && message.id === "run-before-revocation"))
      .toMatchObject({ result: { status: "cancelled" } });
    await server.shutdown();
  });

  test("rejects commands before initialize", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { collect(output, message); } });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "health-1",
      method: "ensure_session",
      params: { request: { session_id: "session-1", source: {}, workspace: workspace(process.cwd()) } },
    }));
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ id: "health-1", error: { code: -32001 } });
  });

  test("rejects the removed pop_pending_events command", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { collect(output, message); } });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "pop-1",
      method: "pop_pending_events",
      params: { session_id: "session-1" },
    }));
    expect(output).toHaveLength(1);
    const response = output[0];
    expect(response && !("type" in response) && "error" in response).toBe(true);
    expect(response && !("type" in response) && "error" in response ? response.error.message : "")
      .toContain("Unknown method:");
  });

  test("run_turn returns steering the runtime never consumed", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      runTurn: async (
        _job: unknown,
        handle: { pushSteering(message: { text: string; response_route_id: string; message_id: string }): void },
      ) => {
        handle.pushSteering({ text: "late steer", response_route_id: "route-s", message_id: "m-s" });
        return { status: "completed", reply: "ok", input_tokens: 1, output_tokens: 2, tool_calls: 3 };
      },
    })) as unknown as CreateHost;
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "turn-1",
      method: "run_turn",
      params: { job: turnJob(root) },
    }));

    const response = output.find((message): message is AgentResponse =>
      !("type" in message) && message.id === "turn-1");
    expect(response).toMatchObject({

      result: {
        status: "completed",
        reply: "ok",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 3,
        remaining_steering: [
          { text: "late steer", response_route_id: "route-s", message_id: "m-s" },
        ],
      },
    });
    await server.shutdown();
  });

  test("run_turn returns an empty steering array when every message was consumed", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      runTurn: async () => ({
        status: "completed",
        reply: "ok",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 0,
      }),
    })) as unknown as CreateHost;
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-empty-steering",
      method: "initialize",
      params: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "turn-empty-steering",
      method: "run_turn",
      params: { job: turnJob(root) },
    }));

    expect(output.find((message) => !("type" in message) && message.id === "turn-empty-steering"))
      .toMatchObject({ result: { remaining_steering: [] } });
    await server.shutdown();
  });

  test("rejects the removed health command", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { collect(output, message); } });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "health-1",
      method: "health",
      params: {},
    }));
    expect(output).toHaveLength(1);
    const response = output[0];
    expect(response && !("type" in response) && "error" in response).toBe(true);
    expect(response && !("type" in response) && "error" in response ? response.error.message : "")
      .toContain("Unknown method:");
  });

  test("propagates Dashboard RPC errors through the agent error envelope", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost: fakeHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-dashboard",
      method: "initialize",
      params: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "dashboard-1",
      method: "dashboard_call",
      params: { operation: "models.list", input: {} },
    }));
    expect(output.find((message) => !("type" in message) && message.id === "dashboard-1"))
      .toMatchObject({

        error: { code: -32000,
        data: { code: "not_found" }, message: "dashboard item not found" },
      });
    await server.shutdown();
  });

  test("rolls back a partially initialized host and remains uninitialized", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let stops = 0;
    const createHost = (() => ({
      start: async () => { throw new Error("runtime start failed"); },
      stop: async () => { stops += 1; },
    })) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { collect(output, message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });

    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-failed",
      method: "initialize",
      params: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "command-after-failure",
      method: "ensure_session",
      params: { request: { session_id: "session-1", source: {}, workspace: workspace(root) } },
    }));

    expect(stops).toBe(1);
    expect(output.find((message) => !("type" in message) && message.id === "initialize-failed"))
      .toMatchObject({ error: { message: "runtime start failed" } });
    expect(output.find((message) => !("type" in message) && message.id === "command-after-failure"))
      .toMatchObject({ error: { message: "agent-cli is not initialized" } });
    await server.shutdown();
  });

  test("writes the shutdown response before requesting process exit", async () => {
    const order: string[] = [];
    const server = new AgentProtocolServer({
      write: (message) => {
        for (const item of Array.isArray(message) ? message : [message]) {
          order.push("method" in item ? item.method : `response:${item.id}`);
        }
      },
      exit: () => { order.push("exit"); },
    });
    await server.accept(JSON.stringify({
      jsonrpc: "2.0",
      id: "shutdown-1",
      method: "shutdown",
      params: {},
    }));
    expect(order).toEqual(["system.status", "response:shutdown-1", "exit"]);
  });

  test("persists agent logs under the initialized data root and reports sink health", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-cli-logging-"));
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "INFO",
      },
      write: (message) => { collect(output, message); },
      createHost: fakeHost,
    });
    try {
      await server.accept(JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize-1",
        method: "initialize",
        params: initializePayload(root),
      }));

      const response = output.find((message): message is AgentResponse =>
        !("type" in message) && message.id === "initialize-1");
      expect(response).toMatchObject({
        result: {
          logging: {
            local_file_enabled: true,
            disabled_reason: "",
            console_level: "error",
            file_level: "info",
          },
        },
      });
      const ready = output.find((message): message is AgentEvent =>
        "type" in message && message.type === "system.ready");
      expect(ready).toMatchObject({ payload: { logging: { local_file_enabled: true } } });
      const filePath = String(response && "result" in response
        && response.result !== null
        && typeof response.result === "object"
        && !Array.isArray(response.result)
        && response.result.logging !== null
        && typeof response.result.logging === "object"
        && !Array.isArray(response.result.logging)
        ? response.result.logging.file_path
        : "");
      expect(filePath).toMatch(/logs[\\/]runtime[\\/]\d{8}[\\/]runtime\.log$/u);
      expect(filePath).not.toMatch(/var[\\/]var[\\/]/u);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain('"message":"logging_configured"');
      expect(content).toContain('"message":"data_sync_uploaded"');
      expect(content).toContain('"target":"cloud"');
      expect(content).not.toContain("must-not-appear");

      await server.shutdown();
      const closedContent = readFileSync(filePath, "utf8");
      const consoleWrite = spyOn(console, "log").mockImplementation(() => undefined);
      try {
        createLogger("runtime.after_shutdown").info("must_not_be_persisted");
      } finally {
        consoleWrite.mockRestore();
      }
      expect(readFileSync(filePath, "utf8")).toBe(closedContent);
    } finally {
      await server.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
