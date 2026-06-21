import {
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import {
  lazy,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import { ReaderMarkdown } from "../workspace/WorkspaceChrome";
import { type SelectedContext } from "../../hooks/usePageSelection";
import { type AgentAttachment } from "../../lib/assistant/agentChatAdapter";
import {
  useAppCopy,
  useAssistantUi,
} from "../../lib/contexts";
import { type PageData } from "../../lib/generation/teachingGeneration";
import { compactText } from "../../lib/workspace/pagePairState";
import { selectedContextSourceLabel } from "./agentLabels";

const MarkdownRenderer = lazy(() => import("../MarkdownRenderer"));

// ── AssistantThread ──────────────────────────────────────────

export function AssistantThread({
  page,
  suggestions,
  contextPreview,
  attachments,
  selectedContext,
  onRemoveAttachment,
  onRemoveSelectedContext,
  composerInputRef,
  onPasteImages,
}: {
  page: PageData;
  suggestions: string[];
  contextPreview: string;
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  onRemoveAttachment: (id: string) => void;
  onRemoveSelectedContext: () => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ThreadPrimitive } = assistantUi;
  const thread = assistantUi.useThreadRuntime();
  const sendSuggestion = useCallback((suggestion: string) => {
    thread.append({
      role: "user",
      content: [{ type: "text", text: suggestion }],
    });
  }, [thread]);

  return (
    <ThreadPrimitive.Root className="aui-thread-root">
      <ThreadPrimitive.Viewport className="aui-thread-viewport">
        <div className="aui-thread-inner">
          <ThreadPrimitive.Empty>
            <div className="aui-welcome">
              <span className="aui-welcome-kicker">PDF p.{page.page_no} · {compactText(page.teaching.slide_title, 36)}</span>
              <h2>{copy.agent.askCurrentPage}</h2>
              <div className="prompt-suggestions" aria-label="Prompt suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => sendSuggestion(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <div className="aui-message-list">
            <ThreadPrimitive.Messages>{() => <AssistantMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="aui-thread-footer">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button className="scroll-bottom" type="button">↓</button>
            </ThreadPrimitive.ScrollToBottom>
            <AssistantComposer
              contextPreview={contextPreview}
              attachments={attachments}
              selectedContext={selectedContext}
              onRemoveAttachment={onRemoveAttachment}
              onRemoveSelectedContext={onRemoveSelectedContext}
              inputRef={composerInputRef}
              onPasteImages={onPasteImages}
            />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

// ── AssistantMessage gate ────────────────────────────────────

function AssistantMessage() {
  const assistantUi = useAssistantUi();
  const role = assistantUi.useAuiState((state) => state.message.role);
  return role === "user" ? <UserMessage /> : <AgentMessage />;
}

// ── UserMessage ──────────────────────────────────────────────

function UserMessage() {
  const copy = useAppCopy();
  const { ActionBarPrimitive, MessagePrimitive } = useAssistantUi();
  return (
    <MessagePrimitive.Root className="aui-message user-message">
      <div className="message-bubble user-bubble">
        <MessagePrimitive.Quote>
          {(quote: { text: string }) => (
            <div className="message-quote">
              <span>{copy.agent.quoteLabel}</span>
              <p>{compactText(quote.text, 220)}</p>
            </div>
          )}
        </MessagePrimitive.Quote>
        <MessagePrimitive.Parts />
      </div>
      <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Edit asChild>
          <button type="button" aria-label={copy.agent.edit} title={copy.agent.edit}><RefreshCw /></button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

// ── AgentMessage ─────────────────────────────────────────────

function AgentMessage() {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const {
    ActionBarPrimitive,
    BranchPickerPrimitive,
    ErrorPrimitive,
    MessagePrimitive,
  } = assistantUi;
  const status = assistantUi.useAuiState((state) => state.message.status);
  const content = assistantUi.useAuiState((state) => state.message.content);
  const isThinking = status?.type === "running" && content.length === 0;
  const isStopped = status?.type === "incomplete" && status.reason === "cancelled";
  const failureText = status?.type === "incomplete" && status.reason === "error"
    ? assistantContentText(content)
    : "";

  return (
    <MessagePrimitive.Root className="aui-message assistant-message">
      <div className="assistant-label">{copy.common.assistant}</div>
      <div className="message-bubble assistant-bubble">
        {isThinking && <AssistantThinkingIndicator />}
        {isStopped && <MessageStatusNote>{copy.agent.generationStopped}</MessageStatusNote>}
        {failureText ? (
          <div className="message-error">
            <MarkdownRenderer className="message-error-detail" text={failureText} />
          </div>
        ) : (
          <>
            <MessagePrimitive.Parts components={{ Text: MarkdownPart }} />
            <MessagePrimitive.Error>
              <ErrorPrimitive.Root className="message-error">
                <strong>{copy.agent.generationFailed}</strong>
                <ErrorPrimitive.Message />
              </ErrorPrimitive.Root>
            </MessagePrimitive.Error>
          </>
        )}
      </div>
      <div className="assistant-footer">
        <BranchPickerPrimitive.Root hideWhenSingleBranch className="branch-picker">
          <BranchPickerPrimitive.Previous asChild>
            <button type="button" aria-label={copy.pdf.previousPage} title={copy.pdf.previousPage}><ChevronLeft /></button>
          </BranchPickerPrimitive.Previous>
          <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
          <BranchPickerPrimitive.Next asChild>
            <button type="button" aria-label={copy.pdf.nextPage} title={copy.pdf.nextPage}><ChevronRight /></button>
          </BranchPickerPrimitive.Next>
        </BranchPickerPrimitive.Root>
        <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
          <ActionBarPrimitive.Copy asChild>
            <button type="button" aria-label={copy.agent.copy} title={copy.agent.copy}><Copy /></button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button type="button" aria-label={copy.agent.regenerate} title={copy.agent.regenerate}><RefreshCw /></button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

// ── AssistantComposer ────────────────────────────────────────

function AssistantComposer({
  contextPreview,
  attachments,
  selectedContext,
  onRemoveAttachment,
  onRemoveSelectedContext,
  inputRef,
  onPasteImages,
}: {
  contextPreview: string;
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  onRemoveAttachment: (id: string) => void;
  onRemoveSelectedContext: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ComposerPrimitive } = assistantUi;
  const thread = assistantUi.useThreadRuntime();

  useEffect(() => {
    thread.composer.setQuote(
      selectedContext
        ? {
            text: selectedContext.text,
            messageId: selectedContext.id,
          }
        : undefined,
    );
  }, [selectedContext, thread]);

  return (
    <div className="composer-shell">
      {selectedContext && (
        <SelectedSourcePreview context={selectedContext} onRemove={onRemoveSelectedContext} />
      )}
      {!!attachments.length && (
        <div className="composer-attachment-preview" aria-label={copy.agent.addImage}>
          {attachments.map((attachment) => (
            <figure className="composer-image-preview" key={attachment.id} title={attachment.name}>
              <img src={attachment.data_url} alt={attachment.name} />
              <figcaption>{compactText(attachment.name, 24)}</figcaption>
              <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={copy.agent.removeImage} title={copy.agent.removeImage}>
                <X />
              </button>
            </figure>
          ))}
        </div>
      )}
      {contextPreview && (
        <div className="composer-context-preview">
          <span />
          {contextPreview}
        </div>
      )}
      <ComposerPrimitive.Root className="aui-composer-root">
        <ComposerPrimitive.Input
          ref={inputRef}
          className="aui-composer-input"
          placeholder={selectedContext ? copy.agent.askWithSelectionPlaceholder : copy.agent.askPlaceholder}
          rows={2}
          submitMode="enter"
          aria-label={copy.agent.inputAria}
          onPaste={onPasteImages}
        />
        <div className="aui-composer-actions">
          <ComposerPrimitive.Send asChild>
            <button className="composer-send" type="button" aria-label={copy.agent.send} title={copy.agent.send}><Send /></button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

// ── MarkdownPart ─────────────────────────────────────────────

function MarkdownPart() {
  const assistantUi = useAssistantUi();
  const text = assistantUi.useAuiState((state) => {
    if (state.part.type !== "text" && state.part.type !== "reasoning") return "";
    return state.part.text || "";
  });

  return (
    <ReaderMarkdown className="markdown-body" text={text} />
  );
}

// ── AssistantThinkingIndicator ───────────────────────────────

function AssistantThinkingIndicator() {
  const copy = useAppCopy();
  return (
    <div className="assistant-thinking" aria-label="Assistant is thinking">
      <span className="thinking-skeleton-stack" aria-hidden="true">
        <span className="thinking-skeleton-line long" />
        <span className="thinking-skeleton-line medium" />
        <span className="thinking-skeleton-line short" />
      </span>
      <span>{copy.agent.thinking}</span>
    </div>
  );
}

// ── MessageStatusNote ────────────────────────────────────────

function MessageStatusNote({ children }: { children: ReactNode }) {
  return <div className="message-status-note">{children}</div>;
}

// ── SelectedSourcePreview ────────────────────────────────────

function SelectedSourcePreview({ context, onRemove }: { context: SelectedContext; onRemove: () => void }) {
  const copy = useAppCopy();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`selected-source-preview ${expanded ? "expanded" : ""}`}>
      <button
        className="selected-source-main"
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="selected-source-label">{selectedContextSourceLabel(context, copy)}</span>
        <span className="selected-source-text">{compactText(context.text, expanded ? 520 : 220)}</span>
      </button>
      <button className="selected-source-remove" type="button" onClick={onRemove} aria-label={copy.agent.removeSelectedContent} title={copy.agent.removeSelectedContent}>
        <X />
      </button>
    </div>
  );
}

// ── Utility ──────────────────────────────────────────────────

function assistantContentText(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item: unknown) => item && typeof item === "object" && "type" in (item as Record<string, unknown>))
    .map((item: unknown) => {
      const typed = item as { type: string; text?: string };
      return typed.type === "text" || typed.type === "reasoning" ? typed.text || "" : "";
    })
    .filter(Boolean)
    .join("\n");
}
