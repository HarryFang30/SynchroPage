import {
  createContext,
  type ComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { getAppCopy, type AppCopy } from "../i18n";
import type { ChatModelAdapter, ComposerImageAttachment } from "./assistant/agentChatAdapter";
import type { ThreadMessageLike } from "./persistence/workspaceStore";

// ── AppCopy context ──────────────────────────────────────────

export const AppCopyContext = createContext<AppCopy>(getAppCopy("zh-CN"));

export function useAppCopy() {
  return useContext(AppCopyContext);
}

// ── Assistant-ui runtime types ───────────────────────────────

export type AssistantPrimitiveGroup = Record<string, ComponentType<any>>;

export type AssistantThreadRuntime = {
  append: (message: unknown) => void;
  getState?: () => { isRunning?: boolean };
  subscribe?: (callback: () => void) => () => void;
  composer: {
    reset: () => void | Promise<void>;
    setQuote: (quote?: { text: string; messageId: string }) => void;
    setText: (text: string) => void;
    send: () => void;
    getState: () => { attachments: readonly { id: string }[] };
    addAttachment: (attachment: ComposerImageAttachment) => Promise<void>;
    getAttachmentByIndex: (index: number) => { remove: () => Promise<void> };
    unstable_on: (event: "send", callback: () => void) => () => void;
  };
};

export type AssistantUiRuntime = {
  AssistantRuntimeProvider: ComponentType<{ runtime: unknown; children?: ReactNode }>;
  ThreadPrimitive: AssistantPrimitiveGroup;
  MessagePrimitive: AssistantPrimitiveGroup;
  ActionBarPrimitive: AssistantPrimitiveGroup;
  BranchPickerPrimitive: AssistantPrimitiveGroup;
  ErrorPrimitive: AssistantPrimitiveGroup;
  ComposerPrimitive: AssistantPrimitiveGroup;
  useLocalRuntime: (adapter: ChatModelAdapter, options: { initialMessages: ThreadMessageLike[] }) => {
    thread: {
      reset: () => void;
      composer: { reset: () => void | Promise<void> };
    };
  };
  useThreadRuntime: () => AssistantThreadRuntime;
  useMessageRuntime: () => { composer: { setQuote: (quote?: { text: string; messageId: string }) => void } };
  useAuiState: <T>(selector: (state: {
    thread: { messages: readonly unknown[]; isRunning: boolean };
    message: {
      id?: string;
      role: string;
      status?: { type?: string; reason?: string };
      content: unknown[];
      attachments?: readonly unknown[];
      metadata?: { custom?: Record<string, unknown> };
      /** The message's own composer: open while the learner edits the message. */
      composer: { isEditing: boolean };
    };
    part: { type?: string; text?: string };
  }) => T) => T;
};

// ── Assistant-ui runtime context ─────────────────────────────

export const AssistantUiContext = createContext<AssistantUiRuntime | null>(null);

export function useAssistantUi() {
  const runtime = useContext(AssistantUiContext);
  if (!runtime) throw new Error("assistant-ui runtime is not loaded");
  return runtime;
}

// ── Sending a user message from a button ─────────────────────

/** Hands over the images waiting in the composer and empties the draft. */
export const PendingImagesContext = createContext<() => ComposerImageAttachment[]>(() => []);

/** The selection the next message is about, as the composer would quote it. */
export const PendingQuoteContext = createContext<() => MessageQuote | undefined>(() => undefined);

export type MessageQuote = { text: string; messageId: string };

/**
 * Sends a user message that was not typed into the composer (a suggestion, a
 * challenge button, a quiz answer, a selection prompt). The images and the
 * selection waiting in the composer go with it, exactly as they do when the
 * composer sends.
 */
export function useAppendUserText() {
  const thread = useAssistantUi().useThreadRuntime();
  const takePendingImages = useContext(PendingImagesContext);
  const pendingQuote = useContext(PendingQuoteContext);
  return useCallback((text: string, quote: MessageQuote | undefined = pendingQuote()) => {
    thread.append({
      role: "user",
      content: [{ type: "text", text }],
      attachments: takePendingImages(),
      metadata: { custom: quote ? { quote } : {} },
    });
  }, [pendingQuote, takePendingImages, thread]);
}

// ── Lazy loading ─────────────────────────────────────────────

let assistantUiRuntimePromise: Promise<AssistantUiRuntime> | null = null;

export function loadAssistantUiRuntime() {
  assistantUiRuntimePromise ??= import("./assistant/assistantUiRuntime") as unknown as Promise<AssistantUiRuntime>;
  return assistantUiRuntimePromise;
}

export function useAssistantUiRuntime(shouldLoad: boolean, deferUntilIdle: boolean) {
  const [runtime, setRuntime] = useState<AssistantUiRuntime | null>(null);

  useEffect(() => {
    if (!shouldLoad || runtime) return undefined;
    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    const loadRuntime = () => {
      void loadAssistantUiRuntime().then((loadedRuntime) => {
        if (!cancelled) setRuntime(loadedRuntime);
      });
    };
    if (deferUntilIdle && "requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(loadRuntime, { timeout: 1800 });
    } else if (deferUntilIdle) {
      timeoutHandle = window.setTimeout(loadRuntime, 900);
    } else {
      loadRuntime();
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    };
  }, [deferUntilIdle, runtime, shouldLoad]);

  return runtime;
}

export function useDeferredAssistantRuntime(shouldLoadImmediately: boolean) {
  const [requested, setRequested] = useState(false);
  const assistantUi = useAssistantUiRuntime(true, !requested && !shouldLoadImmediately);
  const requestAssistantUi = useCallback(() => {
    setRequested(true);
  }, []);
  useEffect(() => {
    if (shouldLoadImmediately) setRequested(true);
  }, [shouldLoadImmediately]);
  return { assistantUi, requestAssistantUi };
}
