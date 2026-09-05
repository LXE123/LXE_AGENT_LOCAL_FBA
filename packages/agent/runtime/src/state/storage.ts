import { existsSync, mkdirSync, statSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, stat, truncate, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { JsonObject, JsonValue, SessionWorkspaceRequest, WorkspaceContext } from "@lxe/protocol";
import type {
  RuntimeMessage,
  RuntimeArtifactRecord,
  RuntimeAttachmentRecord,
  RuntimeSessionRecord,
  RuntimeStore,
  RuntimeTurnContextRecord,
  RuntimeTurnUsageRecord,
} from "../engine/types";
import {
  createLogger,
  sameWorkspaceContext,
  SessionWorkspaceMismatchError,
  workspaceContextFrom,
} from "@lxe/core";
import {
  applyTranscriptEvent,
  createContextPatchEvent,
  legacyTranscriptMigrationHint,
  scanTranscriptBuffer,
  transcriptDisplayMarker,
  transcriptHeader,
  tryParseTranscriptEvent,
} from "./transcript";
import { allPrepared, getPrepared, parseObject, text } from "./sql";
import { UsageStore } from "./usage-store";

const transcriptArtifact = (event: JsonObject): RuntimeArtifactRecord | undefined => {
  if (text(event.kind) !== "artifact") return undefined;
  const artifact = {
    artifact_id: text(event.artifact_id),
    turn_id: text(event.turn_id),
    tool_call_id: text(event.tool_call_id),
    path: text(event.path),
    name: basename(text(event.path)),
    ts: Number(event.ts ?? 0),
  };
  if (
    !artifact.artifact_id || !artifact.turn_id || !artifact.tool_call_id || !artifact.path || !artifact.name
    || !isAbsolute(artifact.path) || !Number.isFinite(artifact.ts) || artifact.ts < 0
  ) {
    return undefined;
  }
  return artifact;
};

interface TranscriptTurnError {
  turn_id: string;
  message: string;
  ts: number;
}

const transcriptTurnError = (event: JsonObject): TranscriptTurnError | undefined => {
  if (text(event.kind) !== "turn_error") return undefined;
  const error = {
    turn_id: text(event.turn_id),
    message: text(event.message),
    ts: Number(event.ts ?? 0),
  };
  if (!error.turn_id || !error.message || !Number.isFinite(error.ts) || error.ts < 0) return undefined;
  return error;
};

const publicArtifact = (artifact: RuntimeArtifactRecord): JsonObject => ({
  artifact_id: artifact.artifact_id,
  turn_id: artifact.turn_id,
  tool_call_id: artifact.tool_call_id,
  name: artifact.name,
});

const transcriptAttachment = (value: unknown): RuntimeAttachmentRecord | undefined => {
  const block = parseObject(value);
  if (text(block.type) !== "local_file") return undefined;
  const attachment: RuntimeAttachmentRecord = {
    attachment_id: text(block.attachment_id),
    turn_id: text(block.turn_id),
    path: text(block.path),
    name: basename(text(block.path)),
    size_bytes: Math.max(0, Math.trunc(Number(block.size_bytes ?? 0))),
    media_type: text(block.media_type),
    ts: Number(block.ts ?? 0),
  };
  if (!attachment.attachment_id || !attachment.turn_id || !attachment.path || !attachment.name
    || !isAbsolute(attachment.path) || !attachment.media_type
    || !Number.isFinite(attachment.ts) || attachment.ts < 0) return undefined;
  return attachment;
};

const publicAttachment = (attachment: RuntimeAttachmentRecord): JsonObject => ({
  attachment_id: attachment.attachment_id,
  name: attachment.name,
  size_bytes: attachment.size_bytes,
  media_type: attachment.media_type,
});

const publicMessage = (value: JsonObject): JsonObject => {
  const message = structuredClone(value);
  delete message.artifacts;
  delete message.attachments;
  if (!Array.isArray(message.content)) return message;
  const attachments: JsonObject[] = [];
  const content: JsonValue[] = [];
  for (const block of message.content) {
    const attachment = transcriptAttachment(block);
    if (attachment) attachments.push(publicAttachment(attachment));
    else content.push(block);
  }
  message.content = content;
  if (attachments.length > 0) message.attachments = attachments;
  return message;
};

const transcriptEventTimestamp = (event: JsonObject): number => {
  const timestamp = Number(event.ts ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
};

const mergeObjects = (base: JsonObject, patch: JsonObject): JsonObject => {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
      ? mergeObjects(current as JsonObject, value as JsonObject)
      : value;
  }
  return merged;
};

const retiredWorkspaceColumn = ["workspace", "server", "scope"].join("_");

const imagePlaceholder = (): JsonObject => ({
  type: "text",
  text: "[Image omitted from persisted transcript after this turn]",
});

const sanitizePersistedValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(sanitizePersistedValue);
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && /^data:image\/[^;]+;base64,/iu.test(value)
      ? "[Image data URL omitted from persisted transcript after this turn]"
      : value;
  }
  const source = parseObject(value.source);
  if (text(value.type) === "image" && (text(source.type) === "base64" || typeof source.data === "string")) {
    return imagePlaceholder();
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePersistedValue(item)]));
};

const persistedMessage = (message: RuntimeMessage): RuntimeMessage => {
  if (message.role === "compactionSummary") {
    return sanitizePersistedValue(message as unknown as JsonObject) as unknown as RuntimeMessage;
  }
  if (Array.isArray(message.content) && message.content.some((block) => transcriptAttachment(block))) {
    return sanitizePersistedValue({
      ...message,
      // Attached images remain durable through their local_file reference;
      // their transient visual block is only for the current provider call.
      content: message.content.filter((block) => text(block.type) !== "image"),
    } as unknown as JsonObject) as unknown as RuntimeMessage;
  }
  return sanitizePersistedValue(message as unknown as JsonObject) as unknown as RuntimeMessage;
};

const sessionTitle = (message: RuntimeMessage, reason: string): string => {
  if (message.role !== "user" || !["turn_input", "user_input", "inbound"].includes(reason)) return "";
  const content = typeof message.content === "string" ? message.content : (() => {
    const textContent = message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text)).join(" ").trim();
    if (textContent) return textContent;
    return message.content.map((block) => transcriptAttachment(block)?.name ?? "").filter(Boolean).join(" ");
  })();
  return content.replaceAll(/\s+/g, " ").trim().slice(0, 120);
};

interface TranscriptDisplayPage {
  messages: JsonObject[];
  page: JsonObject;
}

export class InvalidTranscriptCursorError extends Error {
  override readonly name = "InvalidTranscriptCursorError";
}

const displayGroupCursor = (sessionId: string, groupNumber: number): string =>
  `dg1_${Buffer.from(JSON.stringify([sessionId, groupNumber]), "utf8").toString("base64url")}`;

const displayGroupNumber = (sessionId: string, cursor: string): number => {
  try {
    if (!cursor.startsWith("dg1_")) throw new Error("unsupported cursor version");
    const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== sessionId
      || !Number.isSafeInteger(decoded[1]) || Number(decoded[1]) < 0
      || displayGroupCursor(sessionId, Number(decoded[1])) !== cursor) {
      throw new Error("cursor payload is invalid");
    }
    return Number(decoded[1]);
  } catch (cause) {
    throw new InvalidTranscriptCursorError("message cursor is invalid or belongs to another session", { cause });
  }
};

const displayWindow = (
  sessionId: string,
  total: number,
  options: DashboardSessionPageOptions,
): { limit: number; start: number; end: number } => {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
  if (options.before !== undefined && options.after !== undefined) throw new InvalidTranscriptCursorError("before and after are mutually exclusive");
  if (options.after !== undefined) {
    const start = displayGroupNumber(sessionId, options.after) + 1;
    if (start > total) throw new InvalidTranscriptCursorError("message cursor is outside the current transcript");
    return { limit, start, end: Math.min(total, start + limit) };
  }
  const end = options.before === undefined ? total : displayGroupNumber(sessionId, options.before);
  if (end < 0 || end > total || (options.before !== undefined && end === total)) {
    throw new InvalidTranscriptCursorError("message cursor is outside the current transcript");
  }
  return { limit, start: Math.max(0, end - limit), end };
};

const displayPageMetadata = (
  sessionId: string,
  total: number,
  rawMessageTotal: number,
  limit: number,
  start: number,
  end: number,
): JsonObject => ({
  total,
  raw_message_total: rawMessageTotal,
  limit,
  oldest_cursor: start < end ? displayGroupCursor(sessionId, start) : null,
  newest_cursor: start < end ? displayGroupCursor(sessionId, end - 1) : null,
  previous_cursor: start > 0 ? displayGroupCursor(sessionId, start) : null,
  has_previous: start > 0,
  has_next: end < total,
  next_cursor: end < total && end > start ? displayGroupCursor(sessionId, end - 1) : null,
  group_cursors: Array.from({ length: end - start }, (_, i) => displayGroupCursor(sessionId, start + i)),
});

const transcriptDisplayPage = (
  sessionId: string,
  events: JsonObject[],
  options: DashboardSessionPageOptions,
): TranscriptDisplayPage => {
  const ranges: Array<[number, number]> = [];
  let pendingStart: number | undefined;
  let pendingEnd = 0;
  const flushPending = (): void => {
    if (pendingStart === undefined) return;
    ranges.push([pendingStart, pendingEnd]);
    pendingStart = undefined;
    pendingEnd = 0;
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (text(event.kind) === "message") {
      const message = parseObject(event.message);
      const role = text(message.role).toLowerCase();
      if (role === "assistant" || role === "tool") {
        pendingStart ??= index;
        pendingEnd = index + 1;
      } else {
        flushPending();
        ranges.push([index, index + 1]);
      }
      continue;
    }
    if (transcriptArtifact(event) && pendingStart !== undefined) {
      pendingEnd = index + 1;
      continue;
    }
    if (transcriptTurnError(event)) {
      pendingStart ??= index;
      pendingEnd = index + 1;
      continue;
    }
    if (!transcriptDisplayMarker(event)) continue;
    flushPending();
    ranges.push([index, index + 1]);
  }
  flushPending();

  const total = ranges.length;
  const { limit, start, end } = displayWindow(sessionId, total, options);
  const selected = ranges.slice(start, end);
  const messages: JsonObject[] = [];
  const visibleArtifactPaths = new Set<string>();
  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
    const [eventStart, eventEnd] = selected[selectedIndex]!;
    const displayGroupId = displayGroupCursor(sessionId, start + selectedIndex);
    let messageOrdinal = 0;
    let latestMessage: JsonObject | undefined;
    for (const event of events.slice(eventStart, eventEnd)) {
      if (text(event.kind) === "message") {
        const message = parseObject(event.message);
        if (text(message.role)) {
          latestMessage = {
            ...publicMessage(message),
            display_id: `${displayGroupId}:${messageOrdinal++}`,
            source_reason: text(event.reason),
            display_group_id: displayGroupId,
            created_at: transcriptEventTimestamp(event),
          };
          messages.push(latestMessage);
        }
        continue;
      }
      const artifact = transcriptArtifact(event);
      if (artifact && latestMessage) {
        const key = `${artifact.turn_id}\u0000${artifact.path}`;
        if (visibleArtifactPaths.has(key)) continue;
        visibleArtifactPaths.add(key);
        const existing = Array.isArray(latestMessage.artifacts) ? latestMessage.artifacts : [];
        latestMessage.artifacts = [...existing, publicArtifact(artifact)];
        continue;
      }
      const turnError = transcriptTurnError(event);
      if (turnError) {
        latestMessage = {
          role: "assistant",
          content: [{ type: "text", text: turnError.message }],
          display_group_id: displayGroupId,
          created_at: turnError.ts,
        };
        messages.push(latestMessage);
        continue;
      }
      const marker = transcriptDisplayMarker(event);
      if (marker) {
        latestMessage = {
          ...marker,
              display_id: `${displayGroupId}:${messageOrdinal++}`,
          display_group_id: displayGroupId,
          created_at: transcriptEventTimestamp(event),
        };
        messages.push(latestMessage);
      }
    }
  }
  return {
    messages,
    page: displayPageMetadata(
      sessionId,
      total,
      events.filter((event) => text(event.kind) === "message").length,
      limit,
      start,
      end,
    ),
  };
};

export interface DashboardSessionListOptions {
  limit: number;
  offset: number;
  query?: string;
}

export interface DashboardSessionPageOptions {
  limit: number;
  before?: string;
  after?: string;
}

interface ReplayCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  byteSize: number;
  messages: RuntimeMessage[];
}

interface TranscriptFileState {
  file_size: number;
  mtime_ms: number;
  indexed_bytes: number;
  event_count: number;
  raw_message_count: number;
  display_group_count: number;
  last_display_kind: string;
}

export interface SqliteRuntimeStoreOptions {
  replayCacheMaxEntries?: number;
  replayCacheMaxBytes?: number;
  legacyWorkspace?: WorkspaceContext;
}

const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 32;
const DEFAULT_REPLAY_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export class SqliteRuntimeStore implements RuntimeStore {
  private readonly logger = createLogger("runtime.storage");
  private database: Database | undefined;
  private usageStore: UsageStore | undefined;
  private readonly replayCache = new Map<string, ReplayCacheEntry>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly indexQueues = new Map<string, Promise<void>>();
  private readonly replayCacheMaxEntries: number;
  private readonly replayCacheMaxBytes: number;
  private replayCacheBytes = 0;
  private replayHits = 0;
  private replayMisses = 0;

  constructor(readonly path: string, private readonly options: SqliteRuntimeStoreOptions = {}) {
    this.replayCacheMaxEntries = Math.max(0, Math.trunc(
      options.replayCacheMaxEntries ?? DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
    ));
    this.replayCacheMaxBytes = Math.max(0, Math.trunc(
      options.replayCacheMaxBytes ?? DEFAULT_REPLAY_CACHE_MAX_BYTES,
    ));
  }

  async start(): Promise<void> {
    if (this.database) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new Database(this.path, { create: true, strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    this.database = database;
    this.usageStore = new UsageStore(database);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          session_id TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT '{}',
          workspace_directory TEXT NOT NULL DEFAULT '',
          workspace_worktree TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          reasoning_effort TEXT NOT NULL DEFAULT '',
          model_config TEXT NOT NULL DEFAULT '{}',
          created_at REAL NOT NULL,
          last_active_at REAL NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT '',
          pinned_at REAL NOT NULL DEFAULT 0,
          api_call_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS agent_session_pending_events (
          queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          text TEXT NOT NULL,
          queued_at TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS transcript_file_state (
          session_id TEXT PRIMARY KEY,
          file_size INTEGER NOT NULL DEFAULT 0,
          mtime_ms REAL NOT NULL DEFAULT 0,
          indexed_bytes INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          raw_message_count INTEGER NOT NULL DEFAULT 0,
          display_group_count INTEGER NOT NULL DEFAULT 0,
          last_display_kind TEXT NOT NULL DEFAULT '',
          updated_at REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS transcript_display_groups (
          session_id TEXT NOT NULL,
          group_number INTEGER NOT NULL,
          byte_start INTEGER NOT NULL,
          byte_end INTEGER NOT NULL,
          group_kind TEXT NOT NULL,
          turn_id TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (session_id, group_number)
        );
        CREATE TABLE IF NOT EXISTS transcript_artifacts (
          session_id TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at REAL NOT NULL,
          PRIMARY KEY (session_id, artifact_id)
        );
        CREATE TABLE IF NOT EXISTS transcript_attachments (
          session_id TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          media_type TEXT NOT NULL,
          created_at REAL NOT NULL,
          PRIMARY KEY (session_id, attachment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_transcript_display_groups_session
          ON transcript_display_groups (session_id, group_number);
        CREATE INDEX IF NOT EXISTS idx_transcript_artifacts_turn
          ON transcript_artifacts (session_id, turn_id);
        CREATE INDEX IF NOT EXISTS idx_transcript_attachments_turn
          ON transcript_attachments (session_id, turn_id);
      `);
      const columns = this.allPrepared<{ name: string }>("PRAGMA table_info(agent_sessions)");
      if (!columns.some((column) => column.name === "reasoning_effort")) {
        database.exec("ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
      }
      if (!columns.some((column) => column.name === "pinned_at")) {
        database.exec("ALTER TABLE agent_sessions ADD COLUMN pinned_at REAL NOT NULL DEFAULT 0");
      }
      for (const [name, declaration] of [
        ["workspace_directory", "TEXT NOT NULL DEFAULT ''"],
        ["workspace_worktree", "TEXT NOT NULL DEFAULT ''"],
      ] as const) {
        if (!columns.some((column) => column.name === name)) {
          database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${declaration}`);
        }
      }
      if (this.options.legacyWorkspace) {
        const workspace = this.options.legacyWorkspace;
        database.query(`
          UPDATE agent_sessions SET
            workspace_directory = ?, workspace_worktree = ?
          WHERE workspace_directory = '' OR workspace_worktree = ''
        `).run(workspace.directory, workspace.worktree);
      }
      if (columns.some((column) => column.name === retiredWorkspaceColumn)) {
        database.exec(`ALTER TABLE agent_sessions DROP COLUMN ${retiredWorkspaceColumn}`);
      }
      UsageStore.migrate(database);
      const displayGroupColumns = this.allPrepared<{ name: string }>(
        "PRAGMA table_info(transcript_display_groups)",
      );
      if (!displayGroupColumns.some((column) => column.name === "turn_id")) {
        database.exec(`
          ALTER TABLE transcript_display_groups ADD COLUMN turn_id TEXT NOT NULL DEFAULT '';
          DELETE FROM transcript_display_groups;
          DELETE FROM transcript_file_state;
        `);
      }
      database.exec("COMMIT");
      await this.catchUpTranscriptIndexes();
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the startup failure. */ }
      this.database = undefined;
      this.usageStore = undefined;
      database.close(false);
      this.clearReplayCache();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.writeQueues.values(), ...this.indexQueues.values()]);
    this.database?.close(false);
    this.database = undefined;
    this.usageStore = undefined;
    this.clearReplayCache();
  }

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const workspace = workspaceContextFrom(request.workspace);
    const incomingSource = parseObject(request.source);
    const current = this.getPrepared<{
      source: string;
      workspace_directory: string;
      workspace_worktree: string;
    }>(
      `SELECT source, workspace_directory, workspace_worktree
       FROM agent_sessions WHERE session_id = ?`,
      sessionId,
    );
    const currentWorkspace = current ? this.workspaceFromRow(current) : undefined;
    if (currentWorkspace && !sameWorkspaceContext(currentWorkspace, workspace)) {
      throw new SessionWorkspaceMismatchError(sessionId);
    }
    const source = mergeObjects(current ? parseObject(current.source) : {}, incomingSource);
    const now = Date.now() / 1_000;
    this.db().query(`
      INSERT INTO agent_sessions (
        session_id, source, workspace_directory, workspace_worktree,
        created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        source = excluded.source,
        workspace_directory = excluded.workspace_directory,
        workspace_worktree = excluded.workspace_worktree,
        last_active_at = excluded.last_active_at
    `).run(
      sessionId,
      JSON.stringify(source),
      workspace.directory,
      workspace.worktree,
      now,
      now,
    );
  }

  async getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined> {
    const row = this.getPrepared<{
      session_id: string;
      source: string;
      workspace_directory: string;
      workspace_worktree: string;
    }>(
      `SELECT session_id, source, workspace_directory, workspace_worktree
       FROM agent_sessions WHERE session_id = ?`,
      text(sessionId),
    );
    if (!row) return undefined;
    const workspace = this.workspaceFromRow(row);
    if (!workspace) throw new Error(`session workspace is missing: ${row.session_id}`);
    return { session_id: row.session_id, source: parseObject(row.source), workspace };
  }

  async appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = Math.trunc(Date.now() / 1_000);
    this.db().query(`
      INSERT OR IGNORE INTO agent_session_pending_events
        (session_id, event_id, job_id, created_at, text, queued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      text(sessionId),
      text(event.event_id) || randomUUID().replaceAll("-", ""),
      text(event.job_id),
      text(event.created_at) || String(createdAt),
      text(event.text),
      now,
    );
  }

  async hasPendingEvents(sessionId: string): Promise<boolean> {
    const row = this.getPrepared<{ present: number }>(
      "SELECT 1 AS present FROM agent_session_pending_events WHERE session_id = ? LIMIT 1",
      text(sessionId),
    );
    return Boolean(row?.present);
  }

  async popPendingEvents(sessionId: string): Promise<JsonObject[]> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const rows = this.allPrepared<Record<string, unknown>>(`
        SELECT event_id, job_id, created_at, text, queued_at
        FROM agent_session_pending_events WHERE session_id = ? ORDER BY queue_id ASC
      `, safeSessionId);
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
      return rows.map((row) => ({
        event_id: text(row.event_id),
        job_id: text(row.job_id),
        created_at: text(row.created_at),
        text: text(row.text),
        queued_at: text(row.queued_at),
      }));
    });
    return transaction();
  }

  discardPendingEvent(sessionId: string, jobId: string): number {
    const safeSessionId = text(sessionId);
    const safeJobId = text(jobId);
    if (!safeSessionId || !safeJobId) return 0;
    const result = this.db().transaction(() => this.db().query(`
      DELETE FROM agent_session_pending_events
      WHERE session_id = ? AND job_id = ?
    `).run(safeSessionId, safeJobId))();
    return Number(result.changes ?? 0);
  }

  discardPendingEvents(sessionId: string): number {
    const result = this.db().transaction(() => this.db().query(
      "DELETE FROM agent_session_pending_events WHERE session_id = ?",
    ).run(text(sessionId)))();
    return Number(result.changes ?? 0);
  }

  async resetContext(sessionId: string, reason: "context_reset" | "memory_clear" = "context_reset"): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const previous = await this.loadMessagesUnqueued(safeSessionId);
      this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, createContextPatchEvent(previous, [], reason));
      this.db().transaction(() => {
        this.db().query("UPDATE agent_sessions SET last_active_at = ?, message_count = 0 WHERE session_id = ?")
          .run(Date.now() / 1_000, safeSessionId);
        this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
      })();
      await this.updateCacheAfterWrite(safeSessionId, path, []);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  clearSessionRuntimeState(sessionId: string): void {
    const safeSessionId = text(sessionId);
    this.db().transaction(() => {
      const row = this.getPrepared<{ source: string }>(
        "SELECT source FROM agent_sessions WHERE session_id = ?",
        safeSessionId,
      );
      if (!row) throw new Error(`session not found: ${safeSessionId}`);
      const source = parseObject(row.source);
      delete source.tool_state;
      this.db().query("UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?")
        .run(JSON.stringify(source), Date.now() / 1_000, safeSessionId);
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
    })();
  }

  replayCacheStats(): { hits: number; misses: number; entries: number; bytes: number } {
    return {
      hits: this.replayHits,
      misses: this.replayMisses,
      entries: this.replayCache.size,
      bytes: this.replayCacheBytes,
    };
  }

  async loadMessages(sessionId: string): Promise<RuntimeMessage[]> {
    const safeSessionId = text(sessionId);
    await this.waitForSessionWrites(safeSessionId);
    return await this.loadMessagesUnqueued(safeSessionId);
  }

  private async loadMessagesUnqueued(safeSessionId: string): Promise<RuntimeMessage[]> {
    const path = this.transcriptPath(safeSessionId);
    let raw: Uint8Array;
    try {
      const fileStat = await stat(path);
      const cached = this.replayCache.get(safeSessionId);
      if (cached && cached.path === path && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
        this.replayHits += 1;
        this.touchReplayCache(safeSessionId, cached);
        return structuredClone(cached.messages);
      }
      this.replayMisses += 1;
      raw = await readFile(path);
    } catch (error) {
      this.removeReplayCacheEntry(safeSessionId);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.loadMessagesWithoutTranscript(safeSessionId);
      throw error;
    }
    if (raw.length === 0) return this.loadMessagesWithoutTranscript(safeSessionId);
    let messages: RuntimeMessage[] = [];
    const scanned = scanTranscriptBuffer(raw, 0, true);
    for (const { event } of scanned.lines) messages = applyTranscriptEvent(messages, event);
    const fileStat = await stat(path);
    this.installReplayCacheEntry(safeSessionId, path, fileStat.size, fileStat.mtimeMs, messages);
    return structuredClone(messages);
  }

  async loadTranscriptDisplayPage(
    sessionId: string,
    options: DashboardSessionPageOptions,
  ): Promise<TranscriptDisplayPage> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    await this.waitForSessionWrites(safeSessionId);
    const state = await this.enqueueIndexSync(safeSessionId, path);
    if (!state) return transcriptDisplayPage(safeSessionId, [], options);
    return await this.readIndexedDisplayPage(safeSessionId, path, state, options);
  }

  async appendMessage(
    sessionId: string,
    message: RuntimeMessage,
    reason = "runtime",
    turnId = "",
  ): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      const persisted = persistedMessage(message);
      await this.appendTranscriptEvent(safeSessionId, {
        kind: "message",
        message: persisted as unknown as JsonObject,
        reason,
        ...(text(turnId) ? { turn_id: text(turnId) } : {}),
        ts: Date.now() / 1_000,
      });
      const title = sessionTitle(message, reason);
      this.db().query(`
          UPDATE agent_sessions SET last_active_at = ?, message_count = message_count + 1,
            title = CASE WHEN title = '' AND ? <> '' THEN ? ELSE title END
          WHERE session_id = ?
        `).run(Date.now() / 1_000, title, title, safeSessionId);
      if (cached) await this.appendReplayCacheMessage(safeSessionId, path, cached, persisted);
      else this.removeReplayCacheEntry(safeSessionId);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async appendTurnContext(sessionId: string, context: RuntimeTurnContextRecord): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, {
        kind: "turn_context",
        turn_id: text(context.turn_id),
        job_kind: context.job_kind,
        provider: text(context.provider),
        model: text(context.model),
        credential_source: context.credential_source === "cloud" ? "cloud" : "local",
        effort: text(context.effort),
        thinking_enabled: context.thinking_enabled === true,
        provider_generation: Math.max(0, Math.trunc(Number(context.provider_generation ?? 0))),
        context_window_tokens: Math.max(0, Math.trunc(Number(context.context_window_tokens ?? 0))),
        ts: Number(context.ts ?? Date.now() / 1_000),
      });
      if (cached) await this.refreshReplayCacheMetadata(safeSessionId, path, cached);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async appendTurnError(sessionId: string, turnId: string, message: string): Promise<void> {
    const safeSessionId = text(sessionId);
    const safeTurnId = text(turnId);
    const safeMessage = text(message);
    if (!safeSessionId || !safeTurnId || !safeMessage) throw new Error("invalid transcript turn error");
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, {
        kind: "turn_error",
        turn_id: safeTurnId,
        message: safeMessage,
        ts: Date.now() / 1_000,
      });
      this.db().query("UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?")
        .run(Date.now() / 1_000, safeSessionId);
      if (cached) await this.refreshReplayCacheMetadata(safeSessionId, path, cached);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async appendArtifact(sessionId: string, artifact: RuntimeArtifactRecord): Promise<void> {
    const safeSessionId = text(sessionId);
    const safePath = text(artifact.path);
    if (!safeSessionId || !text(artifact.artifact_id) || !text(artifact.turn_id) || !text(artifact.tool_call_id)) {
      throw new Error("invalid transcript artifact identity");
    }
    if (!isAbsolute(safePath)) throw new Error("transcript artifact path must be absolute");
    const timestamp = Number(artifact.ts);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("invalid transcript artifact timestamp");
    const persisted: RuntimeArtifactRecord = {
      artifact_id: text(artifact.artifact_id),
      turn_id: text(artifact.turn_id),
      tool_call_id: text(artifact.tool_call_id),
      path: safePath,
      name: basename(safePath),
      ts: timestamp,
    };
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      await this.enqueueIndexSync(safeSessionId, path);
      const duplicate = this.getPrepared<{ artifact_id: string }>(`
        SELECT artifact_id FROM transcript_artifacts
        WHERE session_id = ? AND turn_id = ? AND path = ? LIMIT 1
      `, safeSessionId, persisted.turn_id, persisted.path);
      if (duplicate) return;
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, { kind: "artifact", ...persisted });
      if (cached) await this.refreshReplayCacheMetadata(safeSessionId, path, cached);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async resolveArtifact(sessionId: string, artifactId: string): Promise<RuntimeArtifactRecord | undefined> {
    const safeSessionId = text(sessionId);
    const safeArtifactId = text(artifactId);
    if (!safeSessionId || !safeArtifactId) return undefined;
    await this.waitForSessionWrites(safeSessionId);
    await this.enqueueIndexSync(safeSessionId, this.transcriptPath(safeSessionId));
    const row = this.getPrepared<Record<string, unknown>>(`
      SELECT artifact_id, turn_id, tool_call_id, path, name, created_at
      FROM transcript_artifacts WHERE session_id = ? AND artifact_id = ?
    `, safeSessionId, safeArtifactId);
    if (!row) return undefined;
    return transcriptArtifact({
      kind: "artifact",
      artifact_id: text(row.artifact_id),
      turn_id: text(row.turn_id),
      tool_call_id: text(row.tool_call_id),
      path: text(row.path),
      name: text(row.name),
      ts: Number(row.created_at ?? 0),
    });
  }

  async resolveAttachment(sessionId: string, attachmentId: string): Promise<RuntimeAttachmentRecord | undefined> {
    const safeSessionId = text(sessionId);
    const safeAttachmentId = text(attachmentId);
    if (!safeSessionId || !safeAttachmentId) return undefined;
    await this.waitForSessionWrites(safeSessionId);
    await this.enqueueIndexSync(safeSessionId, this.transcriptPath(safeSessionId));
    const row = this.getPrepared<Record<string, unknown>>(`
      SELECT attachment_id, turn_id, path, name, size_bytes, media_type, created_at
      FROM transcript_attachments WHERE session_id = ? AND attachment_id = ?
    `, safeSessionId, safeAttachmentId);
    if (!row) return undefined;
    return transcriptAttachment({
      type: "local_file",
      attachment_id: text(row.attachment_id),
      turn_id: text(row.turn_id),
      path: text(row.path),
      name: text(row.name),
      size_bytes: Number(row.size_bytes ?? 0),
      media_type: text(row.media_type),
      ts: Number(row.created_at ?? 0),
    });
  }

  async attachmentPaths(sessionId: string): Promise<string[]> {
    const safeSessionId = text(sessionId);
    if (!safeSessionId) return [];
    await this.waitForSessionWrites(safeSessionId);
    await this.enqueueIndexSync(safeSessionId, this.transcriptPath(safeSessionId));
    return this.allPrepared<{ path: string }>(`
      SELECT DISTINCT path FROM transcript_attachments WHERE session_id = ? ORDER BY path
    `, safeSessionId).map((row) => text(row.path)).filter(Boolean);
  }

  async replaceMessages(
    sessionId: string,
    messages: RuntimeMessage[],
    replacementKind: "compaction" | "repair" | "history_limit" | "context_replacement",
    metadata: JsonObject = {},
  ): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const previous = await this.loadMessagesUnqueued(safeSessionId);
      this.validCacheBeforeWrite(safeSessionId, path);
      const persisted = messages.map(persistedMessage);
      await this.appendTranscriptEvent(
        safeSessionId,
        createContextPatchEvent(previous, persisted, replacementKind, metadata),
      );
      this.db().query("UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?")
        .run(Date.now() / 1_000, safeSessionId);
      await this.updateCacheAfterWrite(safeSessionId, path, persisted);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async patchSessionState(sessionId: string, patch: JsonObject): Promise<void> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const row = this.getPrepared<{ source: string }>(
        "SELECT source FROM agent_sessions WHERE session_id = ?",
        safeSessionId,
      );
      if (!row) throw new Error(`session not found: ${safeSessionId}`);
      const source = parseObject(row.source);
      source.tool_state = mergeObjects(parseObject(source.tool_state), patch);
      this.db().query("UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?")
        .run(JSON.stringify(source), Date.now() / 1_000, safeSessionId);
    });
    transaction();
  }

  async recordTurn(sessionId: string, metrics: RuntimeTurnUsageRecord): Promise<void> {
    const safeSessionId = text(sessionId);
    this.db().transaction(() => {
      this.db().query(`
        UPDATE agent_sessions SET
          last_active_at = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
          tool_call_count = tool_call_count + ?, api_call_count = api_call_count + ?
        WHERE session_id = ?
      `).run(
        Date.now() / 1_000,
        Number(metrics.input_tokens ?? 0), Number(metrics.output_tokens ?? 0),
        Number(metrics.tool_calls ?? 0), Number(metrics.api_calls ?? metrics.llm_calls ?? 0), safeSessionId,
      );
      this.usage().recordTurn(safeSessionId, metrics);
    })();
  }

  usageOverview(days: number): JsonObject {
    return this.usage().usageOverview(days);
  }

  toolUsageStats(days: number): JsonObject[] {
    return this.usage().toolUsageStats(days);
  }

  skillUsageStats(days: number, name = ""): JsonObject[] {
    return this.usage().skillUsageStats(days, name);
  }

  skillUsageDetail(name: string, days: number, failureLimit = 10): JsonObject {
    return this.usage().skillUsageDetail(name, days, failureLimit);
  }

  exportTurnUsage(days: number, limit = 5_000): JsonObject[] {
    return this.usage().exportTurnUsage(days, limit);
  }

  exportTurnUsageBatch(
    targetUrl: string,
    cutoff: number,
    limit = 200,
  ): { turns: JsonObject[]; acknowledged_sequence: number; has_more: boolean } {
    return this.usage().exportTurnUsageBatch(targetUrl, cutoff, limit);
  }

  acknowledgeTurnUsage(targetUrl: string, sequence: number): void {
    this.usage().acknowledgeTurnUsage(targetUrl, sequence);
  }

  turnUsageAcknowledgedSequence(targetUrl: string): number | undefined {
    return this.usage().turnUsageAcknowledgedSequence(targetUrl);
  }

  listSessions(options: DashboardSessionListOptions): {
    items: JsonObject[];
    limit: number;
    offset: number;
    total: number;
    summary: JsonObject;
  } {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
    const offset = Math.max(0, Math.trunc(options.offset));
    const needle = text(options.query).toLowerCase();
    const where = needle
      ? "WHERE lower(coalesce(session_id, '')) LIKE ? OR lower(coalesce(title, '')) LIKE ? OR lower(coalesce(model, '')) LIKE ? OR lower(coalesce(source, '')) LIKE ?"
      : "";
    const whereArgs = needle ? Array(4).fill(`%${needle}%`) : [];
    const totalRow = this.getPrepared<{ count: number }>(
      `SELECT COUNT(*) AS count FROM agent_sessions ${where}`,
      ...whereArgs,
    );
    const rows = this.allPrepared<Record<string, unknown>>(`
      SELECT session_id, source, workspace_directory, workspace_worktree,
             model, reasoning_effort, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, pinned_at, api_call_count
      FROM agent_sessions ${where}
      ORDER BY CASE WHEN pinned_at > 0 THEN 0 ELSE 1 END ASC,
               CASE WHEN pinned_at > 0 THEN pinned_at ELSE last_active_at END DESC,
               created_at DESC, session_id ASC LIMIT ? OFFSET ?
    `, ...whereArgs, limit, offset);
    const summary = this.getPrepared<Record<string, number>>(`
      SELECT COUNT(*) AS total_sessions, COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
             COALESCE(SUM(input_tokens + output_tokens), 0) AS token_count FROM agent_sessions
    `);
    return {
      items: rows.map((row) => this.sessionPayload(row)),
      limit,
      offset,
      total: Number(totalRow?.count ?? 0),
      summary: {
        total_sessions: Number(summary?.total_sessions ?? 0),
        tool_call_count: Number(summary?.tool_call_count ?? 0),
        token_count: Number(summary?.token_count ?? 0),
      },
    };
  }

  pinSession(sessionId: string, pinned: boolean): JsonObject | undefined {
    const safeSessionId = text(sessionId);
    const result = this.db().query(
      "UPDATE agent_sessions SET pinned_at = ? WHERE session_id = ?",
    ).run(pinned ? Date.now() / 1_000 : 0, safeSessionId);
    if (Number(result.changes ?? 0) !== 1) return undefined;
    const row = this.getPrepared<Record<string, unknown>>(`
      SELECT session_id, source, workspace_directory, workspace_worktree,
             model, reasoning_effort, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, pinned_at, api_call_count
      FROM agent_sessions WHERE session_id = ?
    `, safeSessionId);
    return row ? this.sessionPayload(row) : undefined;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const safeSessionId = text(sessionId);
    if (!safeSessionId) return false;
    let deleted = false;
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const exists = this.getPrepared<{ present: number }>(
        "SELECT 1 AS present FROM agent_sessions WHERE session_id = ?",
        safeSessionId,
      );
      if (!exists) return;
      const path = this.transcriptPath(safeSessionId);
      const tombstone = `${path}.deleting-${randomUUID().replaceAll("-", "")}`;
      let movedTranscript = false;
      try {
        await rename(path, tombstone);
        movedTranscript = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        this.db().transaction(() => {
          this.db().query("DELETE FROM transcript_display_groups WHERE session_id = ?").run(safeSessionId);
          this.db().query("DELETE FROM transcript_artifacts WHERE session_id = ?").run(safeSessionId);
          this.db().query("DELETE FROM transcript_attachments WHERE session_id = ?").run(safeSessionId);
          this.db().query("DELETE FROM transcript_file_state WHERE session_id = ?").run(safeSessionId);
          this.db().query("DELETE FROM agent_sessions WHERE session_id = ?").run(safeSessionId);
          const remaining = this.getPrepared<{ present: number }>(
            "SELECT 1 AS present FROM agent_sessions WHERE session_id = ?",
            safeSessionId,
          );
          if (remaining) throw new Error(`session delete did not complete: ${safeSessionId}`);
        })();
      } catch (error) {
        if (movedTranscript) {
          try {
            await rename(tombstone, path);
          } catch (restoreError) {
            this.logger.error("transcript_delete_rollback_failed", {
              session_id: safeSessionId,
              error: restoreError,
            });
          }
        }
        throw error;
      }
      this.removeReplayCacheEntry(safeSessionId);
      if (movedTranscript) {
        try {
          await unlink(tombstone);
        } catch (error) {
          this.logger.warn("transcript_tombstone_cleanup_failed", {
            session_id: safeSessionId,
            error,
          });
        }
      }
      deleted = true;
    });
    return deleted;
  }

  async sessionDetail(sessionId: string, options: DashboardSessionPageOptions): Promise<JsonObject | undefined> {
    const safeSessionId = text(sessionId);
    const exists = this.getPrepared<{ present: number }>(
      "SELECT 1 AS present FROM agent_sessions WHERE session_id = ?",
      safeSessionId,
    );
    if (!exists) return undefined;
    const display = await this.loadTranscriptDisplayPage(safeSessionId, options);
    const row = this.getPrepared<Record<string, unknown>>(`
      SELECT session_id, source, workspace_directory, workspace_worktree,
             model, reasoning_effort, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, pinned_at, api_call_count
      FROM agent_sessions WHERE session_id = ?
    `, safeSessionId);
    if (!row) return undefined;
    return {
      session: this.sessionPayload(row),
      messages: display.messages,
      messages_page: display.page,
    };
  }

  private db(): Database {
    if (!this.database) throw new Error("runtime store is not started");
    return this.database;
  }

  private usage(): UsageStore {
    if (!this.usageStore) throw new Error("runtime store is not started");
    return this.usageStore;
  }

  private allPrepared<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    return allPrepared<T>(this.db(), sql, ...bindings);
  }

  private getPrepared<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    return getPrepared<T>(this.db(), sql, ...bindings);
  }

  private sessionPayload(row: Record<string, unknown>): JsonObject {
    const source = parseObject(row.source);
    const workspace = this.workspaceFromRow(row);
    if (!workspace) throw new Error(`session workspace is missing: ${text(row.session_id)}`);
    return {
      session_id: text(row.session_id),
      title: text(row.title),
      pinned_at: Math.max(0, Number(row.pinned_at ?? 0)),
      source,
      workspace,
      source_summary: {
        platform: text(source.platform) || "unknown",
        chat_type: text(source.chat_type),
      },
      model: text(row.model),
      reasoning_effort: text(row.reasoning_effort),
      model_config: parseObject(row.model_config),
      created_at: Number(row.created_at ?? 0),
      last_active_at: Number(row.last_active_at ?? 0),
      message_count: Number(row.message_count ?? 0),
      tool_call_count: Number(row.tool_call_count ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      api_call_count: Number(row.api_call_count ?? 0),
    };
  }

  private workspaceFromRow(row: Record<string, unknown>): WorkspaceContext | undefined {
    const directory = text(row.workspace_directory);
    const worktree = text(row.workspace_worktree);
    if (!directory && !worktree) return undefined;
    return workspaceContextFrom({ directory, worktree });
  }

  private validCacheBeforeWrite(
    sessionId: string,
    path: string,
  ): ReplayCacheEntry | undefined {
    const cached = this.replayCache.get(sessionId);
    if (!cached || cached.path !== path) return undefined;
    try {
      const fileStat = statSync(path);
      if (cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) return cached;
    } catch {
      // External deletion invalidates the replay cache.
    }
    this.removeReplayCacheEntry(sessionId);
    return undefined;
  }

  private async updateCacheAfterWrite(sessionId: string, path: string, messages: RuntimeMessage[]): Promise<void> {
    const fileStat = await stat(path);
    this.installReplayCacheEntry(sessionId, path, fileStat.size, fileStat.mtimeMs, messages);
  }

  private async appendReplayCacheMessage(
    sessionId: string,
    path: string,
    cached: ReplayCacheEntry,
    message: RuntimeMessage,
  ): Promise<void> {
    const current = this.replayCache.get(sessionId);
    if (current !== cached) return;
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    const delta = cached.messages.length === 0 ? messageBytes : messageBytes + 1;
    cached.messages.push(message);
    cached.byteSize += delta;
    this.replayCacheBytes += delta;
    const fileStat = await stat(path);
    cached.size = fileStat.size;
    cached.mtimeMs = fileStat.mtimeMs;
    this.touchReplayCache(sessionId, cached);
    this.evictReplayCache();
  }

  private async refreshReplayCacheMetadata(
    sessionId: string,
    path: string,
    cached: ReplayCacheEntry,
  ): Promise<void> {
    if (this.replayCache.get(sessionId) !== cached) return;
    const fileStat = await stat(path);
    cached.size = fileStat.size;
    cached.mtimeMs = fileStat.mtimeMs;
    this.touchReplayCache(sessionId, cached);
  }

  private installReplayCacheEntry(
    sessionId: string,
    path: string,
    size: number,
    mtimeMs: number,
    messages: RuntimeMessage[],
  ): void {
    this.removeReplayCacheEntry(sessionId);
    const byteSize = Buffer.byteLength(JSON.stringify(messages));
    if (
      this.replayCacheMaxEntries === 0 ||
      this.replayCacheMaxBytes === 0 ||
      byteSize > this.replayCacheMaxBytes
    ) return;
    this.replayCache.set(sessionId, { path, size, mtimeMs, byteSize, messages });
    this.replayCacheBytes += byteSize;
    this.evictReplayCache();
  }

  private touchReplayCache(sessionId: string, entry: ReplayCacheEntry): void {
    this.replayCache.delete(sessionId);
    this.replayCache.set(sessionId, entry);
  }

  private removeReplayCacheEntry(sessionId: string): void {
    const entry = this.replayCache.get(sessionId);
    if (!entry) return;
    this.replayCache.delete(sessionId);
    this.replayCacheBytes = Math.max(0, this.replayCacheBytes - entry.byteSize);
  }

  private clearReplayCache(): void {
    this.replayCache.clear();
    this.replayCacheBytes = 0;
  }

  private evictReplayCache(): void {
    while (
      this.replayCache.size > this.replayCacheMaxEntries ||
      this.replayCacheBytes > this.replayCacheMaxBytes
    ) {
      const oldest = this.replayCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.removeReplayCacheEntry(oldest);
    }
  }

  private enqueueKeyed<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(key, barrier);
    void barrier.then(() => {
      if (queues.get(key) === barrier) queues.delete(key);
    });
    return result;
  }

  private enqueueSessionWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
    return this.enqueueKeyed(this.writeQueues, sessionId, operation);
  }

  private async waitForSessionWrites(sessionId: string): Promise<void> {
    await this.writeQueues.get(sessionId);
  }

  private enqueueIndexSync(sessionId: string, path: string): Promise<TranscriptFileState | undefined> {
    return this.enqueueKeyed(this.indexQueues, sessionId, () => this.syncTranscriptIndex(sessionId, path));
  }

  private async appendTranscriptEvent(sessionId: string, event: JsonObject): Promise<void> {
    const path = this.transcriptPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let separator = "";
    if (size > 0) {
      const lastByte = await this.readByteRange(path, size - 1, size);
      if (lastByte[0] !== 0x0a) {
        const repaired = await this.repairUnterminatedTail(sessionId, path, size);
        size = repaired.size;
        separator = repaired.separator;
      }
    }
    const prefix = size === 0 ? `${JSON.stringify(transcriptHeader(sessionId))}\n` : "";
    await appendFile(path, `${separator}${prefix}${JSON.stringify(event)}\n`, "utf8");
  }

  /**
   * An interrupted append can leave the file without a trailing newline. A
   * parseable tail only lost its newline, so seal it with a separator; an
   * unparseable tail is torn, unacknowledged data and must be truncated
   * before the next event would fuse with it into one permanently corrupt
   * line.
   */
  private async repairUnterminatedTail(
    sessionId: string,
    path: string,
    size: number,
  ): Promise<{ size: number; separator: string }> {
    const tailStart = await this.lastNewlineOffset(path, size);
    const tailRaw = new TextDecoder().decode(await this.readByteRange(path, tailStart, size)).trim();
    if (tailRaw && tryParseTranscriptEvent(tailRaw)) return { size, separator: "\n" };
    await truncate(path, tailStart);
    this.logger.warn("transcript_torn_tail_truncated", {
      session_id: sessionId,
      truncated_bytes: size - tailStart,
    });
    return { size: tailStart, separator: "" };
  }

  private async lastNewlineOffset(path: string, size: number): Promise<number> {
    const chunkSize = 64 * 1024;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const chunk = await this.readByteRange(path, start, end);
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] === 0x0a) return start + index + 1;
      }
      end = start;
    }
    return 0;
  }

  private async catchUpTranscriptIndexes(): Promise<void> {
    const rows = this.allPrepared<{ session_id: string }>(
      "SELECT session_id FROM agent_sessions ORDER BY session_id",
    );
    for (const row of rows) {
      const sessionId = text(row.session_id);
      if (sessionId) await this.enqueueIndexSync(sessionId, this.transcriptPath(sessionId));
    }
  }

  private clearTranscriptIndex(sessionId: string): void {
    this.db().transaction(() => {
      this.db().query("DELETE FROM transcript_display_groups WHERE session_id = ?").run(sessionId);
      this.db().query("DELETE FROM transcript_artifacts WHERE session_id = ?").run(sessionId);
      this.db().query("DELETE FROM transcript_attachments WHERE session_id = ?").run(sessionId);
      this.db().query("DELETE FROM transcript_file_state WHERE session_id = ?").run(sessionId);
      this.db().query(`
        UPDATE agent_sessions SET model = '', reasoning_effort = '', model_config = '{}'
        WHERE session_id = ?
      `).run(sessionId);
    })();
  }

  private async readByteRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const result = await handle.read(buffer, offset, length - offset, start + offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  private async syncTranscriptIndex(
    sessionId: string,
    path: string,
  ): Promise<TranscriptFileState | undefined> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.clearTranscriptIndex(sessionId);
      this.removeReplayCacheEntry(sessionId);
      return undefined;
    }
    const rawState = this.getPrepared<Record<string, unknown>>(`
      SELECT file_size, mtime_ms, indexed_bytes, event_count, raw_message_count,
             display_group_count, last_display_kind
      FROM transcript_file_state WHERE session_id = ?
    `, sessionId);
    const state: TranscriptFileState | undefined = rawState ? {
      file_size: Number(rawState.file_size ?? 0),
      mtime_ms: Number(rawState.mtime_ms ?? 0),
      indexed_bytes: Number(rawState.indexed_bytes ?? 0),
      event_count: Number(rawState.event_count ?? 0),
      raw_message_count: Number(rawState.raw_message_count ?? 0),
      display_group_count: Number(rawState.display_group_count ?? 0),
      last_display_kind: text(rawState.last_display_kind),
    } : undefined;
    if (
      state &&
      state.indexed_bytes === fileStat.size &&
      state.file_size === fileStat.size &&
      state.mtime_ms === fileStat.mtimeMs
    ) return state;

    const rebuild = !state || state.indexed_bytes > fileStat.size || (
      state.indexed_bytes === fileStat.size && state.mtime_ms !== fileStat.mtimeMs
    );
    const start = rebuild ? 0 : state.indexed_bytes;
    const bytes = await this.readByteRange(path, start, fileStat.size);
    const scanned = scanTranscriptBuffer(bytes, start, false);
    let eventCount = rebuild ? 0 : state.event_count;
    let rawMessageCount = rebuild ? 0 : state.raw_message_count;
    let displayGroupCount = rebuild ? 0 : state.display_group_count;
    let lastDisplayKind = rebuild ? "" : state.last_display_kind;
    let latestContext: JsonObject | undefined;

    const transaction = this.db().transaction(() => {
      if (rebuild) {
        this.db().query("DELETE FROM transcript_display_groups WHERE session_id = ?").run(sessionId);
        this.db().query("DELETE FROM transcript_artifacts WHERE session_id = ?").run(sessionId);
        this.db().query("DELETE FROM transcript_attachments WHERE session_id = ?").run(sessionId);
        this.db().query(`
          UPDATE agent_sessions SET model = '', reasoning_effort = '', model_config = '{}'
          WHERE session_id = ?
        `).run(sessionId);
      }
      for (const line of scanned.lines) {
        const event = line.event;
        eventCount += 1;
        if (text(event.kind) === "turn_context") latestContext = event;
        if (text(event.kind) === "message") {
          rawMessageCount += 1;
          const message = parseObject(event.message);
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              const attachment = transcriptAttachment(block);
              if (!attachment) continue;
              this.db().query(`
                INSERT OR REPLACE INTO transcript_attachments
                  (session_id, attachment_id, turn_id, path, name, size_bytes, media_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                sessionId,
                attachment.attachment_id,
                attachment.turn_id,
                attachment.path,
                attachment.name,
                attachment.size_bytes,
                attachment.media_type,
                attachment.ts,
              );
            }
          }
          const role = text(message.role).toLowerCase();
          const turnId = text(event.turn_id) || text(latestContext?.turn_id);
          if (role === "assistant" || role === "tool") {
            if (lastDisplayKind === "assistant_tool" && displayGroupCount > 0) {
              this.db().query(`
                UPDATE transcript_display_groups SET
                  byte_end = ?, turn_id = CASE WHEN turn_id = '' THEN ? ELSE turn_id END
                WHERE session_id = ? AND group_number = ?
              `).run(line.byteEnd, turnId, sessionId, displayGroupCount - 1);
            } else {
              this.db().query(`
                INSERT INTO transcript_display_groups
                  (session_id, group_number, byte_start, byte_end, group_kind, turn_id)
                VALUES (?, ?, ?, ?, 'assistant_tool', ?)
              `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd, turnId);
              displayGroupCount += 1;
            }
            lastDisplayKind = "assistant_tool";
          } else if (role) {
            this.db().query(`
              INSERT INTO transcript_display_groups
                (session_id, group_number, byte_start, byte_end, group_kind, turn_id)
              VALUES (?, ?, ?, ?, 'message', ?)
            `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd, turnId);
            displayGroupCount += 1;
            lastDisplayKind = "message";
          }
          continue;
        }
        const artifact = transcriptArtifact(event);
        if (artifact) {
          this.db().query(`
            INSERT OR REPLACE INTO transcript_artifacts
              (session_id, artifact_id, turn_id, tool_call_id, path, name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            sessionId,
            artifact.artifact_id,
            artifact.turn_id,
            artifact.tool_call_id,
            artifact.path,
            artifact.name,
            artifact.ts,
          );
          if (lastDisplayKind === "assistant_tool" && displayGroupCount > 0) {
            this.db().query(`
              UPDATE transcript_display_groups SET
                byte_end = ?, turn_id = CASE WHEN turn_id = '' THEN ? ELSE turn_id END
              WHERE session_id = ? AND group_number = ?
            `).run(line.byteEnd, artifact.turn_id, sessionId, displayGroupCount - 1);
          } else {
            this.db().query(`
              INSERT INTO transcript_display_groups
                (session_id, group_number, byte_start, byte_end, group_kind, turn_id)
              VALUES (?, ?, ?, ?, 'artifact', ?)
            `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd, artifact.turn_id);
            displayGroupCount += 1;
          }
          lastDisplayKind = "assistant_tool";
          continue;
        }
        const turnError = transcriptTurnError(event);
        if (turnError) {
          if (lastDisplayKind === "assistant_tool" && displayGroupCount > 0) {
            this.db().query(`
              UPDATE transcript_display_groups SET
                byte_end = ?, turn_id = CASE WHEN turn_id = '' THEN ? ELSE turn_id END
              WHERE session_id = ? AND group_number = ?
            `).run(line.byteEnd, turnError.turn_id, sessionId, displayGroupCount - 1);
          } else {
            this.db().query(`
              INSERT INTO transcript_display_groups
                (session_id, group_number, byte_start, byte_end, group_kind, turn_id)
              VALUES (?, ?, ?, ?, 'assistant_tool', ?)
            `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd, turnError.turn_id);
            displayGroupCount += 1;
          }
          lastDisplayKind = "assistant_tool";
          continue;
        }
        if (transcriptDisplayMarker(event)) {
          this.db().query(`
            INSERT INTO transcript_display_groups
              (session_id, group_number, byte_start, byte_end, group_kind, turn_id)
            VALUES (?, ?, ?, ?, 'marker', '')
          `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd);
          displayGroupCount += 1;
          lastDisplayKind = "marker";
        }
      }
      if (latestContext) {
        const modelConfig: JsonObject = {
          provider: text(latestContext.provider),
          credential_source: latestContext.credential_source === "cloud" ? "cloud" : "local",
          thinking_enabled: latestContext.thinking_enabled === true,
          provider_generation: Math.max(0, Math.trunc(Number(latestContext.provider_generation ?? 0))),
          context_window_tokens: Math.max(0, Math.trunc(Number(latestContext.context_window_tokens ?? 0))),
        };
        this.db().query(`
          UPDATE agent_sessions SET model = ?, reasoning_effort = ?, model_config = ?
          WHERE session_id = ?
        `).run(
          text(latestContext.model),
          text(latestContext.effort),
          JSON.stringify(modelConfig),
          sessionId,
        );
      }
      this.db().query(`
        INSERT INTO transcript_file_state (
          session_id, file_size, mtime_ms, indexed_bytes, event_count,
          raw_message_count, display_group_count, last_display_kind, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          indexed_bytes = excluded.indexed_bytes,
          event_count = excluded.event_count,
          raw_message_count = excluded.raw_message_count,
          display_group_count = excluded.display_group_count,
          last_display_kind = excluded.last_display_kind,
          updated_at = excluded.updated_at
      `).run(
        sessionId,
        fileStat.size,
        fileStat.mtimeMs,
        scanned.completeBytes,
        eventCount,
        rawMessageCount,
        displayGroupCount,
        lastDisplayKind,
        Date.now() / 1_000,
      );
    });
    transaction();
    return {
      file_size: fileStat.size,
      mtime_ms: fileStat.mtimeMs,
      indexed_bytes: scanned.completeBytes,
      event_count: eventCount,
      raw_message_count: rawMessageCount,
      display_group_count: displayGroupCount,
      last_display_kind: lastDisplayKind,
    };
  }

  private async readIndexedDisplayPage(
    sessionId: string,
    path: string,
    state: TranscriptFileState,
    options: DashboardSessionPageOptions,
  ): Promise<TranscriptDisplayPage> {
    const total = state.display_group_count;
    const { limit, start, end } = displayWindow(sessionId, total, options);
    const groups = this.allPrepared<{
      group_number: number;
      byte_start: number;
      byte_end: number;
      turn_id: string;
      turn_status: string | null;
      turn_elapsed_ms: number | null;
    }>(`
      SELECT groups.group_number, groups.byte_start, groups.byte_end, groups.turn_id,
             usage.status AS turn_status, usage.elapsed_ms AS turn_elapsed_ms
      FROM transcript_display_groups AS groups
      -- turn_usage belongs to UsageStore; this stays a read-only join so the
      -- display page keeps resolving turn status in a single query.
      LEFT JOIN turn_usage AS usage
        ON usage.session_id = groups.session_id AND usage.turn_id = groups.turn_id
      WHERE groups.session_id = ? AND groups.group_number >= ? AND groups.group_number < ?
      ORDER BY groups.group_number ASC
    `, sessionId, start, end);
    const messages: JsonObject[] = [];
    if (groups.length > 0) {
      const byteStart = Number(groups[0]!.byte_start);
      const byteEnd = Number(groups.at(-1)!.byte_end);
      const bytes = await this.readByteRange(path, byteStart, byteEnd);
      const visibleArtifactPaths = new Set<string>();
      for (const group of groups) {
        const groupStart = Number(group.byte_start);
        const groupEnd = Number(group.byte_end);
        const groupBytes = bytes.subarray(groupStart - byteStart, groupEnd - byteStart);
        const displayGroupId = displayGroupCursor(sessionId, Number(group.group_number));
        const turnId = text(group.turn_id);
        const turnStatus = ["completed", "cancelled", "error"].includes(text(group.turn_status))
          ? text(group.turn_status)
          : null;
        const elapsed = group.turn_elapsed_ms === null
          ? null
          : Math.max(0, Math.trunc(Number(group.turn_elapsed_ms)));
        const turn = turnId ? {
          turn_id: turnId,
          status: turnStatus,
          elapsed_ms: Number.isFinite(elapsed) ? elapsed : null,
        } : undefined;
        let messageOrdinal = 0;
    let latestMessage: JsonObject | undefined;
        for (const { event } of scanTranscriptBuffer(groupBytes, groupStart, true).lines) {
          if (text(event.kind) === "message") {
            const message = parseObject(event.message);
            if (text(message.role)) {
              latestMessage = {
                ...publicMessage(message),
            display_id: `${displayGroupId}:${messageOrdinal++}`,
            source_reason: text(event.reason),
                display_group_id: displayGroupId,
                created_at: transcriptEventTimestamp(event),
                ...(turn ? { turn } : {}),
              };
              messages.push(latestMessage);
            }
            continue;
          }
          const artifact = transcriptArtifact(event);
          if (artifact && latestMessage) {
            const key = `${artifact.turn_id}\u0000${artifact.path}`;
            if (visibleArtifactPaths.has(key)) continue;
            visibleArtifactPaths.add(key);
            const existing = Array.isArray(latestMessage.artifacts) ? latestMessage.artifacts : [];
            latestMessage.artifacts = [...existing, publicArtifact(artifact)];
            continue;
          }
          const turnError = transcriptTurnError(event);
          if (turnError) {
            latestMessage = {
              role: "assistant",
              display_id: `${displayGroupId}:${messageOrdinal++}`,
              content: [{ type: "text", text: turnError.message }],
              display_group_id: displayGroupId,
              created_at: turnError.ts,
              ...(turn ? { turn } : {}),
            };
            messages.push(latestMessage);
            continue;
          }
          const marker = transcriptDisplayMarker(event);
          if (marker) {
            latestMessage = {
              ...marker,
              display_id: `${displayGroupId}:${messageOrdinal++}`,
              display_group_id: displayGroupId,
              created_at: transcriptEventTimestamp(event),
            };
            messages.push(latestMessage);
          }
        }
      }
    }
    return {
      messages,
      page: displayPageMetadata(sessionId, total, state.raw_message_count, limit, start, end),
    };
  }

  private transcriptPath(sessionId: string): string {
    const safe = text(sessionId).replaceAll(/[^A-Za-z0-9_.-]/g, "_");
    return join(dirname(this.path), "session_transcripts", `${safe}.jsonl`);
  }

  private loadMessagesWithoutTranscript(safeSessionId: string): RuntimeMessage[] {
    const safe = text(safeSessionId).replaceAll(/[^A-Za-z0-9_.-]/g, "_");
    const legacyPath = join(dirname(this.path), "session_messages", `${safe}.jsonl`);
    if (existsSync(legacyPath)) {
      throw new Error(`session ${safe} still uses the legacy session_messages format; ${legacyTranscriptMigrationHint}`);
    }
    return [];
  }
}
