import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Copy,
  RefreshCw,
  Send,
  Target,
  X,
  XCircle,
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
import { compactText } from "../../lib/workspace/synchroPageState";
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
  const sendChallenge = useCallback(() => {
    thread.append({
      role: "user",
      content: [{ type: "text", text: copy.agent.challengeUserMessage }],
    });
  }, [copy.agent.challengeUserMessage, thread]);

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
            <ChallengePanel onStart={sendChallenge} />
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

function ChallengePanel({ onStart }: { onStart: () => void }) {
  const copy = useAppCopy();
  return (
    <div className="challenge-panel" aria-label={copy.agent.challengeAria}>
      <div className="challenge-title">
        <Target />
        <span>{copy.agent.challengeTitle}</span>
        <span className="challenge-mode">{copy.agent.challengeModeDiagnostic}</span>
      </div>
      <button className="challenge-start" type="button" onClick={onStart}>
        {copy.agent.challengeAction}
      </button>
    </div>
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
  const assistantText = assistantContentText(content);
  const challengeQuiz = parseChallengeQuiz(assistantText);
  const isThinking = status?.type === "running" && content.length === 0;
  const isChallengeStreaming = status?.type === "running" && !challengeQuiz && looksLikeChallengeQuizText(assistantText);
  const isStopped = status?.type === "incomplete" && status.reason === "cancelled";
  const failureText = status?.type === "incomplete" && status.reason === "error"
    ? assistantText
    : "";

  return (
    <MessagePrimitive.Root className="aui-message assistant-message">
      <div className="assistant-label">{copy.common.assistant}</div>
      <div className="message-bubble assistant-bubble">
        {(isThinking || isChallengeStreaming) && <AssistantThinkingIndicator />}
        {isStopped && <MessageStatusNote>{copy.agent.generationStopped}</MessageStatusNote>}
        {failureText ? (
          <div className="message-error">
            <MarkdownRenderer className="message-error-detail" text={failureText} />
          </div>
        ) : challengeQuiz ? (
          <ChallengeQuizCard quiz={challengeQuiz} />
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

type ChallengeQuiz = {
  title: string;
  knowledgeType: string;
  challengeType: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  feedback: {
    correct: string;
    incorrect: string;
  };
  explanation: string;
  followUp: string;
};

function ChallengeQuizCard({ quiz }: { quiz: ChallengeQuiz }) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const thread = assistantUi.useThreadRuntime();
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const selectedOption = selectedOptionId
    ? quiz.options.find((option) => option.id === selectedOptionId) || null
    : null;
  const hasAnswered = Boolean(selectedOptionId);
  const correct = selectedOptionId === quiz.correctOptionId;

  return (
    <section className="challenge-quiz-card" aria-label={quiz.title || copy.agent.challengeTitle}>
      <header className="challenge-quiz-header">
        <div>
          <span className="challenge-quiz-kicker">{quiz.knowledgeType} · {quiz.challengeType}</span>
          <h3>{quiz.title || copy.agent.challengeTitle}</h3>
        </div>
        <span className="challenge-quiz-count">1/1</span>
      </header>
      <div className="challenge-quiz-progress" aria-hidden="true">
        <span />
      </div>
      <div className="challenge-quiz-question">
        <ReaderMarkdown className="markdown-body" text={quiz.question} />
      </div>
      <div className="challenge-options">
        {quiz.options.map((option) => {
          const isSelected = option.id === selectedOptionId;
          const isCorrect = option.id === quiz.correctOptionId;
          const stateClass = hasAnswered
            ? isCorrect
              ? "correct"
              : isSelected
                ? "incorrect"
                : "dimmed"
            : "";
          return (
            <button
              className={`challenge-option ${stateClass}`}
              key={option.id}
              type="button"
              onClick={() => {
                if (!hasAnswered) setSelectedOptionId(option.id);
              }}
              aria-pressed={isSelected}
              disabled={hasAnswered}
            >
              <span className="challenge-option-id">{option.id}</span>
              <span className="challenge-option-text">
                <ReaderMarkdown className="markdown-body" text={option.text} />
              </span>
            </button>
          );
        })}
      </div>
      {hasAnswered && (
        <div className={`challenge-feedback ${correct ? "correct" : "incorrect"}`}>
          <div className="challenge-feedback-title">
            {correct ? <CheckCircle2 /> : <XCircle />}
            <span>{correct ? copy.agent.challengeCorrect : copy.agent.challengeIncorrect}</span>
            {selectedOption && <span className="challenge-feedback-selection">{selectedOption.id}</span>}
          </div>
          <ReaderMarkdown
            className="markdown-body"
            text={[
              correct ? quiz.feedback.correct : quiz.feedback.incorrect,
              quiz.explanation ? `${copy.agent.challengeAnswerLabel} ${quiz.correctOptionId}. ${quiz.explanation}` : "",
              quiz.followUp ? `${copy.agent.challengeFollowUpLabel} ${quiz.followUp}` : "",
            ].filter(Boolean).join("\n\n")}
          />
          <button
            className="challenge-next"
            type="button"
            onClick={() => {
              thread.append({
                role: "user",
                content: [{ type: "text", text: copy.agent.challengeUserMessage }],
              });
            }}
          >
            {copy.agent.challengeNext}
          </button>
        </div>
      )}
    </section>
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

function parseChallengeQuiz(text: string): ChallengeQuiz | null {
  const raw = extractJsonObjectText(text);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.type !== "synchropage.challenge_quiz.v1") return null;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const option = item as Record<string, unknown>;
      const fallbackId = String.fromCharCode(65 + index);
      const id = normalizeOptionId(option.id, fallbackId);
      const textValue = stringField(option.text);
      return id && textValue ? { id, text: textValue } : null;
    })
    .filter((item): item is { id: string; text: string } => Boolean(item))
    .slice(0, 6);
  const correctOptionId = normalizeOptionId(value.correct_option_id ?? value.correctOptionId ?? value.answer, "");
  if (!stringField(value.question) || options.length < 2 || !options.some((option) => option.id === correctOptionId)) {
    return null;
  }
  const feedback = value.feedback && typeof value.feedback === "object"
    ? value.feedback as Record<string, unknown>
    : {};
  return {
    title: stringField(value.title) || "Challenge Quiz",
    knowledgeType: stringField(value.knowledge_type ?? value.knowledgeType) || "mixed",
    challengeType: stringField(value.challenge_type ?? value.challengeType) || "diagnostic",
    question: stringField(value.question),
    options,
    correctOptionId,
    feedback: {
      correct: stringField(feedback.correct) || "回答正确。",
      incorrect: stringField(feedback.incorrect) || "这个选项暴露了一个常见误区。",
    },
    explanation: stringField(value.explanation),
    followUp: stringField(value.follow_up ?? value.followUp),
  };
}

function looksLikeChallengeQuizText(text: string) {
  const value = text.trim();
  return value.startsWith("{") || value.startsWith("```json") || value.includes("synchropage.challenge_quiz.v1");
}

function extractJsonObjectText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : "";
}

function normalizeOptionId(value: unknown, fallback: string) {
  const id = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]$/.test(id) ? id : "";
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

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
