import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import {
  ArrowUp,
  Brain,
  Cloud,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Copy,
  FileText,
  FolderOpen,
  Info,
  LoaderCircle,
  MessageSquareText,
  MoreVertical,
  PackageCheck,
  Paperclip,
  Plus,
  Search,
  Settings2,
  Square,
  Pin,
  PinOff,
  Trash2,
  UserRound,
  Wrench,
  X
} from "lucide-react";

import csvIcon from "../../assets/file-types/csv.png";
import htmlIcon from "../../assets/file-types/html.png";
import xlsIcon from "../../assets/file-types/xls.png";
import xlsxIcon from "../../assets/file-types/xlsx.png";

import { EmptyState } from "../../shared/components";
import { copyTextToClipboard, displayText, isRecord, sanitizeForDisplay, shortText, splitContentBlocks } from "../../shared/content";
import {
  hasLiveToolOperationDetails,
  readerFacingMessageText,
  roleLabel,
  toolOperationArguments,
  toolOperationPresentation,
  toolOperations,
} from "./conversation";
import type { ToolOperation } from "./conversation";
import { formatCompactNumber, formatDate, formatMessageTime, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type {
  DesktopConversationActivityPayload,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  DesktopInputAttachmentPayload,
  ModelPayload,
  SessionArtifactPayload,
  SessionDetailPayload,
  SessionMessage,
  SessionPayload,
  SourceSummary
} from "../../api/payloads";
import { CodeBlock, languageForPath } from "../../shared/ui/code-block";
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from "../../shared/ui/markdown";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import { ProviderBrandMark } from "../../shared/ui/provider-brand-mark";
import {
  conversationModelChoices,
  modelDisabledReasonLabel,
  modelThinkingLevelLabel,
} from "../models/model";
import { groupSidebarSessions } from "./model";
import { ConversationWindow } from "./virtual-window";
import { thinkingParagraphs, formatConversationDuration } from "./typography";
import { useProcessRows } from "./process";
import { conversationRows, type ConversationRow, type PendingMessage } from "./presentation";
import { ConversationWelcome } from "./welcome";

/** How close to the bottom still counts as "following the reply". */

export type PendingConversationMessage = PendingMessage;

function sourceLabel(source: SourceSummary | Record<string, unknown>): string {
  const platform = String(source.platform || "unknown");
  const chatType = String(source.chat_type || "");
  return [platform, chatType].filter(Boolean).join(" / ");
}

function RoleBadge({ role }: { role: string }) {
  const t = useUiText();
  const normalized = roleLabel(role);
  const label = t.role[normalized as keyof typeof t.role] || normalized;
  const icon =
    normalized === "user" ? (
      <UserRound aria-hidden="true" size={13} />
    ) : normalized === "assistant" ? (
      <Brain aria-hidden="true" size={13} />
    ) : normalized === "tool" ? (
      <Wrench aria-hidden="true" size={13} />
    ) : normalized === "system" ? (
      <Settings2 aria-hidden="true" size={13} />
    ) : (
      <Info aria-hidden="true" size={13} />
    );

  return (
    <span className={`role-badge role-${normalized}`}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function MessageMeta({
  createdAt,
  role,
  text,
}: {
  createdAt: number;
  role: "assistant" | "user";
  text: string;
}) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  const timestamp = formatMessageTime(createdAt);
  const copyLabel = copied ? t.common.copied : t.message.copyMessage;
  const handleCopy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  const copyButton = text ? (
    <button
      aria-label={copyLabel}
      className="message-meta-copy"
      onClick={handleCopy}
      title={copyLabel}
      type="button"
    >
      {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
    </button>
  ) : null;
  const time = timestamp ? (
    <time dateTime={new Date(createdAt * 1000).toISOString()}>{timestamp}</time>
  ) : null;
  if (!copyButton && !time) return null;
  return (
    <div className={`message-meta role-${role}`}>
      {role === "user" ? time : copyButton}
      {role === "user" ? copyButton : time}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone = "neutral"
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "green" | "blue" | "amber";
}) {
  return (
    <div className={`stat-tile stat-${tone}`}>
      <div className="stat-icon">{icon}</div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
      </div>
    </div>
  );
}

const MessageMarkdown = React.memo(function MessageMarkdown({
  text,
}: {
  text: string;
}) {
  const visibleText = text;
  return (
    <div className="message-markdown">
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={markdownRehypePlugins}
        remarkPlugins={markdownRemarkPlugins}
      >
        {visibleText}
      </ReactMarkdown>
    </div>
  );
});

function MessageBlock({ block }: { block: unknown }) {
  const t = useUiText();
  if (!isRecord(block)) {
    return (
      <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
    );
  }
  const type = String(block.type || "unknown");
  if (type === "text") {
    return <MessageMarkdown text={String(block.text || "")} />;
  }
  if (type === "thinking") {
    return <ThinkingBlock block={block} />;
  }
  if (type === "redacted_thinking") {
    return <RedactedThinkingBlock />;
  }
  if (type === "tool_use" || type === "tool_call") {
    const input = block.input ?? block.arguments ?? {};
    const blockName = String(block.name || "");
    return (
      <div className="message-block tool-block">
        <div className="block-title">
          <Wrench size={14} />
          <span>{blockName === "__tool_calls__" ? t.message.toolCalls : blockName || t.common.fallbackTool}</span>
          {block.id ? <code>{String(block.id)}</code> : null}
        </div>
        <pre className="message-json">{shortText(sanitizeForDisplay(input))}</pre>
      </div>
    );
  }
  if (type === "tool_result") {
    return <ToolResultBlock block={block} />;
  }
  if (type === "image" || type === "file") {
    return (
      <div className="message-block media-block">
        <div className="block-title">
          <FileText size={14} />
          <span>{type} {t.common.block}</span>
        </div>
        <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
      </div>
    );
  }
  return (
    <div className="message-block">
      <div className="block-title">
        <Info size={14} />
        <span>{type}</span>
      </div>
      <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
    </div>
  );
}

function ThinkingBlock({ block }: { block: Record<string, unknown> }) {
  const t = useUiText();
  const [expanded, setExpanded] = useState(false);
  const thinking = String(block.thinking || "").trim();
  const canExpand = Boolean(thinking);

  return (
    <div className="message-block thinking-block">
      <button
        aria-expanded={expanded}
        className="block-title block-title-split thinking-block-toggle"
        disabled={!canExpand}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <div className="block-title-main">
          <Brain size={14} />
          <span>{t.message.thinking}</span>
        </div>
      </button>
      {expanded && canExpand ? (
        <div className="thinking-block-body">
          <div className="message-text">{thinking}</div>
        </div>
      ) : null}
    </div>
  );
}

function RedactedThinkingBlock() {
  const t = useUiText();
  return (
    <div className="message-block thinking-block redacted">
      <div className="block-title">
        <Brain size={14} />
        <span>{t.message.thinking}</span>
      </div>
      <div className="thinking-block-body">
        <div className="muted">{t.message.redactedThinking}</div>
      </div>
    </div>
  );
}

function ToolResultBlock({ block, language = "" }: { block: Record<string, unknown>; language?: string }) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  // Pull the text out of the content blocks first. Stringifying the array turns
  // every real newline in the output into a literal \n and the result arrives
  // as one unreadable wall.
  const { text, residual } = splitContentBlocks(block.content ?? "");
  const resultText = text || (residual.length ? "" : displayText(block.content ?? ""));
  const residualText = residual.length
    ? displayText(sanitizeForDisplay(residual, { truncateStrings: false }))
    : "";
  const copyLabel = copied ? t.common.copied : t.message.copyResult;
  const truncation = isRecord(block.dashboard_truncation) ? block.dashboard_truncation : null;
  const originalBytes = Math.max(0, Number(truncation?.original_bytes) || 0);
  const previewBytes = Math.max(0, Number(truncation?.preview_bytes) || 0);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard([resultText, residualText].filter(Boolean).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={block.is_error ? "message-block result-block error" : "message-block result-block"}>
      <div className="block-title block-title-split">
        <div className="block-title-main">
          <PackageCheck size={14} />
          <span>{block.is_error ? t.message.toolResultError : t.message.toolResult}</span>
        </div>
        <div className="tool-result-actions">
          {/* Correlating an id with the logs is a debugging need, not the
              headline the reader came for. */}
          {block.tool_call_id ? (
            <code className="tool-call-id" title={`${t.message.toolCallIdLabel}: ${String(block.tool_call_id)}`}>
              {String(block.tool_call_id)}
            </code>
          ) : null}
          <button className="tool-result-button" type="button" onClick={handleCopy}>
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copyLabel}</span>
          </button>
        </div>
      </div>
      {truncation?.truncated === true ? (
        <div className="tool-result-truncation">
          {t.message.toolResultTruncated(formatNumber(previewBytes), formatNumber(originalBytes))}
        </div>
      ) : null}
      {resultText ? <CodeBlock className="tool-result-full" code={resultText} language={language} /> : null}
      {residualText ? <pre className="message-json tool-result-residual">{residualText}</pre> : null}
    </div>
  );
}

const COMPACT_TOOL_ARGUMENT_MAX_CHARS = 80;

/**
 * `timeout: 120` deserves a chip, not three lines of JSON. Long strings and
 * structured values stay in the detail flow so a pill never stretches around
 * a paragraph-sized payload.
 */
function ToolCallRest({ rest }: { rest: Record<string, unknown> }) {
  const t = useUiText();
  const entries = Object.entries(rest);
  const scalars = entries.filter(([, value]) =>
    value === null || ["string", "number", "boolean"].includes(typeof value));
  const compactScalars = scalars.filter(([, value]) =>
    typeof value !== "string" || value.length <= COMPACT_TOOL_ARGUMENT_MAX_CHARS);
  const longScalars = scalars.filter(([, value]) =>
    typeof value === "string" && value.length > COMPACT_TOOL_ARGUMENT_MAX_CHARS);
  const structured = Object.fromEntries(entries.filter(([key]) =>
    !scalars.some(([scalarKey]) => scalarKey === key)));
  const hasStructured = Object.keys(structured).length > 0;
  return (
    <div className="tool-call-rest">
      {compactScalars.length ? (
        <div className="tool-call-chips">
          {compactScalars.map(([key, value]) => (
            <span className="tool-call-chip" key={key}>
              <span className="tool-call-chip-key">{key}</span>
              <span className="tool-call-chip-value">{String(value)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {longScalars.length ? (
        <div className="tool-call-long-values">
          {longScalars.map(([key, value]) => (
            <div className="tool-call-long-value" key={key}>
              <span className="tool-call-rest-label">{key}</span>
              <pre className="message-json">{String(value)}</pre>
            </div>
          ))}
        </div>
      ) : null}
      {hasStructured ? (
        <>
          <span className="tool-call-rest-label">{t.message.toolOtherArguments}</span>
          <pre className="message-json">{shortText(sanitizeForDisplay(structured))}</pre>
        </>
      ) : null}
    </div>
  );
}

/**
 * The call side of one operation: the value that describes it rendered as what
 * it is — a shell command as shell, a path as a path — with the remaining
 * arguments kept below rather than dropped.
 */
function ToolCallArguments({ operation }: { operation: ToolOperation }) {
  const t = useUiText();
  const { primary, rest } = toolOperationArguments(operation);
  const restKeys = Object.keys(rest);
  if (!primary && !restKeys.length) return null;
  const primaryLanguage = operation.action === "run"
    ? "bash"
    : languageForPath(primary);
  const isPath = ["read", "edit", "write", "list", "send"].includes(operation.action);
  return (
    <div className="tool-call-args">
      {primary
        ? (isPath
          ? <div className="tool-call-path" title={primary}>{primary}</div>
          : <CodeBlock code={primary} language={primaryLanguage} />)
        : null}
      {restKeys.length ? <ToolCallRest rest={rest} /> : null}
    </div>
  );
}

function MessageContent({ content, message }: { content: unknown; message: SessionMessage }) {
  const t = useUiText();
  const toolCalls = message.tool_calls;
  return (
    <div className="message-content">
      {typeof content === "string" ? <MessageMarkdown text={content} /> : null}
      {Array.isArray(content) ? (
        <div className="message-block-list">
          {content.map((block, index) => (
            <MessageBlock block={block} key={index} />
          ))}
        </div>
      ) : null}
      {content !== undefined && typeof content !== "string" && !Array.isArray(content) ? (
        <pre className="message-json">{shortText(sanitizeForDisplay(content))}</pre>
      ) : null}
      {toolCalls ? (
        <div className="message-block tool-block">
          <div className="block-title">
            <Wrench size={14} />
            <span>{t.message.toolCalls}</span>
          </div>
          <pre className="message-json">{shortText(sanitizeForDisplay(toolCalls))}</pre>
        </div>
      ) : null}
    </div>
  );
}

function resultLanguage(operation: ToolOperation): string {
  return operation.action === "read" ? languageForPath(operation.target) : "";
}

function defaultToolOperationBody(operation: ToolOperation): React.ReactNode {
  const result = operation.result;
  return (
    <>
      <ToolCallArguments operation={operation} />
      {result === undefined
        ? null
        : isRecord(result) && (result.type === "tool_result" || result.content !== undefined)
          ? <ToolResultBlock block={result} language={resultLanguage(operation)} />
          : <MessageBlock block={result} />}
    </>
  );
}

type LiveToolStep = DesktopConversationStreamPayload["tool_steps"][number];

function liveToolOperations(steps: LiveToolStep[]): ToolOperation[] {
  return steps.map((step, index) => {
    const name = String(step.name || "tool");
    const argument = String(step.detail || "");
    return {
      key: `live-${step.id || `${name}-${index}`}`,
      name,
      argument,
      ...toolOperationPresentation(name, argument),
      status: step.status,
      expandable: hasLiveToolOperationDetails(step),
      call: undefined,
      result: step,
    };
  });
}

function LiveToolOperationBody({ operation }: { operation: ToolOperation }) {
  const step = operation.result as LiveToolStep;
  const language = resultLanguage(operation);
  return (
    <>
      <ToolCallArguments operation={operation} />
      {step.result_block ? (
        <ToolResultBlock block={{ type: "tool_result", content: step.result_block.content }} language={language} />
      ) : null}
      {step.error_block ? (
        <ToolResultBlock block={{ type: "tool_result", content: step.error_block.content, is_error: true }} />
      ) : null}
    </>
  );
}

function TurnFileList({
  files,
  onOpenFile,
  onRevealFile,
}: {
  files: SessionArtifactPayload[];
  onOpenFile: (artifactId: string) => Promise<void>;
  onRevealFile: (artifactId: string) => Promise<void>;
}) {
  const t = useUiText();
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [opening, setOpening] = useState<Set<string>>(() => new Set());
  // Both actions land in the same busy and error slots: only one of them runs
  // at a time per file, and either failure belongs on the same row.
  const run = async (artifactId: string, action: (id: string) => Promise<void>) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(artifactId);
      return next;
    });
    setOpening((current) => new Set(current).add(artifactId));
    try {
      await action(artifactId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setErrors((current) => new Map(current).set(artifactId, message));
    } finally {
      setOpening((current) => {
        const next = new Set(current);
        next.delete(artifactId);
        return next;
      });
    }
  };
  const open = (artifactId: string) => run(artifactId, onOpenFile);
  const reveal = (artifactId: string) => run(artifactId, onRevealFile);
  // The type marker stays on every row even when the whole set shares a type:
  // it doubles as the anchor the eye lands on, and without it the list reads as
  // a wall of text. It earns that by being quiet - the extension itself still
  // leaves the name, which is where the width was going.
  const heading = t.conversation.files(formatNumber(files.length));
  return (
    <section className="turn-file-section" aria-label={heading}>
      <div className="turn-file-heading">{heading}</div>
      <div className="turn-file-grid">
        {files.map((file) => {
          const extension = fileExtensionLabel(file.name);
          const isOpening = opening.has(file.artifact_id);
          const error = errors.get(file.artifact_id) ?? "";
          return (
            <div className={error ? "turn-file-item has-error" : "turn-file-item"} key={file.artifact_id}>
              <button
                aria-busy={isOpening}
                aria-label={t.conversation.openFile(file.name)}
                className="turn-file-card"
                disabled={isOpening}
                onClick={() => void open(file.artifact_id)}
                title={t.conversation.openFile(file.name)}
                type="button"
              >
                <span aria-hidden="true" className="turn-file-extension">
                  {FILE_TYPE_ICONS[extension]
                    ? <img alt="" draggable={false} src={FILE_TYPE_ICONS[extension]} />
                    : extension}
                </span>
                <span className="turn-file-name" title={file.name}>{file.name}</span>
                {isOpening
                  ? <LoaderCircle aria-hidden="true" className="conversation-spinner turn-file-action" size={14} />
                  : null}
              </button>
              {/* A second action needs its own button - one cannot nest inside
                  the card's - and its own shape. An arrow would read as "open",
                  which is what the card already does. */}
              <button
                aria-label={t.conversation.revealFile(file.name)}
                className="turn-file-reveal"
                disabled={isOpening}
                onClick={() => void reveal(file.artifact_id)}
                title={t.conversation.revealFile(file.name)}
                type="button"
              >
                <FolderOpen aria-hidden="true" size={14} />
              </button>
              {error ? (
                <div className="turn-file-card-error" role="alert">{t.conversation.openFileFailed(error)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{1,8})$/i;

/* The icon names the exact type, so an extension without one keeps the text
   badge - TSV is not CSV, and a cousin's icon would mislabel the file. */
const FILE_TYPE_ICONS: Record<string, string> = {
  CSV: csvIcon,
  HTML: htmlIcon,
  XLS: xlsIcon,
  XLSX: xlsxIcon,
};

function fileExtensionLabel(name: string): string {
  const match = FILE_EXTENSION_PATTERN.exec(name.trim());
  return match?.[1] ? match[1].slice(0, 5).toUpperCase() : "FILE";
}

function InputAttachmentList({
  attachments,
  onOpen,
  onRemove,
}: {
  attachments: DesktopInputAttachmentPayload[];
  onOpen?: (attachmentId: string) => Promise<void>;
  onRemove?: (attachmentId: string) => void;
}) {
  const t = useUiText();
  const [error, setError] = useState("");
  const open = async (attachmentId: string) => {
    if (!onOpen) return;
    setError("");
    try {
      await onOpen(attachmentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="turn-file-list input-attachment-list">
      <span className="turn-file-label">{t.conversation.attachments}</span>
      {attachments.map((attachment) => (
        <span className="input-attachment-chip" key={attachment.attachment_id}>
          <button
            className="turn-file-chip"
            disabled={!onOpen}
            onClick={() => void open(attachment.attachment_id)}
            title={onOpen ? t.conversation.openFile(attachment.name) : attachment.name}
            type="button"
          >
            <Paperclip size={14} />
            <span>{attachment.name}</span>
          </button>
          {onRemove ? (
            <button
              aria-label={t.conversation.removeAttachment(attachment.name)}
              className="input-attachment-remove"
              onClick={() => onRemove(attachment.attachment_id)}
              type="button"
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      ))}
      {error ? <div className="turn-file-error" role="alert">{t.conversation.openFileFailed(error)}</div> : null}
    </div>
  );
}

function ConversationModelPicker({
  current,
  disabled,
  loading,
  models,
  saving,
  onChange,
}: {
  current: ModelPayload | null;
  disabled: boolean;
  loading: boolean;
  models: ModelPayload[];
  saving: boolean;
  onChange: (provider: string, model: string, credentialSource: "local" | "cloud") => void;
}) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choices = useMemo(() => conversationModelChoices(models), [models]);
  const triggerLabel = loading
    ? t.common.loading
    : current?.credential_source === "cloud" ? "云端" : current?.model || t.models.modelOptionUnavailable;

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selectModel = (
    provider: string,
    model: string,
    credentialSource: "local" | "cloud",
  ) => {
    setOpen(false);
    if (current?.provider !== provider
      || current.model !== model
      || current.credential_source !== credentialSource) {
      onChange(provider, model, credentialSource);
    }
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="conversation-model-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${t.models.currentModel}: ${triggerLabel}`}
        className="conversation-model-trigger"
        disabled={disabled || loading || !current}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        title={t.models.effectiveNextTurn}
        type="button"
      >
        <ProviderBrandMark provider={current?.provider} size={15} />
        <span>{triggerLabel}</span>
        {saving ? <LoaderCircle aria-hidden className="conversation-spinner" size={13} /> : null}
      </button>
      {open ? (
        <div aria-label={t.models.model} className="conversation-model-menu" role="menu">
          <div className="conversation-model-menu-heading">{t.models.model}</div>
          <div className="conversation-model-options">
            {choices.length ? choices.map((choice) => {
              const selected = current?.provider === choice.provider
                && current.model === choice.model
                && current.credential_source === choice.credentialSource;
              return (
                <button
                  aria-checked={selected}
                  className={selected ? "conversation-model-option selected" : "conversation-model-option"}
                  disabled={saving || !choice.selectable}
                  key={`${choice.provider}:${choice.model}:${choice.credentialSource}`}
                  onClick={() => selectModel(choice.provider, choice.model, choice.credentialSource)}
                  role="menuitemradio"
                  title={!choice.selectable && choice.disabledReason
                    ? modelDisabledReasonLabel(t, choice.disabledReason)
                    : undefined}
                  type="button"
                >
                  <ProviderBrandMark provider={choice.provider} size={17} />
                  <span className="conversation-model-option-copy">
                    <strong>{choice.title}</strong>
                    <span>{choice.subtitle}</span>
                  </span>
                  <span className="conversation-model-option-status">
                    {choice.credentialSource === "cloud" ? <Cloud aria-hidden size={15} /> : null}
                    {selected ? <Check aria-hidden size={15} /> : null}
                  </span>
                </button>
              );
            }) : (
              <div className="conversation-model-empty">{t.models.modelOptionUnavailable}</div>
            )}
          </div>
          <div className="conversation-model-menu-footer">
            <small>{t.models.effectiveNextTurn}</small>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConversationThinkingPicker({
  current,
  disabled,
  saving,
  onChange,
}: {
  current: ModelPayload | null;
  disabled: boolean;
  saving: boolean;
  onChange: (level: string) => void;
}) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const levels = current?.thinking_levels ?? [];
  const selectedLevel = current?.thinking_state?.level || current?.thinking_default || levels[0] || "";
  const selectedLabel = current ? modelThinkingLevelLabel(current, selectedLevel) : "-";
  const editable = Boolean(current?.thinking_state?.editable && levels.length > 1);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);

  useEffect(() => {
    if (!open) setDragging(false);
  }, [open]);

  useEffect(() => {
    if (!dragging) setDragRatio(null);
  }, [dragging]);

  if (!current || levels.length === 0) return null;

  const selectedIndex = Math.max(0, levels.indexOf(selectedLevel));

  // Notches are pinned to the rail's two ends: the first level sits at 0% and
  // the last at 100%, so the extremes stay close to the track edges.
  const notchPosition = (index: number): number => (
    levels.length > 1 ? (index / (levels.length - 1)) * 100 : 50
  );

  // Clicking or dragging on the track keeps the menu open so the knob can be
  // slid across notches; the menu still closes on outside pointerdown/Escape.
  const applyLevel = (level: string) => {
    if (level !== selectedLevel) onChange(level);
  };

  const ratioAtClientX = (clientX: number): number | null => {
    const rail = trackRef.current;
    if (!rail || levels.length === 0) return null;
    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  // While dragging, the knob tracks the pointer locally. Persisting only on
  // release avoids starting one request per pointer move and lets the gesture
  // reach its intended notch before the saving state disables the control.
  const slideToClientX = (event: React.PointerEvent<HTMLDivElement>): number | null => {
    if (disabled || saving) return null;
    const ratio = ratioAtClientX(event.clientX);
    if (ratio === null) return null;
    setDragRatio(ratio);
    return ratio;
  };

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || saving) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    slideToClientX(event);
  };

  const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    slideToClientX(event);
  };

  const cancelDragging = () => setDragging(false);

  const finishDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const ratio = slideToClientX(event);
    setDragging(false);
    if (ratio === null) return;
    const level = levels[Math.round(ratio * (levels.length - 1))];
    if (level) applyLevel(level);
  };

  return (
    <div className="conversation-thinking-picker" ref={rootRef}>
      <button
        aria-expanded={editable ? open : undefined}
        aria-haspopup={editable ? "menu" : undefined}
        aria-label={`${t.models.thinkingEffort}: ${selectedLabel}`}
        className="conversation-thinking-trigger"
        disabled={disabled || saving || !editable}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        title={editable ? t.models.thinkingEffectiveNextTurn : t.models.providerManaged}
        type="button"
      >
        <span>{selectedLabel}</span>
        {saving ? <LoaderCircle aria-hidden className="conversation-spinner" size={13} /> : null}
      </button>
      {open ? (
        <div aria-label={t.models.thinkingEffort} className="conversation-thinking-menu" role="menu">
          <div className="conversation-thinking-heading">
            <span>
              {t.models.thinkingEffort} <strong>{selectedLabel}</strong>
            </span>
            <button
              aria-label={t.models.thinkingEffortHint}
              className="conversation-thinking-help"
              type="button"
            >
              <CircleHelp aria-hidden size={13} />
              <span className="conversation-thinking-tooltip" role="tooltip">
                <strong>{t.models.thinkingEffort}</strong>
                <span>{t.models.thinkingEffortHint}</span>
                <small>{t.models.thinkingEffectiveNextTurn}</small>
              </span>
            </button>
          </div>
          <div aria-hidden className="conversation-thinking-scale-labels">
            <span>{t.models.faster}</span>
            <span>{t.models.smarter}</span>
          </div>
          <div
            className={dragging ? "conversation-thinking-levels dragging" : "conversation-thinking-levels"}
            onLostPointerCapture={cancelDragging}
            onPointerCancel={cancelDragging}
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={finishDragging}
          >
            <div className="conversation-thinking-cells" ref={trackRef}>
              {levels.map((level, index) => {
                const selected = level === selectedLevel;
                const label = modelThinkingLevelLabel(current, level);
                return (
                  <button
                    aria-checked={selected}
                    aria-label={label}
                    className={selected ? "conversation-thinking-level selected" : "conversation-thinking-level"}
                    disabled={saving}
                    key={level}
                    onClick={(event) => {
                      // Pointer activation is committed by finishDragging;
                      // detail=0 preserves keyboard and assistive activation.
                      if (event.detail === 0) applyLevel(level);
                    }}
                    role="menuitemradio"
                    style={{ left: `${notchPosition(index)}%` }}
                    title={label}
                    type="button"
                  >
                    <span aria-hidden className="conversation-thinking-dot" />
                  </button>
                );
              })}
              <span
                aria-hidden
                className={dragging && dragRatio !== null
                  ? "conversation-thinking-knob dragging"
                  : "conversation-thinking-knob"}
                style={{
                  left: `${dragging && dragRatio !== null ? dragRatio * 100 : notchPosition(selectedIndex)}%`,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const CONTEXT_RING_RADIUS = 8;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/**
 * Prefer the current turn's estimate, including a valid zero. Legacy turns
 * without a source retain their provider-usage fallback behavior.
 */
function latestDisplayMetrics(
  activity: DesktopConversationActivityPayload | null,
): DesktopConversationStreamPayload["display_metrics"] | null {
  for (const turn of [activity?.active, activity?.latest]) {
    const metrics = turn?.stream?.display_metrics;
    if (metrics && metrics.context_window_tokens > 0 && (metrics.context_source !== undefined || metrics.context_tokens > 0)) return metrics;
  }
  return null;
}

function ConversationContextMeter({
  activity,
  currentModel,
}: {
  activity: DesktopConversationActivityPayload | null;
  currentModel: ModelPayload | null;
}) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const metrics = latestDisplayMetrics(activity);
  const total = metrics?.context_window_tokens
    || Math.max(0, Math.trunc(currentModel?.capabilities?.context_window_tokens ?? 0));

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (total <= 0) setOpen(false);
  }, [total]);

  if (total <= 0) return null;

  const used = metrics ? Math.min(total, metrics.context_tokens) : 0;
  const free = total - used;
  const ratio = used / total;
  const percent = `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`;
  const label = t.conversation.contextMeter.trigger(percent);
  const rows: { key: string; label: string; value: number }[] = [
    { key: "fresh", label: t.conversation.contextMeter.freshInput, value: metrics?.input_tokens ?? 0 },
    { key: "cache-read", label: t.conversation.contextMeter.cacheRead, value: metrics?.cache_read_input_tokens ?? 0 },
    { key: "cache-write", label: t.conversation.contextMeter.cacheWrite, value: metrics?.cache_creation_input_tokens ?? 0 },
    { key: "output", label: t.conversation.contextMeter.output, value: metrics?.output_tokens ?? 0 },
  ];

  return (
    <div className="conversation-context-meter" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="conversation-context-trigger"
        data-level={ratio >= 0.9 ? "critical" : ratio >= 0.7 ? "warn" : "normal"}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        title={metrics?.context_source ? `${t.conversation.contextMeter[metrics.context_source]} · ${percent}` : label}
        type="button"
      >
        <svg aria-hidden className="conversation-context-ring" viewBox="0 0 22 22">
          <circle className="conversation-context-ring-track" cx="11" cy="11" r={CONTEXT_RING_RADIUS} />
          <circle
            className="conversation-context-ring-value"
            cx="11"
            cy="11"
            r={CONTEXT_RING_RADIUS}
            strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
            strokeDashoffset={CONTEXT_RING_CIRCUMFERENCE * (1 - ratio)}
          />
        </svg>
      </button>
      {open ? (
        <div aria-label={t.conversation.contextMeter.title} className="conversation-context-panel" role="dialog">
          <div className="conversation-context-panel-head">
            <span>{t.conversation.contextMeter.title}</span>
            <strong>
              {t.conversation.contextMeter.ratio(formatCompactNumber(used), formatCompactNumber(total))}
              <em>{percent}</em>
            </strong>
          </div>
          <div aria-hidden className="conversation-context-bar">
            <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
          </div>
          <dl className="conversation-context-rows">
            <div>
              <dt><i aria-hidden className="conversation-context-swatch used" />{t.conversation.contextMeter.used}</dt>
              <dd>{formatNumber(used)}</dd>
            </div>
            <div>
              <dt><i aria-hidden className="conversation-context-swatch free" />{t.conversation.contextMeter.free}</dt>
              <dd>{formatNumber(free)}</dd>
            </div>
          </dl>
          <div className="conversation-context-section">{t.conversation.contextMeter.turnUsage}</div>
          <dl className="conversation-context-rows">
            {rows.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{formatNumber(row.value)}</dd>
              </div>
            ))}
          </dl>
          <small>{t.conversation.contextMeter.turnUsageHint}</small>
          <small>
            {metrics?.context_source ? t.conversation.contextMeter[metrics.context_source] : metrics ? t.conversation.contextMeter.snapshotHint : t.conversation.contextMeter.notStartedHint}
          </small>
        </div>
      ) : null}
    </div>
  );
}

function ConversationComposer({
  activity,
  conversationKey,
  currentModel,
  modelLoading,
  models,
  modelSaving,
  thinkingSaving,
  runtimeReady,
  runtimeUnavailableMessage,
  onModelChange,
  onThinkingLevelChange,
  onSend,
  onStop,
}: {
  activity: DesktopConversationActivityPayload | null;
  conversationKey: string;
  currentModel: ModelPayload | null;
  modelLoading: boolean;
  models: ModelPayload[];
  modelSaving: boolean;
  thinkingSaving: boolean;
  runtimeReady: boolean;
  runtimeUnavailableMessage: string;
  onModelChange: (provider: string, model: string, credentialSource: "local" | "cloud") => void;
  onThinkingLevelChange: (level: string) => void;
  onSend: (text: string, attachments: DesktopInputAttachmentPayload[]) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const t = useUiText();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<DesktopInputAttachmentPayload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousConversationKey = useRef(conversationKey);
  const hasWork = Boolean(activity?.active || activity?.queued.length);
  const actionLabel = hasWork
    ? stopping ? t.conversation.stopping : t.conversation.stop
    : sending ? t.conversation.sending : t.conversation.send;
  const showCharacterCount = text.length >= Math.floor(8192 * 0.75);
  const addAttachments = useCallback((selected: DesktopInputAttachmentPayload[]) => {
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.attachment_id));
      const additions = selected.filter((item) => !known.has(item.attachment_id));
      if (current.length + additions.length > 5) {
        const rejected = additions.map((item) => item.attachment_id);
        if (rejected.length) void window.lxe?.desktop.discardConversationFiles(rejected);
        setError(t.conversation.tooManyAttachments);
        return current;
      }
      return [...current, ...additions];
    });
  }, [t]);
  const selectFiles = async () => {
    setError("");
    try {
      if (!window.lxe) throw new Error(t.conversation.unavailable);
      addAttachments(await window.lxe.desktop.selectConversationFiles());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stageDroppedFiles = useCallback(async (files: File[]) => {
    if (!runtimeReady) return;
    setError("");
    try {
      if (!window.lxe) throw new Error(t.conversation.unavailable);
      addAttachments(await window.lxe.desktop.stageDroppedConversationFiles(files));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [addAttachments, runtimeReady, t]);
  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.attachment_id !== attachmentId));
    void window.lxe?.desktop.discardConversationFiles([attachmentId]);
  };
  useEffect(() => {
    if (previousConversationKey.current === conversationKey) return;
    previousConversationKey.current = conversationKey;
    const attachmentIds = attachments.map((item) => item.attachment_id);
    if (attachmentIds.length) void window.lxe?.desktop.discardConversationFiles(attachmentIds);
    setAttachments([]);
    setText("");
    setError("");
  }, [attachments, conversationKey]);
  useEffect(() => {
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (!runtimeReady) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };
    const dragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragActive(false);
      if (!runtimeReady) return;
      void stageDroppedFiles(Array.from(event.dataTransfer.files));
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
    };
  }, [runtimeReady, stageDroppedFiles]);
  const submit = async () => {
    const message = text.trim();
    if (!runtimeReady || modelSaving || thinkingSaving || sending || (!message && attachments.length === 0)) return;
    setSending(true);
    setError("");
    try {
      await onSend(message, attachments);
      setText("");
      setAttachments([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };
  const stop = async () => {
    if (!hasWork || stopping) return;
    setStopping(true);
    setError("");
    try {
      await onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className={`conversation-composer ${dragActive ? "drag-active" : ""}`}>
      {dragActive ? <div className="conversation-drop-hint">{t.conversation.dropFiles}</div> : null}
      <div className="conversation-compose-box">
        {attachments.length ? (
          <InputAttachmentList attachments={attachments} onRemove={removeAttachment} />
        ) : null}
        <textarea
          aria-label={t.conversation.placeholder}
          disabled={!runtimeReady}
          maxLength={8192}
          onChange={(event) => {
            setText(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
          placeholder={runtimeReady ? t.conversation.placeholder : runtimeUnavailableMessage}
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <div className="conversation-compose-actions">
          <div className="conversation-compose-leading">
            <button
              aria-label={t.conversation.addFiles}
              className="conversation-attach-button"
              disabled={!runtimeReady || sending || attachments.length >= 5}
              onClick={() => void selectFiles()}
              title={t.conversation.addFiles}
              type="button"
            >
              <Paperclip size={17} />
            </button>
            <span className="conversation-input-hint">
              {runtimeReady ? t.conversation.inputHint : runtimeUnavailableMessage}
            </span>
          </div>
          <div className="conversation-compose-trailing">
            <ConversationContextMeter activity={activity} currentModel={currentModel} />
            <ConversationModelPicker
              current={currentModel}
              disabled={!runtimeReady || sending || modelSaving || thinkingSaving}
              loading={modelLoading}
              models={models}
              onChange={onModelChange}
              saving={modelSaving}
            />
            <ConversationThinkingPicker
              current={currentModel}
              disabled={!runtimeReady || sending || modelSaving || thinkingSaving}
              onChange={onThinkingLevelChange}
              saving={thinkingSaving}
            />
            {showCharacterCount ? (
              <span className="conversation-character-count">
                {t.conversation.characterCount(formatNumber(text.length), formatNumber(8192))}
              </span>
            ) : null}
            {/* One button, two modes: it stops the running turn while there is
                work, and sends otherwise. Enter still queues a message mid-turn. */}
            <button
              aria-label={actionLabel}
              className="conversation-send-button"
              data-mode={hasWork ? "stop" : "send"}
              disabled={hasWork
                ? stopping
                : !runtimeReady || modelSaving || thinkingSaving || sending || (!text.trim() && attachments.length === 0)}
              onClick={() => void (hasWork ? stop() : submit())}
              title={actionLabel}
              type="button"
            >
              {(hasWork ? stopping : sending)
                ? <LoaderCircle className="conversation-spinner" size={17} />
                : hasWork
                  ? <Square aria-hidden fill="currentColor" size={13} strokeWidth={0} />
                  : <ArrowUp aria-hidden size={18} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
      {activity?.queued.length ? (
        <div className="conversation-queue-status" role="status">
          {t.conversation.queuedCount(formatNumber(activity.queued.length))}
        </div>
      ) : null}
      {error ? <div className="conversation-compose-error" role="alert">{error}</div> : null}
    </div>
  );
}

function ConversationStatus({ row }: { row: ConversationRow }) {
  const t = useUiText();
  const active = row.status === "running" || row.status === "stopping";
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsedMs = active && row.startedAt && row.startedAt > 0 ? clock - row.startedAt : row.elapsedMs ?? 0;
  const phaseLabel = () => {
    switch (row.phase) {
      case "preparing_context": return t.conversation.preparingContext;
      case "waiting_model": return t.conversation.waitingModel;
      case "thinking": return t.conversation.thinking;
      case "running_tool": return t.conversation.runningTool;
      case "generating_answer": return t.conversation.generatingAnswer;
      default: return t.conversation.preparingContext;
    }
  };
  const label = row.status === "error" ? t.conversation.error : row.status === "cancelled" ? t.conversation.cancelled
    : row.status === "completed" ? t.conversation.completed : row.status === "queued" ? t.conversation.queued
    : row.status === "stopping" ? t.conversation.stopping : phaseLabel();
  return <div aria-live={row.status === "error" ? "assertive" : "polite"} className={`live-progress-status state-${row.status}`}>
    {active ? <LoaderCircle className="conversation-spinner" size={13} /> : null}
    <span className="live-progress-label">{row.kind === "process" && row.status === "completed" ? t.conversation.processCompleted(elapsedMs >= 1_000 ? formatConversationDuration(elapsedMs) : "") : label}</span>
    {elapsedMs >= 1_000 && !(row.kind === "process" && row.status === "completed") ? <span className="live-progress-elapsed">{formatConversationDuration(elapsedMs)}</span> : null}
  </div>;
}

export const UnifiedConversationRow = React.memo(function UnifiedConversationRow({ row, expanded, onToggle, onOpenFile, onRevealFile, onOpenAttachment }: {
  row: ConversationRow; expanded: boolean; onToggle: (id: string) => void;
  onOpenFile: (id: string) => Promise<void>; onRevealFile: (id: string) => Promise<void>; onOpenAttachment: (id: string) => Promise<void>;
}) {
  const t = useUiText();
  const stateLabel = row.status === "error" ? t.conversation.error : row.status === "cancelled" ? t.conversation.cancelled
    : row.status === "completed" ? t.conversation.completed : row.status === "queued" ? t.conversation.queued : t.conversation.running;
  if (row.kind === "status") return <ConversationStatus row={row} />;
  if (row.kind === "process") return <button type="button" className="conversation-process-toggle"
    aria-expanded={expanded} onClick={() => onToggle(row.id)}>
    <ConversationStatus row={row} /><ChevronRight size={14} style={{transform: expanded ? "rotate(90deg)" : undefined}} />
  </button>;
  if (row.kind === "artifacts") return <TurnFileList files={row.artifacts ?? []} onOpenFile={onOpenFile} onRevealFile={onRevealFile} />;
  if (row.kind === "tool") {
    const operation = row.operation ?? (row.liveTool ? liveToolOperations([row.liveTool])[0] : undefined);
    if (!operation) return null;
    return <section className="tool-turn-group embedded single"><ul className="tool-op-list"><li className={`tool-op state-${operation.status}`}>
      <button className="tool-op-summary" type="button" aria-expanded={expanded} onClick={() => onToggle(row.id)}>
        <span className="tool-op-name">{t.message.toolActions[operation.action]}</span><span className="tool-op-argument">{operation.target}</span>
        {operation.status === "running" ? <LoaderCircle className="conversation-spinner" size={13} /> : null}
        {operation.status === "error" ? <CircleAlert size={13} /> : null}<ChevronRight className={expanded ? "tool-op-chevron expanded" : "tool-op-chevron"} size={14} />
      </button>
      {expanded ? <div className="tool-op-body">{row.operation ? defaultToolOperationBody(operation) : <LiveToolOperationBody operation={operation} />}</div> : null}
    </li></ul></section>;
  }
  const message = row.message!;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const thinking = blocks.length === 1 && isRecord(blocks[0]) && ["thinking", "redacted_thinking"].includes(String(blocks[0].type)) ? blocks[0] : undefined;
  if (thinking) return <div className="process-message-content">
    {row.status === "error" ? <div className="process-thinking-text">{stateLabel}</div> : null}
    <div className="process-thinking-paragraphs">{thinkingParagraphs(String(thinking.thinking ?? "")).map((paragraph, index) => <div className="process-thinking-text" key={index}>{paragraph}</div>)}</div>
    {thinking.redacted || thinking.type === "redacted_thinking" ? <div className="process-thinking-text redacted">{t.message.redactedThinking}</div> : null}
  </div>;
  if (row.presentation === "process" && message.role === "assistant") return <div className="timeline-text process-message-content">
    <MessageContent content={message.content} message={message} />
    {row.status === "error" ? <div role="status">{stateLabel}</div> : null}
    {message.attachments?.length ? <InputAttachmentList attachments={message.attachments} onOpen={onOpenAttachment} /> : null}
  </div>;
  if (message.role !== "user" && message.role !== "assistant") return <article className="message-card role-system"><RoleBadge role={message.role} /><MessageContent content={message.content} message={message} /></article>;
  const role = message.role;
  return <div className={`message-with-meta role-${role}`}>
    <article className={`message-card role-${role}${row.presentation === "final" ? " response-final-answer" : ""}${message.attachments?.length ? " has-attachments" : ""}`}>
      <MessageContent content={message.content} message={message} />
      {message.attachments?.length ? <InputAttachmentList attachments={message.attachments} onOpen={onOpenAttachment} /> : null}
      {row.error ? <div role="alert">{row.error}</div> : row.status === "error" ? <div role="status">{stateLabel}</div> : null}
      {role === "user" && ["sending", "queued"].includes(row.status ?? "") ? <div className="optimistic-message-state">{stateLabel}</div> : null}
    </article>
    <MessageMeta createdAt={Number(message.created_at ?? row.createdAt / 1000)} role={role} text={readerFacingMessageText(message)} />
  </div>;
}, (a, b) => a.expanded === b.expanded && a.onToggle === b.onToggle && a.onOpenFile === b.onOpenFile
  && a.onRevealFile === b.onRevealFile && a.onOpenAttachment === b.onOpenAttachment && JSON.stringify(a.row) === JSON.stringify(b.row));

export function SessionDetailView({
  fallbackSession,
  detail,
  activity,
  currentModel,
  models,
  modelLoading,
  modelSaving,
  thinkingSaving,
  newConversation,
  runtimeReady,
  runtimeUnavailableMessage,
  loading,
  error,
  hasOlder,
  loadingOlder,
  loadOlderError,
  onLoadOlder,
  hasNewer = false, onLoadNewer = async () => undefined, onJumpToLatest = () => {}, onVisibleGroups = () => {},
  onModelChange,
  onThinkingLevelChange,
  onSend,
  onStop,
  onOpenFile,
  onRevealFile,
  onOpenAttachment,
  pendingMessages,
}: {
  fallbackSession: SessionPayload | null;
  detail: SessionDetailPayload | null;
  activity: DesktopConversationActivityPayload | null;
  currentModel: ModelPayload | null;
  models: ModelPayload[];
  modelLoading: boolean;
  modelSaving: boolean;
  thinkingSaving: boolean;
  newConversation: boolean;
  runtimeReady: boolean;
  runtimeUnavailableMessage: string;
  loading: boolean;
  error: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlderError: string;
  onLoadOlder: () => Promise<SessionDetailPayload | undefined>;
  hasNewer?: boolean;
  onLoadNewer?: () => Promise<SessionDetailPayload | undefined>;
  onJumpToLatest?: () => void;
  onVisibleGroups?: (groups: string[]) => void;
  onModelChange: (provider: string, model: string, credentialSource: "local" | "cloud") => void;
  onThinkingLevelChange: (level: string) => void;
  onSend: (text: string, attachments: DesktopInputAttachmentPayload[]) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenFile: (artifactId: string) => Promise<void>;
  onRevealFile: (artifactId: string) => Promise<void>;
  onOpenAttachment: (attachmentId: string) => Promise<void>;
  pendingMessages: PendingConversationMessage[];
}) {
  const t = useUiText();
  const session = detail?.session || fallbackSession;
  const messages = detail?.messages || [];
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const closeSessionInfo = () => setSessionInfoOpen(false);
  const sessionInfoRef = useDialogFocus<HTMLElement>(sessionInfoOpen, closeSessionInfo);
  const memory = useRef<{ session: string; turns: Map<string, DesktopConversationTurnPayload> }>({ session: "", turns: new Map() });
  const sessionKey = session?.session_id ?? "new";
  if (memory.current.session !== sessionKey) memory.current = { session: sessionKey, turns: new Map() };
  for (const turn of [activity?.latest, activity?.active, ...(activity?.queued ?? [])]) {
    if (turn) memory.current.turns.set(turn.turn_id, turn);
  }
  const persistedTurns = new Set(messages.flatMap((message) => message.turn ? [message.turn.turn_id] : []));
  const durableIds = new Set(messages.flatMap((message) => Array.isArray(message.content) ? message.content.flatMap((block, index) => {
    if (!isRecord(block)) return [];
    return [block.type === "tool_call" || block.type === "tool_use" ? `tool:${block.id}` : `${message.id || message.display_id}:${index}`];
  }) : []));
  for (const [id, turn] of memory.current.turns) {
    if (["running", "stopping", "queued"].includes(turn.state)) continue;
    if (!persistedTurns.has(id)) {
      if (turn !== activity?.latest && !pendingMessages.some((item) => item.turnId === id)) memory.current.turns.delete(id);
      continue;
    }
    if (turn.stream) {
      // Keep ordering and failed-attempt text, but release duplicate successful payloads.
      const parts = turn.stream.process_parts.map((part) => durableIds.has(part.type === "tool" ? `tool:${part.tool_step.id}` : part.part_id)
        ? part.type === "tool" ? { ...part, tool_step: { ...part.tool_step, result_block: undefined, error_block: undefined } }
          : { ...part, text: "" }
        : part);
      memory.current.turns.set(id, { ...turn, stream: { ...turn.stream, content: "", thinking: "", tool_steps: [], process_parts: parts } });
    }
  }
  const turns = hasNewer ? [] : [...memory.current.turns.values()].filter((turn) =>
    persistedTurns.has(turn.turn_id) || turn.turn_id === activity?.active?.turn_id || turn.turn_id === activity?.latest?.turn_id || activity?.queued.some((entry) => entry.turn_id === turn.turn_id)
    || pendingMessages.some((item) => item.turnId === turn.turn_id));
  const rows = conversationRows(messages, turns, hasNewer ? [] : pendingMessages);
  const process = useProcessRows(rows, sessionKey);
  const [expandedRows, setExpandedRows] = useState<Map<string, boolean>>(() => new Map());
  useEffect(() => { setExpandedRows(new Map()); setSessionInfoOpen(false); }, [sessionKey]);
  const toggleRow = useCallback((id: string) => setExpandedRows((current) => new Map(current).set(id, !current.get(id))), []);
  const detailItems = session ? [
    { label: t.sessionDetail.sessionId, value: session.session_id, mono: true },
    { label: t.sessionDetail.source, value: sourceLabel(session.source_summary || session.source) },
    { label: t.sessionDetail.directory, value: session.workspace.directory, mono: true },
    { label: t.sessionDetail.worktree, value: session.workspace.worktree, mono: true },
    { label: t.sessionDetail.model, value: session.model || "-" },
    { label: t.sessionDetail.lastActive, value: formatDate(session.last_active_at) },
    { label: t.stats.messages, value: formatNumber(session.message_count) },
    { label: t.stats.toolCalls, value: formatNumber(session.tool_call_count) },
    { label: t.stats.tokens, value: formatNumber(session.input_tokens + session.output_tokens) },
    { label: t.stats.apiCalls, value: formatNumber(session.api_call_count) },
  ] : [];
  const title = newConversation ? t.conversation.newTitle : session?.title || t.sessions.title;
  return (
    <div className="session-detail conversation-view">
      <header className="conversation-header">
        {/* An unstarted conversation has no title worth printing, but the row
            still has to exist: it is the window's drag area on both desktops. */}
        <div className="conversation-header-copy">
          {newConversation ? null : (
            <>
              <MessageSquareText aria-hidden="true" className="conversation-header-icon" size={15} />
              <h2>{title}</h2>
              {session ? <span>{sourceLabel(session.source_summary || session.source)}</span> : null}
            </>
          )}
        </div>
        {session ? (
          <button
            className="session-detail-toggle"
            type="button"
            aria-expanded={sessionInfoOpen}
            onClick={() => setSessionInfoOpen((current) => !current)}
          >
            <Info size={15} />
            <span>{sessionInfoOpen ? t.sessionDetail.hideDetails : t.sessionDetail.details}</span>
            <ChevronRight size={15} className={sessionInfoOpen ? "expanded" : ""} />
          </button>
        ) : null}
      </header>
      {sessionInfoOpen && session ? (
        <>
          <button
            aria-label={t.sessionDetail.hideDetails}
            className="session-detail-scrim"
            onClick={closeSessionInfo}
            type="button"
          />
          <section
            aria-label={t.sessionDetail.details}
            aria-modal="true"
            className="session-detail-panel"
            ref={sessionInfoRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="session-detail-panel-header">
              <div>
                <span>{t.sessionDetail.eyebrow}</span>
                <h3>{title}</h3>
              </div>
              <button aria-label={t.sessionDetail.hideDetails} onClick={closeSessionInfo} type="button">
                <X size={17} />
              </button>
            </header>
            <dl className="session-detail-grid">
              {detailItems.map((item) => (
                <div className="session-detail-field" key={item.label}>
                  <dt>{item.label}</dt>
                  <dd className={item.mono ? "mono" : ""}>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      ) : null}
      {loading ? <EmptyState label={t.sessionDetail.loading} /> : null}
      {error ? <EmptyState label={t.common.errorPrefix(t.sessionDetail.errorLabel, error)} /> : null}
      {!loading && !error ? (
        <ConversationWindow key={sessionKey} rows={process.rows} hasOlder={hasOlder} hasNewer={hasNewer}
          loadOlder={onLoadOlder} loadNewer={onLoadNewer} jumpToLatest={onJumpToLatest} onVisibleGroups={onVisibleGroups}
          pageError={loadOlderError} empty={newConversation ? <ConversationWelcome /> : <EmptyState label={t.sessionDetail.empty} />}
          renderRow={(row) => <UnifiedConversationRow row={row} expanded={row.kind === "process" ? process.states.get(row.id)?.expanded ?? false : expandedRows.get(row.id) ?? false} onToggle={row.kind === "process" ? process.toggle : toggleRow}
            onOpenFile={onOpenFile} onRevealFile={onRevealFile} onOpenAttachment={onOpenAttachment} />} />
      ) : null}
      <div className="conversation-composer-dock">
        <ConversationComposer
          activity={activity}
          conversationKey={session?.session_id ?? (newConversation ? "new" : "")}
          currentModel={currentModel}
          modelLoading={modelLoading}
          models={models}
          modelSaving={modelSaving}
          thinkingSaving={thinkingSaving}
          onModelChange={onModelChange}
          onThinkingLevelChange={onThinkingLevelChange}
          runtimeReady={runtimeReady}
          runtimeUnavailableMessage={runtimeUnavailableMessage}
          onSend={onSend}
          onStop={onStop}
        />
      </div>
    </div>
  );
}

function SessionActionsMenu({
  anchor,
  deletingBlocked,
  error,
  pending,
  session,
  onClose,
  onDelete,
  onPin,
}: {
  anchor: HTMLElement;
  deletingBlocked: boolean;
  error: string;
  pending: boolean;
  session: SessionPayload;
  onClose: (restoreFocus?: boolean) => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  const t = useUiText();
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  const width = 150;
  const estimatedHeight = error ? 113 : 82;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  const top = rect.bottom + 5 + estimatedHeight <= window.innerHeight
    ? rect.bottom + 5
    : Math.max(8, rect.top - estimatedHeight - 5);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target) && !anchor.contains(target)) {
        onClose(false);
      }
    };
    document.addEventListener("pointerdown", pointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", pointerDown);
    };
  }, [anchor, onClose]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return createPortal(
    <div
      aria-label={t.sessions.actionsFor(session.title || t.common.unnamedSession)}
      className="session-actions-menu"
      onKeyDown={handleKeyDown}
      ref={menuRef}
      role="menu"
      style={{ left, top, width }}
    >
      <button disabled={pending} onClick={onPin} role="menuitem" type="button">
        {session.pinned_at > 0 ? <PinOff size={12} /> : <Pin size={12} />}
        <span>{session.pinned_at > 0 ? t.sessions.unpin : t.sessions.pin}</span>
      </button>
      <button
        className="danger"
        disabled={pending || deletingBlocked}
        onClick={onDelete}
        role="menuitem"
        title={deletingBlocked ? t.sessions.deleteRunning : undefined}
        type="button"
      >
        <Trash2 size={12} />
        <span>{t.sessions.delete}</span>
      </button>
      {deletingBlocked ? <p className="session-actions-hint">{t.sessions.deleteRunning}</p> : null}
      {error ? <p className="session-actions-error" role="alert">{error}</p> : null}
    </div>,
    document.body,
  );
}

function SessionDeleteDialog({
  error,
  pending,
  session,
  onCancel,
  onConfirm,
}: {
  error: string;
  pending: boolean;
  session: SessionPayload;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useUiText();
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const title = session.title || t.common.unnamedSession;
  return createPortal(
    <div className="session-delete-backdrop">
      <section
        aria-labelledby="session-delete-title"
        aria-modal="true"
        className="session-delete-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id="session-delete-title">{t.sessions.deleteTitle}</h2>
        <p>{t.sessions.deletePrompt(title)}</p>
        <p className="session-delete-note">{t.sessions.deleteNote}</p>
        {error ? <p className="session-delete-error" role="alert">{error}</p> : null}
        <footer>
          <button disabled={pending} onClick={onCancel} type="button">{t.sessions.cancelDelete}</button>
          <button className="danger" disabled={pending} onClick={onConfirm} type="button">
            {pending ? <LoaderCircle className="conversation-spinner" size={14} /> : null}
            <span>{pending ? t.sessions.deleting : t.sessions.deleteConfirm}</span>
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function SessionsIndex({
  sessions,
  query,
  searchOpen,
  searchFocusKey = 0,
  initialLoading,
  loadingMore,
  error,
  hasMore,
  loadMoreError,
  selectedSessionId,
  onQueryChange,
  onSearchClose,
  onLoadMore,
  onNew,
  onOpen,
  onPin,
  onDelete,
  onTransientInteractionChange,
  visible = true,
  deleteBlockedSessionIds = [],
}: {
  sessions: SessionPayload[];
  query: string;
  searchOpen: boolean;
  searchFocusKey?: number;
  initialLoading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  loadMoreError: string;
  selectedSessionId: string;
  onQueryChange: (value: string) => void;
  onSearchClose: () => void;
  onLoadMore: () => void;
  onNew: () => void;
  onOpen: (session: SessionPayload) => void;
  onPin: (session: SessionPayload, pinned: boolean) => Promise<void>;
  onDelete: (session: SessionPayload) => Promise<void>;
  onTransientInteractionChange?: (active: boolean) => void;
  visible?: boolean;
  deleteBlockedSessionIds?: readonly string[];
}) {
  const t = useUiText();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = query.trim();
  const emptyLabel = trimmedQuery ? t.sessions.emptySearch : t.sessions.empty;
  const showTable = sessions.length > 0;
  const [menu, setMenu] = useState<{ anchor: HTMLElement; session: SessionPayload } | null>(null);
  const [confirmation, setConfirmation] = useState<SessionPayload | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const blockedIds = useMemo(() => new Set(deleteBlockedSessionIds), [deleteBlockedSessionIds]);
  const { pinned: pinnedSessions, recent: recentSessions } = groupSidebarSessions(sessions, Boolean(trimmedQuery));
  const transientInteractionActive = Boolean(menu);

  useEffect(() => {
    onTransientInteractionChange?.(transientInteractionActive);
    return () => {
      if (transientInteractionActive) onTransientInteractionChange?.(false);
    };
  }, [onTransientInteractionChange, transientInteractionActive]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen, searchFocusKey]);

  function maybeLoadMore() {
    const list = sessionListRef.current;
    if (!list || initialLoading || loadingMore || !hasMore || loadMoreError) {
      return;
    }
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom <= 80) {
      onLoadMore();
    }
  }

  useEffect(() => {
    maybeLoadMore();
  }, [sessions.length, initialLoading, loadingMore, hasMore, loadMoreError]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setMenu((current) => {
      if (restoreFocus) current?.anchor.focus();
      return null;
    });
    setActionError("");
  }, []);

  useEffect(() => {
    if (visible) return;
    closeMenu(false);
  }, [closeMenu, visible]);

  async function pinSelected() {
    if (!menu || actionPending) return;
    setActionPending(true);
    setActionError("");
    try {
      await onPin(menu.session, menu.session.pinned_at <= 0);
      closeMenu();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }

  async function deleteConfirmed() {
    if (!confirmation || actionPending) return;
    setActionPending(true);
    setActionError("");
    try {
      await onDelete(confirmation);
      setConfirmation(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }

  const renderSession = (session: SessionPayload) => {
    const selected = selectedSessionId === session.session_id;
    const sessionTitle = session.title || t.common.unnamedSession;
    const menuOpen = menu?.session.session_id === session.session_id;
    return (
      <div className={`${selected ? "session-index-item active" : "session-index-item"}${menuOpen ? " menu-open" : ""}`} key={session.session_id}>
        <button
          aria-current={selected ? "page" : undefined}
          aria-label={sessionTitle}
          className="session-index-open"
          title={sessionTitle}
          type="button"
          onClick={() => onOpen(session)}
        >
          <span aria-hidden="true" className="session-index-icon" />
          <span className="primary-cell">{sessionTitle}</span>
        </button>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={t.sessions.actionsFor(sessionTitle)}
          className="session-index-actions"
          onClick={(event) => {
            event.stopPropagation();
            setActionError("");
            setMenu(menuOpen ? null : { anchor: event.currentTarget, session });
          }}
          title={t.sessions.actionsFor(sessionTitle)}
          type="button"
        >
          <MoreVertical size={15} />
        </button>
      </div>
    );
  };

  return (
    <div className="session-index-panel">
      <button className="session-new-button" type="button" onClick={onNew} aria-label={t.sessions.newConversationAria}>
        <Plus size={15} />
        <span>{t.sessions.newConversation}</span>
      </button>
      {searchOpen ? (
        <div className="search-box">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t.sessions.searchPlaceholder}
            aria-label={t.sessions.searchAria}
          />
          <button
            aria-label={t.sessions.closeSearch}
            className="session-search-close"
            onClick={onSearchClose}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {error ? <EmptyState label={t.common.errorPrefix(t.sessions.errorLabel, error)} /> : null}
      {!showTable && initialLoading && !error ? <EmptyState label={t.sessions.loading} /> : null}
      {!showTable && !initialLoading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showTable ? (
        <div
          className="session-index-list"
          onScroll={() => {
            closeMenu(false);
            maybeLoadMore();
          }}
          ref={sessionListRef}
        >
          {trimmedQuery ? <div className="session-index-heading">{t.sessions.searchResults(formatNumber(sessions.length))}</div> : null}
          {pinnedSessions.length > 0 ? (
            <div className="session-index-heading">{t.sessions.pinned}</div>
          ) : null}
          {pinnedSessions.map(renderSession)}
          {!trimmedQuery && recentSessions.length > 0 ? (
            <div className="session-index-heading">{t.sessions.recent}</div>
          ) : null}
          {recentSessions.map(renderSession)}
          {loadingMore ? (
            <span aria-label={t.common.loading} className="sessions-load-more-indicator" role="status">
              <LoaderCircle aria-hidden="true" className="conversation-spinner" size={14} />
            </span>
          ) : null}
          {loadMoreError ? (
            <div className="session-load-more-error">{t.common.errorPrefix(t.sessions.errorLabel, loadMoreError)}</div>
          ) : null}
        </div>
      ) : null}
      {menu ? (
        <SessionActionsMenu
          anchor={menu.anchor}
          deletingBlocked={blockedIds.has(menu.session.session_id)}
          error={actionError}
          pending={actionPending}
          session={menu.session}
          onClose={closeMenu}
          onDelete={() => {
            if (blockedIds.has(menu.session.session_id)) return;
            setConfirmation(menu.session);
            closeMenu(false);
          }}
          onPin={() => void pinSelected()}
        />
      ) : null}
      {confirmation ? (
        <SessionDeleteDialog
          error={actionError}
          pending={actionPending}
          session={confirmation}
          onCancel={() => {
            if (actionPending) return;
            setConfirmation(null);
            setActionError("");
          }}
          onConfirm={() => void deleteConfirmed()}
        />
      ) : null}
    </div>
  );
}
