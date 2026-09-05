import { platform, release } from "node:os";
import type { WorkspaceContext } from "@lxe/protocol";
import type { RuntimeConversationMessage, RuntimeEnvironmentSnapshot, RuntimeMessage } from "./types";

const fields = ["current_date", "timezone", "cwd", "worktree", "artifact_root", "os", "bun_version", "platform", "provider", "model"] as const;
const escapeXml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function captureEnvironment(context: {
  workspace: WorkspaceContext; platform: string; provider: string; model: string; artifactRoot?: string;
}, now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): RuntimeEnvironmentSnapshot {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return {
    current_date: `${part("year")}-${part("month")}-${part("day")}`, timezone,
    cwd: context.workspace.directory, worktree: context.workspace.worktree,
    ...(context.artifactRoot ? { artifact_root: context.artifactRoot } : {}),
    os: `${platform()} ${release()}`, bun_version: Bun.version,
    platform: context.platform || "unknown", provider: context.provider || "custom", model: context.model || "unknown",
  };
}

export function environmentMessage(snapshot: RuntimeEnvironmentSnapshot): RuntimeConversationMessage {
  return { role: "user", environmentContext: structuredClone(snapshot), content: [
    "<environment_context>",
    ...fields.flatMap((field) => snapshot[field] === undefined ? [] : [`  <${field}>${escapeXml(snapshot[field]!)}</${field}>`]),
    "</environment_context>",
  ].join("\n") };
}

/** Only runtime metadata is a baseline; user-authored XML is ordinary content. */
export function environmentMetadata(value: unknown): { environmentContext?: RuntimeEnvironmentSnapshot } {
  if (!value || typeof value !== "object") return {};
  const message = value as Record<string, unknown>;
  const snapshot = message.environmentContext;
  if (message.role !== "user" || !snapshot || typeof snapshot !== "object") return {};
  const record = snapshot as Record<string, unknown>;
  if (!fields.every((key) => key === "artifact_root" && record[key] === undefined || typeof record[key] === "string")) return {};
  return { environmentContext: Object.fromEntries(fields.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as unknown as RuntimeEnvironmentSnapshot };
}

export function environmentChanged(messages: readonly RuntimeMessage[], snapshot: RuntimeEnvironmentSnapshot): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const previous = environmentMetadata(messages[index]).environmentContext;
    if (previous) return fields.some((field) => previous[field] !== snapshot[field]);
  }
  return true;
}
