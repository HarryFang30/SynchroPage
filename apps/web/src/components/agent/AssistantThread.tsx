import {
  Copy,
  FileText,
  Pencil,
  RefreshCw,
  Send,
  Square,
  Target,
  X,
} from "lucide-react";
import {
  createContext,
  lazy,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ReaderMarkdown } from "../workspace/WorkspaceChrome";
import { type SelectedContext } from "../../hooks/usePageSelection";
import { type AgentAttachment, composerImageAttachment, messageImages } from "../../lib/assistant/agentChatAdapter";
import { messageAnchor, useLiveMessageAnchor } from "../../lib/assistant/messageAnchors";
import {
  useAppCopy,
  useAppendUserText,
  useAssistantUi,
} from "../../lib/contexts";
import { type PageData } from "../../lib/generation/teachingGeneration";
import { type ChatThreadSummary } from "../../lib/persistence";
import { compactText } from "../../lib/workspace/synchroPageState";
import { selectedContextSourceLabel } from "./agentLabels";
import { RecentConversations } from "./ConversationHistory";
import { QuizOverlay, QuizSkeletonOverlay, QuizThreadCard, useQuizRun } from "./QuizOverlay";
import {
  PROBLEM_TYPE_V1,
  QUIZ_TYPE_V1,
  QUIZ_TYPE_V2,
  QUIZ_WEAK_POINTS_EVENT,
  consumeLiveQuizAutoOpen,
  containsChallengeMarker,
  extractJsonObjectText,
  getActiveQuizDocumentId,
  looksLikeChallengeText,
  looksLikeQuizText,
  parseJsonLoose,
  parseQuizSetValue,
  readQuizWeakPoints,
  type QuizSet,
} from "./quizModel";

const MarkdownRenderer = lazy(() => import("../MarkdownRenderer"));
// Past this many messages a conversation has usually drifted over several topics.
const LONG_CONVERSATION_MESSAGES = 24;
const JumpToPageContext = createContext<(pageNo: number) => void>(() => undefined);
const CHALLENGE_COUNT_OPTIONS = [1, 3, 5, 10] as const;
const DEFAULT_CHALLENGE_COUNT = 3;
type ChallengeKind = "quiz" | "problem";

// ── AssistantThread ──────────────────────────────────────────

export function AssistantThread({
  page,
  suggestions,
  contextPreview,
  attachments,
  selectedContext,
  onRemoveAttachment,
  onAttachmentsSent,
  onRemoveSelectedContext,
  composerInputRef,
  onPasteImages,
  learnerNoteCount = 0,
  conversations,
  activeConversationId,
  onOpenConversation,
  onShowHistory,
  onNewConversation,
  onJumpToPage,
}: {
  page: PageData;
  suggestions: string[];
  contextPreview: string;
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  onRemoveAttachment: (id: string) => void;
  /** The composer sent a message: the pending images went with it. */
  onAttachmentsSent: () => void;
  onRemoveSelectedContext: () => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  learnerNoteCount?: number;
  conversations: ChatThreadSummary[];
  activeConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onShowHistory: () => void;
  onNewConversation: () => void;
  onJumpToPage: (pageNo: number) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ThreadPrimitive } = assistantUi;
  const messageCount = assistantUi.useAuiState((state) => state.thread.messages.length);
  const appendUserText = useAppendUserText();
  const [challengeCount, setChallengeCount] = useState(DEFAULT_CHALLENGE_COUNT);
  const [challengeKind, setChallengeKind] = useState<ChallengeKind>("quiz");
  const sendSuggestion = appendUserText;
  const sendChallenge = useCallback((kind = challengeKind, count = challengeCount) => {
    appendUserText(copy.agent.challengeUserMessage(kind, normalizeChallengeCount(count)));
  }, [appendUserText, challengeCount, challengeKind, copy.agent]);

  return (
    <JumpToPageContext.Provider value={onJumpToPage}>
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
              <RecentConversations
                conversations={conversations}
                activeConversationId={activeConversationId}
                onOpenConversation={onOpenConversation}
                onShowAll={onShowHistory}
              />
            </div>
          </ThreadPrimitive.Empty>
          <div className="aui-message-list">
            <ThreadPrimitive.Messages>{() => <AssistantMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="aui-thread-footer">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button className="scroll-bottom" type="button">↓</button>
            </ThreadPrimitive.ScrollToBottom>
            <ChallengePanel
              kind={challengeKind}
              onKindChange={setChallengeKind}
              count={challengeCount}
              onCountChange={setChallengeCount}
              onStart={sendChallenge}
              learnerNoteCount={learnerNoteCount}
            />
            {messageCount >= LONG_CONVERSATION_MESSAGES && (
              <p className="long-conversation-hint">
                <span>{copy.agent.longConversationHint}</span>
                <button type="button" onClick={() => onNewConversation()}>{copy.agent.newConversation}</button>
              </p>
            )}
            <AssistantComposer
              page={page}
              contextPreview={contextPreview}
              attachments={attachments}
              selectedContext={selectedContext}
              onRemoveAttachment={onRemoveAttachment}
              onAttachmentsSent={onAttachmentsSent}
              onRemoveSelectedContext={onRemoveSelectedContext}
              inputRef={composerInputRef}
              onPasteImages={onPasteImages}
            />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
    </JumpToPageContext.Provider>
  );
}

function ChallengePanel({
  kind,
  onKindChange,
  count,
  onCountChange,
  onStart,
  learnerNoteCount = 0,
}: {
  kind: ChallengeKind;
  onKindChange: (kind: ChallengeKind) => void;
  count: number;
  onCountChange: (count: number) => void;
  onStart: (kind: ChallengeKind, count: number) => void;
  learnerNoteCount?: number;
}) {
  const copy = useAppCopy();
  const weakPointCount = useWeakPointCount();
  return (
    <div className="challenge-panel" aria-label={copy.agent.challengeAria}>
      <div className="challenge-title">
        <Target />
        <span>{copy.agent.challengeTitle}</span>
        <span className="challenge-mode">{copy.agent.challengeModeDiagnostic}</span>
      </div>
      {weakPointCount > 0 && (
        <p className="quiz-weak-note">{copy.agent.quizWeakPointNote(weakPointCount)}</p>
      )}
      {learnerNoteCount > 0 && (
        <p className="quiz-weak-note quiz-note-note">{copy.agent.quizNoteNote(learnerNoteCount)}</p>
      )}
      <div className="challenge-controls">
        <div className="challenge-kind-control" role="group" aria-label={copy.agent.challengeKindLabel}>
          <span>{copy.agent.challengeKindLabel}</span>
          <div className="challenge-segment-toggle">
            <button
              className={`challenge-kind-option ${kind === "quiz" ? "active" : ""}`}
              type="button"
              aria-pressed={kind === "quiz"}
              onClick={() => onKindChange("quiz")}
            >
              {copy.agent.challengeQuizKind}
            </button>
            <button
              className={`challenge-kind-option ${kind === "problem" ? "active" : ""}`}
              type="button"
              aria-pressed={kind === "problem"}
              onClick={() => onKindChange("problem")}
            >
              {copy.agent.challengeProblemKind}
            </button>
          </div>
        </div>
        {kind === "quiz" && (
          <div className="challenge-count-control" role="group" aria-label={copy.agent.challengeCountLabel}>
            <span>{copy.agent.challengeCountLabel}</span>
            <div className="challenge-count-toggle">
              {CHALLENGE_COUNT_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={`challenge-count-option ${option === count ? "active" : ""}`}
                  type="button"
                  aria-pressed={option === count}
                  onClick={() => onCountChange(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        )}
        <button className="challenge-start" type="button" onClick={() => onStart(kind, count)}>
          {copy.agent.challengeAction}
        </button>
      </div>
    </div>
  );
}

/** Number of stored weak points for the document the chat adapter is bound to. */
function useWeakPointCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => setCount(readQuizWeakPoints(getActiveQuizDocumentId()).length);
    refresh();
    window.addEventListener(QUIZ_WEAK_POINTS_EVENT, refresh);
    return () => window.removeEventListener(QUIZ_WEAK_POINTS_EVENT, refresh);
  }, []);
  return count;
}

// ── AssistantMessage gate ────────────────────────────────────

function AssistantMessage() {
  const assistantUi = useAssistantUi();
  const role = assistantUi.useAuiState((state) => state.message.role);
  const isEditing = assistantUi.useAuiState((state) => state.message.composer.isEditing);
  if (role !== "user") return <AgentMessage />;
  return isEditing ? <UserMessageEditor /> : <UserMessage />;
}

// ── UserMessage ──────────────────────────────────────────────

function UserMessage() {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ActionBarPrimitive, MessagePrimitive } = assistantUi;
  const attachments = assistantUi.useAuiState((state) => state.message.attachments);
  const images = useMemo(() => messageImages({ attachments }), [attachments]);
  const messageId = assistantUi.useAuiState((state) => state.message.id || "");
  const metadata = assistantUi.useAuiState((state) => state.message.metadata);
  const liveAnchor = useLiveMessageAnchor(messageId);
  const anchor = messageAnchor({ id: messageId, metadata }) || liveAnchor;
  const jumpToPage = useContext(JumpToPageContext);
  return (
    <MessagePrimitive.Root className="aui-message user-message">
      <div className="message-bubble user-bubble">
        {anchor && (
          <button
            className="message-page-chip"
            type="button"
            onClick={() => jumpToPage(anchor.pageNo)}
            title={copy.agent.askedOnPage(anchor.pageNo)}
            aria-label={copy.agent.askedOnPage(anchor.pageNo)}
          >
            <FileText aria-hidden="true" />
            <span>p.{anchor.pageNo}</span>
            {anchor.pageTitle && <span className="message-page-title">{compactText(anchor.pageTitle, 28)}</span>}
          </button>
        )}
        <MessagePrimitive.Quote>
          {(quote: { text: string }) => (
            <div className="message-quote">
              <span>{copy.agent.quoteLabel}</span>
              <p>{compactText(quote.text, 220)}</p>
            </div>
          )}
        </MessagePrimitive.Quote>
        {!!images.length && (
          <div className="message-images">
            {images.map((image) => (
              <img key={image.id} src={image.data_url} alt={image.name} title={image.name} />
            ))}
          </div>
        )}
        <MessagePrimitive.Parts />
      </div>
      <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Edit asChild>
          <button type="button" aria-label={copy.agent.edit} title={copy.agent.edit}><Pencil /></button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

/**
 * Editing a question sends it again from that point: the answers that came
 * after it are replaced, as in any chat where a message can be corrected.
 */
function UserMessageEditor() {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ComposerPrimitive, MessagePrimitive } = assistantUi;
  const message = assistantUi.useMessageRuntime();
  const quote = assistantUi.useAuiState((state) => state.message.metadata?.custom?.quote) as
    | { text: string; messageId: string }
    | undefined;
  // The edited question is still about the selection the original quoted.
  useEffect(() => {
    if (quote?.text) message.composer.setQuote(quote);
  }, [message, quote]);
  return (
    <MessagePrimitive.Root className="aui-message user-message editing">
      <ComposerPrimitive.Root className="edit-composer">
        {quote?.text && (
          <div className="message-quote">
            <span>{copy.agent.quoteLabel}</span>
            <p>{compactText(quote.text, 220)}</p>
          </div>
        )}
        <ComposerPrimitive.Input
          className="edit-composer-input"
          autoFocus
          submitMode="enter"
          aria-label={copy.agent.edit}
        />
        <div className="edit-composer-actions">
          <ComposerPrimitive.Cancel asChild>
            <button type="button">{copy.agent.cancel}</button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <button className="primary" type="button">{copy.agent.editResend}</button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

// ── AgentMessage ─────────────────────────────────────────────

function AgentMessage() {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const {
    ActionBarPrimitive,
    ErrorPrimitive,
    MessagePrimitive,
  } = assistantUi;
  const status = assistantUi.useAuiState((state) => state.message.status);
  const content = assistantUi.useAuiState((state) => state.message.content);
  const messageId = assistantUi.useAuiState((state) => state.message.id || "");
  const assistantText = assistantContentText(content);
  const challengeContent = parseChallengeContent(assistantText);
  const isRunning = status?.type === "running";
  const isThinking = isRunning && content.length === 0;
  const isChallengeStreaming = isRunning && !challengeContent && looksLikeChallengeText(assistantText);
  // A quiz that is still being written opens the overlay as a skeleton so the
  // thread never shows raw JSON.
  const isQuizStreaming = isChallengeStreaming && looksLikeQuizText(assistantText);
  const isChallengeParseFailed = status?.type !== "running" && !challengeContent && containsChallengeMarker(assistantText);
  const isStopped = status?.type === "incomplete" && status.reason === "cancelled";
  const failureText = status?.type === "incomplete" && status.reason === "error"
    ? assistantText
    : "";

  return (
    <MessagePrimitive.Root className="aui-message assistant-message">
      <div className="assistant-label">{copy.common.assistant}</div>
      <div className="message-bubble assistant-bubble">
        {(isThinking || isChallengeStreaming) && <AssistantThinkingIndicator />}
        {isQuizStreaming && <QuizSkeletonOverlay />}
        {isStopped && <MessageStatusNote>{copy.agent.generationStopped}</MessageStatusNote>}
        {failureText ? (
          <div className="message-error">
            <MarkdownRenderer className="message-error-detail" text={failureText} />
          </div>
        ) : isChallengeStreaming ? null : isChallengeParseFailed ? (
          <MessageStatusNote>{copy.agent.challengeParseFailed}</MessageStatusNote>
        ) : challengeContent?.kind === "quiz" ? (
          <ChallengeQuizCard quiz={challengeContent.quiz} isStreaming={isRunning} messageId={messageId} />
        ) : challengeContent?.kind === "problem" ? (
          <ChallengeProblemCard problem={challengeContent.problem} />
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

type ChallengeContent =
  | { kind: "quiz"; quiz: QuizSet }
  | { kind: "problem"; problem: ChallengeProblem };

type ChallengeProblem = {
  title: string;
  hasTypicalProblem: boolean;
  reason: string;
  knowledgeType: string;
  challengeType: string;
  problemType: string;
  difficulty: string;
  timeMinutes: number | null;
  stem: string;
  given: string[];
  tasks: string[];
  expectedEntry: string;
  firstHint: string;
  commonTraps: string[];
  rubric: string[];
  selfCheck: string;
};

/**
 * Compact in-thread card. The run state lives here (not in the overlay) so the
 * overlay can be closed and reopened without losing progress.
 */
function ChallengeQuizCard({ quiz, isStreaming, messageId }: { quiz: QuizSet; isStreaming: boolean; messageId: string }) {
  // Bind the app-owned document id once, at construction: the model may echo
  // document_id imperfectly and the active id can move if the user switches
  // documents mid-quiz.
  const storageDocumentIdRef = useRef(getActiveQuizDocumentId());
  const run = useQuizRun(quiz, storageDocumentIdRef.current);
  const autoOpenedRef = useRef(false);
  // Seeded with the mount-time value: a message that mounts already complete
  // (a restored thread, a remounted panel) never shows a streaming->finished
  // transition and therefore never auto-opens.
  const wasStreamingRef = useRef(isStreaming);
  const { setOpen } = run;

  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      return;
    }
    if (autoOpenedRef.current) return;
    const liveRun = consumeLiveQuizAutoOpen(messageId) || wasStreamingRef.current;
    if (!liveRun) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [isStreaming, messageId, setOpen]);

  return (
    <>
      <QuizThreadCard run={run} />
      <QuizOverlay run={run} />
    </>
  );
}

function ChallengeProblemCard({ problem }: { problem: ChallengeProblem }) {
  const copy = useAppCopy();
  const appendUserText = useAppendUserText();
  const [showHint, setShowHint] = useState(false);
  const [showSelfCheck, setShowSelfCheck] = useState(false);
  const meta = [
    problem.problemType,
    problem.difficulty,
    problem.timeMinutes ? `${problem.timeMinutes} min` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className="challenge-problem-card" aria-label={problem.title || copy.agent.challengeProblemKind}>
      <header className="challenge-quiz-header">
        <div>
          <span className="challenge-quiz-kicker">{problem.knowledgeType} · {problem.challengeType}</span>
          <h3>{problem.title || copy.agent.challengeProblemKind}</h3>
        </div>
        <span className={`challenge-problem-status ${problem.hasTypicalProblem ? "suitable" : "unsuitable"}`}>
          {problem.hasTypicalProblem ? copy.agent.challengeProblemSuitable : copy.agent.challengeProblemUnsuitable}
        </span>
      </header>
      {meta && <div className="challenge-problem-meta">{meta}</div>}
      {problem.reason && (
        <div className="challenge-problem-reason">
          <ReaderMarkdown className="markdown-body" text={problem.reason} />
        </div>
      )}
      <div className="challenge-problem-stem">
        <ReaderMarkdown className="markdown-body" text={problem.stem} />
      </div>
      {!!problem.given.length && (
        <ChallengeProblemList title={copy.agent.challengeProblemGivenLabel} items={problem.given} />
      )}
      {!!problem.tasks.length && (
        <ChallengeProblemList title={copy.agent.challengeProblemTasksLabel} items={problem.tasks} ordered />
      )}
      <div className="challenge-problem-actions">
        <button type="button" onClick={() => setShowHint((current) => !current)}>
          {copy.agent.challengeProblemHintAction}
        </button>
        <button type="button" onClick={() => setShowSelfCheck((current) => !current)}>
          {copy.agent.challengeProblemSelfCheckAction}
        </button>
        <button
          type="button"
          onClick={() => appendUserText(copy.agent.challengeUserMessage("problem", 1))}
        >
          {copy.agent.challengeProblemAgain}
        </button>
      </div>
      {showHint && (
        <div className="challenge-problem-panel">
          <h4>{copy.agent.challengeProblemEntryLabel}</h4>
          <ReaderMarkdown className="markdown-body" text={[problem.expectedEntry, problem.firstHint].filter(Boolean).join("\n\n")} />
        </div>
      )}
      {showSelfCheck && (
        <div className="challenge-problem-panel">
          <h4>{copy.agent.challengeProblemRubricLabel}</h4>
          <ReaderMarkdown
            className="markdown-body"
            text={[
              problem.selfCheck,
              ...problem.rubric.map((item) => `- ${item}`),
              problem.commonTraps.length ? `${copy.agent.challengeProblemTrapLabel}\n${problem.commonTraps.map((item) => `- ${item}`).join("\n")}` : "",
            ].filter(Boolean).join("\n\n")}
          />
        </div>
      )}
    </section>
  );
}

function ChallengeProblemList({ title, items, ordered = false }: { title: string; items: string[]; ordered?: boolean }) {
  const ListTag = ordered ? "ol" : "ul";
  return (
    <div className="challenge-problem-list">
      <h4>{title}</h4>
      <ListTag>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>
            <ReaderMarkdown className="markdown-body" text={item} />
          </li>
        ))}
      </ListTag>
    </div>
  );
}

// ── AssistantComposer ────────────────────────────────────────

function AssistantComposer({
  page,
  contextPreview,
  attachments,
  selectedContext,
  onRemoveAttachment,
  onAttachmentsSent,
  onRemoveSelectedContext,
  inputRef,
  onPasteImages,
}: {
  page: PageData;
  contextPreview: string;
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  onRemoveAttachment: (id: string) => void;
  onAttachmentsSent: () => void;
  onRemoveSelectedContext: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ComposerPrimitive } = assistantUi;
  const thread = assistantUi.useThreadRuntime();
  const isRunning = assistantUi.useAuiState((state) => state.thread.isRunning);
  const jumpToPage = useContext(JumpToPageContext);

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

  // The pending images are part of the draft: the composer holds them so that
  // sending moves them onto the user message, the way it does with the quote.
  useEffect(() => {
    const composer = thread.composer;
    const pendingIds = new Set(attachments.map((attachment) => attachment.id));
    const heldIds = new Set<string>();
    for (const held of [...composer.getState().attachments]) {
      if (pendingIds.has(held.id)) {
        heldIds.add(held.id);
        continue;
      }
      const index = composer.getState().attachments.findIndex((item) => item.id === held.id);
      if (index !== -1) void composer.getAttachmentByIndex(index).remove().catch(() => undefined);
    }
    for (const attachment of attachments) {
      if (!heldIds.has(attachment.id)) void composer.addAttachment(composerImageAttachment(attachment)).catch(() => undefined);
    }
  }, [attachments, thread]);

  const onAttachmentsSentRef = useRef(onAttachmentsSent);
  onAttachmentsSentRef.current = onAttachmentsSent;
  useEffect(() => thread.composer.unstable_on("send", () => onAttachmentsSentRef.current()), [thread]);

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
          {/* What the next question is asked about, visible before it is sent. */}
          <button
            className="composer-page-pill"
            type="button"
            onClick={() => jumpToPage(page.page_no)}
            title={copy.agent.composerPageContextHint}
          >
            <FileText aria-hidden="true" />
            <span>{copy.agent.composerPageContext(page.page_no)}</span>
            <span className="composer-page-title">{compactText(page.teaching.slide_title, 30)}</span>
          </button>
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild>
              <button className="composer-send composer-stop" type="button" aria-label={copy.agent.stop} title={copy.agent.stop}><Square /></button>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild>
              <button className="composer-send" type="button" aria-label={copy.agent.send} title={copy.agent.send}><Send /></button>
            </ComposerPrimitive.Send>
          )}
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

function parseChallengeContent(text: string): ChallengeContent | null {
  const raw = extractJsonObjectText(text);
  if (!raw) return null;
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === QUIZ_TYPE_V2 || value.type === QUIZ_TYPE_V1) {
    const quiz = parseQuizSetValue(value);
    return quiz ? { kind: "quiz", quiz } : null;
  }
  if (value.type === PROBLEM_TYPE_V1) {
    const problem = parseChallengeProblemValue(value);
    return problem ? { kind: "problem", problem } : null;
  }
  return null;
}

function parseChallengeProblemValue(value: Record<string, unknown>): ChallengeProblem | null {
  const suitability = objectField(value.suitability);
  const problem = objectField(value.problem);
  const coach = objectField(value.coach);
  const stem = stringField(problem.stem ?? value.stem ?? value.question);
  const tasks = stringArrayField(problem.tasks ?? value.tasks);
  if (!stem || !tasks.length) return null;
  const timeMinutes = numberField(problem.time_minutes ?? problem.timeMinutes);
  return {
    title: stringField(value.title) || "典型大题 Challenge",
    hasTypicalProblem: booleanField(suitability.has_typical_problem ?? suitability.hasTypicalProblem ?? value.has_typical_problem ?? value.hasTypicalProblem),
    reason: stringField(suitability.reason ?? value.reason),
    knowledgeType: stringField(value.knowledge_type ?? value.knowledgeType) || "mixed",
    challengeType: stringField(value.challenge_type ?? value.challengeType) || "typical problem",
    problemType: stringField(suitability.problem_type ?? suitability.problemType ?? problem.problem_type ?? problem.problemType),
    difficulty: stringField(problem.difficulty),
    timeMinutes,
    stem,
    given: stringArrayField(problem.given ?? problem.conditions ?? value.given),
    tasks,
    expectedEntry: stringField(problem.expected_entry ?? problem.expectedEntry ?? coach.expected_entry ?? coach.expectedEntry),
    firstHint: stringField(coach.first_hint ?? coach.firstHint ?? problem.first_hint ?? problem.firstHint),
    commonTraps: stringArrayField(coach.common_traps ?? coach.commonTraps),
    rubric: stringArrayField(problem.rubric ?? coach.rubric),
    selfCheck: stringField(coach.after_attempt_check ?? coach.afterAttemptCheck ?? coach.self_check ?? coach.selfCheck),
  };
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayField(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function booleanField(value: unknown) {
  return value === true || value === "true";
}

function numberField(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeChallengeCount(value: number) {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return DEFAULT_CHALLENGE_COUNT;
  if (rounded <= 1) return 1;
  if (rounded <= 3) return 3;
  if (rounded <= 5) return 5;
  return 10;
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
