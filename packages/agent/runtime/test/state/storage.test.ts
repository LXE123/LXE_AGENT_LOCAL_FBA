import { captureEnvironment, environmentMessage, environmentChanged } from "../../src/engine/environment-context";
import { messageFixture } from "../message-fixtures";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { removeTemporaryRoot } from "../temp-directory";
import { testWorkspace } from "../workspace";

const roots: string[] = [];
const retiredWorkspaceColumn = ["workspace", "server", "scope"].join("_");
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe("SqliteRuntimeStore", () => {
  test("replays environment baselines after restart and replacement without changing the title", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-environment-replay-"));
    roots.push(root);
    const path = join(root, "agent.sqlite3");
    const snapshot = captureEnvironment({ workspace: testWorkspace, platform: "desktop", provider: "custom", model: "test" });
    const message = environmentMessage(snapshot);
    const store = new SqliteRuntimeStore(path);
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "desktop" } });
    await store.appendMessage("s1", message, "environment_context", "j1");
    expect(store.listSessions({ limit: 10, offset: 0 }).items[0]?.title).toBe("");
    await store.appendMessage("s1", { role: "user", content: "Actual question" }, "turn_input", "j1");
    expect(store.listSessions({ limit: 10, offset: 0 }).items[0]?.title).toBe("Actual question");
    await store.replaceMessages("s1", [message], "context_replacement");
    await store.stop();
    const resumed = new SqliteRuntimeStore(path);
    await resumed.start();
    try {
      expect(await resumed.loadMessages("s1")).toEqual([message]);
      expect(environmentChanged(await resumed.loadMessages("s1"), snapshot)).toBe(false);
    } finally { await resumed.stop(); }
  });

  test("upgrades and invalidates the rebuildable display index when turn ownership is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-display-index-"));
    roots.push(root);
    const databasePath = join(root, "local_agent.sqlite3");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE transcript_display_groups (
        session_id TEXT NOT NULL,
        group_number INTEGER NOT NULL,
        byte_start INTEGER NOT NULL,
        byte_end INTEGER NOT NULL,
        group_kind TEXT NOT NULL,
        PRIMARY KEY (session_id, group_number)
      );
      CREATE TABLE transcript_file_state (
        session_id TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        raw_message_count INTEGER NOT NULL DEFAULT 0,
        display_group_count INTEGER NOT NULL DEFAULT 0,
        last_display_kind TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL DEFAULT 0
      );
      INSERT INTO transcript_file_state (session_id) VALUES ('stale');
    `);
    legacy.close(false);

    const store = new SqliteRuntimeStore(databasePath);
    await store.start();
    const inspected = new Database(databasePath, { readonly: true });
    const columns = inspected.query("PRAGMA table_info(transcript_display_groups)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("turn_id");
    expect(inspected.query("SELECT COUNT(*) AS count FROM transcript_file_state").get())
      .toEqual({ count: 0 });
    inspected.close(false);
    await store.stop();
  });

  test("persists local file references while projecting only safe attachment metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-attachments-"));
    roots.push(root);
    const databasePath = join(root, "local_agent.sqlite3");
    const selectedPath = join(root, "selected.csv");
    writeFileSync(selectedPath, "sku,qty\nA,1\n", "utf8");
    const localFile = {
      type: "local_file",
      attachment_id: "attachment-1",
      turn_id: "turn-1",
      path: selectedPath,
      name: "renderer-cannot-trust-this-name.csv",
      size_bytes: 14,
      media_type: "text/csv",
      ts: 100,
    };
    const store = new SqliteRuntimeStore(databasePath);
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "desktop" } });
    await store.appendMessage("s1", {
      role: "user",
      content: [localFile, { type: "text", text: "summarize this" }],
    }, "turn_input");

    expect(await store.loadMessages("s1")).toEqual([{
      role: "user",
      content: [localFile, { type: "text", text: "summarize this" }],
    }]);
    expect(await store.resolveAttachment("s1", "attachment-1")).toEqual(expect.objectContaining({
      path: selectedPath,
      name: "selected.csv",
      media_type: "text/csv",
    }));
    expect(await store.resolveAttachment("other", "attachment-1")).toBeUndefined();
    expect(await store.attachmentPaths("s1")).toEqual([selectedPath]);
    const detail = await store.sessionDetail("s1", { limit: 10 });
    expect(JSON.stringify(detail)).not.toContain(selectedPath);
    expect(detail).toMatchObject({
      session: { message_count: 1, title: "summarize this" },
      messages: [{
        role: "user",
        content: [{ type: "text", text: "summarize this" }],
        attachments: [{
          attachment_id: "attachment-1",
          name: "selected.csv",
          size_bytes: 14,
          media_type: "text/csv",
        }],
      }],
    });
    await store.stop();

    const database = new Database(databasePath);
    database.exec("DELETE FROM transcript_attachments; DELETE FROM transcript_file_state;");
    database.close(true);
    const rebuilt = new SqliteRuntimeStore(databasePath);
    await rebuilt.start();
    expect(await rebuilt.resolveAttachment("s1", "attachment-1"))
      .toEqual(expect.objectContaining({ path: selectedPath }));
    await rebuilt.stop();
  });

  test("backfills legacy sessions once and never allows a workspace change", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-workspace-migration-"));
    roots.push(root);
    const databasePath = join(root, "local_agent.sqlite3");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE agent_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
        model_config TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        last_active_at REAL NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        api_call_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO agent_sessions (session_id, source, created_at, last_active_at)
      VALUES ('legacy', '{"platform":"feishu"}', 1, 1);
    `);
    legacy.close(true);

    const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: testWorkspace });
    await store.start();
    expect(await store.getSession("legacy")).toEqual(expect.objectContaining({
      session_id: "legacy",
      workspace: testWorkspace,
    }));
    await store.ensureSession({
      session_id: "legacy",
      source: { chat_id: "same-workspace" },
      workspace: testWorkspace,
    });
    const different = { ...testWorkspace, directory: join(testWorkspace.worktree, "different") };
    await expect(store.ensureSession({
      session_id: "legacy",
      source: {},
      workspace: different,
    })).rejects.toThrow("workspace is immutable");
    expect(await store.sessionDetail("legacy", { limit: 10 })).toMatchObject({
      session: { workspace: testWorkspace },
    });
    await store.appendPendingEvent("legacy", { event_id: "migration-event", job_id: "job-1", text: "preserved" });
    await store.appendMessage("legacy", { role: "user", content: "preserved transcript" }, "turn_input");
    await store.stop();

    const oldDatabase = new Database(databasePath);
    const newColumns = oldDatabase.query("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
    expect(newColumns.map((column) => column.name)).toContain("workspace_directory");
    expect(newColumns.map((column) => column.name)).toContain("workspace_worktree");
    expect(newColumns.map((column) => column.name)).toContain("pinned_at");
    expect(newColumns.map((column) => column.name)).not.toContain(retiredWorkspaceColumn);
    oldDatabase.exec(`
      ALTER TABLE agent_sessions
      ADD COLUMN ${retiredWorkspaceColumn} TEXT NOT NULL DEFAULT 'unexpected';
      INSERT INTO turn_usage (turn_id, session_id, started_at)
      VALUES ('preserved-turn', 'legacy', 1);
    `);
    oldDatabase.close(true);

    const reopened = new SqliteRuntimeStore(databasePath, { legacyWorkspace: different });
    await reopened.start();
    expect(await reopened.getSession("legacy")).toEqual(expect.objectContaining({
      source: { platform: "feishu", chat_id: "same-workspace" },
      workspace: testWorkspace,
    }));
    expect(await reopened.popPendingEvents("legacy")).toEqual([
      expect.objectContaining({ event_id: "migration-event", job_id: "job-1", text: "preserved" }),
    ]);
    expect(await reopened.loadMessages("legacy")).toEqual([
      { role: "user", content: "preserved transcript" },
    ]);
    await reopened.stop();

    const migrated = new Database(databasePath);
    const migratedColumns = migrated.query("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
    expect(migratedColumns.map((column) => column.name)).not.toContain(retiredWorkspaceColumn);
    expect(migrated.query(`
      SELECT session_id, sequence, platform FROM turn_usage WHERE turn_id = 'preserved-turn'
    `).get()).toEqual({ session_id: "legacy", sequence: 1, platform: "feishu" });
    migrated.close(true);

    const idempotent = new SqliteRuntimeStore(databasePath, { legacyWorkspace: different });
    await idempotent.start();
    expect((await idempotent.getSession("legacy"))?.workspace).toEqual(testWorkspace);
    await idempotent.stop();
  });

  test("rolls back all workspace schema changes when the retired column cannot be dropped", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-workspace-rollback-"));
    roots.push(root);
    const databasePath = join(root, "local_agent.sqlite3");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE agent_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        ${retiredWorkspaceColumn} TEXT NOT NULL DEFAULT 'unexpected',
        model TEXT NOT NULL DEFAULT '',
        model_config TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        last_active_at REAL NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        api_call_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_retired_workspace_column
      ON agent_sessions (${retiredWorkspaceColumn});
      INSERT INTO agent_sessions (session_id, source, created_at, last_active_at)
      VALUES ('preserved', '{"platform":"feishu"}', 1, 1);
    `);
    legacy.close(true);

    const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: testWorkspace });
    await expect(store.start()).rejects.toThrow();

    const inspected = new Database(databasePath);
    const columns = inspected.query("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain(retiredWorkspaceColumn);
    expect(columns.map((column) => column.name)).not.toContain("workspace_directory");
    expect(columns.map((column) => column.name)).not.toContain("workspace_worktree");
    expect(columns.map((column) => column.name)).not.toContain("reasoning_effort");
    expect(inspected.query("SELECT source FROM agent_sessions WHERE session_id = 'preserved'").get())
      .toEqual({ source: '{"platform":"feishu"}' });
    inspected.close(true);
  });

  test("rejects legacy session_messages and v1 transcripts with a migration hint", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-legacy-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();

    mkdirSync(join(root, "session_messages"), { recursive: true });
    writeFileSync(join(root, "session_messages", "fallback.jsonl"), [
      JSON.stringify({ role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "echo", arguments: { text: "hi" } }] }),
      JSON.stringify({ role: "tool", content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }] }),
      "",
    ].join("\n"), "utf8");
    await expect(store.loadMessages("fallback")).rejects.toThrow("scripts/migrate-transcripts-v2.ts");

    mkdirSync(join(root, "session_transcripts"), { recursive: true });
    writeFileSync(join(root, "session_transcripts", "replacement.jsonl"), [
      JSON.stringify({ kind: "message", message: { role: "user", content: "discard me" } }),
      JSON.stringify({
        kind: "compaction",
        replacement_history: [{ role: "user", content: "summary" }],
      }),
      "",
    ].join("\n"), "utf8");
    await expect(store.loadMessages("replacement")).rejects.toThrow("scripts/migrate-transcripts-v2.ts");

    writeFileSync(join(root, "session_transcripts", "early-bun.jsonl"), [
      JSON.stringify({
        kind: "message",
        message: { role: "assistant", content: [{ type: "tool_use", id: "old-1", name: "exec", input: {} }] },
      }),
      "",
    ].join("\n"), "utf8");
    await expect(store.loadMessages("early-bun")).rejects.toThrow("scripts/migrate-transcripts-v2.ts");

    // A session without any persisted history still loads as empty.
    expect(await store.loadMessages("fresh")).toEqual([]);
    await store.stop();
  });

  test("round-trips existing session, pending-event, and transcript shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu", chat_id: "c1" } });
    await store.appendPendingEvent("s1", { event_id: "e1", job_id: "j1", text: "done" });
    expect(await store.hasPendingEvents("s1")).toBe(true);
    expect(await store.popPendingEvents("s1")).toEqual([
      expect.objectContaining({ event_id: "e1", job_id: "j1", text: "done" }),
    ]);
    await store.appendPendingEvent("s1", { event_id: "e2", job_id: "j2", text: "consume me" });
    await store.appendPendingEvent("s1", { event_id: "e3", job_id: "j3", text: "keep me" });
    expect(store.discardPendingEvent("s1", "j2")).toBe(1);
    expect(store.discardPendingEvent("s1", "j2")).toBe(0);
    expect(store.discardPendingEvent("", "j3")).toBe(0);
    expect(await store.popPendingEvents("s1")).toEqual([
      expect.objectContaining({ event_id: "e3", job_id: "j3", text: "keep me" }),
    ]);
    await store.appendMessage("s1", { role: "user", content: "hello" }, "turn_input");
    await store.appendMessage("s1", { role: "assistant", content: "world" }, "turn_output");
    await store.replaceMessages("s1", [
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
    ], "compaction", {
      trigger: "pre_call",
      summary_text: "important decision",
      compacted_count: 2,
      before_tokens: 1000,
      after_tokens: 100,
    });
    await store.appendMessage("s1", { role: "user", content: "after compaction" }, "turn_input");
    await store.patchSessionState("s1", { browser: { session_id: "remote-1", page: 1 } });
    await store.patchSessionState("s1", { browser: { page: 2 }, amazon: { shipment_id: "FBA1" } });
    expect(await store.loadMessages("s1")).toEqual([
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
      { role: "user", content: "after compaction" },
    ]);
    expect(await store.getSession("s1")).toEqual(expect.objectContaining({
      session_id: "s1",
      source: expect.objectContaining({
        tool_state: {
          browser: { session_id: "remote-1", page: 2 },
          amazon: { shipment_id: "FBA1" },
        },
      }),
    }));
    await store.stop();
    const reopened = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await reopened.start();
    expect(await reopened.loadMessages("s1")).toEqual([
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
      { role: "user", content: "after compaction" },
    ]);
    await reopened.stop();
  });

  test("caches transcript replay, sanitizes persisted images, derives title, and invalidates external writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-cache-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "images", source: { platform: "feishu" } });
    await store.appendMessage("images", {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "  第一条真实用户消息   with title  " },
      ],
    }, "turn_input");
    const transcript = join(root, "session_transcripts", "images.jsonl");
    const persisted = readFileSync(transcript, "utf8");
    expect(persisted).not.toContain("aGVsbG8=");
    expect(persisted).toContain("Image omitted from persisted transcript");
    expect(store.listSessions({ limit: 10, offset: 0 }).items[0]?.title).toBe("第一条真实用户消息 with title");

    await store.loadMessages("images");
    await store.loadMessages("images");
    expect(store.replayCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    appendFileSync(transcript, `${JSON.stringify({ kind: "message", message: { role: "assistant", content: "external" } })}\n`, "utf8");
    expect(await store.loadMessages("images")).toEqual(expect.arrayContaining([{ role: "assistant", content: "external" }]));
    expect(store.replayCacheStats().misses).toBe(2);
    await store.stop();
  });

  test("resets context and records independent skill activation and execution usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-lifecycle-store-"));
    roots.push(root);
    const databasePath = join(root, "local_agent.sqlite3");
    const store = new SqliteRuntimeStore(databasePath);
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { tool_state: { browser: { page: 1 } } } });
    await store.appendPendingEvent("s1", { event_id: "e1", text: "pending" });
    expect(store.discardPendingEvents("s1")).toBe(1);
    await store.appendMessage("s1", { role: "user", content: "keep until reset" }, "turn_input");
    await store.resetContext("s1");
    expect(await store.loadMessages("s1")).toEqual([]);
    const startedAt = Date.now() / 1_000;
    await store.recordTurn("s1", {
      turn_id: "turn-1", started_at: startedAt, status: "completed", elapsed_ms: 40,
      input_tokens: 1, output_tokens: 1, tool_calls: 2, api_calls: 1, tools: [],
      activations: [{ skill: "demo", module: "amazon_replenish" }],
      executions: [
        { skill: "demo", module: "amazon_replenish", command: "replenish store resolve", success: true, duration_ms: 10 },
        { skill: "demo", module: "amazon_replenish", command: "replenish store resolve", success: false, duration_ms: 20 },
      ],
    });
    await store.recordTurn("s1", {
      turn_id: "turn-2", started_at: startedAt + 1, status: "completed", elapsed_ms: 30,
      input_tokens: 1, output_tokens: 1, tool_calls: 1, api_calls: 1, tools: [], activations: [],
      executions: [
        { skill: "demo", module: "amazon_replenish", command: "replenish store resolve", success: true, duration_ms: 30 },
      ],
    });
    await store.recordTurn("s1", {
      turn_id: "turn-3", started_at: startedAt + 2, status: "completed", elapsed_ms: 1,
      input_tokens: 0, output_tokens: 0, tool_calls: 0, api_calls: 0, tools: [],
      activations: [{ skill: "activation-only", module: "amazon_fba" }], executions: [],
    });

    const legacy = new Database(databasePath);
    const legacyInsert = legacy.prepare(`
      INSERT INTO turn_usage_items
        (turn_id, session_id, started_at, kind, name, module, calls, errors, duration_ms, detail)
      VALUES ('turn-1', 's1', ?, 'skill', 'legacy', 'legacy_module', 99, 99, 999, 'legacy command')
    `);
    try {
      legacyInsert.run(startedAt);
    } finally {
      legacyInsert.finalize();
      legacy.close(true);
    }

    expect(store.skillUsageStats(30, "demo")).toEqual([{
      name: "demo", module: "amazon_replenish", activations: 1, executions: 3,
      failures: 1, execution_turns: 2, duration_ms: 60, last_used_at: startedAt + 1,
    }]);
    expect(store.skillUsageStats(30, "activation-only")).toEqual([expect.objectContaining({
      name: "activation-only", module: "amazon_fba", activations: 1, executions: 0,
      failures: 0, execution_turns: 0, duration_ms: 0,
    })]);
    expect(store.skillUsageStats(30, "legacy")).toEqual([]);
    expect(store.usageOverview(30)).toMatchObject({
      totals: { skill_executions: 3, skill_failures: 1 },
      modules: [{
        module: "amazon_replenish", skills: 1, turns: 2, executions: 3, failures: 1, duration_ms: 60,
      }],
      daily: [expect.objectContaining({ executions: 3, failures: 1 })],
    });
    expect(store.skillUsageDetail("demo", 30)).toMatchObject({
      name: "demo",
      daily: [expect.objectContaining({ activations: 1, executions: 3, failures: 1 })],
      recent_failures: [{
        turn_id: "turn-1", session_id: "s1", started_at: startedAt, command: "replenish store resolve",
      }],
    });
    const exported = store.exportTurnUsage(30);
    expect(exported.flatMap((turn) => Array.isArray(turn.items) ? turn.items : [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "skill_activation", name: "demo", module: "amazon_replenish" }),
      expect.objectContaining({ kind: "skill_execution", name: "demo", detail: "replenish store resolve" }),
    ]));
    expect(JSON.stringify(exported)).not.toContain('"kind":"skill"');
    expect(JSON.stringify(exported)).not.toContain("legacy command");
    const firstBatch = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2);
    expect(firstBatch).toMatchObject({
      acknowledged_sequence: 0,
      has_more: true,
      turns: [
        expect.objectContaining({ sequence: 1, turn_id: "turn-1" }),
        expect.objectContaining({ sequence: 2, turn_id: "turn-2" }),
      ],
    });
    expect(JSON.stringify(firstBatch)).not.toContain("session_id");
    expect(JSON.stringify(firstBatch)).not.toContain("replenish store resolve");
    store.acknowledgeTurnUsage("https://cloud.example", 2);
    expect(store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2).turns)
      .toEqual([expect.objectContaining({ sequence: 3, turn_id: "turn-3" })]);
    expect(store.exportTurnUsageBatch("https://fallback.example", startedAt - 1, 1).turns)
      .toEqual([expect.objectContaining({ sequence: 1, turn_id: "turn-1" })]);
    const direct = new Database(databasePath);
    direct.query("DELETE FROM turn_usage WHERE turn_id = 'turn-3'").run();
    direct.close(true);
    await store.recordTurn("s1", {
      turn_id: "turn-4", started_at: startedAt + 3, status: "completed", elapsed_ms: 1,
      input_tokens: 0, output_tokens: 0, tool_calls: 0, api_calls: 0,
      tools: [], activations: [], executions: [],
    });
    expect(store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2).turns)
      .toEqual([expect.objectContaining({ sequence: 4, turn_id: "turn-4" })]);
    store.clearSessionRuntimeState("s1");
    expect((await store.getSession("s1"))?.source.tool_state).toBeUndefined();
    await store.stop();
  });

  test("releases SQLite files after session detail and usage export", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-usage-close-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    await store.appendMessage("s1", { role: "user", content: "hello" });
    await store.recordTurn("s1", {
      turn_id: "turn-1", started_at: Date.now() / 1_000, status: "completed", elapsed_ms: 4,
      input_tokens: 1, output_tokens: 1, tool_calls: 1, api_calls: 1,
      tools: [{ name: "lxeskill:demo", calls: 1, errors: 0, duration_ms: 4 }],
      activations: [{ skill: "demo", module: "test" }],
      executions: [{ skill: "demo", module: "test", command: "demo run", success: true, duration_ms: 4 }],
    });

    expect(store.listSessions({ limit: 10, offset: 0 }).items).toHaveLength(1);
    expect((await store.sessionDetail("s1", { limit: 10 }))?.messages).toHaveLength(1);
    expect(store.exportTurnUsage(30)).toEqual([
      expect.objectContaining({ turn_id: "turn-1", items: expect.any(Array) }),
    ]);

    await store.stop();
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
    roots.splice(roots.indexOf(root), 1);
  });
});

test("retains assistant origin and replay metadata across a cold transcript reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-assistant-roundtrip-"));
  roots.push(root);
  const path = join(root, "agent.sqlite3");
  const message = messageFixture({ api: "openai_responses", responseId: "resp_1", content: [
    { type: "thinking", thinking: "plan", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }) },
    { type: "tool_call", id: "call_1", providerItemId: "fc_1", name: "read", arguments: { path: "a" }, namespace: "files" },
    { type: "text", text: "answer", textSignature: JSON.stringify({ v: 1, id: "msg_1" }) },
  ] });
  const store = new SqliteRuntimeStore(path);
  await store.start();
  await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "desktop" } });
  await store.appendMessage("s1", message);
  await store.stop();
  const reopened = new SqliteRuntimeStore(path);
  await reopened.start();
  try { expect(await reopened.loadMessages("s1")).toEqual([message]); }
  finally { await reopened.stop(); }
});
