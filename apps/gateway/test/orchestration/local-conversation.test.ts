import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION } from "@lxe/desktop-protocol";
import type {
  AgentJob,
  DesktopStreamBatchRequest,
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import {
  LocalConversationController,
  LocalConversationSessionNotFoundError,
  type LocalConversationStorage,
} from "../../src/orchestration/local-conversation";
import {
  RunHandle,
  SessionScheduler,
  type RuntimePort,
  type SchedulerJobStateEvent,
} from "../../src/orchestration/scheduler";
import { SessionRuntimeState } from "../../src/state/session-state";
import type { ResponseRouteRecord } from "../../src/state/models";
import { testWorkspace } from "../workspace";

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class RecordingRuntime implements RuntimePort {
  readonly started: AgentJob[] = [];
  readonly cancelled: string[] = [];
  async startTurn(job: AgentJob): Promise<void> { this.started.push(job); }
  async cancelTurn(handle: RunHandle): Promise<void> { this.cancelled.push(handle.jobId); }
  async steerTurn(): Promise<void> {}
}

class MemoryStorage implements LocalConversationStorage {
  readonly sessions = new Map<string, { session_id: string; source: JsonObject; workspace: WorkspaceContext }>();
  readonly ensured: SessionWorkspaceRequest[] = [];
  readonly routes: JsonObject[] = [];
  readonly pending: JsonObject[] = [];

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    this.ensured.push(request);
    this.sessions.set(request.session_id, {
      session_id: request.session_id,
      source: { ...request.source },
      workspace: request.workspace,
    });
  }
  async upsertResponseRoute(request: JsonObject): Promise<void> { this.routes.push(request); }
  async getSession(sessionId: string) { return this.sessions.get(sessionId); }
  async appendPendingEvent(_sessionId: string, event: JsonObject): Promise<void> { this.pending.push(event); }
  async getResponseRoute(): Promise<ResponseRouteRecord | undefined> { return undefined; }
}

function harness(ids: string[]) {
  const runtime = new RecordingRuntime();
  const storage = new MemoryStorage();
  const events: SchedulerJobStateEvent[] = [];
  const activities: unknown[] = [];
  const streamBatches: unknown[] = [];
  const clock = { value: 1_000 };
  let controller!: LocalConversationController;
  const scheduler = new SessionScheduler({
    runtime,
    maxConcurrency: 1,
    onJobState: (event) => {
      events.push(event);
      controller.handleSchedulerEvent(event);
    },
  });
  controller = new LocalConversationController({
    storage,
    scheduler,
    runtimeState: new SessionRuntimeState(),
    defaultWorkspace: () => testWorkspace,
    onActivity: (activity) => activities.push(activity),
    onStreamBatch: (batch) => streamBatches.push(batch),
    id: () => {
      const next = ids.shift();
      if (!next) throw new Error("test id exhausted");
      return next;
    },
    now: () => (clock.value += 1),
  });
  return { runtime, storage, scheduler, controller, events, activities, streamBatches, clock };
}

const externalJob = (sessionId: string): AgentJob => ({
  job_id: "external-turn",
  session_id: sessionId,
  session_key: `agent:main:feishu:dm:${sessionId}`,
  response_route_id: "external-route",
  user_id: "feishu-user",
  conversation_id: "feishu-chat",
  is_group: false,
  message_id: "external-message",
  user_input: "external",
  job_kind: "turn",
  sender_nick: "Feishu user",
  workspace: testWorkspace,
  source: { platform: "feishu", chat_id: "feishu-chat", chat_type: "dm" },
  raw_data: {},
  user_content_blocks: [],
  diagnostics: [],
});

describe("LocalConversationController", () => {
  test("applies desktop deltas to canonical activity without publishing full activity frames", async () => {
    const h = harness(["session-1", "turn-1", "message-1", "route-1"]);
    await h.controller.send({ text: "hello" });
    const beforeActivities = h.activities.length;
    const metrics = {
      status: "running" as const,
      phase: "thinking" as const,
      elapsed_ms: 16,
      model: "model",
      input_tokens: 0,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      context_tokens: 0,
      context_window_tokens: 100,
    };
    const batch: DesktopStreamBatchRequest = {
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
      mutations: [
        {
          kind: "part_updated",
          part: {
            type: "thinking",
            part_id: "thinking-1",
            sequence: 1,
            status: "streaming",
            text: "",
            redacted_count: 0,
          },
        },
        { kind: "part_delta", part_id: "thinking-1", field: "text", delta: "inspect" },
        { kind: "stream_updated", state: "delta", display_metrics: metrics },
      ],
    };
    expect(h.controller.handleStreamBatch(batch)).toBe(true);
    expect(h.activities).toHaveLength(beforeActivities);
    expect(h.controller.activity("session-1").active?.stream?.thinking).toBe("inspect");
    expect(h.controller.activity("session-1").active?.created_at).toBeGreaterThan(0);
    expect(h.streamBatches).toHaveLength(1);
    expect(JSON.stringify(h.streamBatches)).not.toContain("response_route_id");
    expect(h.controller.handleStreamBatch({ ...batch, seq: 3 })).toBe(false);
    expect(h.controller.handleStreamBatch({ ...batch, session_id: "session-2", seq: 2 })).toBe(false);
    expect(h.controller.handleStreamBatch({ ...batch, emit_id: "emit-2", seq: 2 })).toBe(false);
    expect(h.controller.activity("session-1").active?.stream?.seq).toBe(1);
  });
  test("continues an existing transcript without changing its source or workspace", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    const originalSource = { platform: "feishu", chat_id: "chat-1", chat_type: "dm", user_id: "user-1" };
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: originalSource,
      workspace: testWorkspace,
    });

    const result = await h.controller.send({ session_id: "session-1", text: " continue here " });
    await tick();

    expect(result).toEqual({
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      created: false,
      state: "running",
    });
    expect(h.storage.ensured).toEqual([]);
    expect(h.storage.sessions.get("session-1")?.source).toEqual(originalSource);
    expect(h.storage.routes[0]).toMatchObject({ platform: "desktop", response_route_id: "route-1" });
    expect(h.runtime.started[0]).toMatchObject({
      session_id: "session-1",
      workspace: testWorkspace,
      source: { platform: "desktop" },
      user_input: "continue here",
    });
    expect(h.controller.activity("session-1").active?.state).toBe("running");
    expect(h.controller.activity("session-1").active?.started_at).toBeGreaterThan(0);
    h.controller.dispose();
  });

  test("creates a desktop session lazily for the first message", async () => {
    const h = harness(["new-session", "turn-1", "message-1", "route-1"]);
    const result = await h.controller.send({ text: "hello" });
    expect(result.created).toBe(true);
    expect(result.session_id).toBe("new-session");
    expect(h.storage.ensured[0]).toMatchObject({
      session_id: "new-session",
      entry_text: "hello",
      source: { platform: "desktop", chat_id: "new-session" },
      workspace: testWorkspace,
    });
    h.controller.dispose();
  });

  test("creates a file-only turn with durable local-file and visual blocks without exposing its path", async () => {
    const h = harness(["new-session", "turn-1", "message-1", "route-1"]);
    const result = await h.controller.send({
      text: "",
      attachments: [{
        attachment_id: "attachment-1",
        name: "photo.png",
        size_bytes: 123,
        media_type: "image/png",
        path: "/private/files/photo.png",
        image_block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "encoded" } },
      }],
    });
    await tick();
    expect(result.created).toBe(true);
    expect(h.storage.ensured[0]?.entry_text).toBe("photo.png");
    expect(h.runtime.started[0]?.user_content_blocks).toEqual([
      expect.objectContaining({
        type: "local_file",
        attachment_id: "attachment-1",
        turn_id: "turn-1",
        path: "/private/files/photo.png",
        name: "photo.png",
      }),
      expect.objectContaining({ type: "image" }),
    ]);
    const activity = h.controller.activity("new-session");
    expect(activity.active?.attachments).toEqual([{
      attachment_id: "attachment-1",
      name: "photo.png",
      size_bytes: 123,
      media_type: "image/png",
    }]);
    expect(JSON.stringify(activity)).not.toContain("/private/files");
    expect(JSON.stringify(activity)).not.toContain("encoded");
    h.controller.dispose();
  });

  test("rejects a missing existing session", async () => {
    const h = harness([]);
    expect(h.controller.send({ session_id: "missing", text: "hello" }))
      .rejects.toBeInstanceOf(LocalConversationSessionNotFoundError);
    h.controller.dispose();
  });

  test("keeps a desktop turn queued behind external work and clears only the desktop turn", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace: testWorkspace,
    });
    await h.scheduler.enqueue(externalJob("session-1"));
    await tick();
    const result = await h.controller.send({ session_id: "session-1", text: "local follow-up" });
    expect(result.state).toBe("queued");
    expect(h.controller.activity("session-1").queued[0]?.started_at).toBe(0);

    const stopped = await h.controller.stop("session-1");
    expect(stopped).toEqual({
      session_id: "session-1",
      stopped_turn_id: null,
      cleared_turn_ids: ["turn-1"],
    });
    expect(h.runtime.cancelled).toEqual([]);
    expect(h.scheduler.activeRun("session-1")?.jobId).toBe("external-turn");
    h.controller.dispose();
  });

  test("stops an active desktop turn without clearing work submitted by another entry", async () => {
    const h = harness(["turn-1", "message-1", "route-1", "pending-event", "pending-job"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "local work" });
    await tick();
    await h.scheduler.enqueue(externalJob("session-1"));

    const stopped = await h.controller.stop("session-1");
    expect(stopped).toEqual({
      session_id: "session-1",
      stopped_turn_id: "turn-1",
      cleared_turn_ids: [],
    });
    expect(h.runtime.cancelled).toEqual(["turn-1"]);
    expect(h.storage.pending).toHaveLength(1);

    expect(h.scheduler.handleRuntimeEvent({
      kind: "runtime.turn.completed",
      run_id: "turn-1",
      payload: { session_id: "session-1", job_id: "turn-1", status: "cancelled" },
    })).toBe(true);
    await tick();
    expect(h.scheduler.activeRun("session-1")?.jobId).toBe("external-turn");
    h.controller.dispose();
  });

  test("keeps the completed turn visible while the next desktop turn starts", async () => {
    const h = harness(["turn-1", "message-1", "route-1", "turn-2", "message-2", "route-2"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "first" });
    await h.controller.send({ session_id: "session-1", text: "second" });
    expect(h.controller.activity("session-1").queued.map((turn) => turn.turn_id)).toEqual(["turn-2"]);

    h.scheduler.handleRuntimeEvent({
      kind: "runtime.turn.completed",
      run_id: "turn-1",
      payload: { session_id: "session-1", job_id: "turn-1", status: "completed" },
    });
    await tick();
    const activity = h.controller.activity("session-1");
    expect(activity.latest?.turn_id).toBe("turn-1");
    expect(activity.latest?.state).toBe("completed");
    expect(activity.active?.turn_id).toBe("turn-2");
    h.controller.dispose();
  });

  test("publishes only allowlisted stream fields and marks the user message persisted", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "hello" });
    h.controller.handleOutbound({
      action: "stream_message",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "secret-route",
      event_id: "event-1",
      payload: {
        state: "delta",
        seq: 1,
        content: "answer",
        thinking: "thought",
        redacted_thinking_count: 0,
        thinking_elapsed_ms: 10,
        tool_pending: false,
        tool_elapsed_ms: 0,
        tool_steps: [{
          id: "tool-1",
          name: "read",
          title: "Read",
          detail: "/private/var/artifacts/report.json not found",
          icon_token: "file-link-text_outlined",
          status: "running",
          duration_ms: 0,
        }],
        process_parts: [{
          type: "thinking",
          part_id: "part-1",
          sequence: 1,
          status: "completed",
          text: "thought",
          redacted_count: 0,
        }, {
          type: "tool",
          part_id: "part-2",
          sequence: 2,
          tool_step: {
            id: "tool-1",
            name: "read",
            title: "Read",
            detail: "/private/var/artifacts/report.json not found",
            icon_token: "file-link-text_outlined",
            status: "success",
            duration_ms: 10,
            result_block: { language: "text", content: "result" },
          },
        }],
        display_metrics: {
          status: "running",
          phase: "running_tool",
          elapsed_ms: 10,
          model: "model",
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          context_tokens: 1,
          context_window_tokens: 100,
        },
        files: ["/private/var/artifacts/report.json"],
      },
    });
    h.controller.handleAgentEvent({
      version: AGENT_PROTOCOL_VERSION,
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages"] },
    });
    const activity = h.controller.activity("session-1");
    expect(activity.active?.user_persisted_at).toBeGreaterThan(0);
    expect(activity.active?.stream?.content).toBe("answer");
    expect(activity.active?.stream?.display_metrics.phase).toBe("running_tool");
    expect(activity.active?.stream?.process_parts.map((part) => part.part_id)).toEqual(["part-1", "part-2"]);
    expect(activity.active?.stream?.process_parts[1]).toEqual(expect.objectContaining({
      type: "tool",
      tool_step: expect.objectContaining({ result_block: { language: "text", content: "result" } }),
    }));
    // The reader owns this filesystem: a path stays whole, so it reads the same
    // live as in history and an error keeps saying which file it was about.
    expect(activity.active?.stream?.tool_steps[0]?.detail)
      .toBe("/private/var/artifacts/report.json not found");
    // Routing identifiers are still not the renderer's business.
    expect(JSON.stringify(activity)).not.toContain("secret-route");
    // A stream emit's own `files` field is not a delivery channel: only an
    // explicit send_file outbound is eligible for artifact persistence.
    expect(activity.active?.stream).not.toHaveProperty("files");
    h.controller.handleOutbound({
      action: "stream_message",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "secret-route",
      event_id: "event-duplicate-part",
      payload: {
        ...activity.active!.stream!,
        seq: 2,
        process_parts: [
          activity.active!.stream!.process_parts[0],
          { ...activity.active!.stream!.process_parts[1], part_id: "part-1" },
        ],
      } as unknown as JsonObject,
    });
    expect(h.controller.activity("session-1").active?.stream?.seq).toBe(1);
    h.controller.handleOutbound({
      action: "stream_message",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "secret-route",
      event_id: "event-2",
      payload: {
        ...activity.active!.stream!,
        seq: 2,
        display_metrics: { ...activity.active!.stream!.display_metrics, phase: "waiting_vendor" },
      } as unknown as JsonObject,
    });
    expect(h.controller.activity("session-1").active?.stream?.seq).toBe(1);
    h.controller.dispose();
  });

  test("does not retain outbound file paths in conversation activity", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "export the report" });
    h.controller.handleOutbound({
      action: "send_file",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      event_id: "event-1",
      payload: { path: "/tmp/exports/orders.xlsx" },
    });
    expect(JSON.stringify(h.controller.activity("session-1"))).not.toContain("/tmp/exports/orders.xlsx");
    h.controller.dispose();
  });

  test("updates the original live exec card from a UI-only completion event", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "run it" });
    h.controller.handleOutbound({
      action: "stream_message",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      event_id: "event-1",
      payload: {
        state: "final",
        seq: 1,
        content: "done",
        thinking: "",
        redacted_thinking_count: 0,
        thinking_elapsed_ms: 0,
        tool_pending: false,
        tool_elapsed_ms: 250,
        tool_steps: [{
          id: "tool-exec-1", name: "exec", title: "Run command", detail: "sleep",
          icon_token: "setting_outlined", status: "running", duration_ms: 250,
        }],
        process_parts: [{
          type: "tool", part_id: "part-1", sequence: 1,
          tool_step: {
            id: "tool-exec-1", name: "exec", title: "Run command", detail: "sleep",
            icon_token: "setting_outlined", status: "running", duration_ms: 250,
          },
        }],
        display_metrics: {
          status: "completed", phase: "generating_answer", elapsed_ms: 300, model: "model",
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          context_tokens: 1, context_window_tokens: 100,
        },
      },
    });
    h.controller.handleAgentEvent({
      version: AGENT_PROTOCOL_VERSION,
      type: "background_task.changed",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: {
        tool_call_id: "tool-exec-1",
        task: {
          exec_id: "exec_1234abcd", session_id: "session-1", origin_turn_id: "turn-1",
          status: "completed", pid: 1, command: "sleep", cwd: "/work", started_at: 1,
          ended_at: 2, duration_sec: 1, exit_code: 0, truncated: false, output_tail: "finished",
        },
      },
    });
    const stream = h.controller.activity("session-1").active?.stream;
    expect(stream?.tool_steps[0]).toMatchObject({
      status: "success",
      duration_ms: 1_000,
      result_block: { language: "text", content: expect.stringContaining("finished") },
    });
    expect(stream?.process_parts[0]).toMatchObject({
      type: "tool",
      tool_step: { status: "success" },
    });
    expect(stream?.seq).toBe(1);
    h.controller.dispose();
  });

  test("retains an exec completion that arrives before its live card", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "run it" });
    h.controller.handleAgentEvent({
      version: AGENT_PROTOCOL_VERSION,
      type: "background_task.changed",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: {
        tool_call_id: "tool-exec-1",
        task: {
          exec_id: "exec_1234abcd", session_id: "session-1", origin_turn_id: "turn-1",
          status: "completed", pid: 1, command: "true", cwd: "/work", started_at: 1,
          ended_at: 2, duration_sec: 1, exit_code: 0, truncated: false, output_tail: "early",
        },
      },
    });
    h.controller.handleOutbound({
      action: "stream_message",
      platform: "desktop",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      event_id: "event-1",
      payload: {
        state: "final", seq: 1, content: "done", thinking: "", redacted_thinking_count: 0,
        thinking_elapsed_ms: 0, tool_pending: false, tool_elapsed_ms: 250,
        tool_steps: [{
          id: "tool-exec-1", name: "exec", title: "Run command", detail: "true",
          icon_token: "setting_outlined", status: "running", duration_ms: 250,
        }],
        process_parts: [{
          type: "tool", part_id: "part-1", sequence: 1,
          tool_step: {
            id: "tool-exec-1", name: "exec", title: "Run command", detail: "true",
            icon_token: "setting_outlined", status: "running", duration_ms: 250,
          },
        }],
        display_metrics: {
          status: "completed", phase: "generating_answer", elapsed_ms: 300, model: "model",
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          context_tokens: 1, context_window_tokens: 100,
        },
      },
    });
    expect(h.controller.activity("session-1").active?.stream?.tool_steps[0]).toMatchObject({
      status: "success",
      result_block: { content: expect.stringContaining("early") },
    });
    h.controller.dispose();
  });

  test("watermarks the turn as the transcript receives it, regardless of stored text", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "desktop", chat_id: "session-1" },
      workspace: testWorkspace,
    });
    await h.controller.send({ session_id: "session-1", text: "hello" });
    await tick();
    expect(h.controller.activity("session-1").active?.user_persisted_at).toBe(0);

    // The runtime prefixes pending system events onto the stored user message,
    // so persistence is signalled by the event, never by matching text.
    h.controller.handleAgentEvent({
      version: AGENT_PROTOCOL_VERSION,
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages"] },
    });
    const persistedAt = h.controller.activity("session-1").active?.user_persisted_at ?? 0;
    expect(persistedAt).toBeGreaterThan(0);

    h.scheduler.handleRuntimeEvent({
      kind: "runtime.turn.completed",
      run_id: "turn-1",
      payload: { session_id: "session-1", job_id: "turn-1", status: "completed" },
    });
    await tick();
    const latest = h.controller.activity("session-1").latest;
    expect(latest?.user_persisted_at).toBe(persistedAt);
    expect(latest?.settled_at).toBeGreaterThan(persistedAt);
    h.controller.dispose();
  });

  test("leaves the user watermark unset when a queued turn is cancelled before it runs", async () => {
    const h = harness(["turn-1", "message-1", "route-1"]);
    h.storage.sessions.set("session-1", {
      session_id: "session-1",
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace: testWorkspace,
    });
    await h.scheduler.enqueue(externalJob("session-1"));
    await tick();
    await h.controller.send({ session_id: "session-1", text: "never ran" });

    await h.controller.stop("session-1");
    const latest = h.controller.activity("session-1").latest;
    expect(latest?.state).toBe("cancelled");
    expect(latest?.settled_at).toBeGreaterThan(0);
    // Nothing reached the transcript, so the message must stay on screen.
    expect(latest?.user_persisted_at).toBe(0);
    h.controller.dispose();
  });
});

test("client message identity follows acknowledgement, activity and runtime input", async () => {
  const h=harness(["session","turn","message","route"]);
  const result=await h.controller.send({text:"hello",client_message_id:"client"});
  await tick();
  expect(result.client_message_id).toBe("client");
  expect(h.runtime.started[0]?.raw_data.client_message_id).toBe("client");
  expect(JSON.stringify(h.activities)).toContain('"client_message_id":"client"');
});
