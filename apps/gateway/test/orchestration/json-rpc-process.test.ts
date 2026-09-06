import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProcessAgentRuntime, type ProcessAgentRuntimeOptions } from "../../src/orchestration/process-runtime";
const runtimes: ProcessAgentRuntime[] = [];
const roots: string[] = [];
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture state did not arrive");
    await Bun.sleep(5);
  }
};
const create = (mode: string, overrides: Partial<ProcessAgentRuntimeOptions> = {}) => {
  const runtime = new ProcessAgentRuntime({
    command: process.execPath, arguments: [resolve(import.meta.dirname, "fixtures/json-rpc-peer.mjs")],
    cwd: process.cwd(), environment: { ...process.env, RPC_FIXTURE_MODE: mode },
    agentSoulPath: "/soul", skillsRoot: "/skills", userSkillsRoot: "/user-skills",
    lxeskillCatalogPath: "/catalog", llmConfigRoot: "/llm", dataRoot: process.cwd(),
    legacyWorkspace: { directory: process.cwd(), worktree: process.cwd() },
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
};
const read = (runtime: ProcessAgentRuntime, provider = "test") => runtime.resolveArtifact("session", provider);
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JSON-RPC subprocess transport", () => {
  test.each(["version-error", "version-result"])("fails incompatible startup without retries: %s", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "rpc-starts-")); roots.push(root);
    const path = join(root, "starts");
    const runtime = create(mode, { restartDelaysMs: [10, 10], environment: { ...process.env, RPC_FIXTURE_MODE: mode, RPC_STARTS_PATH: path } });
    await expect(runtime.start()).rejects.toMatchObject({ rpcCode: -32002 });
    await Bun.sleep(60);
    expect(readFileSync(path, "utf8")).toBe("start\n");
    expect(runtime.status().state).toBe("error");
  });

  test("correlates concurrent responses arriving in reverse order", async () => {
    const runtime = create("reordered"); await runtime.start();
    const first = read(runtime, "first");
    const second = read(runtime, "second");
    expect(await second).toEqual("second");
    expect(await first).toEqual("first");
  });

  test("handles split JSONL frames, escaped newlines and CRLF", async () => {
    const runtime = create("fragmented"); await runtime.start();
    expect(await read(runtime)).toEqual("你好\n第二行");
  });

  test("times out without replay and ignores late duplicate responses", async () => {
    const runtime = create("late", { requestTimeoutMs: 40 }); await runtime.start();
    await expect(read(runtime, "first")).rejects.toMatchObject({ code: "AgentRequestTimeout" });
    expect(await read(runtime, "second")).toEqual("second");
    await Bun.sleep(100);
    expect(runtime.isReady).toBe(true);
    expect(await read(runtime, "third")).toEqual("third");
  });

  test("keeps actual business error and both code representations", async () => {
    const runtime = create("business-error"); await runtime.start();
    await expect(read(runtime)).rejects.toMatchObject({ code: "vendor_failed", rpcCode: -32000, message: "actual vendor error" });
    expect(runtime.isReady).toBe(true);
  });

  test.each(["broken-response", "bad-notification", "null-error"])("terminates invalid connection and rejects outstanding work: %s", async (mode) => {
    const runtime = create(mode); await runtime.start();
    const results = await Promise.allSettled([read(runtime), read(runtime)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await until(() => runtime.status().pid === 0);
    expect(runtime.status().state).toBe("error");
  });

  test("slow and throwing consumers preserve notification order without blocking responses", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const received: string[] = [];
    const runtime = create("slow-events", { onEvent: async (event) => {
      if (event.type !== "session.changed") return;
      received.push(event.thread_id);
      if (event.thread_id === "session-1") { await gate; throw new Error("consumer failure"); }
    } });
    await runtime.start();
    expect(await read(runtime)).toEqual("test");
    await until(() => received.length === 1);
    expect(received).toEqual(["session-1"]);
    release();
    await until(() => received.length === 2);
    expect(received).toEqual(["session-1", "session-2"]);
    expect(runtime.isReady).toBe(true);
  });

  test("queued notifications from a replaced process cannot reach the new connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const received: string[] = [];
    const runtime = create("slow-events", { onEvent: async (event) => {
      if (event.type !== "session.changed") return;
      received.push(event.thread_id);
      if (received.length === 1) await gate;
    } });
    await runtime.start(); await read(runtime);
    await until(() => received.length === 1);
    const oldPid = runtime.status().pid;
    await runtime.restart();
    expect(runtime.status().pid).not.toBe(oldPid);
    release(); await read(runtime);
    await until(() => received.length === 3);
    expect(received).toEqual(["session-1", "session-1", "session-2"]);
    expect(runtime.isReady).toBe(true);
  });

  test.each(["", "estimated", "usage_calibrated"])("delivers context_source through real stdio: %s", async (source) => {
    let received: unknown;
    const runtime = create("metrics", { environment: { ...process.env, RPC_FIXTURE_MODE: "metrics", RPC_CONTEXT_SOURCE: source },
      onDesktopStream: (batch) => { received = batch.mutations; },
    });
    await runtime.start(); await read(runtime); await until(() => !!received);
    expect(received).toEqual([expect.objectContaining({ display_metrics: expect.objectContaining({ context_tokens: 100, ...(source ? { context_source: source } : {}) }) })]);
    expect(runtime.isReady).toBe(true);
  });

  test("invalid context source identifies its own field, not the part_updated branch", async () => {
    const runtime = create("metrics", { environment: { ...process.env, RPC_FIXTURE_MODE: "metrics", RPC_CONTEXT_SOURCE: "bad-source" } });
    await runtime.start();
    await expect(read(runtime)).rejects.toThrow("/display_metrics/context_source");
    expect(runtime.status().message).not.toContain("required property 'part'");
  });
});
