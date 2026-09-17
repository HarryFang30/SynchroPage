import { useSyncExternalStore } from "react";
import type { SelectedContext } from "../../hooks/usePageSelection";

/** The PDF page a question was asked from. */
export type MessageAnchor = {
  pageNo: number;
  pageTitle: string;
};

// A message sent in this session gets its anchor when the request starts; a
// restored message carries it in `metadata.custom`. Both are read through
// `messageAnchor`, so the thread and the transcript agree on the page.
const anchors = new Map<string, MessageAnchor>();
const listeners = new Set<() => void>();

export function setMessageAnchor(messageId: string, anchor: MessageAnchor) {
  if (!messageId || !anchor.pageNo) return;
  const current = anchors.get(messageId);
  if (current?.pageNo === anchor.pageNo && current.pageTitle === anchor.pageTitle) return;
  anchors.set(messageId, anchor);
  for (const listener of listeners) listener();
}

/** The anchor of a message: the stored one if it was restored, else the one recorded when it was sent. */
export function messageAnchor(message: unknown): MessageAnchor | null {
  const value = message as { id?: string; metadata?: { custom?: { pageNo?: unknown; pageTitle?: unknown } } } | null;
  const stored = Number(value?.metadata?.custom?.pageNo);
  if (Number.isFinite(stored) && stored > 0) {
    return { pageNo: stored, pageTitle: String(value?.metadata?.custom?.pageTitle || "") };
  }
  return (value?.id && anchors.get(value.id)) || null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The anchor recorded for a message sent in this session (re-renders when it arrives). */
export function useLiveMessageAnchor(messageId: string) {
  return useSyncExternalStore(subscribe, () => anchors.get(messageId) || null);
}

// ── The selection a question was about ───────────────────────

// A message quotes its selection by id (`quote.messageId`). The full selection
// (source page, PDF text behind an explanation) is kept here for the session,
// so asking again — regenerate, or an edited question — is asked about the
// same thing.
const selections = new Map<string, SelectedContext>();

export function rememberSelection(context: SelectedContext) {
  if (context.id) selections.set(context.id, context);
}

/** The selection a sent message was about, or null when it had none. */
export function messageSelection(message: unknown, fallbackPageNo?: number): SelectedContext | null {
  const custom = (message as { metadata?: { custom?: Record<string, unknown> } } | null)?.metadata?.custom;
  const quote = custom?.quote as { text?: unknown; messageId?: unknown } | undefined;
  const remembered = typeof quote?.messageId === "string" ? selections.get(quote.messageId) : undefined;
  if (remembered) return remembered;
  // A restored message carries the selection it was stored with.
  const stored = custom?.selectedContext as Partial<SelectedContext> | null | undefined;
  if (stored && typeof stored.text === "string" && stored.text.trim()) {
    return { sourceType: "unknown", createdAt: 0, ...stored, id: String(stored.id || quote?.messageId || "selection"), text: stored.text };
  }
  if (typeof quote?.text !== "string" || !quote.text.trim()) return null;
  return {
    id: String(quote.messageId || "selection"),
    text: quote.text,
    sourceType: "unknown",
    pageNumber: fallbackPageNo,
    createdAt: 0,
  };
}
