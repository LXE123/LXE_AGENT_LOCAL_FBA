import { messageFixture, eventFixture } from "../message-fixtures";
import { describe, expect, test } from "bun:test";
import type { DesktopStreamBatchRequest, EmitRequest } from "@lxe/protocol";
import { FinalAnswerStreamer } from "../../src/engine/final-answer-streamer";

describe("FinalAnswerStreamer display contract", () => {
  test("coalesces desktop text deltas into one lightweight frame and reconciles at terminal", async () => {
    const emitted: EmitRequest[] = [];
    const batches: DesktopStreamBatchRequest[] = [];
    let release: (() => void) | undefined;
    const streamer = new FinalAnswerStreamer({
      sessionId: "session-1",
      turnId: "turn-1",
      responseRouteId: "route-1",
      emitId: "emit-1",
      desktopBatchIntervalMs: 16,
      delay: () => new Promise<void>((resolve) => { release = resolve; }),
      emitDesktopBatch: async (batch) => { batches.push(batch); return true; },
      emit: async (request) => { emitted.push(request); return true; },
    });

    for (let index = 0; index < 10_000; index += 1) {
      await streamer.pushEvent(eventFixture("text_delta", "text-1", "x"));
    }
    expect(batches).toHaveLength(0);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.mutations.filter((mutation) => mutation.kind === "part_delta")).toEqual([{
      kind: "part_delta",
      part_id: "text-1:0",
      field: "text",
      delta: "x".repeat(10_000),
    }]);
    expect(JSON.stringify(batches[0])).not.toContain("process_parts");
    expect(await streamer.finish("x".repeat(10_000))).toBe(true);
    const terminal = emitted.at(-1);
    expect(terminal?.emit_kind).toBe("stream");
    if (terminal?.emit_kind !== "stream") throw new Error("terminal stream frame expected");
    expect(terminal.seq).toBe((batches.at(-1)?.seq ?? 0) + 1);
    expect(terminal.process_parts[0]).toEqual(expect.objectContaining({ text: "x".repeat(10_000) }));
  });
  test("tracks overlapping tool timers independently", async () => {
    let clock = 1_000;
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-parallel",
      responseRouteId: "r1",
      minIntervalMs: 0,
      now: () => clock,
      emit: async (request) => { emitted.push(request); return true; },
    });
    const first = { type: "tool_call" as const, id: "tool-a", name: "exec", arguments: {} };
    const second = { type: "tool_call" as const, id: "tool-b", name: "exec", arguments: {} };

    await streamer.pushToolStart(first);
    clock += 100;
    await streamer.pushToolStart(second);
    clock += 200;
    await Promise.resolve();
    await Promise.resolve();
    const inFlight = emitted.at(-1);
    expect(inFlight?.tool_steps).toEqual([
      expect.objectContaining({ id: "tool-a", status: "running" }),
      expect.objectContaining({ id: "tool-b", status: "running" }),
    ]);
    expect(inFlight?.tool_elapsed_ms).toBe(500);

    await streamer.pushToolFinish(first, "success", 300);
    clock += 100;
    await streamer.pushToolFinish(second, "success", 300);
    expect(await streamer.finish("done")).toBe(true);
    expect(emitted.at(-1)?.tool_elapsed_ms).toBe(600);
  });
  test("finalizes overlapping active tools with their own elapsed durations", async () => {
    let clock = 1_000;
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-cancel-parallel",
      responseRouteId: "r1",
      minIntervalMs: 0,
      now: () => clock,
      emit: async (request) => { emitted.push(request); return true; },
    });
    await streamer.pushToolStart({ type: "tool_call", id: "tool-a", name: "exec", arguments: {} });
    clock += 100;
    await streamer.pushToolStart({ type: "tool_call", id: "tool-b", name: "wait", arguments: {} });
    clock += 200;

    expect(await streamer.finish("done")).toBe(true);
    expect(emitted.at(-1)?.tool_elapsed_ms).toBe(500);
    expect(emitted.at(-1)?.tool_steps).toEqual([
      expect.objectContaining({ id: "tool-a", status: "error", duration_ms: 300 }),
      expect.objectContaining({ id: "tool-b", status: "error", duration_ms: 200 }),
    ]);
  });
  test("emits redacted counts, cumulative metrics, sanitized tool output and one terminal frame", async () => {
    let clock = 1_000;
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-1",
      responseRouteId: "r1",
      emitId: "emit-1",
      minIntervalMs: 0,
      now: () => clock,
      model: "model-1",
      contextWindowTokens: 200_000,
      toolUseMode: "full",
      showFullPaths: false,
      emit: async (request) => { emitted.push(request); return true; },
    });

    await streamer.pushEvent(eventFixture("thinking_delta", "thinking-1", "checking"));
    await streamer.pushEvent(eventFixture("thinking_start", "redacted-1", "", true));
    clock += 3_200;
    await streamer.pushEvent(eventFixture("text_delta", "text-1", "done"));
    streamer.updateUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
    });
    await streamer.updateContext({ tokens: 112, estimatedTokens: 90, source: "usage_calibrated", contextWindowTokens: 200_000 });
    const commandSecret = "command-secret";
    const outputSecret = "output-secret";
    const call = {
      type: "tool_call" as const,
      id: "tool-1",
      name: "exec",
      arguments: { command: `run C:\\Users\\Alice\\command.txt --token=${commandSecret}` },
    };
    await streamer.pushToolStart(call);
    await streamer.pushToolFinish(call, "success", 1_400, {
      result: { path: "C:\\Users\\Alice\\result.json", token: outputSecret, output: "x".repeat(5_000) },
    });
    const failedCall = {
      ...call,
      id: "tool-2",
      arguments: { command: "curl https://user:pass@example.test/private?token=second-command-secret" },
    };
    await streamer.pushToolStart(failedCall);
    await streamer.pushToolFinish(failedCall, "error", 600, {
      error: `failed at C:\\Users\\Alice\\private.log token=${outputSecret} ${"e".repeat(2_500)}`,
    });
    clock += 1_400;
    expect(await streamer.finish("done")).toBe(true);

    const terminal = emitted.at(-1);
    expect(terminal?.emit_kind).toBe("stream");
    if (terminal?.emit_kind !== "stream") throw new Error("terminal stream frame expected");
    expect(terminal.state).toBe("final");
    expect(terminal.thinking).toBe("checking");
    expect(terminal.redacted_thinking_count).toBe(1);
    expect(terminal.display_metrics).toEqual(expect.objectContaining({
      status: "completed",
      phase: "generating_answer",
      elapsed_ms: 4_600,
      model: "model-1",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
      context_tokens: 112,
      context_window_tokens: 200_000,
    }));
    expect(terminal.tool_steps[0]).toEqual(expect.objectContaining({
      icon_token: "setting_outlined",
      status: "success",
      detail: call.arguments.command,
    }));
    expect(terminal.tool_steps[1]?.detail).toBe(failedCall.arguments.command);
    const serialized = JSON.stringify(terminal);
    expect(serialized).toContain(commandSecret);
    expect(serialized).toContain("second-command-secret");
    expect(terminal.tool_steps[0]?.result_block?.content).not.toContain(outputSecret);
    expect(terminal.tool_steps[0]?.result_block?.content).not.toContain("C:\\Users\\Alice\\result.json");
    expect(terminal.tool_steps[1]?.error_block?.content).not.toContain(outputSecret);
    expect(terminal.tool_steps[1]?.error_block?.content).not.toContain("C:\\Users\\Alice\\private.log");
    expect(serialized).not.toContain("encrypted");
    expect(terminal.tool_steps[0]?.result_block?.content.length).toBeLessThanOrEqual(4_000);
    expect(terminal.tool_steps[1]?.error_block?.content.length).toBeLessThanOrEqual(2_000);
    expect(emitted.map((frame) => frame.seq)).toEqual(emitted.map((_, index) => index + 1));
    expect(emitted.every((frame) => frame.turn_id === "turn-1")).toBe(true);
  });

  test("reports explicit context, provider, thinking, answer and tool phases", async () => {
    const emitted: EmitRequest[] = [];
    const flush = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-1",
      responseRouteId: "r1",
      minIntervalMs: 0,
      emit: async (request) => { emitted.push(request); return true; },
    });

    await streamer.startPreparingContext();
    await flush();
    expect(emitted.at(-1)?.display_metrics?.phase).toBe("preparing_context");
    await streamer.startWaitingModel();
    await flush();
    expect(emitted.at(-1)?.display_metrics?.phase).toBe("waiting_model");
    await streamer.pushEvent(eventFixture("thinking_delta", "thinking-1", "checking"));
    await flush();
    expect(emitted.at(-1)?.display_metrics?.phase).toBe("thinking");
    await streamer.pushEvent(eventFixture("text_delta", "text-1", "answer"));
    await flush();
    expect(emitted.at(-1)?.display_metrics?.phase).toBe("generating_answer");
    await streamer.pushToolStart({ type: "tool_call", id: "tool-1", name: "read", arguments: {} });
    await flush();
    expect(emitted.at(-1)?.display_metrics?.phase).toBe("running_tool");
  });

  test("keeps thinking, tools and narration in one stable ordered part sequence", async () => {
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-ordered",
      responseRouteId: "r1",
      minIntervalMs: 0,
      toolUseMode: "full",
      emit: async (request) => { emitted.push(request); return true; },
    });
    const firstTool = { type: "tool_call" as const, id: "tool-1", name: "read", arguments: { path: "a.txt" } };
    const secondTool = { type: "tool_call" as const, id: "tool-2", name: "exec", arguments: { command: "bun test" } };

    await streamer.startWaitingModel();
    await streamer.pushEvent(eventFixture("thinking_start", "thinking-1", ""));
    await streamer.pushEvent(eventFixture("thinking_delta", "thinking-1", "inspect"));
    await streamer.pushEvent(eventFixture("thinking_end", "thinking-1", ""));
    streamer.completeModelResponse("", false);
    await streamer.pushToolStart(firstTool);
    await streamer.pushToolFinish(firstTool, "success", 10, { result: "read ok" });

    await streamer.startWaitingModel();
    await streamer.pushEvent(eventFixture("text_start", "narration-1", ""));
    await streamer.pushEvent(eventFixture("text_delta", "narration-1", "run tests"));
    await streamer.pushEvent(eventFixture("text_end", "narration-1", ""));
    streamer.completeModelResponse("run tests", false);
    await streamer.pushToolStart(secondTool);
    await streamer.pushToolFinish(secondTool, "error", 20, { error: "test failed" });

    await streamer.startWaitingModel();
    await streamer.pushEvent(eventFixture("thinking_start", "thinking-2", ""));
    await streamer.pushEvent(eventFixture("thinking_delta", "thinking-2", "summarize"));
    await streamer.pushEvent(eventFixture("thinking_end", "thinking-2", ""));
    await streamer.pushEvent(eventFixture("text_start", "answer-1", ""));
    await streamer.pushEvent(eventFixture("text_delta", "answer-1", "finished"));
    await streamer.pushEvent(eventFixture("text_end", "answer-1", ""));
    streamer.completeModelResponse("finished", true);
    expect(await streamer.finish("finished")).toBe(true);

    const terminal = emitted.at(-1);
    if (terminal?.emit_kind !== "stream") throw new Error("terminal stream frame expected");
    expect(terminal.process_parts.map((part) => part.type)).toEqual([
      "thinking", "tool", "text", "tool", "thinking", "text",
    ]);
    expect(terminal.process_parts.map((part) => part.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(terminal.process_parts[0]).toEqual(expect.objectContaining({ part_id: "thinking-1:0", text: "inspect" }));
    expect(terminal.process_parts[1]).toEqual(expect.objectContaining({
      type: "tool",
      tool_step: expect.objectContaining({ id: "tool-1", status: "success" }),
    }));
    expect(terminal.process_parts[2]).toEqual(expect.objectContaining({ presentation: "process", text: "run tests" }));
    expect(terminal.process_parts[3]).toEqual(expect.objectContaining({
      type: "tool",
      tool_step: expect.objectContaining({ id: "tool-2", status: "error" }),
    }));
    expect(terminal.process_parts[5]).toEqual(expect.objectContaining({ presentation: "final", text: "finished" }));
  });

  test("reports cancelled without creating a stream when no frame was delivered", async () => {
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-1",
      responseRouteId: "r1",
      toolUseMode: "off",
      minIntervalMs: 0,
      emit: async (request) => { emitted.push(request); return true; },
    });
    expect(await streamer.cancel()).toBe(false);
    expect(emitted).toEqual([]);
  });

  test("reports a failed terminal frame even after an earlier delta was delivered", async () => {
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-1",
      responseRouteId: "r1",
      minIntervalMs: 0,
      emit: async (request) => {
        emitted.push(request);
        return request.state !== "final";
      },
    });
    await streamer.pushEvent(eventFixture("text_delta", "text-1", "partial"));
    expect(await streamer.finish("complete")).toBe(false);
    expect(emitted.some((frame) => frame.state === "delta")).toBe(true);
    expect(emitted.at(-1)?.state).toBe("final");
  });

  test("does not project internal tool input events into the display stream", async () => {
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      turnId: "turn-1",
      responseRouteId: "r1",
      minIntervalMs: 0,
      emit: async (request) => { emitted.push(request); return true; },
    });

    await streamer.pushEvent(eventFixture("toolcall_start", "call-1"));
    await streamer.pushEvent(eventFixture("toolcall_delta", "call-1", '{"path":"a"}'));
    await streamer.pushEvent({ type: "toolcall_end", contentIndex: 0, partial: messageFixture(),
      toolCall: { type: "tool_call", id: "call-1", name: "read", arguments: { path: "a" } } });
    await streamer.finish("");

    expect(emitted.at(-1)?.process_parts).toEqual([]);
    expect(emitted.at(-1)?.redacted_thinking_count).toBe(0);
  });
});

test("summary accounting cannot change occupancy and terminal maintenance keeps completed state", async () => {
  const emitted: EmitRequest[] = [];
  const streamer = new FinalAnswerStreamer({
    sessionId:"s",turnId:"t",responseRouteId:"r",emitId:"e",
    emit: async request => { emitted.push(request); return true; },
  });
  await streamer.updateContext({tokens:1000,estimatedTokens:900,source:"usage_calibrated",contextWindowTokens:10000});
  await streamer.finish("done");
  streamer.updateUsage({input_tokens:5000,output_tokens:200});
  await streamer.updateContext({tokens:300,estimatedTokens:200,source:"usage_calibrated",contextWindowTokens:10000});
  const last=emitted.at(-1);
  if(last?.emit_kind!=="stream") throw new Error("missing frame");
  expect(last.state).toBe("final");
  expect(last.content).toBe("done");
  expect(last.display_metrics).toMatchObject({status:"completed",context_tokens:300,input_tokens:5000,output_tokens:200});
  const count=emitted.length;
  await streamer.updateContext({tokens:300,estimatedTokens:200,source:"usage_calibrated",contextWindowTokens:10000});
  expect(emitted).toHaveLength(count);
});
