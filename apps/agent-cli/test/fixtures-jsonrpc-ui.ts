// Fake runtime host behind the real agent-cli protocol server. No model, DB or tool calls.
import { createInterface } from "node:readline";
import { AgentProtocolServer, type AgentProtocolServerOptions } from "../src/server";
import type { AgentJob, DesktopStreamBatchRequest } from "@lxe/protocol";
import type { AgentRunHandle } from "../src/run-handle";
console.log = (...values: unknown[]) => { process.stderr.write(values.map(String).join(" ") + "\n"); };
let writes = Promise.resolve();
const server = new AgentProtocolServer({
  environment: { LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR" },
  write: (message) => {
    const line = JSON.stringify(message) + "\n";
    writes = writes.then(() => new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve());
    }));
    return writes;
  },
  exit: (code) => { void writes.then(() => process.exit(code)); },
  createHost: ((options: Parameters<NonNullable<AgentProtocolServerOptions["createHost"]>>[0]) => ({
    start: async () => {}, stop: async () => {}, health: () => ({ ready: true }),
    runTurn: async (job: AgentJob, handle: AgentRunHandle) => {
      let seq = 0;
      const emit = async (mutations: DesktopStreamBatchRequest["mutations"]) => {
        await options.emitter.desktopStream?.({ session_id: job.session_id, turn_id: job.job_id,
          response_route_id: job.response_route_id, emit_id: job.job_id, seq: ++seq, mutations });
      };
      const metrics = { status: "running" as const, phase: "generating_answer" as const, elapsed_ms: 100,
        model: "local-fixture", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, context_tokens: 100, context_window_tokens: 1000, context_source: "estimated" as const };
      await emit([
        { kind: "part_updated", part: { type: "text", part_id: `${job.job_id}:0`, sequence: 1, status: "streaming", presentation: "final", text: "" } },
        { kind: "stream_updated", state: "delta", display_metrics: metrics },
      ]);
      let text = "";
      const chunks = ["正在通过真实 JSON-RPC 通道接收文本。", "\n\n用户气泡保持可见。", "\n\n**完成**：模型与数据库均为本地 fixture。"];
      for (let i = 0; i < 30 && !handle.cancelled; i += 1) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); handle.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 100);
          handle.signal.addEventListener("abort", done, { once: true });
        });
        if (handle.cancelled) break;
        if (i % 10 === 0) {
          const delta = chunks[i / 10]!; text += delta;
          await emit([{ kind: "part_delta", part_id: `${job.job_id}:0`, field: "text", delta }]);
        }
      }
      await emit([
        { kind: "part_updated", part: { type: "text", part_id: `${job.job_id}:0`, sequence: 1, status: handle.cancelled ? "error" : "completed", presentation: "final", text } },
        { kind: "stream_updated", state: handle.cancelled ? "error" : "final", display_metrics: { ...metrics, status: handle.cancelled ? "cancelled" : "completed" } },
      ]);
      return { status: handle.cancelled ? "cancelled" : "completed", reply: text, input_tokens: 100, output_tokens: 20, tool_calls: 0 };
    },
  })) as unknown as NonNullable<AgentProtocolServerOptions["createHost"]>,
});
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim()) void server.accept(line);
}
await server.shutdown();
await writes;
