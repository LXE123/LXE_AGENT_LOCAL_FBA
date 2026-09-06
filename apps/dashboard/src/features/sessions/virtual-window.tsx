import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { processId } from "./process";
import type { ConversationRow } from "./presentation";
import { useUiText } from "../../shared/i18n";

export function ConversationWindow({ rows, renderRow, hasOlder, hasNewer, loadOlder, loadNewer, jumpToLatest, onVisibleGroups, pageError, empty }: {
  rows: ConversationRow[]; renderRow: (row: ConversationRow) => React.ReactNode;
  hasOlder: boolean; hasNewer: boolean; loadOlder: () => Promise<unknown>; loadNewer: () => Promise<unknown>;
  jumpToLatest: () => void; onVisibleGroups: (groups: string[]) => void; pageError: string; empty?: React.ReactNode;
}) {
  const t = useUiText();
  const root = useRef<HTMLDivElement>(null);
  const initial = useRef(false);
  const jumping = useRef(false);
  const busy = useRef(false);
  const retryDirection = useRef<"older" | "newer">("older");
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(false);
  const getItemKey = useCallback((index: number) => rows[index]!.id, [rows]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => root.current,
    getItemKey, estimateSize: () => 100, overscan: 5, anchorTo: "end", followOnAppend: hasNewer ? false : "auto",
    scrollEndThreshold: 80, useAnimationFrameWithResizeObserver: true,
    // Include edge spacing in virtual measurements and scroll-to-end targets.
    // The bottom fade covers 26px; keep the last row above it.
    paddingStart: 24, paddingEnd: 40,
  });
  useEffect(() => {
    const ids = new Set(rows.map((row) => row.id));
    for (const key of virtual.itemSizeCache.keys()) if (!ids.has(String(key))) virtual.itemSizeCache.delete(key);
  }, [rows, virtual]);
  const manualAnchor = useRef<{id: string; offset: number; bottom: boolean} | undefined>(undefined);
  const previousRows = useRef(rows);
  const previousIds = new Set(previousRows.current.map(row => row.id));
  const currentIds = new Set(rows.map(row => row.id));
  const folding = previousRows.current.some(row => row.presentation === "process" && !currentIds.has(row.id) && currentIds.has(processId(row)));
  const unfolding = rows.some(row => row.presentation === "process" && !previousIds.has(row.id) && previousIds.has(processId(row)));
  let anchor: {id: string; offset: number; bottom: boolean} | undefined;
  if ((folding || unfolding) && root.current) {
    const el = root.current;
    const top = el.getBoundingClientRect().top;
    const elements = [...el.querySelectorAll<HTMLElement>("[data-conversation-row]")];
    const first = elements.find(item => item.getBoundingClientRect().bottom > top);
    if (first) {
      let id = first.dataset.conversationRow!;
      let offset = first.getBoundingClientRect().top - top;
      if (!currentIds.has(id)) {
        const old = previousRows.current.find(row => row.id === id);
        if (old) {
          id = processId(old);
          const header = elements.find(item => item.dataset.conversationRow === id);
          offset = header ? Math.max(0, header.getBoundingClientRect().top - top) : 0;
        }
      }
      anchor = {id, offset, bottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 80 && !hasNewer};
    }
  }
  if (manualAnchor.current && (folding || unfolding)) anchor = manualAnchor.current;
  useLayoutEffect(() => {
    previousRows.current = rows;
    manualAnchor.current = undefined;
    if (!anchor) return;
    const saved = anchor;
    let frame = 0;
    let passes = 0;
    const restore = () => {
      if (saved.bottom) virtual.scrollToEnd();
      else {
        const index = rows.findIndex(row => row.id === saved.id);
        const item = root.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (item && root.current) virtual.scrollBy(item.getBoundingClientRect().top - root.current.getBoundingClientRect().top - saved.offset);
        else if (index >= 0) virtual.scrollToIndex(index, {align: "start"});
      }
      if (++passes < 3) frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [rows, virtual]);
  const items = virtual.getVirtualItems();
  const visibleIds = items.filter((item) => item.end >= (virtual.scrollOffset ?? 0)
    && item.start <= (virtual.scrollOffset ?? 0) + (root.current?.clientHeight ?? 0)).map((item) => rows[item.index]!.groupId);
  const visibleKey = JSON.stringify([...new Set(visibleIds)]);
  useLayoutEffect(() => { onVisibleGroups(JSON.parse(visibleKey)); }, [visibleKey, onVisibleGroups]);
  useLayoutEffect(() => {
    if (!rows.length) return;
    if (!initial.current || (jumping.current && !hasNewer)) {
      virtual.scrollToEnd(); initial.current = true; jumping.current = false; setFollowing(true);
    }
  }, [rows, hasNewer, virtual]);
  const load = useCallback(async (direction: "older" | "newer") => {
    if (busy.current) return;
    busy.current = true; retryDirection.current = direction; setLoading(true);
    try { await (direction === "older" ? loadOlder() : loadNewer()); }
    catch { /* The query owns the actual error, displayed below. */ }
    finally { busy.current = false; setLoading(false); }
  }, [loadOlder, loadNewer]);
  useEffect(() => {
    const el = root.current;
    if (!el || loading || pageError) return;
    if (!rows.length) { if (hasOlder) void load("older"); return; }
    if (!initial.current) return;
    if (el.scrollTop <= 120 && hasOlder && !following) void load("older");
    else if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120 && hasNewer) void load("newer");
  }, [items[0]?.index, items.at(-1)?.index, following, hasOlder, hasNewer, loading, load, pageError, rows.length]);
  return <div className="conversation-scroll-area">
    <div className="conversation-transcript" ref={root} style={{ overflowAnchor: "none" }} onClickCapture={(event) => {
      const target = event.target as HTMLElement;
      const button = target.closest(".conversation-process-toggle");
      const row = button?.closest<HTMLElement>("[data-conversation-row]");
      if (row && root.current) manualAnchor.current = {id: row.dataset.conversationRow!, offset: row.getBoundingClientRect().top - root.current.getBoundingClientRect().top, bottom: false};
    }} onScroll={() => {
      const el = root.current;
      if (initial.current && el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= 80 && !hasNewer);
    }}>
      <div className="conversation-feed" style={{ position: "relative", paddingBlock: rows.length ? 0 : undefined, height: rows.length ? virtual.getTotalSize() : undefined, minHeight: rows.length ? undefined : "100%" }}>
        {!rows.length ? empty : items.map((item) => <div key={item.key} ref={virtual.measureElement} data-index={item.index}
          data-conversation-row={rows[item.index]!.id} data-display-group={rows[item.index]!.groupId}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)`, paddingBottom: rows[item.index]!.kind === "process" ? 8 : rows[item.index]!.presentation === "process" ? 6 : 12 }}>
          {renderRow(rows[item.index]!)}
        </div>)}
      </div>
    </div>
    {loading ? <span className="conversation-window-loading" aria-live="polite">{t.sessionDetail.loading}</span> : null}
    {pageError ? <div className="message-page-error" role="alert">{pageError}<button onClick={() => void load(retryDirection.current)}>{t.sessionDetail.retryEarlier}</button></div> : null}
    {!following || hasNewer ? <button className="conversation-jump-latest" type="button" onClick={() => {
      jumping.current = true; jumpToLatest(); virtual.scrollToEnd(); setFollowing(true);
    }}><ChevronDown size={14} />{t.conversation.jumpToLatest}</button> : null}
  </div>;
}
