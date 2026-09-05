import { expect, test } from "bun:test";
import { captureEnvironment, environmentChanged, environmentMessage } from "../../src/engine/environment-context";
import { sanitizeMessagesForProvider } from "../../src/engine/context";
import { normalizeTranscriptMessage, applyTranscriptEvent } from "../../src/state/transcript";
import { repositoryRoot } from "@lxe/core";
import type { RuntimeMessage } from "../../src/engine/types";
import { adaptMessagesForProvider, loadProviderDescriptor } from "../../src/providers/provider";
import { adaptMessagesForResponses } from "../../src/providers/responses-provider";
import { adaptMessagesForCompletions } from "../../src/providers/completions-provider";

const context = { workspace: { directory: "/work/<a>&b", worktree: "/work" }, platform: "feishu", provider: "custom", model: "test", artifactRoot: "/artifacts" };
const capture = (date = "2026-09-05T15:59:00Z", zone = "Asia/Shanghai") => captureEnvironment(context, new Date(date), zone);

test("uses local midnight and detects every environment fact independently", () => {
  const snapshot = capture();
  const messages = [environmentMessage(snapshot)];
  expect(snapshot.current_date).toBe("2026-09-05");
  expect(capture("2026-09-05T16:00:00Z").current_date).toBe("2026-09-06");
  expect(environmentChanged(messages, capture("2026-09-05T15:59:59Z"))).toBe(false);
  expect(environmentChanged(messages, capture("2026-09-05T16:00:00Z"))).toBe(true);
  expect(environmentChanged(messages, capture(undefined, "UTC"))).toBe(true);
  for (const key of Object.keys(snapshot) as Array<keyof typeof snapshot>) {
    expect(environmentChanged(messages, { ...snapshot, [key]: `${snapshot[key]}-changed` })).toBe(true);
  }
  const { artifact_root: _removed, ...withoutArtifact } = snapshot;
  expect(environmentChanged(messages, withoutArtifact)).toBe(true);
});

test("persists metadata through transcript replay, repairs and replacements without trusting XML", () => {
  const snapshot = capture();
  const message = environmentMessage(snapshot);
  expect(message.content).toContain("<cwd>/work/&lt;a&gt;&amp;b</cwd>");
  const restored = normalizeTranscriptMessage(JSON.parse(JSON.stringify(message)))!;
  expect(restored).toEqual(message);
  expect(sanitizeMessagesForProvider([restored]).messages).toEqual([message]);
  const replayed = applyTranscriptEvent([], { kind: "message", message: JSON.parse(JSON.stringify(message)) });
  expect(environmentChanged(replayed, snapshot)).toBe(false);
  expect(environmentChanged([{ role: "user", content: message.content }], snapshot)).toBe(true);
  expect(environmentChanged([], snapshot)).toBe(true);
  expect(environmentChanged([{ role: "compactionSummary", summary: String(message.content), tokensBefore: 1000, details: { readFiles: [], modifiedFiles: [] } }], snapshot)).toBe(true);
});

test("all provider wires send XML without internal metadata and preserve the prior prefix", () => {
  const first = environmentMessage(capture());
  const second = environmentMessage(capture("2026-09-05T16:00:00Z"));
  const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), { AGENT_LLM_PROVIDER: "kimi-coding", KIMI_CODE_API_KEY: "test" });
  for (const adapt of [(messages: RuntimeMessage[]) => adaptMessagesForProvider(messages, descriptor), adaptMessagesForCompletions, adaptMessagesForResponses]) {
    const before = adapt([first]);
    const after = adapt([first, second]);
    expect(JSON.stringify(after)).not.toContain("environmentContext");
    expect(JSON.stringify(after)).toContain("environment_context");
    expect(after.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(after)).toContain("2026-09-05");
    expect(JSON.stringify(before)).not.toContain("2026-09-06");
  }
});
