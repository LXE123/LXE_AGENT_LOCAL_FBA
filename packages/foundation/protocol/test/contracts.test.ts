import { describe, expect, test } from "bun:test";

import invalidAgentJobShape from "../fixtures/invalid-agent-job-shape.json";
import validAgentJob from "../fixtures/valid-agent-job.json";
import validEmitRequest from "../fixtures/valid-emit-request.json";
async function loadProtocol() {
  return import("../src/index");
}

describe("protocol contracts", () => {
  test("accepts every valid cross-language fixture", async () => {
    const { validateAgentJob, validateEmitRequest } = await loadProtocol();

    expect(validateAgentJob(validAgentJob)).toBe(true);
    const retiredField = ["server", "scope"].join("_");
    expect(validateAgentJob({
      ...validAgentJob,
      workspace: { ...validAgentJob.workspace, [retiredField]: "local" },
    })).toBe(false);
    expect(validateEmitRequest(validEmitRequest)).toBe(true);
    expect(validateEmitRequest({ ...validEmitRequest, turn_id: "" })).toBe(false);
  });

  test("rejects a payload with the wrong field shape", async () => {
    const { validateAgentJob } = await loadProtocol();

    expect(validateAgentJob(invalidAgentJobShape)).toBe(false);
  });

  test("strictly validates operation diagnostics", async () => {
    const { validateAgentJob } = await loadProtocol();
    const diagnostic = {
      type: "operation_failure",
      provider: "feishu",
      operation: "quote_lookup",
      stage: "lookup",
      error_name: "FeishuApiHttpError",
      observed_error: "Feishu API GET failed: HTTP 400",
      redacted: false,
      truncated: false,
      cause_known: false,
      http_status: 400,
    };
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [diagnostic] })).toBe(true);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, unexpected: true }] })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, observed_error: "x".repeat(4_001) }] })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: Array.from({ length: 17 }, () => diagnostic) })).toBe(false);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, provider_code: Number.MAX_SAFE_INTEGER + 1 }],
    })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, cause_known: true }] })).toBe(false);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, cause_known: true, verified_reason: "fixed_provider_code" }],
    })).toBe(true);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, verified_reason: "not_allowed_without_known_cause" }],
    })).toBe(false);
  });

  test("enforces the final-answer stream discriminant", async () => {
    const { validateEmitRequest } = await loadProtocol();
    const stream = {
      ...validEmitRequest,
      emit_kind: "stream",
      stream_type: "final_answer",
      state: "delta",
      seq: 1,
    };
    expect(validateEmitRequest(stream)).toBe(true);
    for (const context_source of ["estimated", "usage_calibrated", "unknown", null]) {
      expect(validateEmitRequest({
        ...stream,
        display_metrics: { ...stream.display_metrics, context_source },
      })).toBe(context_source === "estimated" || context_source === "usage_calibrated");
    }
    expect(validateEmitRequest({ ...stream, stream_type: "content_block_delta" })).toBe(false);
    expect(validateEmitRequest({ ...stream, state: "running" })).toBe(false);
    expect(validateEmitRequest({ ...stream, seq: 0 })).toBe(false);
    expect(validateEmitRequest({ ...stream, process_parts: undefined })).toBe(false);
    expect(validateEmitRequest({
      ...stream,
      process_parts: [{ ...stream.process_parts[0], sequence: 0 }],
    })).toBe(false);
    expect(validateEmitRequest({
      ...stream,
      process_parts: [{ ...stream.process_parts[0], status: "waiting" }],
    })).toBe(false);
    expect(validateEmitRequest({
      ...stream,
      display_metrics: { ...stream.display_metrics, phase: "waiting_model" },
    })).toBe(true);
    const { phase: _phase, ...metricsWithoutPhase } = stream.display_metrics;
    expect(validateEmitRequest({ ...stream, display_metrics: metricsWithoutPhase })).toBe(false);
    expect(validateEmitRequest({
      ...stream,
      display_metrics: { ...stream.display_metrics, phase: "waiting_vendor" },
    })).toBe(false);

    const { display_metrics: _displayMetrics, process_parts: _processParts, ...base } = stream;
    const final = { ...base, emit_kind: "final", stream_type: "", state: "", seq: 0 };
    expect(validateEmitRequest(final)).toBe(true);
    expect(validateEmitRequest({ ...final, process_parts: [] })).toBe(false);
    expect(validateEmitRequest({ ...final, display_metrics: validEmitRequest.display_metrics })).toBe(false);
    expect(validateEmitRequest({ ...final, stream_type: "final_answer", state: "final", seq: 1 })).toBe(false);
  });

  test("strictly validates desktop stream mutation batches", async () => {
    const { validateDesktopStreamBatchRequest } = await loadProtocol();
    const batch = {
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
      mutations: [
        { kind: "part_updated", part: validEmitRequest.process_parts[0] },
        { kind: "part_delta", part_id: "part-thinking", field: "text", delta: "hello" },
        { kind: "stream_updated", state: "delta", display_metrics: validEmitRequest.display_metrics },
      ],
    };
    expect(validateDesktopStreamBatchRequest(batch)).toBe(true);
    expect(validateDesktopStreamBatchRequest({ ...batch, response_route_id: "" })).toBe(false);
    expect(validateDesktopStreamBatchRequest({ ...batch, seq: 0 })).toBe(false);
    expect(validateDesktopStreamBatchRequest({ ...batch, mutations: [] })).toBe(false);
    expect(validateDesktopStreamBatchRequest({
      ...batch,
      mutations: [{ kind: "part_delta", part_id: "part-thinking", field: "content", delta: "x" }],
    })).toBe(false);
    expect(validateDesktopStreamBatchRequest({
      ...batch,
      mutations: [{ kind: "part_delta", part_id: "part-thinking", field: "text", delta: "" }],
    })).toBe(false);
  });

  test("allows an empty heartbeat message id but keeps normal turns strict", async () => {
    const { validateAgentJob } = await loadProtocol();
    const heartbeat = {
      ...validAgentJob,
      job_id: "heartbeat-1",
      job_kind: "heartbeat",
      message_id: "",
      user_input: "",
    };
    expect(validateAgentJob(heartbeat)).toBe(true);
    expect(validateAgentJob({ ...heartbeat, job_kind: "turn" })).toBe(false);
  });
});
