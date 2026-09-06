import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentJob } from "@lxe/protocol";
import { AgentProtocolError, type AgentEvent } from "@lxe/desktop-protocol";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";
import { RunHandle } from "../../src/orchestration/scheduler";
import { testWorkspace, workspaceFor } from "../workspace";

const runtimes: ProcessAgentRuntime[] = [];
const temporaryRoots: string[] = [];
const waitFor = async (
  predicate: () => boolean,
  label: string,
  details: () => string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(`timed out waiting for ${label}: ${details()}`);
};
const removeTemporaryRoot = async (root: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code) || attempt >= 19) throw error;
      await Bun.sleep(50);
    }
  }
};
const resourcePaths = (root: string) => ({
  agentSoulPath: join(root, "SOUL.md"),
  skillsRoot: join(root, "skills"),
  userSkillsRoot: join(root, "user-skills"),
  lxeskillCatalogPath: join(root, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
  llmConfigRoot: join(root, "config", "llm"),
});
const agentJob = (): AgentJob => ({
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
  workspace: testWorkspace,
});

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of temporaryRoots.splice(0)) await removeTemporaryRoot(root);
});

describe("ProcessAgentRuntime", () => {
  test("forwards Desktop stream batches through their dedicated callback", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const batches: Array<Extract<AgentEvent, { type: "conversation.stream.delta" }>["payload"]> = [];
    const events: AgentEvent[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_DESKTOP_STREAM_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onDesktopStream: (batch) => { batches.push(batch); },
      onEvent: (event) => { events.push(event); },
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = performance.now() + 2_000;
    while (batches.length === 0 && performance.now() < deadline) await Bun.sleep(10);

    expect(batches).toEqual([expect.objectContaining({
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
    })]);
    expect(events.some((event) => event.type === "conversation.stream.delta")).toBe(true);
  });

  test("forwards content-free persisted session change events", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const events: AgentEvent[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_SESSION_CHANGE_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onEvent: (event) => { events.push(event); },
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = performance.now() + 2_000;
    while (!events.some((event) => event.type === "session.changed") && performance.now() < deadline) {
      await Bun.sleep(10);
    }

    const change = events.find((event): event is Extract<AgentEvent, { type: "session.changed" }> =>
      event.type === "session.changed");
    expect(change).toEqual({

      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages"] },
    });
    expect(JSON.stringify(change)).not.toContain("content");
  });

  test("uses stream-json stdio and keeps request responses correlated", async () => {
    const states: string[] = [];
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);

    await runtime.start();
    expect(runtime.isReady).toBe(true);
    expect(runtime.status()).toMatchObject({
      lxeskillAvailable: true,
      logging: {
        local_file_enabled: true,
        file_path: "/tmp/runtime.log",
      },
    });
    expect(await runtime.dashboardCall({ operation: "models.list", input: {} }))
      .toEqual({ items: [], total: 0 });
    expect(await runtime.resolveArtifact("session-1", "artifact-1")).toBe("/tmp/report.xlsx");
    expect(await runtime.resolveArtifact("session-2", "artifact-1")).toBeUndefined();
    await runtime.stop();

    expect(runtime.status().state).toBe("stopped");
    expect(states).toContain("starting");
    expect(states).toContain("ready");
  });

  test("caches degraded lxeskill health without failing agent startup", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_LXESKILL_UNAVAILABLE: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
    });
    runtimes.push(runtime);

    await runtime.start();

    expect(runtime.isReady).toBe(true);
    expect(runtime.status()).toMatchObject({
      state: "ready",
      lxeskillAvailable: false,
      lxeskillMessage: "No module named lxeskill",
    });
  });

  test("starts fail-closed and updates Skill permissions without restarting", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-permission-"));
    temporaryRoots.push(root);
    const permissionPath = join(root, "permissions.json");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_SKILL_PERMISSION_PATH: permissionPath },
      ...resourcePaths(process.cwd()),
      dataRoot: root,
      legacyWorkspace: workspaceFor(root),
    });
    runtimes.push(runtime);

    await runtime.start();
    expect(JSON.parse(readFileSync(permissionPath, "utf8"))).toEqual([]);
    await runtime.updateSkillPermissions(["amazon_fba", "default", "default"]);
    expect(JSON.parse(readFileSync(permissionPath, "utf8"))).toEqual(["amazon_fba", "default"]);
    await runtime.updateManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "managed-secret",
      credential_revision: "f".repeat(64),
      fetched_at: 123,
      invalid_revision: "",
    });
    expect(runtime.isReady).toBe(true);
  });

  test("propagates an agent logging sink failure without changing process health", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const statuses: ReturnType<ProcessAgentRuntime["status"]>[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_LOGGING_FAILURE_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onStatus: (status) => statuses.push(status),
    });
    runtimes.push(runtime);

    await runtime.start();
    await runtime.dashboardCall({ operation: "models.list", input: {} });
    await waitFor(
      () => runtime.status().logging?.disabled_reason === "sink_failed",
      "logging sink failure status",
      () => JSON.stringify(runtime.status().logging),
    );

    expect(runtime.status()).toMatchObject({
      state: "ready",
      logging: {
        local_file_enabled: false,
        disabled_reason: "sink_failed",
        last_error: "disk unavailable",
      },
    });
    expect(statuses.some((status) => status.logging?.disabled_reason === "sink_failed")).toBe(true);
  }, 15_000);

  test("recovers an unexpectedly crashed agent process", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-process-"));
    temporaryRoots.push(root);
    const crashMarker = join(root, "crashed.once");
    const states: string[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_AGENT_CRASH_MARKER: crashMarker },
      ...resourcePaths(process.cwd()),
      dataRoot: root,
      legacyWorkspace: workspaceFor(root),
      requestTimeoutMs: 2_000,
      restartDelaysMs: [10, 20],
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);
    await runtime.start();

    await expect(runtime.dashboardCall({ operation: "models.list", input: {} })).rejects.toThrow("exited");
    expect(existsSync(crashMarker)).toBe(true);
    await waitFor(
      () => states.filter((state) => state === "ready").length >= 2,
      "agent process restart",
      () => `observed states: ${states.join(", ")}`,
    );

    expect(states).toContain("error");
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(runtime.isReady).toBe(true);
    expect(await runtime.dashboardCall({ operation: "models.list", input: {} }))
      .toEqual({ items: [], total: 0 });
  }, 10_000);

  test("rejects incomplete or malformed run_turn results", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const cases = [
      ["missing_steering", "remaining_steering must be an array"],
      ["malformed_steering", "message_id must be a string"],
      ["negative_counter", "input_tokens must be a non-negative safe integer"],
    ] as const;

    for (const [resultMode, expectedMessage] of cases) {
      const runtime = new ProcessAgentRuntime({
        command: process.execPath,
        arguments: [fixture],
        cwd: process.cwd(),
        environment: { ...process.env, FAKE_RUN_TURN_RESULT: resultMode },
        ...resourcePaths(process.cwd()),
        dataRoot: process.cwd(),
        legacyWorkspace: testWorkspace,
      });
      runtimes.push(runtime);
      await runtime.start();
      const job = agentJob();
      const error = await runtime.runTurn(job, new RunHandle(job)).catch((cause) => cause);
      expect(error).toBeInstanceOf(AgentProtocolError);
      expect(error).toHaveProperty("code", "AgentProtocolError");
      expect(error).toHaveProperty("message", expect.stringContaining(expectedMessage));
      await runtime.stop();
    }
  });

  test("forwards steering and deduplicates cancellation for an active turn", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
    });
    runtimes.push(runtime);
    await runtime.start();
    const job = agentJob();
    const handle = new RunHandle(job);
    const turn = runtime.runTurn(job, handle);
    await Bun.sleep(10);

    await runtime.steerTurn(handle, {
      text: "steer",
      response_route_id: "route-1",
      message_id: "message-2",
    });
    await runtime.cancelTurn(handle);
    await handle.abort();

    expect(await turn).toMatchObject({
      status: "cancelled",
      // The fixture echoes its cancel-turn request count; 1 proves the
      // handle.abort() kill callback was deduplicated against cancelTurn().
      tool_calls: 1,
      remaining_steering: [
        { text: "steer", response_route_id: "route-1", message_id: "message-2" },
      ],
    });
  });
});
