// Run from repo root: bun apps/dashboard/test/features/sessions/jsonrpc-fixture-server.ts
import { resolve } from "node:path";
import { createServer } from "vite";
import { ProcessAgentRuntime } from "../../../../gateway/src/orchestration/process-runtime";
import { LocalConversationController, type LocalConversationStorage } from "../../../../gateway/src/orchestration/local-conversation";
import { SessionScheduler } from "../../../../gateway/src/orchestration/scheduler";
import { SessionRuntimeState } from "../../../../gateway/src/state/session-state";
const root = process.cwd();
const workspace = { directory: root, worktree: root };
const sessions = new Map<string, Awaited<ReturnType<LocalConversationStorage["getSession"]>>>();
let sessionId = "";
let conversations!: LocalConversationController;
const runtime = new ProcessAgentRuntime({
  command: process.execPath, arguments: [resolve(root, "apps/agent-cli/test/fixtures-jsonrpc-ui.ts")],
  cwd: root, environment: { ...process.env },
  agentSoulPath: "/soul", skillsRoot: "/skills", userSkillsRoot: "/user-skills", lxeskillCatalogPath: "/catalog",
  llmConfigRoot: "/llm", dataRoot: root, legacyWorkspace: workspace,
  onDesktopStream: (batch) => { conversations.handleStreamBatch(batch); },
  onEvent: (event) => conversations.handleAgentEvent(event),
});
const scheduler = new SessionScheduler({ maxConcurrency: 1, runtime: {
  startTurn: async (job, handle) => {
    void runtime.runTurn(job, handle).then((outcome) => {
      scheduler.handleRuntimeEvent({ kind: "runtime.turn.completed", run_id: handle.runId,
        payload: { session_id: handle.sessionId, job_id: handle.jobId, status: outcome.status, remaining_steering: outcome.remaining_steering } });
    }, (error) => scheduler.handleRuntimeEvent({ kind: "runtime.turn.completed", run_id: handle.runId,
      payload: { session_id: handle.sessionId, job_id: handle.jobId, status: "error", error: String(error) } }));
  },
  cancelTurn: (handle) => runtime.cancelTurn(handle),
  steerTurn: (handle, message) => runtime.steerTurn(handle, message),
}, onJobState: (event) => conversations.handleSchedulerEvent(event) });
conversations = new LocalConversationController({ scheduler, runtimeState: new SessionRuntimeState(), defaultWorkspace: () => workspace,
  storage: {
    ensureSession: async (request) => { sessions.set(request.session_id, { session_id: request.session_id, source: request.source, workspace: request.workspace }); },
    getSession: async (id) => sessions.get(id), upsertResponseRoute: async () => {},
    appendPendingEvent: async () => {}, getResponseRoute: async () => undefined,
  },
});
await runtime.start();
const vite = await createServer({ root: resolve(root, "apps/dashboard"), server: { port: 5198, strictPort: true, host: "127.0.0.1" }, plugins: [{
  name: "jsonrpc-acceptance-bridge",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__rpc_fixture__/")) return next();
      void (async () => {
        if (req.method === "POST" && req.url === "/__rpc_fixture__/send") {
          const sent = await conversations.send({ session_id: sessionId, text: "检查 JSON-RPC 流式链路", client_message_id: crypto.randomUUID() });
          sessionId = sent.session_id;
        }
        if (req.method === "POST" && req.url === "/__rpc_fixture__/stop") await conversations.stop(sessionId);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ health: runtime.status(), activity: conversations.activity(sessionId) }));
      })().catch((error) => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); });
    });
  },
}] });
try { await vite.listen(); } catch (error) { await runtime.stop(); throw error; }
console.log("JSON-RPC acceptance: http://127.0.0.1:5198/test/features/sessions/jsonrpc-fixture.html");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  void runtime.stop().then(() => vite.close()).then(() => process.exit(0));
});
