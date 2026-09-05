import type {
  SessionDetailPayload,
  SessionListPayload,
  SessionMessage,
  SessionPayload,
  SessionSummaryPayload,
} from "../../api/payloads";

export const EMPTY_SESSION_SUMMARY: SessionSummaryPayload = {
  total_sessions: 0,
  tool_call_count: 0,
  token_count: 0
};

export function normalizeSessionList(payload: SessionListPayload, pageSize: number): SessionListPayload {
  const summary = payload.summary || EMPTY_SESSION_SUMMARY;
  return {
    ...payload,
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Math.max(0, Number(payload.total) || 0),
    limit: Math.max(1, Number(payload.limit) || pageSize),
    offset: Math.max(0, Number(payload.offset) || 0),
    summary: {
      total_sessions: Math.max(0, Number(summary.total_sessions) || 0),
      tool_call_count: Math.max(0, Number(summary.tool_call_count) || 0),
      token_count: Math.max(0, Number(summary.token_count) || 0)
    }
  };
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

export function groupSidebarSessions(
  sessions: SessionPayload[],
  searching: boolean,
): { pinned: SessionPayload[]; recent: SessionPayload[] } {
  if (searching) return { pinned: [], recent: sessions };
  return {
    pinned: sessions.filter((session) => session.pinned_at > 0),
    recent: sessions.filter((session) => session.pinned_at <= 0),
  };
}

type ConversationDisplayGroup = {
  id: string;
  messages: SessionMessage[];
};

const conversationDisplayGroups = (messages: SessionMessage[]): ConversationDisplayGroup[] => {
  const groups: ConversationDisplayGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (previous?.id === message.display_group_id) previous.messages.push(message);
    else groups.push({ id: message.display_group_id, messages: [message] });
  }
  return groups;
};

const flattenConversationGroups = (groups: ConversationDisplayGroup[]): SessionMessage[] =>
  groups.flatMap((group) => group.messages);

/** Refreshes the mutable transcript tail while preserving a contiguous loaded prefix. */
export function mergeLatestConversationWindow(
  current: SessionDetailPayload | undefined,
  latest: SessionDetailPayload,
): SessionDetailPayload {
  if (!current || current.session.session_id !== latest.session.session_id) return latest;
  const currentGroups = conversationDisplayGroups(current.messages);
  const latestGroups = conversationDisplayGroups(latest.messages);
  if (!latestGroups.length) return latest.messages_page.total === 0 ? latest : current;
  const currentIndexes = new Map(currentGroups.map((group, index) => [group.id, index]));
  const firstOverlap = latestGroups.findIndex((group) => currentIndexes.has(group.id));
  if (firstOverlap < 0) return { ...current, session: latest.session, messages_page: { ...current.messages_page, total: latest.messages_page.total, has_next: true, next_cursor: current.messages_page.newest_cursor } };
  const currentCut = currentIndexes.get(latestGroups[firstOverlap]!.id)!;
  return {
    ...latest,
    messages: flattenConversationGroups([
      ...currentGroups.slice(0, currentCut),
      ...latestGroups.slice(firstOverlap),
    ]),
    messages_page: {
      ...latest.messages_page,
      group_cursors: [...pageGroups(current).slice(0, pageGroups(current).indexOf(latestGroups[firstOverlap]!.id)), ...pageGroups(latest).slice(pageGroups(latest).indexOf(latestGroups[firstOverlap]!.id))],
      oldest_cursor: current.messages_page.oldest_cursor,
      previous_cursor: current.messages_page.previous_cursor,
      has_previous: current.messages_page.has_previous,
    },
  };
}

/** Prepends a cursor page without disturbing the latest transcript watermark. */
export function prependConversationWindow(
  current: SessionDetailPayload,
  earlier: SessionDetailPayload,
): SessionDetailPayload {
  if (current.session.session_id !== earlier.session.session_id) return current;
  const currentGroups = conversationDisplayGroups(current.messages);
  const currentIds = new Set(currentGroups.map((group) => group.id));
  const earlierGroups = conversationDisplayGroups(earlier.messages)
    .filter((group) => !currentIds.has(group.id));
  return {
    ...current,
    messages: flattenConversationGroups([...earlierGroups, ...currentGroups]),
    messages_page: {
      ...current.messages_page,
      group_cursors: [...pageGroups(earlier).filter((id) => !pageGroups(current).includes(id)), ...pageGroups(current)],
      oldest_cursor: earlier.messages_page.oldest_cursor ?? current.messages_page.oldest_cursor,
      previous_cursor: earlier.messages_page.previous_cursor,
      has_previous: earlier.messages_page.has_previous,
    },
  };
}

export const CONVERSATION_GROUP_BUDGET = 60;
export const CONVERSATION_BYTE_BUDGET = 16 * 1024 * 1024;
const pageGroups = (page: SessionDetailPayload): string[] => page.messages_page.group_cursors
  ?? [...new Set(page.messages.map((message) => message.display_group_id))];

/** Evict only whole, non-visible groups. The current visible group may exceed the budget. */
export function boundConversationWindow(
  page: SessionDetailPayload, visible: readonly string[] = [], direction: "older" | "newer" = "newer",
): SessionDetailPayload {
  const groups = pageGroups(page).slice();
  const protectedIds = new Set(visible);
  const sizes = new Map(groups.map((id) => [id, new TextEncoder().encode(JSON.stringify(page.messages.filter((m) => m.display_group_id === id))).byteLength]));
  let bytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  let removedStart = false, removedEnd = false;
  while (groups.length > 1 && (groups.length > CONVERSATION_GROUP_BUDGET || bytes > CONVERSATION_BYTE_BUDGET)) {
    const first = groups[0]!, last = groups.at(-1)!;
    const removeStart = direction === "newer" ? !protectedIds.has(first) : protectedIds.has(last);
    const candidate = removeStart ? first : last;
    if (protectedIds.has(candidate)) break;
    bytes -= sizes.get(candidate) ?? 0;
    if (removeStart) { groups.shift(); removedStart = true; } else { groups.pop(); removedEnd = true; }
  }
  const ids = new Set(groups);
  return { ...page, messages: page.messages.filter((m) => ids.has(m.display_group_id)), messages_page: {
    ...page.messages_page, group_cursors: groups,
    oldest_cursor: groups[0] ?? null, newest_cursor: groups.at(-1) ?? null,
    previous_cursor: removedStart ? groups[0]! : page.messages_page.previous_cursor,
    has_previous: removedStart || page.messages_page.has_previous,
    next_cursor: removedEnd ? groups.at(-1)! : page.messages_page.next_cursor,
    has_next: removedEnd || page.messages_page.has_next,
  } };
}

export function appendConversationWindow(current: SessionDetailPayload, later: SessionDetailPayload): SessionDetailPayload {
  if (current.session.session_id !== later.session.session_id) return current;
  const ids = new Set(pageGroups(later));
  return { ...current, messages: [...current.messages.filter((m) => !ids.has(m.display_group_id)), ...later.messages], messages_page: {
    ...current.messages_page, total: later.messages_page.total,
    next_cursor: later.messages_page.next_cursor, has_next: later.messages_page.has_next,
    newest_cursor: later.messages_page.newest_cursor,
    group_cursors: [...pageGroups(current).filter((id) => !ids.has(id)), ...pageGroups(later)],
  } };
}
