import { describe, expect, test } from "bun:test";
import { type AgentEvent, type DesktopDashboardInvalidation } from "@lxe/desktop-protocol";

import {
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
  dashboardInvalidationForAgentEvent,
} from "../src/main/dashboard-invalidation";

const lifecycleEvent = (
  type: "thread.started" | "turn.started" | "turn.completed" | "turn.failed",
): AgentEvent => ({

  type,
  thread_id: "session-1",
  ...(type === "thread.started" ? {} : { turn_id: "turn-1" }),
  payload: {},
} as AgentEvent);

const sessionChanged = (changes: Array<"messages" | "usage" | "artifacts"> = ["messages"]): AgentEvent => ({

  type: "session.changed",
  thread_id: "session-1",
  payload: { changes },
});

const itemCompleted = (
  emitKind: "stream" | "final" | "tool" | "progress",
  state: "delta" | "final" | "error" | "" = "",
): AgentEvent => ({

  type: "item.completed",
  thread_id: "session-1",
  turn_id: "turn-1",
  payload: {
    session_id: "session-1",
    turn_id: "turn-1",
    response_route_id: "route-1",
    content: "secret",
    thinking: "",
    redacted_thinking_count: 0,
    thinking_elapsed_ms: 0,
    tool_pending: false,
    tool_elapsed_ms: 0,
    tool_steps: [],
    emit_id: "emit-1",
    ...(emitKind === "stream"
      ? {
          emit_kind: "stream" as const,
          stream_type: "final_answer" as const,
          state: state as "delta" | "final" | "error",
          seq: 1,
          process_parts: [],
          display_metrics: {
            status: "running" as const,
            phase: "generating_answer" as const,
            elapsed_ms: 1,
            model: "test",
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            context_tokens: 0,
            context_window_tokens: 1,
          },
        }
      : { emit_kind: emitKind, stream_type: "" as const, state: "" as const, seq: 0 as const }),
  },
} as AgentEvent);

describe("Dashboard invalidation bridge", () => {
  test("maps runtime events to the minimum data domains", () => {
    expect(dashboardInvalidationForAgentEvent(sessionChanged(["messages", "usage", "artifacts"]))).toEqual({
      domains: ["sessions"],
      sessionIds: ["session-1"],
    });
    expect(dashboardInvalidationForAgentEvent(lifecycleEvent("turn.completed"))).toEqual({
      domains: ["stats"],
      sessionIds: [],
    });
    expect(dashboardInvalidationForAgentEvent(lifecycleEvent("turn.failed"))).toEqual({
      domains: ["stats"],
      sessionIds: [],
    });
    expect(dashboardInvalidationForAgentEvent(lifecycleEvent("thread.started"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(lifecycleEvent("turn.started"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent({

      type: "background_task.changed",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload: {
        tool_call_id: "tool-1",
        task: {
          exec_id: "exec_1234abcd", session_id: "session-1", origin_turn_id: "turn-1",
          status: "completed", pid: 1, command: "echo ok", cwd: "/work", started_at: 1,
          ended_at: 2, duration_sec: 1, exit_code: 0, truncated: false, output_tail: "ok",
        },
      },
    })).toEqual({ domains: ["sessions"], sessionIds: ["session-1"] });
  });

  test("never derives session invalidation from outbound item events", () => {
    expect(dashboardInvalidationForAgentEvent(itemCompleted("stream", "delta"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(itemCompleted("stream", "final"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(itemCompleted("stream", "error"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(itemCompleted("final"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(itemCompleted("tool"))).toBeUndefined();
    expect(dashboardInvalidationForAgentEvent(itemCompleted("progress"))).toBeUndefined();
  });

  test("maps successful mutation operations to their related domains", () => {
    expect(dashboardDomainsForMutation("models.update")).toEqual(["models"]);
    expect(dashboardDomainsForMutation("models.thinking.update")).toEqual(["models"]);
    expect(dashboardDomainsForMutation("connectors.update")).toEqual(["connectors", "skills"]);
    expect(dashboardDomainsForMutation("mcp.servers.update")).toEqual(["tools"]);
    expect(dashboardDomainsForMutation("sessions.send")).toEqual(["sessions"]);
    expect(dashboardDomainsForMutation("sessions.stop")).toEqual(["sessions"]);
    expect(dashboardDomainsForMutation("sessions.pin")).toEqual(["sessions"]);
    expect(dashboardDomainsForMutation("sessions.delete")).toEqual(["sessions"]);
    expect(dashboardDomainsForMutation("sessions.activity")).toEqual([]);
    expect(dashboardDomainsForMutation("sessions.list")).toEqual([]);
  });

  test("coalesces events for two seconds and preserves a trailing window", () => {
    const published: DesktopDashboardInvalidation[] = [];
    let callback: (() => void) | undefined;
    let delay = 0;
    const batcher = new DashboardInvalidationBatcher(
      (invalidation) => published.push(invalidation),
      2_000,
      ((next, timeout) => {
        callback = next;
        delay = timeout;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      () => undefined,
    );

    batcher.push(["sessions"], ["session-1"]);
    batcher.push(["stats", "sessions"], ["session-1", "session-2"]);
    expect(delay).toBe(2_000);
    expect(published).toEqual([]);
    callback?.();

    expect(published).toEqual([{
      revision: 1,
      domains: ["sessions", "stats"],
      session_ids: ["session-1", "session-2"],
    }]);
    const wire = JSON.stringify(published[0]);
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("password");
    expect(wire).not.toContain("path");

    batcher.push(["sessions"], ["session-3"]);
    expect(published).toHaveLength(1);
    expect(delay).toBe(2_000);
    callback?.();
    expect(published[1]).toEqual({
      revision: 2,
      domains: ["sessions"],
      session_ids: ["session-3"],
    });
  });
});
