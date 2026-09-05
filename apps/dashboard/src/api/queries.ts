import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import {
  mergeLatestConversationWindow,
  appendConversationWindow,
  boundConversationWindow,
  normalizeSessionList,
  prependConversationWindow,
} from "../features/sessions/model";
import type {
  ApiList,
  ChannelHealthList,
  CliCommandPayload,
  ConnectorPayload,
  ModelPayload,
  SessionDetailPayload,
  SessionListPayload,
  SessionPayload,
  SkillContentPayload,
  SkillPayload,
  SkillReferenceContentPayload,
  SkillStatPayload,
  StatsOverviewPayload,
  ToolsetPayload,
  ToolStatPayload,
} from "./payloads";

export const SESSION_LIST_PAGE_SIZE = 10;
export const SESSION_MESSAGE_PAGE_LIMIT = 10;
export const ACTIVE_DATA_STALE_TIME_MS = 5_000;
export const STATS_REFRESH_INTERVAL_MS = 30_000;
export const CATALOG_STALE_TIME_MS = 5 * 60_000;
export const GATEWAY_LIFETIME_STALE_TIME_MS = Number.POSITIVE_INFINITY;

export function queryError(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

export function useSessionsInfiniteQuery(query: string, enabled = true) {
  const normalizedQuery = query.trim();
  return useInfiniteQuery({
    queryKey: dashboardQueryKeys.sessions.list(normalizedQuery),
    queryFn: async ({ pageParam }) => {
      return normalizeSessionList(
        await callDashboard({
          operation: "sessions.list",
          input: { query: normalizedQuery, limit: SESSION_LIST_PAGE_SIZE, offset: pageParam },
        }),
        SESSION_LIST_PAGE_SIZE,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = (lastPage.offset ?? 0) + lastPage.items.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled,
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
  });
}

export function flattenSessionPages(
  pages: SessionListPayload[] | undefined,
): { items: SessionPayload[]; total: number; summary: SessionListPayload["summary"] | undefined } {
  const seen = new Set<string>();
  const items: SessionPayload[] = [];
  for (const page of pages ?? []) {
    for (const session of page.items) {
      if (seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      items.push(session);
    }
  }
  return {
    items,
    total: pages?.[0]?.total ?? 0,
    summary: pages?.[0]?.summary,
  };
}

export function useSessionDetailQuery(sessionId: string, before: string | undefined, enabled = true) {
  const pageKey = before ?? "latest";
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.detail(sessionId, pageKey),
    queryFn: () => callDashboard({
      operation: "sessions.detail",
      input: {
        session_id: sessionId,
        message_limit: SESSION_MESSAGE_PAGE_LIMIT,
        ...(before === undefined ? {} : { message_before: before }),
      },
    }),
    enabled: enabled && Boolean(sessionId),
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
  });
}

export function useSessionConversationQuery(sessionId: string, enabled = true) {
  const queryClient = useQueryClient();
  const latestQuery = useSessionDetailQuery(sessionId, undefined, enabled);
  const [data, setData] = useState<SessionDetailPayload>();
  const state = useRef<SessionDetailPayload | undefined>(undefined);
  const visible = useRef<string[]>([]);
  const generation = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const requests = useRef(new Map<string, Promise<SessionDetailPayload | undefined>>());
  const [fetching, setFetching] = useState<string | null>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  const publish = useCallback((value: SessionDetailPayload) => { state.current = value; setData(value); }, []);
  useEffect(() => {
    generation.current += 1;
    state.current = undefined; setData(undefined); visible.current = []; requests.current.clear();
    setPageError(null); setFetching(null);
    return () => {
      generation.current += 1;
      queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(sessionId), type: "inactive" });
    };
  }, [sessionId, queryClient]);
  useEffect(() => {
    const latest = latestQuery.data;
    if (latest?.session.session_id !== sessionId) return;
    publish(boundConversationWindow(mergeLatestConversationWindow(state.current, latest), visible.current));
  }, [latestQuery.data, sessionId, publish]);
  const fetchPage = useCallback((direction: "older" | "newer"): Promise<SessionDetailPayload | undefined> => {
    const existing = requests.current.get(direction);
    if (existing) return existing;
    const page = state.current;
    const cursor = direction === "older" ? page?.messages_page.previous_cursor : page?.messages_page.next_cursor;
    if (!enabled || !cursor || page?.session.session_id !== sessionId) return Promise.resolve(undefined);
    const epoch = generation.current;
    setFetching(direction); setPageError(null);
    const request = callDashboard({ operation: "sessions.detail", input: {
      session_id: sessionId, message_limit: SESSION_MESSAGE_PAGE_LIMIT,
      ...(direction === "older" ? { message_before: cursor } : { message_after: cursor }),
    } }).then((incoming) => {
      if (epoch !== generation.current || currentSession.current !== sessionId || !state.current) return undefined;
      const merged = direction === "older" ? prependConversationWindow(state.current, incoming) : appendConversationWindow(state.current, incoming);
      const bounded = boundConversationWindow(merged, visible.current, direction);
      publish(bounded);
      return bounded;
    }).catch((error: unknown) => {
      if (epoch === generation.current && currentSession.current === sessionId) setPageError(error);
      throw error;
    }).finally(() => {
      if (epoch !== generation.current || currentSession.current !== sessionId) return;
      requests.current.delete(direction); setFetching(null);
    });
    requests.current.set(direction, request);
    return request;
  }, [enabled, sessionId, publish]);
  const jumpToLatest = useCallback(() => {
    generation.current += 1; requests.current.clear(); setFetching(null); setPageError(null); visible.current = [];
    if (latestQuery.data?.session.session_id === sessionId) publish(boundConversationWindow(latestQuery.data));
    void latestQuery.refetch();
  }, [latestQuery.data, latestQuery.refetch, sessionId, publish]);
  return {
    data: data?.session.session_id === sessionId ? data : undefined,
    error: pageError ?? latestQuery.error,
    isPending: latestQuery.isPending && !data,
    isFetching: latestQuery.isFetching || fetching !== null,
    isRefetchError: latestQuery.isRefetchError,
    hasPreviousPage: Boolean(data?.messages_page.has_previous),
    hasNextPage: Boolean(data?.messages_page.has_next),
    isFetchingPreviousPage: fetching === "older",
    isFetchingNextPage: fetching === "newer",
    isFetchPreviousPageError: pageError !== null,
    fetchPreviousPage: useCallback(() => fetchPage("older"), [fetchPage]),
    fetchNextPage: useCallback(() => fetchPage("newer"), [fetchPage]),
    setVisibleGroups: useCallback((ids: string[]) => { visible.current = ids; }, []),
    jumpToLatest,
  };
}

export function useConversationActivityQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.activity(sessionId),
    queryFn: () => callDashboard({
      operation: "sessions.activity",
      input: { session_id: sessionId },
    }),
    enabled: enabled && Boolean(sessionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useStatsOverviewQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("overview", days),
    queryFn: () => callDashboard({ operation: "stats.overview", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useSkillStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("skills", days),
    queryFn: () => callDashboard({ operation: "stats.skills.list", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useToolStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("tools", days),
    queryFn: () => callDashboard({ operation: "stats.tools.list", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useChannelHealthQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.channelHealth.all,
    queryFn: () => callDashboard({ operation: "channels.health", input: {} }),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useModelsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.list,
    queryFn: () => callDashboard({ operation: "models.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCurrentModelQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.current,
    queryFn: () => callDashboard({ operation: "models.current", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useConnectorsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.connectors.all,
    queryFn: () => callDashboard({ operation: "connectors.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useSkillsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.list,
    queryFn: () => callDashboard({ operation: "skills.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCommandsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.commands.all,
    queryFn: () => callDashboard({ operation: "commands.list", input: {} }),
    enabled,
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useToolsetsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.tools.all,
    queryFn: () => callDashboard({ operation: "toolsets.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useSkillContentQuery(name: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.content(name),
    queryFn: () => callDashboard({ operation: "skills.content", input: { name } }),
    enabled: enabled && Boolean(name),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useSkillReferenceQuery(name: string, path: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.reference(name, path),
    queryFn: () => callDashboard({ operation: "skills.reference", input: { name, path } }),
    enabled: enabled && Boolean(name) && Boolean(path),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}
