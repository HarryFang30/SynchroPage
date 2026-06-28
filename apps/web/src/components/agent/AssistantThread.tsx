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
  const [challengeCount, setChallengeCount] = useState(DEFAULT_CHALLENGE_COUNT);
  const [challengeKind, setChallengeKind] = useState<ChallengeKind>("quiz");
  const sendSuggestion = useCallback((suggestion: string) => {
    thread.append({
      role: "user",
      content: [{ type: "text", text: suggestion }],
    });
  }, [thread]);
  const sendChallenge = useCallback((kind = challengeKind, count = challengeCount) => {
    const normalizedCount = normalizeChallengeCount(count);
    thread.append({
      role: "user",
      content: [{ type: "text", text: copy.agent.challengeUserMessage(kind, normalizedCount) }],
    });
  }, [challengeCount, challengeKind, copy.agent, thread]);

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
            <ChallengePanel
              kind={challengeKind}
              onKindChange={setChallengeKind}
              count={challengeCount}
              onCountChange={setChallengeCount}
              onStart={sendChallenge}
            />
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

function ChallengePanel({
  kind,
  onKindChange,
  count,
  onCountChange,
  onStart,
}: {
  kind: ChallengeKind;
  onKindChange: (kind: ChallengeKind) => void;
  count: number;
  onCountChange: (count: number) => void;
  onStart: (kind: ChallengeKind, count: number) => void;
}) {
  const copy = useAppCopy();
  return (
    <div className="challenge-panel" aria-label={copy.agent.challengeAria}>
      <div className="challenge-title">
        <Target />
        <span>{copy.agent.challengeTitle}</span>
        <span className="challenge-mode">{copy.agent.challengeModeDiagnostic}</span>
      </div>
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
  const challengeContent = parseChallengeContent(assistantText);
  const isThinking = status?.type === "running" && content.length === 0;
  const isChallengeStreaming = status?.type === "running" && !challengeContent && looksLikeChallengeText(assistantText);
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
        {isStopped && <MessageStatusNote>{copy.agent.generationStopped}</MessageStatusNote>}
        {failureText ? (
          <div className="message-error">
            <MarkdownRenderer className="message-error-detail" text={failureText} />
          </div>
        ) : isChallengeParseFailed ? (
          <MessageStatusNote>{copy.agent.challengeParseFailed}</MessageStatusNote>
        ) : challengeContent?.kind === "quiz" ? (
          <ChallengeQuizCard quiz={challengeContent.quiz} />
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

type ChallengeContent =
  | { kind: "quiz"; quiz: ChallengeQuizSet }
  | { kind: "problem"; problem: ChallengeProblem };

type ChallengeQuizSet = {
  title: string;
  questions: ChallengeQuizQuestion[];
};

type ChallengeQuizQuestion = {
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

function ChallengeQuizCard({ quiz }: { quiz: ChallengeQuizSet }) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const thread = assistantUi.useThreadRuntime();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const question = quiz.questions[currentIndex] || quiz.questions[0] || null;
  const selectedOptionId = question ? answers[currentIndex] || null : null;
  const selectedOption = question && selectedOptionId
    ? question.options.find((option) => option.id === selectedOptionId) || null
    : null;
  const hasAnswered = Boolean(selectedOptionId);
  const correct = question ? selectedOptionId === question.correctOptionId : false;

  useEffect(() => {
    if (currentIndex >= quiz.questions.length) setCurrentIndex(0);
  }, [currentIndex, quiz.questions.length]);

  if (!question) return null;
  const isLastQuestion = currentIndex >= quiz.questions.length - 1;
  const progressPercent = `${Math.max(1, ((currentIndex + 1) / quiz.questions.length) * 100)}%`;

  return (
    <section className="challenge-quiz-card" aria-label={quiz.title || copy.agent.challengeTitle}>
      <header className="challenge-quiz-header">
        <div>
          <span className="challenge-quiz-kicker">{question.knowledgeType} · {question.challengeType}</span>
          <h3>{quiz.title || copy.agent.challengeTitle}</h3>
        </div>
        <span className="challenge-quiz-count">{currentIndex + 1}/{quiz.questions.length}</span>
      </header>
      <div className="challenge-quiz-progress" aria-hidden="true">
        <span style={{ width: progressPercent }} />
      </div>
      <div className="challenge-quiz-question">
        <ReaderMarkdown className="markdown-body" text={question.question} />
      </div>
      <div className="challenge-options">
        {question.options.map((option) => {
          const isSelected = option.id === selectedOptionId;
          const isCorrect = option.id === question.correctOptionId;
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
                if (!hasAnswered) {
                  setAnswers((current) => ({ ...current, [currentIndex]: option.id }));
                }
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
              correct ? question.feedback.correct : question.feedback.incorrect,
              question.explanation ? `${copy.agent.challengeAnswerLabel} ${question.correctOptionId}. ${question.explanation}` : "",
              question.followUp ? `${copy.agent.challengeFollowUpLabel} ${question.followUp}` : "",
            ].filter(Boolean).join("\n\n")}
          />
          <button
            className="challenge-next"
            type="button"
            onClick={() => {
              if (!isLastQuestion) {
                setCurrentIndex((index) => Math.min(index + 1, quiz.questions.length - 1));
                return;
              }
              thread.append({
                role: "user",
                content: [{ type: "text", text: copy.agent.challengeUserMessage("quiz", quiz.questions.length) }],
              });
            }}
          >
            {isLastQuestion ? copy.agent.challengeNewSet : copy.agent.challengeNext}
          </button>
        </div>
      )}
    </section>
  );
}

function ChallengeProblemCard({ problem }: { problem: ChallengeProblem }) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const thread = assistantUi.useThreadRuntime();
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
          onClick={() => {
            thread.append({
              role: "user",
              content: [{ type: "text", text: copy.agent.challengeUserMessage("problem", 1) }],
            });
          }}
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

function parseChallengeContent(text: string): ChallengeContent | null {
  const raw = extractJsonObjectText(text);
  if (!raw) return null;
  const parsed = parseChallengeJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === "synchropage.challenge_quiz.v1") {
    const quiz = parseChallengeQuizValue(value);
    return quiz ? { kind: "quiz", quiz } : null;
  }
  if (value.type === "synchropage.challenge_problem.v1") {
    const problem = parseChallengeProblemValue(value);
    return problem ? { kind: "problem", problem } : null;
  }
  return null;
}

function parseChallengeQuizValue(value: Record<string, unknown>): ChallengeQuizSet | null {
  const rawQuestions = Array.isArray(value.questions) && value.questions.length
    ? value.questions
    : [value];
  const questions = rawQuestions
    .map((item) => normalizeChallengeQuestion(item))
    .filter((item): item is ChallengeQuizQuestion => Boolean(item))
    .slice(0, 10);
  if (!questions.length) return null;

  return {
    title: stringField(value.title) || "Challenge Quiz",
    questions,
  };
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

function normalizeChallengeQuestion(item: unknown): ChallengeQuizQuestion | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
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

function parseChallengeJson(raw: string): unknown {
  const repaired = escapeInvalidJsonStringCharacters(raw);
  if (repaired !== raw) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Fall through to the raw parse path. Some non-LaTeX JSON escapes are still valid as-is.
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function escapeInvalidJsonStringCharacters(input: string) {
  let output = "";
  let inString = false;
  const structuralEscapes = new Set(['"', "\\", "/"]);
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (!inString) {
      if (char === "\"") inString = true;
      output += char;
      continue;
    }
    if (char === "\\") {
      const next = input.charAt(index + 1);
      if (structuralEscapes.has(next)) {
        output += char + next;
        index += 1;
      } else if (next === "u" && isJsonUnicodeEscape(input, index + 2)) {
        output += input.slice(index, index + 6);
        index += 5;
      } else {
        output += "\\\\";
      }
      continue;
    }
    if (char === "\"") {
      inString = false;
      output += char;
      continue;
    }
    if (char === "\n") {
      output += "\\n";
      continue;
    }
    if (char === "\r") {
      output += "\\r";
      continue;
    }
    if (char === "\t") {
      output += "\\t";
      continue;
    }
    output += char;
  }
  return output;
}

function isJsonUnicodeEscape(input: string, start: number) {
  return /^[0-9a-fA-F]{4}$/.test(input.slice(start, start + 4));
}

function looksLikeChallengeText(text: string) {
  const value = text.trim();
  return value.startsWith("{") || value.startsWith("```json") || containsChallengeMarker(value);
}

function containsChallengeMarker(text: string) {
  return text.includes("synchropage.challenge_quiz.v1") || text.includes("synchropage.challenge_problem.v1");
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
