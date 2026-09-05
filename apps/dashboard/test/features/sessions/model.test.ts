import { describe, expect, test } from "bun:test";
import type { SessionDetailPayload, SessionMessage, SessionPayload } from "../../../src/api/payloads";
import {
  groupSidebarSessions,
  mergeLatestConversationWindow,
  prependConversationWindow,
} from "../../../src/features/sessions/model";

const messages = (ids: string[], suffix = "old"): SessionMessage[] => ids.map((id) => ({
  display_group_id: id,
  role: "user",
  content: `${id}-${suffix}`,
}));

const detail = (
  ids: string[],
  options: { previous?: string | null; fetchedAt?: number; suffix?: string; total?: number } = {},
): SessionDetailPayload => ({
  session: {
    session_id: "session-1",
    title: "Session",
    source: {},
    source_summary: { platform: "desktop", chat_type: "direct" },
    workspace: { directory: "/workspace", worktree: "/workspace" },
    model: "test",
    reasoning_effort: "",
    model_config: {},
    pinned_at: 0,
    created_at: 1,
    last_active_at: 1,
    message_count: ids.length,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    api_call_count: 0,
  },
  messages: messages(ids, options.suffix),
  messages_page: {
    fetched_at: options.fetchedAt ?? 1,
    total: options.total ?? ids.length,
    raw_message_total: options.total ?? ids.length,
    limit: 10,
    oldest_cursor: ids[0] ?? null,
    newest_cursor: ids.at(-1) ?? null,
    previous_cursor: options.previous ?? null,
    has_previous: Boolean(options.previous),
  },
});

const sidebarSession = (sessionId: string, pinnedAt: number): SessionPayload => ({
  ...detail([]).session,
  session_id: sessionId,
  title: sessionId,
  pinned_at: pinnedAt,
});

describe("sidebar session groups", () => {
  test("separates pinned sessions while preserving server order", () => {
    const sessions = [sidebarSession("pin-2", 2), sidebarSession("pin-1", 1), sidebarSession("recent", 0)];
    const grouped = groupSidebarSessions(sessions, false);
    expect(grouped.pinned.map((session) => session.session_id)).toEqual(["pin-2", "pin-1"]);
    expect(grouped.recent.map((session) => session.session_id)).toEqual(["recent"]);
  });

  test("keeps search results in one server-ordered group", () => {
    const sessions = [sidebarSession("pinned", 2), sidebarSession("recent", 0)];
    expect(groupSidebarSessions(sessions, true)).toEqual({ pinned: [], recent: sessions });
  });
});

describe("conversation cursor windows", () => {
  test("replaces an overlapping tail and preserves the loaded prefix", () => {
    const current = detail(["g0", "g1", "g2", "g3"], { fetchedAt: 10 });
    const latest = detail(["g2", "g3", "g4"], { fetchedAt: 20, suffix: "new", total: 5 });

    const merged = mergeLatestConversationWindow(current, latest);

    expect(merged.messages.map((message) => message.display_group_id))
      .toEqual(["g0", "g1", "g2", "g3", "g4"]);
    expect(merged.messages.find((message) => message.display_group_id === "g3")?.content).toBe("g3-new");
    expect(merged.messages_page).toMatchObject({
      fetched_at: 20,
      total: 5,
      oldest_cursor: "g0",
      newest_cursor: "g4",
      previous_cursor: null,
      has_previous: false,
    });
  });

  test("keeps the reading window when the latest tail has no overlap", () => {
    const merged = mergeLatestConversationWindow(
      detail(["g0", "g1"]),
      detail(["g10", "g11"], { total: 12 }),
    );
    expect(merged.messages.map((message) => message.display_group_id)).toEqual(["g0", "g1"]);
    expect(merged.messages_page.oldest_cursor).toBe("g0");
    expect(merged.messages_page.has_next).toBe(true);
  });

  test("prepends older groups without replacing the latest watermark", () => {
    const current = detail(["g2", "g3"], { previous: "g2", fetchedAt: 20, total: 4 });
    const earlier = detail(["g0", "g1"], { fetchedAt: 30, total: 4 });

    const merged = prependConversationWindow(current, earlier);

    expect(merged.messages.map((message) => message.display_group_id))
      .toEqual(["g0", "g1", "g2", "g3"]);
    expect(merged.messages_page).toMatchObject({
      fetched_at: 20,
      oldest_cursor: "g0",
      newest_cursor: "g3",
      has_previous: false,
    });
  });
});
