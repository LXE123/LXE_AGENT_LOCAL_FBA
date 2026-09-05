import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  DesktopCloudState,
  DesktopConversationActivityPayload,
  DesktopConversationTurnPayload,
  DesktopHealth,
  DesktopInputAttachmentPayload,
} from "@lxe/desktop-protocol";
import {
  ChartColumn,
  BriefcaseBusiness,
  House,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
} from "lucide-react";

import "./styles.css";
import { callDashboard } from "./api/client";
import { dashboardQueryKeys } from "./api/query-keys";
import { DashboardQueryProvider } from "./api/query-client";
import {
  flattenSessionPages,
  queryError,
  useCommandsQuery,
  useConnectorsQuery,
  useCurrentModelQuery,
  useModelsQuery,
  useConversationActivityQuery,
  useSessionConversationQuery,
  useSessionsInfiniteQuery,
  useSkillsQuery,
  useToolsetsQuery,
} from "./api/queries";
import { EmptyState } from "./shared/components";
import { formatDate, formatNumber } from "./shared/format";
import {
  modelDisabledReasonLabel,
  modelWithOption,
  modelWithThinkingLevel
} from "./features/models/model";
import {
  I18nContext,
  LANGUAGE_STORAGE_KEY,
  UI_TEXT,
  initialLanguage
} from "./shared/i18n";
import type { Language } from "./shared/i18n";
import {
  DARK_MEDIA_QUERY,
  FONT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  initialDashboardFontSize,
  initialDashboardTheme,
  resolveTheme,
} from "./shared/appearance";
import type {
  ApiList,
  ConnectorPayload,
  ModelPayload,
  McpServerPayload,
  SessionPayload,
  ToolsetPayload
} from "./api/payloads";
import type { DetailTarget } from "./shared/ui/detail-target";
import { DetailModal } from "./features/details/view";
import { ConnectionsView } from "./features/integrations/view";
import { DashboardHome } from "./features/home/view";
import { applyDesktopStreamBatch } from "./features/sessions/live-stream";
import { ModelsView } from "./features/models/view";
import { RuntimeStatusPopover } from "./features/runtime-status/view";
import {
  type PendingConversationMessage,
  SessionDetailView,
  SessionsIndex
} from "./features/sessions/view";
import { SkillsView } from "./features/skills/view";
import { StatsView } from "./features/stats/view";
import { ToolsView } from "./features/tools/view";
import { SyntheticPerformerWorkbench } from "./features/workbench/view";
import { WorkbenchIndex } from "./features/workbench/index-view";
import { InputAssetsWorkbench, useInputAssetSlots } from "./features/workbench/input-assets-view";
import { DesktopShell } from "./desktop/shell";
import type { DesktopSettingsSection } from "./desktop/settings-model";
import { DashboardRootErrorBoundary } from "./root-error-boundary";
import { BrandMark } from "./shared/ui/brand-mark";
import {
  dashboardRouteFromHistory,
  type WorkbenchView,
  readStoredCapabilityView,
  storeCapabilityView,
} from "./shared/navigation";
import { useThreeStateSidebar } from "./shared/use-three-state-sidebar";
import type {
  ActivityView,
  CapabilityView,
  DashboardRouteSelection,
  DashboardSection,
} from "./shared/navigation";
const DOCS_HOME_PATH = "README.md";

function WorkspaceView<T extends string>({
  activeView,
  children,
  items,
  label,
  onSelect,
}: {
  activeView: T;
  children: ReactNode;
  items: ReadonlyArray<{ id: T; label: string }>;
  label: string;
  onSelect: (view: T) => void;
}) {
  return (
    <section className="workspace-view">
      <header className="workspace-view-header">
        <h2>{label}</h2>
        <nav aria-label={label} className="workspace-subnav">
          {items.map((item) => (
            <button
              aria-current={activeView === item.id ? "page" : undefined}
              className={activeView === item.id ? "workspace-subnav-item active" : "workspace-subnav-item"}
              key={item.id}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="workspace-view-content">{children}</div>
    </section>
  );
}

function modelsWithCurrentModel(
  current: ApiList<ModelPayload> | undefined,
  model: ModelPayload,
): ApiList<ModelPayload> | undefined {
  if (!current) return current;
  return {
    ...current,
    items: current.items.map((item) =>
      item.provider === model.provider && item.credential_source === model.credential_source
        ? { ...item, ...model }
        : item
    ),
  };
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function routeStateFromLocation(): DashboardRouteSelection {
  const storedCapabilityView = readStoredCapabilityView(browserStorage());
  return dashboardRouteFromHistory(window.history.state, storedCapabilityView);
}

function App({
  desktopCloud,
  desktopHealth,
  language,
  onLanguageChange,
  onOpenDesktopSettings,
  setupComplete,
}: {
  desktopCloud: DesktopCloudState;
  desktopHealth: DesktopHealth;
  language: Language;
  onLanguageChange: (language: Language) => void;
  onOpenDesktopSettings?: (section?: DesktopSettingsSection) => void;
  setupComplete: boolean;
}) {
  const queryClient = useQueryClient();
  const [initialRoute] = useState(() => routeStateFromLocation());
  const t = UI_TEXT[language];
  const [activeSection, setActiveSection] = useState<DashboardSection>(initialRoute.section);
  const [capabilityView, setCapabilityView] = useState<CapabilityView>(initialRoute.capabilityView);
  const [activityView, setActivityView] = useState<ActivityView>(initialRoute.activityView);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>(initialRoute.workbenchView);
  const assetSlots = useInputAssetSlots();
  const assetSlotStatus = assetSlots.slots
    ? t.inputAssets.slotSummary(
        assetSlots.slots.filter((slot) => slot.current !== null).length,
        assetSlots.slots.length,
      )
    : "";
  const [error, setError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [pendingConversationMessages, setPendingConversationMessages] = useState<PendingConversationMessage[]>([]);
  const sidebar = useThreeStateSidebar(browserStorage());
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);
  const dashboardRuntimeReady = desktopHealth.gateway === "ready"
    && desktopHealth.agent_cli === "ready";

  const sessionsQuery = useSessionsInfiniteQuery(debouncedQuery, dashboardRuntimeReady);
  const sessionDetailQuery = useSessionConversationQuery(
    selectedSessionId,
    dashboardRuntimeReady && activeSection === "sessions" && !newConversation,
  );
  const conversationActivityQuery = useConversationActivityQuery(
    selectedSessionId,
    dashboardRuntimeReady && activeSection === "sessions" && !newConversation,
  );
  const capabilitiesOpen = activeSection === "capabilities";
  const modelsQuery = useModelsQuery(
    dashboardRuntimeReady
      && (activeSection === "sessions" || (capabilitiesOpen && capabilityView === "models")),
  );
  const currentModelQuery = useCurrentModelQuery(dashboardRuntimeReady);
  const connectorsQuery = useConnectorsQuery(
    dashboardRuntimeReady && capabilitiesOpen && capabilityView === "connections",
  );
  const skillsQuery = useSkillsQuery(
    dashboardRuntimeReady && capabilitiesOpen && capabilityView === "skills",
  );
  const commandsQuery = useCommandsQuery(
    dashboardRuntimeReady && capabilitiesOpen && capabilityView === "skills",
  );
  const toolsetsQuery = useToolsetsQuery(
    dashboardRuntimeReady
      && capabilitiesOpen
      && (capabilityView === "tools" || capabilityView === "connections"),
  );
  const sessions = flattenSessionPages(sessionsQuery.data?.pages);

  useEffect(() => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    return desktop.onConversationEvent(({ activity }) => {
      queryClient.setQueryData(
        dashboardQueryKeys.sessions.activity(activity.session_id),
        activity,
      );
      if (activity.latest) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(activity.session_id) }),
        ]);
      }
    });
  }, [queryClient]);

  useEffect(() => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    const pending = new Map<string, Parameters<typeof applyDesktopStreamBatch>[1][]>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batches = [...pending.entries()];
      pending.clear();
      for (const [sessionId, sessionBatches] of batches) {
        const key = dashboardQueryKeys.sessions.activity(sessionId);
        let gap = false;
        queryClient.setQueryData<DesktopConversationActivityPayload>(key, (current) => {
          if (!current) return current;
          let activity = current;
          for (const batch of sessionBatches) {
            const result = applyDesktopStreamBatch(activity, batch);
            if (result.status === "gap") {
              gap = true;
              break;
            }
            activity = result.activity;
          }
          return gap ? current : activity;
        });
        if (gap) void queryClient.invalidateQueries({ queryKey: key });
      }
    };
    const unsubscribe = desktop.onConversationStreamEvent(({ batch }) => {
      const queued = pending.get(batch.session_id) ?? [];
      queued.push(batch);
      pending.set(batch.session_id, queued);
      if (!frame) frame = window.requestAnimationFrame(flush);
    });
    return () => {
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [queryClient]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeStateFromLocation();
      setActiveSection(nextRoute.section);
      setCapabilityView(nextRoute.capabilityView);
      setActivityView(nextRoute.activityView);
      setWorkbenchView(nextRoute.workbenchView);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  useEffect(() => {
    storeCapabilityView(capabilityView, browserStorage());
  }, [capabilityView]);

  useEffect(() => {
    if (!dashboardRuntimeReady) setDetailTarget(null);
  }, [dashboardRuntimeReady]);

  function handleSessionQueryChange(value: string) {
    setQuery(value);
  }

  function loadMoreSessions() {
    if (dashboardRuntimeReady && !sessionsQuery.isFetchingNextPage && sessionsQuery.hasNextPage) {
      void sessionsQuery.fetchNextPage();
    }
  }

  function handleSessionSearchToggle() {
    sidebar.openForSearch();
    setSessionSearchOpen(true);
    setSessionSearchFocusKey((current) => current + 1);
  }

  // Keep the focused conversation populated by default.
  useEffect(() => {
    if (activeSection === "sessions" && !newConversation && !selectedSessionId && sessions.items.length > 0) {
      setSelectedSessionId(sessions.items[0].session_id);
    }
  }, [activeSection, newConversation, selectedSessionId, sessions.items]);

  function pushDashboardRoute(
    section: DashboardSection,
    nextCapabilityView = capabilityView,
    nextActivityView = activityView,
    nextWorkbenchView = workbenchView,
  ) {
    const nextState = {
      section,
      capabilityView: nextCapabilityView,
      activityView: nextActivityView,
      workbenchView: nextWorkbenchView,
    };
    const currentState = window.history.state;
    const stateChanged = currentState?.section !== section
      || currentState?.capabilityView !== nextCapabilityView
      || currentState?.activityView !== nextActivityView
      || currentState?.workbenchView !== nextWorkbenchView;
    if (window.location.pathname !== "/" || stateChanged) {
      window.history.pushState(nextState, "", "/");
    }
  }

  function openDashboardSection(section: DashboardSection) {
    const nextActivityView = section === "activity" ? "stats" : activityView;
    // Re-entering the workbench from the sidebar always lands on the tool index.
    const nextWorkbenchView = section === "workbench" ? "index" : workbenchView;
    pushDashboardRoute(section, capabilityView, nextActivityView, nextWorkbenchView);
    setActiveSection(section);
    setActivityView(nextActivityView);
    setWorkbenchView(nextWorkbenchView);
  }

  function openWorkbenchView(view: WorkbenchView) {
    pushDashboardRoute("workbench", capabilityView, activityView, view);
    setActiveSection("workbench");
    setWorkbenchView(view);
  }

  function openCapabilityView(view: CapabilityView) {
    pushDashboardRoute("capabilities", view, activityView);
    setActiveSection("capabilities");
    setCapabilityView(view);
  }

  function openActivityView(view: ActivityView) {
    pushDashboardRoute("activity", capabilityView, view);
    setActiveSection("activity");
    setActivityView(view);
  }

  function openSession(session: SessionPayload) {
    pushDashboardRoute("sessions");
    setActiveSection("sessions");
    setSelectedSessionId(session.session_id);
    setNewConversation(false);
  }

  function startNewConversation() {
    pushDashboardRoute("sessions");
    setActiveSection("sessions");
    setSelectedSessionId("");
    setNewConversation(true);
  }

  async function sendConversation(text: string, attachments: DesktopInputAttachmentPayload[]): Promise<void> {
    const pendingId = crypto.randomUUID();
    const pendingMessage: PendingConversationMessage = {
      pendingId,
      sessionId: selectedSessionId,
      text,
      attachments,
      createdAt: Date.now(),
    };
    setPendingConversationMessages((current) => [...current, pendingMessage]);
    const result = await callDashboard({
      operation: "sessions.send",
      input: {
        ...(selectedSessionId ? { session_id: selectedSessionId } : {}),
        text,
        client_message_id: pendingId,
        ...(attachments.length ? { attachment_ids: attachments.map((item) => item.attachment_id) } : {}),
      },
    }).catch((cause) => {
      setPendingConversationMessages((current) => current.map((item) => item.pendingId === pendingId ? { ...item, error: cause instanceof Error ? cause.message : String(cause) } : item));
      throw cause;
    });
    queryClient.setQueryData<DesktopConversationActivityPayload>(
      dashboardQueryKeys.sessions.activity(result.session_id),
      (current) => {
        const optimisticTurn: DesktopConversationTurnPayload = {
          turn_id: result.turn_id,
          message_id: result.message_id,
          client_message_id: pendingId,
          created_at: pendingMessage.createdAt,
          text,
          ...(attachments.length ? { attachments } : {}),
          state: result.state,
          started_at: 0,
          user_persisted_at: 0,
          settled_at: 0,
        };
        const activity = current ?? {
          session_id: result.session_id,
          active: null,
          queued: [],
          latest: null,
        };
        if ([activity.active, activity.latest, ...activity.queued].some((turn) => turn?.turn_id === result.turn_id)) return activity;
        if (result.state === "running") {
          return {
            ...activity,
            active: optimisticTurn,
            queued: activity.queued.filter((turn) => turn.turn_id !== result.turn_id),
          };
        }
        return {
          ...activity,
          queued: activity.queued.some((turn) => turn.turn_id === result.turn_id)
            ? activity.queued
            : [...activity.queued, optimisticTurn],
        };
      },
    );
    setPendingConversationMessages((current) => current.map((item) => item.pendingId === pendingId ? { ...item, sessionId: result.session_id, turnId: result.turn_id, messageId: result.message_id } : item));
    setSelectedSessionId(result.session_id);
    setNewConversation(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(result.session_id) }),
    ]);
  }

  async function stopConversation(): Promise<void> {
    if (!selectedSessionId) return;
    await callDashboard({ operation: "sessions.stop", input: { session_id: selectedSessionId } });
  }

  async function setSessionPinned(session: SessionPayload, pinned: boolean): Promise<void> {
    await callDashboard({
      operation: "sessions.pin",
      input: { session_id: session.session_id, pinned },
    });
    await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function deleteSession(session: SessionPayload): Promise<void> {
    await callDashboard({
      operation: "sessions.delete",
      input: { session_id: session.session_id },
    });
    queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(session.session_id) });
    queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.activity(session.session_id) });
    if (selectedSessionId === session.session_id) startNewConversation();
    await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function openConversationFile(artifactId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await callDashboard({
      operation: "sessions.file.open",
      input: { session_id: selectedSessionId, artifact_id: artifactId },
    });
    // The operating system's own message is the only useful thing to show here.
    if (!result.opened) throw new Error(result.error);
  }

  async function revealConversationFile(artifactId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await callDashboard({
      operation: "sessions.file.reveal",
      input: { session_id: selectedSessionId, artifact_id: artifactId },
    });
    // Only the filesystem's own text reaches here; a reveal past that point
    // has nothing to report either way.
    if (!result.revealed) throw new Error(result.error);
  }

  async function openConversationAttachment(attachmentId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await callDashboard({
      operation: "sessions.attachment.open",
      input: { session_id: selectedSessionId, attachment_id: attachmentId },
    });
    if (!result.opened) throw new Error(result.error);
  }

  const thinkingMutation = useMutation<
    ModelPayload,
    unknown,
    string,
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: (level) => callDashboard({ operation: "models.thinking.update", input: { level } }),
    onMutate: async (level) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      if (current) {
        const optimistic = modelWithThinkingLevel(current, level);
        queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
        queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      }
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _level, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  const modelMutation = useMutation<
    ModelPayload,
    unknown,
    {
      provider: string;
      model: string;
      credentialSource: "local" | "cloud";
      optimistic: ModelPayload;
    },
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: ({ provider, model, credentialSource }) => callDashboard({
      operation: "models.update",
      input: { provider, model, credential_source: credentialSource },
    }),
    onMutate: async ({ optimistic }) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
      queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _variables, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      setError(modelDisabledReasonLabel(t, queryError(cause)));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  const connectorMutation = useMutation<
    ConnectorPayload,
    unknown,
    ConnectorPayload,
    { connectors?: ApiList<ConnectorPayload> }
  >({
    mutationFn: (connector) => callDashboard({
      operation: "connectors.update",
      input: { id: connector.id, enabled: !connector.enabled },
    }),
    onMutate: async (connector) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.connectors.all });
      const connectors = queryClient.getQueryData<ApiList<ConnectorPayload>>(
        dashboardQueryKeys.connectors.all,
      );
      const nextEnabled = !connector.enabled;
      queryClient.setQueryData<ApiList<ConnectorPayload> | undefined>(
        dashboardQueryKeys.connectors.all,
        (current) => current ? {
          ...current,
          items: current.items.map((item) => item.id === connector.id ? {
            ...item,
            enabled: nextEnabled,
            userDisabled: !nextEnabled,
            everConnected: item.everConnected || nextEnabled,
          } : item),
        } : current,
      );
      return { connectors };
    },
    onError: (cause, _connector, context) => {
      queryClient.setQueryData(dashboardQueryKeys.connectors.all, context?.connectors);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.connectors.all }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.skills.all }),
      ]);
    },
  });

  const mcpMutation = useMutation<
    McpServerPayload,
    unknown,
    McpServerPayload,
    { toolsets?: ApiList<ToolsetPayload> }
  >({
    mutationFn: (server) => callDashboard({
      operation: "mcp.servers.update",
      input: { name: server.name, enabled: !server.enabled },
    }),
    onMutate: async (server) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.tools.all });
      const toolsets = queryClient.getQueryData<ApiList<ToolsetPayload>>(dashboardQueryKeys.tools.all);
      const nextEnabled = !server.enabled;
      queryClient.setQueryData<ApiList<ToolsetPayload> | undefined>(
        dashboardQueryKeys.tools.all,
        (current) => current ? {
          ...current,
          items: current.items.map((toolset) => toolset.name === "mcp" ? {
            ...toolset,
            servers: (toolset.servers || []).map((item) => item.name === server.name ? {
              ...item,
              enabled: nextEnabled,
              status: nextEnabled ? item.status : "disabled",
            } : item),
          } : toolset),
        } : current,
      );
      return { toolsets };
    },
    onError: (cause, _server, context) => {
      queryClient.setQueryData(dashboardQueryKeys.tools.all, context?.toolsets);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.tools.all });
    },
  });

  function setCurrentThinkingLevel(level: string) {
    const current = currentModelQuery.data;
    if (!current || thinkingMutation.isPending || !current.thinking_state?.editable) return;
    thinkingMutation.mutate(level);
  }

  function setCurrentModel(
    provider: string,
    modelName: string,
    credentialSource: "local" | "cloud",
  ) {
    if (modelMutation.isPending) return;
    const providerModel = modelsQuery.data?.items.find((item) =>
      item.provider === provider && item.credential_source === credentialSource
    );
    const selectedOption = providerModel?.model_options.find((option) => option.model === modelName);
    if (!providerModel || !selectedOption) {
      setError(t.models.modelOptionUnavailable);
      return;
    }
    if (!providerModel.selectable) {
      setError(
        providerModel.disabled_reason ? modelDisabledReasonLabel(t, providerModel.disabled_reason) : t.models.providerNotSelectable
      );
      return;
    }

    const optimistic = modelWithOption(
      providerModel,
      selectedOption,
      currentModelQuery.data?.thinking_state,
    );
    modelMutation.mutate({ provider, model: modelName, credentialSource, optimistic });
  }

  function toggleConnector(connector: ConnectorPayload) {
    if (!connectorMutation.isPending) connectorMutation.mutate(connector);
  }

  function toggleMcpServer(server: McpServerPayload) {
    if (!mcpMutation.isPending) mcpMutation.mutate(server);
  }

  const sessionDetail = sessionDetailQuery.data ?? null;
  useEffect(() => {
    const persisted = new Set(sessionDetail?.messages.flatMap((message) => message.client_message_id ? [message.client_message_id] : []) ?? []);
    if (persisted.size) setPendingConversationMessages((current) => current.filter((message) => !persisted.has(message.pendingId)));
  }, [sessionDetail?.messages]);

  const selectedSession = sessions.items.find((session) => session.session_id === selectedSessionId)
    || sessionDetail?.session
    || null;
  const conversationActivity = selectedSessionId
    ? conversationActivityQuery.data ?? null
    : null;
  const visiblePendingConversationMessages = pendingConversationMessages.filter((message) =>
    message.sessionId === selectedSessionId || (newConversation && !message.sessionId)
  );
  const showDashboardHome = activeSection === "home";
  const hasEmbeddedPageHeader = activeSection === "capabilities"
    || activeSection === "activity"
    || activeSection === "workbench"
    || activeSection === "sessions";
  const mcpToolset = toolsetsQuery.data?.items.find((toolset) => toolset.name === "mcp");
  const activeQueries = activeSection === "sessions"
    ? [sessionDetailQuery, conversationActivityQuery, modelsQuery, currentModelQuery]
    : activeSection === "capabilities" && capabilityView === "models"
      ? [modelsQuery, currentModelQuery]
      : activeSection === "capabilities" && capabilityView === "tools"
        ? [toolsetsQuery]
        : activeSection === "capabilities" && capabilityView === "skills"
          ? [skillsQuery, commandsQuery]
          : activeSection === "capabilities" && capabilityView === "connections"
            ? [connectorsQuery, toolsetsQuery]
            : [];
  const activeRefreshing = dashboardRuntimeReady
    && activeQueries.some((current) => current.isFetching && !current.isPending);
  const backgroundError = dashboardRuntimeReady
    ? activeQueries.find((current) => current.isRefetchError)?.error
    : undefined;
  const visibleError = dashboardRuntimeReady ? error || queryError(backgroundError) : "";

  const tabs: Array<{ id: DashboardSection; label: string; icon: ReactNode }> = [
    { id: "home", label: t.nav.home, icon: <House size={16} /> },
    { id: "sessions", label: t.nav.sessions, icon: <MessageSquareText size={16} /> },
    { id: "workbench", label: t.nav.workbench, icon: <BriefcaseBusiness size={16} /> },
    { id: "capabilities", label: t.nav.capabilities, icon: <Sparkles size={16} /> },
    { id: "activity", label: t.nav.activity, icon: <ChartColumn size={16} /> },
  ];
  const capabilityItems: Array<{ id: CapabilityView; label: string }> = [
    { id: "models", label: t.nav.models },
    { id: "skills", label: t.nav.skills },
    { id: "tools", label: t.nav.tools },
    { id: "connections", label: t.nav.connections },
  ];
  const pageTitle = activeSection === "home"
    ? t.home.title
    : activeSection === "sessions"
      ? newConversation ? t.conversation.newTitle : selectedSession?.title || t.sessions.title
      : t.app.title;
  const pageSubtitle = activeSection === "home"
    ? ""
    : activeSection === "sessions"
      ? selectedSession
        ? `${formatDate(selectedSession.last_active_at)} · ${formatNumber(selectedSession.input_tokens + selectedSession.output_tokens)} ${t.sessions.tokenSuffix}`
        : ""
      : "";
  const runtimeStatusNavigationKey = `${activeSection}:${capabilityView}:${activityView}:${selectedSessionId}`;
  const runtimeStatusPopover = (
    <RuntimeStatusPopover
      currentModel={currentModelQuery.data ?? null}
      desktopCloud={desktopCloud}
      desktopHealth={desktopHealth}
      enabled={dashboardRuntimeReady}
      navigationKey={runtimeStatusNavigationKey}
      onOpenModels={() => openCapabilityView("models")}
      onOpenSettings={(section) => onOpenDesktopSettings?.(section)}
    />
  );
  const sessionSidebarExpanded = sidebar.expanded;
  const sidebarMode = sidebar.mode;
  const sidebarVisible = sidebar.visible;
  const shellClassName = [
    "app-shell",
    sidebar.collapsed ? "sidebar-collapsed" : "",
    sidebar.peekOpen ? "sidebar-peeking" : "",
    activeSection === "sessions" ? "sessions-focus" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <main className={shellClassName}>
        <div
          className={sidebarVisible ? "sidebar-window-controls sidebar-visible" : "sidebar-window-controls"}
          {...sidebar.controlProps}
        >
          <button
            aria-controls="app-sidebar"
            aria-expanded={sidebarVisible}
            aria-label={sessionSidebarExpanded ? t.sidebar.collapse : t.sidebar.expand}
            className={
              sidebarVisible
                ? "sidebar-icon-button sidebar-toggle-button is-open"
                : "sidebar-icon-button sidebar-toggle-button"
            }
            onClick={sidebar.toggle}
            ref={sidebar.toggleRef}
            title={sessionSidebarExpanded ? t.sidebar.collapse : t.sidebar.expand}
            type="button"
          >
            {sessionSidebarExpanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          {sidebarVisible ? (
            <button
              aria-label={t.sessions.searchAria}
              aria-pressed={sessionSearchOpen}
              className={
                sessionSearchOpen
                  ? "sidebar-icon-button sidebar-search-button is-selected"
                  : "sidebar-icon-button sidebar-search-button"
              }
              onClick={handleSessionSearchToggle}
              title={t.sessions.searchAria}
              type="button"
            >
              <Search size={17} />
            </button>
          ) : null}
        </div>
        <aside
          aria-hidden={!sidebarVisible}
          aria-label={t.nav.aria}
          className={`app-sidebar is-${sidebarMode}`}
          id="app-sidebar"
          inert={!sidebarVisible}
          ref={sidebar.panelRef}
          {...sidebar.panelProps}
        >
          <nav className="tab-list" aria-label={t.nav.aria}>
            {tabs.map((tab) => (
              <button
                className={
                  activeSection === tab.id ? `tab tab-${tab.id} active` : `tab tab-${tab.id}`
                }
                key={tab.id}
                title={tab.label}
                type="button"
                onClick={() => openDashboardSection(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-session-section">
            <SessionsIndex
              sessions={sessions.items}
              query={query}
              searchOpen={sessionSearchOpen}
              searchFocusKey={sessionSearchFocusKey}
              initialLoading={dashboardRuntimeReady
                && sessionsQuery.isPending
                && !sessions.items.length}
              loadingMore={dashboardRuntimeReady && sessionsQuery.isFetchingNextPage}
              error={dashboardRuntimeReady && !sessions.items.length ? queryError(sessionsQuery.error) : ""}
              hasMore={dashboardRuntimeReady && Boolean(sessionsQuery.hasNextPage)}
              loadMoreError={dashboardRuntimeReady && sessions.items.length && sessionsQuery.isFetchNextPageError
                ? queryError(sessionsQuery.error)
                : ""}
              selectedSessionId={activeSection === "sessions" ? selectedSessionId : ""}
              onQueryChange={handleSessionQueryChange}
              onSearchClose={() => {
                setSessionSearchOpen(false);
                setQuery("");
              }}
              onLoadMore={loadMoreSessions}
              onNew={() => {
                startNewConversation();
              }}
              onOpen={(session) => {
                openSession(session);
              }}
              onPin={setSessionPinned}
              onDelete={deleteSession}
              onTransientInteractionChange={sidebar.onTransientInteractionChange}
              visible={sidebarVisible}
              deleteBlockedSessionIds={conversationActivity?.active || conversationActivity?.queued.length
                ? [selectedSessionId]
                : []}
            />
          </div>
          <button
            aria-label={t.sidebar.statusAndSettings}
            className="sidebar-status-card"
            title={t.sidebar.statusAndSettings}
            type="button"
            onClick={() => onOpenDesktopSettings?.("status")}
          >
            <span className="sidebar-status-icon">
              <BrandMark />
            </span>
            <span className="sidebar-status-copy">
              <span className="sidebar-status-title">{t.sidebar.statusAndSettings}</span>
            </span>
          </button>
        </aside>

        <section className={showDashboardHome ? "main-panel dashboard-home-panel" : "main-panel"}>
          {!showDashboardHome && !hasEmbeddedPageHeader ? (
            <header className={`main-header tab-${activeSection}`}>
              <div className="main-title">
                <h2>{pageTitle}</h2>
                {pageSubtitle ? <p>{pageSubtitle}</p> : null}
              </div>
            </header>
          ) : null}
          <section className={activeSection === "sessions" ? "content-panel content-panel-fill" : "content-panel"}>
            {visibleError ? (
              <div className="dashboard-query-notice" role="status">
                {t.common.errorPrefix(t.errors.api, visibleError)}
              </div>
            ) : null}
            {activeRefreshing ? (
              <div className="dashboard-refresh-indicator" role="status">{t.common.updating}</div>
            ) : null}
            {activeSection === "sessions" ? (
              <section className="sessions-conversation-shell">
                {selectedSessionId || newConversation ? (
                  <SessionDetailView
                    fallbackSession={selectedSession}
                    detail={sessionDetail}
                    activity={conversationActivity}
                    currentModel={currentModelQuery.data ?? null}
                    models={modelsQuery.data?.items ?? []}
                    modelLoading={dashboardRuntimeReady
                      && (modelsQuery.isPending || currentModelQuery.isPending)}
                    modelSaving={modelMutation.isPending}
                    thinkingSaving={thinkingMutation.isPending}
                    newConversation={newConversation}
                    runtimeReady={dashboardRuntimeReady}
                    runtimeUnavailableMessage={setupComplete
                      ? t.conversation.unavailable
                      : t.conversation.modelUnavailable}
                    loading={dashboardRuntimeReady
                      && !newConversation
                      && sessionDetailQuery.isPending
                      && !conversationActivity}
                    error={dashboardRuntimeReady
                      && !newConversation
                      && !sessionDetail
                      && !conversationActivity
                      ? queryError(sessionDetailQuery.error)
                      : ""}
                    hasOlder={Boolean(sessionDetailQuery.hasPreviousPage)}
                    loadingOlder={sessionDetailQuery.isFetchingPreviousPage}
                    loadOlderError={sessionDetail && sessionDetailQuery.isFetchPreviousPageError
                      ? queryError(sessionDetailQuery.error)
                      : ""}
                    onLoadOlder={sessionDetailQuery.fetchPreviousPage}
                    hasNewer={sessionDetailQuery.hasNextPage}
                    onLoadNewer={sessionDetailQuery.fetchNextPage}
                    onVisibleGroups={sessionDetailQuery.setVisibleGroups}
                    onJumpToLatest={sessionDetailQuery.jumpToLatest}
                    onModelChange={setCurrentModel}
                    onThinkingLevelChange={setCurrentThinkingLevel}
                    onSend={sendConversation}
                    onStop={stopConversation}
                    onOpenFile={openConversationFile}
                    onRevealFile={revealConversationFile}
                    onOpenAttachment={openConversationAttachment}
                    pendingMessages={visiblePendingConversationMessages}
                  />
                ) : (
                  <EmptyState label={selectedSessionId ? t.sessionDetail.loading : t.sessions.selectPrompt} />
                )}
              </section>
            ) : null}
            {activeSection === "home" ? (
              <DashboardHome
                enabled={dashboardRuntimeReady}
                onOpenSession={openSession}
                onOpenSessions={() => openDashboardSection("sessions")}
                onOpenStats={() => openActivityView("stats")}
              />
            ) : null}
            {activeSection === "workbench" && workbenchView === "index" ? (
              <WorkbenchIndex
                assetStatus={assetSlotStatus}
                onOpen={openWorkbenchView}
                syntheticPerformerStatus=""
              />
            ) : null}
            {activeSection === "workbench" && workbenchView === "synthetic-performer" ? (
              <SyntheticPerformerWorkbench onBack={() => openWorkbenchView("index")} />
            ) : null}
            {activeSection === "workbench" && workbenchView === "input-assets" ? (
              <InputAssetsWorkbench
                error={assetSlots.error}
                loading={assetSlots.loading}
                onBack={() => openWorkbenchView("index")}
                refresh={assetSlots.refresh}
                slots={assetSlots.slots}
              />
            ) : null}
            {activeSection === "capabilities" ? (
              <WorkspaceView
                activeView={capabilityView}
                items={capabilityItems}
                label={t.nav.capabilities}
                onSelect={openCapabilityView}
              >
                {capabilityView === "models" ? (
                  !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
                    : modelsQuery.isPending || currentModelQuery.isPending ? <EmptyState label={t.common.loading} />
                    : !modelsQuery.data || !currentModelQuery.data
                      ? <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(modelsQuery.error || currentModelQuery.error))} />
                      : <ModelsView
                          models={modelsQuery.data.items}
                          current={currentModelQuery.data}
                        />
                ) : null}
                {capabilityView === "skills" ? (
                  !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
                    : skillsQuery.isPending || commandsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : skillsQuery.data && commandsQuery.data
                      ? <SkillsView
                          skills={skillsQuery.data.items}
                          commands={commandsQuery.data.items}
                          onOpen={setDetailTarget}
                        />
                      : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(skillsQuery.error || commandsQuery.error))} />
                ) : null}
                {capabilityView === "tools" ? (
                  !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
                    : toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : toolsetsQuery.data
                      ? <ToolsView toolsets={toolsetsQuery.data.items} onOpen={setDetailTarget} />
                      : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(toolsetsQuery.error))} />
                ) : null}
                {capabilityView === "connections" ? (
                  !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
                    : connectorsQuery.isPending && toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : <ConnectionsView
                        connectorError={!connectorsQuery.data ? queryError(connectorsQuery.error) : ""}
                        connectors={connectorsQuery.data?.items ?? []}
                        mcpError={!toolsetsQuery.data ? queryError(toolsetsQuery.error) : ""}
                        mcpSavingId={mcpMutation.isPending ? mcpMutation.variables?.name || "" : ""}
                        mcpToolset={mcpToolset}
                        savingId={connectorMutation.isPending ? connectorMutation.variables?.id || "" : ""}
                        onConfigureCredentials={onOpenDesktopSettings}
                        onToggle={toggleConnector}
                        onToggleMcpServer={toggleMcpServer}
                      />
                ) : null}
              </WorkspaceView>
            ) : null}
            {activeSection === "activity" ? (
              <section className="workspace-view">
                <header className="workspace-view-header">
                  <h2>{t.nav.activity}</h2>
                </header>
                <div className="workspace-view-content">
                  <StatsView enabled={dashboardRuntimeReady} />
                </div>
              </section>
            ) : null}
          </section>
        </section>

        <DetailModal
          enabled={dashboardRuntimeReady}
          target={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      </main>
      <div className={activeSection === "sessions" ? "runtime-status-host sessions-focus" : "runtime-status-host"}>
        {runtimeStatusPopover}
      </div>
    </>
  );
}

function DashboardApplication() {
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [fontSize, setFontSize] = useState(() => initialDashboardFontSize());
  const [theme, setTheme] = useState(() => initialDashboardTheme());
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.(DARK_MEDIA_QUERY).matches ?? false,
  );
  const t = UI_TEXT[language];

  // "system" has to keep following the OS after the window is already open, so
  // the query stays subscribed rather than being read once at startup.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_MEDIA_QUERY);
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  useLayoutEffect(() => {
    const resolved = resolveTheme(theme, prefersDark);
    document.documentElement.dataset.theme = resolved;
    // Native controls - scrollbars, selects, form widgets - follow this and
    // nothing else, so leaving it out gives light scrollbars on a dark page.
    document.documentElement.style.colorScheme = resolved;
    // The window frame is painted by the Main process and does not follow the
    // page: on Windows the caption strip keeps whatever colour it was built
    // with, so it has to be told.
    void window.lxe?.desktop?.applyAppearance(resolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The selected theme still applies when persistent storage is unavailable.
    }
  }, [theme, prefersDark]);

  useLayoutEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize);
    } catch {
      // The selected font size still works when persistent storage is unavailable.
    }
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The active language still works when persistent storage is unavailable.
    }
  }, [language]);

  return (
    <I18nContext.Provider value={t}>
      <DesktopShell
        fontSize={fontSize}
        language={language}
        onFontSizeChange={setFontSize}
        onLanguageChange={setLanguage}
        onThemeChange={setTheme}
        theme={theme}
      >
        {({ cloud, health, openSettings, setupComplete }) => (
          <App
            desktopCloud={cloud}
            desktopHealth={health}
            language={language}
            onLanguageChange={setLanguage}
            onOpenDesktopSettings={window.lxe ? openSettings : undefined}
            setupComplete={setupComplete}
          />
        )}
      </DesktopShell>
    </I18nContext.Provider>
  );
}

// Reuse the root across vite HMR full-reloads of this entry module.
const rootContainer = document.getElementById("root")! as HTMLElement & {
  __appRoot?: ReturnType<typeof createRoot>;
};
const appRoot = rootContainer.__appRoot ?? createRoot(rootContainer);
rootContainer.__appRoot = appRoot;
appRoot.render(
  <DashboardRootErrorBoundary>
    <DashboardQueryProvider>
      <DashboardApplication />
    </DashboardQueryProvider>
  </DashboardRootErrorBoundary>
);
