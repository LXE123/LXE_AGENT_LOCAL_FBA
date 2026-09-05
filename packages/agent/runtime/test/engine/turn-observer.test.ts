import { messageFixture, eventFixture } from "../message-fixtures";
import { describe, expect, test } from "bun:test";
import { createLogger } from "@lxe/core";
import { RuntimeTurnObserver } from "../../src/engine/turn-observer";

const recordsFrom = (lines: string[]): Array<Record<string, unknown>> => lines.map((line) => JSON.parse(line));

describe("RuntimeTurnObserver", () => {
  test("emits one correlated lifecycle with provider heartbeat and tool metrics", () => {
    const lines: string[] = [];
    let now = 1_000;
    const observer = new RuntimeTurnObserver({
      logger: createLogger("runtime.turn", { write: (line) => lines.push(line) }),
      now: () => now,
    });
    observer.start({
      jobKind: "turn", provider: "anthropic", model: "model", messageTurns: 2,
      systemTokens: 10, messageTokens: 20, contextCapacity: 100, pendingEventCount: 1,
    });
    observer.context({ beforeTokens: 30, afterTokens: 25, compacted: true, compactedCount: 2 });
    const attempt = observer.providerAttempt(1, 1, "anthropic", "model");
    now += 1_000;
    attempt.stream(eventFixture("text_delta", "text-1", "secret reply"));
    attempt.succeed(messageFixture({
      content: [{ type: "tool_call", id: "tool-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
      usage: { input_tokens: 4, output_tokens: 2 },
    }));
    observer.toolStarted(1, "read", "tool-1");
    observer.toolCompleted(1, "read", "tool-1", "success", 15);
    now += 25;
    observer.complete({ status: "completed", inputTokens: 4, outputTokens: 2, toolCalls: 1, apiCalls: 1 });
    observer.complete({ status: "error", inputTokens: 0, outputTokens: 0, toolCalls: 0, apiCalls: 0 });

    const records = recordsFrom(lines);
    expect(records.filter((record) => record.message === "turn_started")).toHaveLength(1);
    expect(records.filter((record) => record.message === "turn_completed")).toHaveLength(1);
    expect(records).toContainEqual(expect.objectContaining({
      message: "provider_stream_heartbeat", event_count: 1, text_chars: 12,
    }));
    expect(records).toContainEqual(expect.objectContaining({
      message: "provider_attempt_completed", tool_use_count: 1,
    }));
    expect(records).toContainEqual(expect.objectContaining({
      message: "tool_started", tool: "read", tool_use_id: "tool-1",
    }));
    expect(records).toContainEqual(expect.objectContaining({
      message: "tool_completed", tool: "read", status: "success", duration_ms: 15,
    }));
    expect(records).toContainEqual(expect.objectContaining({
      message: "turn_completed", status: "completed", context_delta_tokens: -5, compacted: true,
    }));
    expect(lines.join("\n")).not.toContain("secret reply");
  });

  test("uses error only for the terminal error event", () => {
    const lines: string[] = [];
    const observer = new RuntimeTurnObserver({
      logger: createLogger("runtime.turn", { write: (line) => lines.push(line) }),
      now: () => 1,
    });
    observer.start({
      jobKind: "turn", provider: "custom", model: "", messageTurns: 1,
      systemTokens: 1, messageTokens: 1, contextCapacity: 10, pendingEventCount: 0,
    });
    observer.complete({ status: "error", inputTokens: 0, outputTokens: 0, toolCalls: 0, apiCalls: 0, error: new Error("boom") });
    expect(recordsFrom(lines).at(-1)).toEqual(expect.objectContaining({
      level: "error", message: "turn_completed", status: "error",
    }));
  });
});
