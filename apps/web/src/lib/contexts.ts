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
import type { ChatModelAdapter } from "./assistant/agentChatAdapter";
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
  composer: {
    reset: () => void | Promise<void>;
    setQuote: (quote?: { text: string; messageId: string }) => void;
    setText: (text: string) => void;
    send: () => void;
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
  useAuiState: <T>(selector: (state: {
    message: {
      role: string;
      status?: { type?: string; reason?: string };
      content: unknown[];
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
