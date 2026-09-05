import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const view = readFileSync(path.join(sourceDir, "features/sessions/view.tsx"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const queries = readFileSync(path.join(sourceDir, "api/queries.ts"), "utf8");
const conversation = readFileSync(path.join(sourceDir, "features/sessions/conversation.ts"), "utf8");
const windowView = readFileSync(path.join(sourceDir, "features/sessions/virtual-window.tsx"), "utf8");
const presentation = readFileSync(path.join(sourceDir, "features/sessions/presentation.ts"), "utf8");
const markdown = readFileSync(path.join(sourceDir, "shared/ui/markdown.tsx"), "utf8");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8").replaceAll("\r\n", "\n");

test("sessions view exposes text conversation controls and IME-safe keyboard behavior", () => {
  assert.match(view, /maxLength=\{8192\}/);
  assert.match(view, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/);
  assert.match(windowView, /aria-live="polite"/);
  // Send and stop are one control in two modes, so the running turn can always
  // be interrupted from the same place the message was sent.
  assert.match(view, /data-mode=\{hasWork \? "stop" : "send"\}/);
  assert.match(view, /onClick=\{\(\) => void \(hasWork \? stop\(\) : submit\(\)\)\}/);
  assert.doesNotMatch(view, /conversation-stop-button/);
  assert.match(windowView, /loadOlder/);
  assert.match(view, /session-new-button/);
  assert.match(view, /selectConversationFiles/);
  assert.match(view, /stageDroppedConversationFiles/);
  assert.match(main, /attachment_ids: attachments\.map/);
});

test("the composer switches the shared model before the next turn", () => {
  assert.match(view, /function ConversationModelPicker/);
  assert.match(view, /aria-haspopup="menu"/);
  assert.match(view, /role="menuitemradio"/);
  assert.match(view, /event\.key !== "Escape"/);
  assert.match(view, /current\?\.provider !== provider[\s\S]*current\.model !== model[\s\S]*current\.credential_source !== credentialSource/);
  assert.match(view, /disabled=\{saving \|\| !choice\.selectable\}/);
  assert.match(view, /!runtimeReady \|\| modelSaving \|\| thinkingSaving \|\| sending/);
  assert.match(main, /activeSection === "sessions" \|\| \(capabilitiesOpen && capabilityView === "models"\)/);
  assert.match(main, /onModelChange=\{setCurrentModel\}/);
  assert.doesNotMatch(view, /t\.models\.moreModels|onOpenModels/);
  assert.match(styles, /\.conversation-model-menu \{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 9px\)/s);
  assert.match(styles, /\.conversation-model-option:disabled \{[^}]*opacity:\s*0\.46;[^}]*filter:\s*grayscale\(1\)/s);
});

test("the composer edits thinking effort using the shared next-turn preference", () => {
  assert.match(view, /function ConversationThinkingPicker/);
  assert.match(view, /current\?\.thinking_state\?\.editable && levels\.length > 1/);
  assert.match(view, /modelThinkingLevelLabel\(current, level\)/);
  assert.match(view, /className=\{dragging \? "conversation-thinking-levels dragging" : "conversation-thinking-levels"\}/);
  assert.match(view, /onPointerUp=\{finishDragging\}/);
  assert.match(view, /event\.detail === 0/);
  assert.doesNotMatch(view, /const slideToClientX = [\s\S]*?applyLevel\(level\);[\s\S]*?const handleTrackPointerDown/);
  assert.match(view, /onThinkingLevelChange/);
  assert.match(main, /thinkingSaving=\{thinkingMutation\.isPending\}/);
  assert.match(main, /onThinkingLevelChange=\{setCurrentThinkingLevel\}/);
  assert.match(styles, /\.conversation-thinking-menu \{[^}]*bottom:\s*calc\(100% \+ 9px\)/s);
});

test("message identity confirms persistence without retiring the visible component", () => {
  assert.doesNotMatch(view, /transcriptCaughtUp|transcriptFetchedAt|LocalTurnCards/);
  assert.match(presentation, /client_message_id/);
  assert.match(view, /UnifiedConversationRow/);
  assert.match(windowView, /getItemKey/);
});

test("the transcript uses a bounded virtual window with bidirectional history", () => {
  assert.match(windowView, /useVirtualizer/);
  assert.match(windowView, /anchorTo: "end"/);
  assert.match(windowView, /overflowAnchor: "none"/);
  assert.match(windowView, /overscan: 5/);
  assert.match(windowView, /conversation-jump-latest/);
  assert.match(queries, /message_after: cursor/);
  assert.match(queries, /boundConversationWindow/);
  assert.doesNotMatch(view, /previousHeight/);
});

test("the focused conversation takes the full panel without a second session column", () => {
  // The old nested session panel competed with both the transcript and the
  // composer for width and height. The application sidebar owns that list now.
  assert.doesNotMatch(styles, /\.conversation-view \{[^}]*height: calc\(100vh/);
  assert.doesNotMatch(styles, /\.sessions-split/);
  assert.doesNotMatch(main, /sessions-split/);
  assert.match(styles, /\.sessions-conversation-shell \{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
  assert.match(main, /"content-panel content-panel-fill"/);
  assert.doesNotMatch(view, /conversation-header-sidebar-toggle/);
  assert.match(styles, /\.conversation-header \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
});

test("conversation messages and composer share the same focused reading axis", () => {
  // Feed, composer and assistant content all track the one variable, so the
  // axis cannot drift apart the way a hard-coded width per rule allowed.
  assert.match(styles, /\.conversation-feed \{[^}]*width:\s*min\(var\(--assistant-content-width\),/s);
  assert.match(styles, /\.conversation-feed \.message-text,\s*\.conversation-feed \.message-markdown \{[^}]*font-size:\s*0\.875rem;[^}]*font-weight:\s*370;[^}]*line-height:\s*1\.7;/s);
  assert.match(styles, /\.conversation-composer \{[^}]*width:\s*min\(var\(--assistant-content-width\),/s);
  assert.match(styles, /\.conversation-compose-box \{[^}]*border:\s*0\.5px solid var\(--border-strong\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-assistant \{[^}]*background:\s*transparent/s);
  // The user bubble shares the conversation's neutral muted fill instead of
  // turning into a white card against the light page plane.
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \{[^}]*max-width:\s*min\(620px, 78%\)[^}]*margin:\s*22px 0 1px;[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--conversation-muted-fill\)/s);
  assert.match(styles, /\.sessions-focus \.content-panel-fill \{[^}]*background:\s*var\(--bg\)/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \.message-markdown > :last-child \{[^}]*margin-bottom:\s*0/s);
  assert.match(view, /const showCharacterCount = text\.length >= Math\.floor\(8192 \* 0\.75\)/);
  assert.match(view, /message.role !== "user" && message.role !== "assistant"/);
});

test("conversation markdown tables use separated cells instead of a framed grid", () => {
  assert.match(styles, /\.message-markdown \.markdown-table-scroll \{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-markdown table \{[^}]*border-collapse:\s*separate;[^}]*border-spacing:\s*3px;/s);
  // Cells and user bubbles share one deliberately neutral grey so neither can
  // drift cool or warm independently of the other.
  assert.match(styles, /\.message-markdown th,\s*\.message-markdown td \{[^}]*border:\s*0;[^}]*border-radius:\s*6px;[^}]*background:\s*var\(--conversation-muted-fill\);/s);
  assert.doesNotMatch(styles, /\.message-markdown th,\s*\.message-markdown td \{[^}]*background:\s*var\(--surface-subtle\);/s);
  assert.match(styles, /\.message-markdown th \{[^}]*background:\s*var\(--table-header-fill\);/s);
  assert.doesNotMatch(styles, /\.message-markdown (?:th|td|tr:last-child td) \{[^}]*border-bottom:/s);
});

test("conversation quotes and code keep structure without tinted panels", () => {
  assert.match(styles, /\.message-markdown blockquote \{[^}]*border-left:\s*2px solid var\(--accent-muted\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-markdown pre \{[^}]*border:\s*1px solid var\(--border\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /--inline-code-fill:\s*var\(--table-header-fill\);/);
  assert.match(styles, /\.message-markdown code \{[^}]*background:\s*var\(--inline-code-fill\);[^}]*color:\s*var\(--inline-code-text\);/s);
  assert.match(styles, /\.message-markdown pre code \{[^}]*background:\s*transparent;[^}]*color:\s*inherit;/s);
});

test("conversation fenced code reaches the syntax highlighter", () => {
  assert.match(markdown, /import \{ CodeBlock \} from "\.\/code-block"/);
  assert.match(markdown, /const language = CODE_LANGUAGE_PATTERN\.exec\(className\)\?\.\[1\] \|\| ""/);
  assert.match(markdown, /return <CodeBlock autoDetect=\{!language\} code=\{code\} language=\{language\} \/>/);
  assert.match(styles, /\.hljs-keyword,[^}]*color:\s*var\(--accent-strong\)/s);
  assert.match(styles, /\.hljs-string,[^}]*color:\s*var\(--rate-good\)/s);
});

test("unified status rows retain phases and locally ticking elapsed time", () => {
  for (const phase of ["preparing_context", "waiting_model", "thinking", "running_tool", "generating_answer"]) assert.ok(view.includes(`case "${phase}"`));
  assert.match(view, /function ConversationStatus/);
  assert.match(view, /window\.setInterval\(\(\) => setClock\(Date\.now\(\)\), 250\)/);
  assert.match(view, /elapsedMs >= 1_000/);
  assert.match(presentation, /turn\.started_at/);
  assert.match(styles, /\.live-progress-status/);
});

test("details and runtime status overlay the conversation without moving the reading axis", () => {
  assert.match(view, /useDialogFocus<HTMLElement>\(sessionInfoOpen, closeSessionInfo\)/);
  assert.match(view, /className="session-detail-panel"[\s\S]*?role="dialog"/);
  assert.match(styles, /\.session-detail-panel \{[^}]*position:\s*absolute[^}]*width:\s*min\(380px,/s);
  assert.match(main, /runtime-status-host sessions-focus/);
  assert.match(styles, /@media \(max-width:\s*1060px\)[\s\S]*?\.sessions-focus \.runtime-status-floating \{[^}]*bottom:\s*114px/s);
});

test("tool files reach the conversation and open through Main", () => {
  assert.match(view, /turn-file-card/);
  assert.match(view, /row.kind === "artifacts"/);
  assert.match(conversation, /function appendArtifactGroups/);
  assert.match(conversation, /artifact\.turn_id/);
  assert.doesNotMatch(view, /toolGroupArtifacts\(group\.messages\)/);
  assert.match(view, /file\.artifact_id/);
  assert.match(main, /operation: "sessions\.file\.open"/);
  assert.match(main, /artifact_id: artifactId/);
  assert.doesNotMatch(main, /sessions\.file\.open"[\s\S]{0,160}path/);
  // The OS failure text is what surfaces, not a stand-in message.
  assert.match(main, /if \(!result\.opened\) throw new Error\(result\.error\)/);
});

test("the file list spends its width on what differs between the files", () => {
  // The name is the real file name: the spreadsheet icon does not say which of
  // xlsx/xls/csv the file is, so the extension has to survive in the name.
  assert.match(view, /className="turn-file-name" title=\{file\.name\}>\{file\.name\}/);
  assert.doesNotMatch(view, /function fileDisplayName/);
  // The marker stays on every row: it is the anchor the eye lands on, so it is
  // made quiet rather than removed. A filled accent pill outshouted the name.
  // An extension with a type mark gets that icon; every other extension keeps
  // the text badge so the slot never renders empty - and never borrows a
  // cousin's icon (TSV is not CSV).
  assert.match(view, /<span aria-hidden="true" className="turn-file-extension">\s*\{FILE_TYPE_ICONS\[extension\]\s*\?\s*<img alt="" draggable=\{false\} src=\{FILE_TYPE_ICONS\[extension\]\} \/>\s*:\s*extension\}\s*<\/span>/);
  assert.match(view, /const FILE_TYPE_ICONS: Record<string, string> = \{\s*CSV: csvIcon,\s*HTML: htmlIcon,\s*XLS: xlsIcon,\s*XLSX: xlsxIcon,\s*\};/);
  assert.doesNotMatch(view, /SPREADSHEET_EXTENSIONS|\bSheet\b/);
  assert.doesNotMatch(styles, /\.turn-file-extension \{[^}]*background:/s);
  assert.match(styles, /\.turn-file-extension \{[^}]*color:\s*var\(--muted-light\)/s);
  assert.match(styles, /\.turn-file-extension > img \{[^}]*width:\s*22px[^}]*height:\s*22px/s);
  // Cards are --surface on the --bg plane like the rest of the transcript;
  // --surface-subtle sits too close to the background to read as a card.
  assert.match(styles, /\.turn-file-card \{[^}]*background:\s*var\(--surface\)[^}]*text-align:\s*left/s);
  assert.match(styles, /\.turn-file-card \{[^}]*border:\s*1px solid var\(--border\)/s);
  // Two columns only while both can hold a name; otherwise one full-width row
  // beats two clipped ones.
  assert.match(styles, /\.turn-file-grid \{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(330px, 100%\), 1fr\)\)/s);
  // The arrow is decoration on a card that is entirely clickable, but progress
  // is feedback and has to stay visible.
  assert.match(styles, /\.turn-file-action \{[^}]*opacity:\s*0/s);
  assert.match(styles, /\.turn-file-action\.conversation-spinner \{[^}]*opacity:\s*1/s);
});

test("input attachments expose opaque chips and open through Main", () => {
  assert.match(view, /InputAttachmentList/);
  assert.match(view, /message\.attachments/);
  assert.match(main, /operation: "sessions\.attachment\.open"/);
  assert.match(main, /attachment_id: attachmentId/);
  assert.doesNotMatch(main, /sessions\.attachment\.open"[\s\S]{0,160}path/);
});

test("dashboard sends through Main, restores activity, and merges cursor history", () => {
  assert.match(main, /operation: "sessions\.send"/);
  assert.match(main, /operation: "sessions\.stop"/);
  assert.match(main, /onConversationEvent/);
  assert.match(main, /onConversationStreamEvent/);
  assert.match(main, /requestAnimationFrame\(flush\)/);
  assert.match(main, /applyDesktopStreamBatch\(activity, batch\)/);
  assert.match(main, /setQueryData\(\s*dashboardQueryKeys\.sessions\.activity\(activity\.session_id\)/s);
  assert.match(main, /useConversationActivityQuery/);
  assert.doesNotMatch(main, /conversationActivities|setConversationActivities/);
  assert.doesNotMatch(main, /if \(section === "sessions"\) \{\s*setSelectedSessionId\(""\)/s);
  assert.match(queries, /operation: "sessions\.activity"/);
  assert.match(queries, /message_before: before/);
  assert.match(queries, /mergeLatestConversationWindow/);
  assert.match(queries, /prependConversationWindow/);
  assert.doesNotMatch(main, /response_route_id/);
});

test("a user message is projected before the RPC settles and remains on send failure", () => {
  const enqueue = main.indexOf("setPendingConversationMessages((current) => [...current, pendingMessage])");
  assert.ok(enqueue >= 0 && main.indexOf('operation: "sessions.send"', enqueue) > enqueue);
  assert.match(main, /client_message_id: pendingId/);
  assert.match(main, /acknowledgeConversationSend/);
  assert.match(presentation, /item.error/);
  assert.doesNotMatch(view, /pendingMessages\.map/);
});

test("thinking, tools and text share one ordered row projection", () => {
  assert.match(view, /conversationRows\(messages, turns/);
  assert.match(view, /renderRow=\{/);
  assert.match(windowView, /renderRow\(rows\[item.index\]/);
  assert.match(presentation, /part.part_id/);
  assert.match(presentation, /tool_step.id/);
  assert.doesNotMatch(view, /PersistedTimeline|LiveTimeline|liveOwnedTurnIds/);
  assert.match(view, /expandedRows.get\(row.id\)/);
});

test("reader messages expose only copy and timestamp metadata", () => {
  assert.match(view, /function MessageMeta/);
  assert.match(view, /className="message-meta-copy"/);
  assert.match(view, /formatMessageTime\(createdAt\)/);
  assert.match(view, /readerFacingMessageText\(message\)/);
  assert.match(view, /role === "user" \? time : copyButton/);
  assert.match(styles, /\.message-meta-copy\s*\{[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-with-meta\.role-user\s*\{[^}]*align-items:\s*flex-end;/s);
  assert.doesNotMatch(view, /message-meta[^\n]*(?:ThumbsUp|ThumbsDown|Maximize)/);
});

test("user message metadata is smaller and revealed on hover", () => {
  assert.match(styles, /\.message-with-meta\.role-user\s*\{[^}]*position:\s*relative;[^}]*width:\s*fit-content;[^}]*padding-bottom:\s*29px;/s);
  assert.match(styles, /\.message-meta\.role-user\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*min-height:\s*25px;[^}]*gap:\s*6px;[^}]*margin-top:\s*0;[^}]*font-size:\s*0\.6875rem;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.message-with-meta\.role-user:hover \.message-meta,\s*\.message-with-meta\.role-user:focus-within \.message-meta\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
  assert.match(styles, /\.message-meta\.role-user \.message-meta-copy\s*\{[^}]*width:\s*25px;[^}]*height:\s*25px;/s);
  assert.match(styles, /@media \(hover:\s*none\)\s*\{\s*\.message-meta\.role-user,\s*\.message-meta\.role-assistant\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
});

test("assistant message metadata is smaller, sits closer to the response, and is revealed on hover", () => {
  assert.match(styles, /\.message-meta\.role-assistant\s*\{[^}]*min-height:\s*19px;[^}]*gap:\s*6px;[^}]*margin-top:\s*0;[^}]*font-size:\s*0\.6875rem;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.message-with-meta\.role-assistant:hover \.message-meta,\s*\.message-with-meta\.role-assistant:focus-within \.message-meta\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
  assert.match(styles, /\.message-meta\.role-assistant \.message-meta-copy\s*\{[^}]*width:\s*19px;[^}]*height:\s*19px;/s);
  assert.match(styles, /\.message-meta\.role-assistant \.message-meta-copy svg\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s);
});

test("the same component handles streamed and persisted content without replaying text", () => {
  assert.match(view, /UnifiedConversationRow = React.memo/);
  assert.doesNotMatch(view, /usePacedText|LiveTextPart|TEXT_RENDER_PACE/);
  assert.match(presentation, /existing.get\(part.id\)/);
  assert.match(windowView, /key=\{item.key\}/);
});

test("a tool reads the same live as it does in history", () => {
  // Both sources use the raw name and the same deterministic presentation;
  // the curated live title cannot make the wording jump at persistence time.
  assert.match(view, /toolOperationPresentation\(name, argument\)/);
  assert.match(view, /const name = String\(step\.name \|\| "tool"\)/);
  assert.doesNotMatch(view, /<span>\{step\.title\}<\/span>/);
  // One unbroken command must shrink inside its row instead of turning the
  // transcript itself into a horizontal scroller.
  assert.match(view, /className="tool-op-argument"/);
  assert.match(styles, /\.conversation-transcript \{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.tool-op-argument \{[^}]*overflow:\s*hidden[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  // Beside a growing textarea the composer buttons must not be squeezed out of
  // their own footprint.
  assert.match(styles, /\.conversation-send-button,\n\.conversation-attach-button \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.conversation-send-button,\n\.conversation-attach-button \{[^}]*white-space: nowrap/);
});

test("expanded tool details use dividers instead of stacked tinted surfaces", () => {
  assert.match(view, /const longScalars = scalars\.filter/);
  assert.match(view, /className="tool-call-long-value"/);
  assert.match(styles, /\.tool-turn-group\.embedded\.single \{[^}]*border:\s*0/s);
  assert.match(styles, /\.tool-op-body \{[^}]*border-top:\s*1px solid var\(--border\)[^}]*background:\s*transparent/s);
  assert.match(styles, /\.message-block\.tool-block \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.message-block\.result-block \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.code-block\.tool-result-full \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.code-block > code \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.tool-call-long-value \{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/s);
});

test("nothing pads the header away from the transcript", () => {
  // The conversation element also carries .session-detail, a grid container
  // with gap: 12px. Switching display to flex keeps that gap, which put a band
  // between the header and the first message that no rule asked for.
  assert.match(styles, /\.conversation-view \{[^}]*gap:\s*0;/s);
  assert.match(styles, /\.session-detail \{[^}]*gap:\s*12px;/s);
  // min-height above the row's own content is pure padding: a 30px button
  // inside 7px of padding needs 44.
  assert.match(styles, /\.conversation-header \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.session-detail-toggle \{[^}]*min-height:\s*30px;/s);
});

test("the transcript dissolves under the header instead of being cut by a rule", () => {
  // A border has to be drawn because content is sliced at a hard edge. Fading
  // it removes the thing the border was there to explain, which is why the
  // header carries no rule of its own.
  assert.match(styles, /\.conversation-header \{[^}]*border-bottom:\s*0;/s);
  assert.doesNotMatch(styles, /\.conversation-header \{[^}]*border-bottom:\s*1px/s);
  // Mirrors the composer dock's fade at the other end, and starts from the
  // plane's own colour so the two never drift apart.
  assert.match(
    styles,
    /\.conversation-scroll-area::before \{[^}]*background:\s*linear-gradient\(to bottom, var\(--bg\)/s,
  );
  // Both edges of the scroll container do the cutting, so both need covering.
  // The dock's own gradient sits below the container and never reached the
  // bottom edge that slices the text.
  assert.match(
    styles,
    /\.conversation-scroll-area::after \{[^}]*background:\s*linear-gradient\(to top, var\(--bg\)/s,
  );
  assert.match(styles, /\.conversation-scroll-area::before,\n\.conversation-scroll-area::after \{[^}]*pointer-events:\s*none;/s);
});
