import {
  Image,
  NotebookText,
  Trash2,
  X,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { type AppCopy } from "../../i18n";
import {
  createPdfAgentAdapter,
  type AgentAttachment,
  type AgentContextItem,
  type AgentSnapshot,
  type ChatPersistInput,
} from "../../lib/assistant/agentChatAdapter";
import {
  AppCopyContext,
  AssistantUiContext,
  useAppCopy,
  useAssistantUi,
  useDeferredAssistantRuntime,
} from "../../lib/contexts";
import { type PdfDirectFileInput } from "../../lib/pdf/directFile";
import { type PageData, type PagePack } from "../../lib/generation/teachingGeneration";
import { type SelectedContext } from "../../hooks/usePageSelection";
import { type OAuthMode } from "../../hooks/useOAuthFlow";
import { createId, compactText } from "../../lib/workspace/pagePairState";
import { type ThreadMessageLike } from "../../lib/persistence/workspaceStore";
import { AssistantThread } from "./AssistantThread";

// ── Shared helpers ───────────────────────────────────────────

export function contextSourceLabel(context: AgentContextItem, copy: AppCopy) {
  if (context.type === "formula") return copy.agent.contextFormula(context.page_no);
  if (context.type === "selection") return copy.agent.contextSelection(context.page_no);
  if (context.type === "pdf_reference") return copy.agent.contextPdfReference(context.page_no);
  return copy.agent.contextSource(context.page_no, compactText(context.source || context.title, 28));
}

export function selectedContextSourceLabel(context: SelectedContext, copy: AppCopy) {
  if (context.sourceType === "pdf-page") return copy.agent.selectedPdfPage(context.pdfPageNumber || context.pageNumber || "?");
  if (context.sourceType === "generated-explanation") return copy.agent.selectedNotesPage(context.generatedPageNumber || context.pageNumber || "?");
  if (context.sourceType === "assistant-message") return copy.agent.assistantMessage;
  if (context.sourceType === "page") return copy.agent.pageSource(context.pageNumber || "?");
  return copy.common.selectedContent;
}

function composerContextPreview(contexts: AgentContextItem[], copy: AppCopy) {
  if (contexts.length) {
    const first = contexts[contexts.length - 1];
    const extra = contexts.length > 1 ? ` +${contexts.length - 1}` : "";
    return `${contextSourceLabel(first, copy)}${extra}`;
  }
  return "";
}

function pageSuggestions(page: PageData, pageAware: boolean, copy: AppCopy) {
  if (!pageAware) {
    return copy.agent.selectedFallbackSuggestions;
  }
  return copy.agent.pageSuggestions(compactText(page.teaching.slide_title, 42), page.teaching.concepts[0] || "this page");
}

async function readFileAsDataUrl(file: File, copy: AppCopy) {
  return new Promise<AgentAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: createId("img"),
        type: "image",
        name: file.name || "image",
        mime: file.type || "image/png",
        size: file.size || 0,
        data_url: String(reader.result || ""),
      });
    reader.onerror = () => reject(reader.error || new Error(copy.errors.imageReadFailed));
    reader.readAsDataURL(file);
  });
}

// ── Types ────────────────────────────────────────────────────

export type AgentPanelProps = {
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  initialMessages: ThreadMessageLike[];
  pendingSelectionPrompt: QuickSelectionPrompt | null;
  setContexts: (fn: AgentContextItem[] | ((items: AgentContextItem[]) => AgentContextItem[])) => void;
  setAttachments: (fn: AgentAttachment[] | ((items: AgentAttachment[]) => AgentAttachment[])) => void;
  setSelectedContext: (context: SelectedContext | null) => void;
  clearPendingSelectionPrompt: (id: string) => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  getSnapshot: () => AgentSnapshot;
  getDocumentFile: () => Promise<PdfDirectFileInput | null>;
  getPack: () => PagePack;
  getPage: () => PageData;
  backendOffline: boolean;
  oauthMode: OAuthMode;
  showSourcePills: boolean;
  pageAwareSuggestions: boolean;
  persistChatMessage?: (input: ChatPersistInput) => Promise<void>;
  onNewConversation: () => void;
};

export type QuickSelectionPrompt = {
  id: string;
  prompt: string;
  context: SelectedContext;
};

// ── QuickSelectionPromptRunner ───────────────────────────────

function QuickSelectionPromptRunner(props: {
  prompt: QuickSelectionPrompt | null;
  onConsumed: (id: string) => void;
}) {
  const assistantUi = useAssistantUi();
  const thread = assistantUi.useThreadRuntime();
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!props.prompt) return;
    if (consumedRef.current === props.prompt.id) return;
    consumedRef.current = props.prompt.id;
    thread.append({
      role: "user",
      content: [{ type: "text", text: props.prompt.prompt }],
    });
    props.onConsumed(props.prompt.id);
  }, [props.prompt, props.onConsumed, thread]);

  return null;
}

// ── Main AgentPanel components ───────────────────────────────

export function AgentPanel(props: AgentPanelProps) {
  const copy = useAppCopy();
  const { assistantUi, requestAssistantUi } = useDeferredAssistantRuntime(Boolean(props.pendingSelectionPrompt));
  if (!assistantUi) {
    return (
      <aside
        className="agent-panel"
        onPointerEnter={requestAssistantUi}
        onFocusCapture={requestAssistantUi}
      >
        <div className="agent-toolbar">
          <div className="toolbar-title">
            <span className="agent-dot" />
            <span>{copy.common.assistant}</span>
          </div>
          <div className="toolbar-actions">
            <span className="agent-model">{copy.agent.thinking}</span>
          </div>
        </div>
      </aside>
    );
  }
  return (
    <AssistantUiContext.Provider value={assistantUi}>
      <AgentPanelLoaded {...props} />
    </AssistantUiContext.Provider>
  );
}

function AgentPanelLoaded(props: AgentPanelProps) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const adapter = useMemo(
    () =>
      createPdfAgentAdapter({
        getSnapshot: props.getSnapshot,
        getDocumentFile: props.getDocumentFile,
        getPack: props.getPack,
        getPage: props.getPage,
        copy,
        createId,
        isBackendOffline: () => props.backendOffline,
        clearSelectedContext: () => props.setSelectedContext(null),
        persistChatMessage: props.persistChatMessage,
      }),
    [copy, props.backendOffline, props.getDocumentFile, props.getPage, props.getPack, props.getSnapshot, props.persistChatMessage, props.setSelectedContext],
  );
  const runtime = assistantUi.useLocalRuntime(adapter, { initialMessages: props.initialMessages });
  const { AssistantRuntimeProvider } = assistantUi;
  const page = props.getPage();
  const suggestions = pageSuggestions(page, props.pageAwareSuggestions, copy);
  const contextPreview = composerContextPreview(props.contexts, copy);

  const clearAgentContext = useCallback(() => {
    props.setContexts([]);
    props.setAttachments([]);
    props.setSelectedContext(null);
  }, [props]);

  const startNewConversation = useCallback(() => {
    runtime.thread.reset();
    void runtime.thread.composer.reset();
    clearAgentContext();
    if (props.pendingSelectionPrompt) {
      props.clearPendingSelectionPrompt(props.pendingSelectionPrompt.id);
    }
    props.onNewConversation();
  }, [clearAgentContext, props, runtime]);

  const addImages = async (files: FileList | File[]) => {
    const images = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).slice(0, 6).map((file) => readFileAsDataUrl(file, copy)));
    props.setAttachments((items) => [...items, ...images].slice(-8));
  };

  const addClipboardImages = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }, [addImages]);

  return (
    <aside className="agent-panel">
      <div className="agent-toolbar">
        <div className="toolbar-title">
          <span className="agent-dot" />
          <span>{copy.common.assistant}</span>
        </div>
        <div className="toolbar-actions">
          <span className="agent-model">{props.oauthMode === "connected" ? "OAuth" : props.backendOffline ? "Local" : "OAuth"}</span>
          <button className="agent-action-button" type="button" onClick={startNewConversation}>
            <NotebookText />
            <span>{copy.agent.newConversation}</span>
          </button>
          <button className="agent-action-button" type="button" onClick={clearAgentContext}>
            <Trash2 />
            <span>{copy.agent.clearContext}</span>
          </button>
          <label className="agent-action-button" title={copy.agent.addImage} aria-label={copy.agent.addImage}>
            <Image />
            <span>{copy.agent.addImage}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                if (event.target.files) void addImages(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <div className="agent-context-strip" hidden={!props.showSourcePills || !props.contexts.length}>
        {props.contexts.map((context) => (
          <span className="context-pill" key={context.id} title={context.text}>
            <span>{contextSourceLabel(context, copy)}</span>
            <button
              type="button"
              onClick={() => props.setContexts((items) => items.filter((item) => item.id !== context.id))}
              aria-label={copy.agent.removeContext}
              title={copy.agent.removeContext}
            >
              <X />
            </button>
          </span>
        ))}
      </div>
      <AssistantRuntimeProvider runtime={runtime}>
        <QuickSelectionPromptRunner
          prompt={props.pendingSelectionPrompt}
          onConsumed={props.clearPendingSelectionPrompt}
        />
        <AssistantThread
          page={page}
          suggestions={suggestions}
          contextPreview={contextPreview}
          attachments={props.attachments}
          selectedContext={props.selectedContext}
          onRemoveAttachment={(id) => props.setAttachments((items) => items.filter((item) => item.id !== id))}
          onRemoveSelectedContext={() => props.setSelectedContext(null)}
          composerInputRef={props.composerInputRef}
          onPasteImages={addClipboardImages}
        />
      </AssistantRuntimeProvider>
    </aside>
  );
}
