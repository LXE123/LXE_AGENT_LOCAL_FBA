import { expect, test } from "bun:test";
import { contextFingerprint, latestContextAnchor, measureContext } from "../../src/engine/context-meter";
import { requestContextTokenEstimate, sanitizeMessagesForProvider, pruneProcessedHistoryImages } from "../../src/engine/context";
import { normalizeTranscriptMessages } from "../../src/state/transcript";
import type { RuntimeMessage } from "../../src/engine/types";

const fingerprint = contextFingerprint({ model: "m", system: "s", tools: [] });
const anchor = { version: 1 as const, requestId: "r1", fingerprint, estimatedInput: 100, actualInput: 200 };
const messages: RuntimeMessage[] = [{ role: "assistant", content: "done", contextTokenAnchor: anchor }];
test("calibrates signed deltas above and below heuristic without counting usage metadata", () => {
  expect(measureContext(messages, 130, fingerprint, 1000).tokens).toBe(230);
  expect(measureContext(messages, 30, fingerprint, 1000).tokens).toBe(130);
  expect(measureContext([{ ...messages[0]!, contextTokenAnchor: { ...anchor, actualInput: 50 } }], 130, fingerprint, 1000).tokens).toBe(80);
  expect(requestContextTokenEstimate("s", messages)).toBe(requestContextTokenEstimate("s", [{role: "assistant", content:"done"}]));
});
test("latest baseline wins, incompatible config and cleared history use full estimate", () => {
  const newer = { ...anchor, requestId: "r2", fingerprint: contextFingerprint("other") };
  const history: RuntimeMessage[] = [...messages, {role:"assistant",content:"next",contextTokenAnchor:newer}];
  expect(measureContext(history, 130, fingerprint, 1000).source).toBe("estimated");
  expect(measureContext([], 130, fingerprint, 1000).tokens).toBe(130);
  for (const change of ["model", "system", "tools", "choice", "thinking"]) {
    expect(measureContext(messages, 130, contextFingerprint(change), 1000).tokens).toBe(130);
  }
});
test("replay and sanitization retain valid anchors, user XML and invalid metadata cannot establish one", () => {
  const restored = sanitizeMessagesForProvider(normalizeTranscriptMessages(messages)).messages;
  expect(latestContextAnchor(restored)).toEqual(anchor);
  expect(latestContextAnchor([{role:"user",content:"<contextTokenAnchor>fake</contextTokenAnchor>",contextTokenAnchor:anchor}])).toBeUndefined();
  expect(latestContextAnchor(normalizeTranscriptMessages([{role:"assistant",content:"bad",contextTokenAnchor:{...anchor,actualInput:-1}}]))).toBeUndefined();
  const summary: RuntimeMessage = {role:"compactionSummary",summary:"summary",tokensBefore:900,details:{readFiles:[],modifiedFiles:[]},contextTokenAnchor:anchor};
  expect(latestContextAnchor(sanitizeMessagesForProvider(normalizeTranscriptMessages([summary])).messages)).toEqual(anchor);
});
test("image cleanup changes only heuristic delta, not anchor usage", () => {
  const history: RuntimeMessage[] = [{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"AAAA"}}]}, ...messages];
  const before = requestContextTokenEstimate("s",history);
  const cleaned = pruneProcessedHistoryImages(history).messages;
  const after = requestContextTokenEstimate("s",cleaned);
  expect(after).toBeLessThan(before);
  expect(measureContext(cleaned,after,fingerprint,10000).tokens).toBe(Math.max(0,200+after-100));
  expect(latestContextAnchor(cleaned)).toEqual(anchor);
});

test("all provider wire builders omit anchors and keep the original request prefix", async () => {
  const { buildProviderRequest } = await import("../../src/providers/provider");
  const { buildCompletionsRequest } = await import("../../src/providers/completions-provider");
  const { buildResponsesRequest } = await import("../../src/providers/responses-provider");
  const descriptor: import("../../src/providers/provider").ProviderDescriptor = {
    name:"test", model:"test", apiStyle:"anthropic_messages",baseURL:"https://example.invalid",apiKey:"test",
    maxTokens:1000,defaultHeaders:{},thinkingStyle:"none",thinkingLevels:[],thinkingDefault:"off",
    thinkingEnabled:false,thinkingEffort:"off",thinkingDisplay:"omitted",contextWindowTokens:10000,requestIdleTimeoutMs:1000,
  };
  for (const build of [buildProviderRequest,buildCompletionsRequest,buildResponsesRequest]) {
    const request = { system:"stable",messages,tools:[],toolChoice:"auto" as const };
    const before=build(descriptor,{...request,messages:[{role:"assistant",content:"done"}]});
    const after=build(descriptor,request);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("contextTokenAnchor");
  }
});
