import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ReaderMarkdown } from "../workspace/WorkspaceChrome";
import { buildChallengeFollowUpPrompt } from "../../lib/assistant/agentChatAdapter";
import { useAppCopy, useAppendUserText } from "../../lib/contexts";
import {
  EMPTY_QUIZ_ANSWER,
  advanceRetryQueue,
  buildRetryQueue,
  quizAnswerEntry,
  retryQuestionFor,
  saveQuizWeakPoints,
  summarizeQuizRun,
  weakPointsFromSummary,
  type QuizAnswerLog,
  type QuizQuestion,
  type QuizRunSummary,
  type QuizSet,
} from "./quizModel";

export const NAVIGATE_PAGE_EVENT = "synchropage:navigate-page";
const PEEK_DURATION_MS = 3000;

export type QuizPhase = "quiz" | "summary" | "retry";

export type QuizRun = ReturnType<typeof useQuizRun>;

/**
 * All run state lives in the in-thread message card, so closing and reopening
 * the overlay never loses progress.
 */
export function useQuizRun(quiz: QuizSet, storageDocumentId?: string) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<QuizPhase>("quiz");
  const [index, setIndex] = useState(0);
  const [log, setLog] = useState<QuizAnswerLog>({});
  const [retryQueue, setRetryQueue] = useState<string[]>([]);
  const [retryRound, setRetryRound] = useState(1);
  const [retryPick, setRetryPick] = useState<string | null>(null);
  const [retryCleared, setRetryCleared] = useState(false);
  const savedWeakPointsRef = useRef(false);

  const summary = useMemo(() => summarizeQuizRun(quiz, log), [quiz, log]);
  const reachedSummary = phase !== "quiz";
  const finished = reachedSummary || (summary.total > 0 && summary.answered >= summary.total);

  useEffect(() => {
    if (index < quiz.questions.length) return;
    setIndex(Math.max(0, quiz.questions.length - 1));
  }, [index, quiz.questions.length]);

  // Store the misses once the learner reaches the summary so the next set on
  // this document can target them (spaced retrieval).
  useEffect(() => {
    if (phase !== "summary" || savedWeakPointsRef.current) return;
    savedWeakPointsRef.current = true;
    // Prefer the id the app owns; the model-echoed document_id is display metadata.
    const target = storageDocumentId && storageDocumentId !== "unknown" ? storageDocumentId : quiz.documentId;
    saveQuizWeakPoints(target, weakPointsFromSummary(summary));
  }, [phase, quiz.documentId, storageDocumentId, summary]);

  const question = quiz.questions[index] || null;
  const entry = question ? quizAnswerEntry(log, question.id) : EMPTY_QUIZ_ANSWER;

  const pick = useCallback((optionId: string) => {
    if (!question) return;
    setLog((current) => {
      const previous = current[question.id] || EMPTY_QUIZ_ANSWER;
      if (previous.locked || previous.attempts.includes(optionId)) return current;
      const attempts = [...previous.attempts, optionId];
      const correct = optionId === question.correctOptionId;
      return {
        ...current,
        [question.id]: {
          attempts,
          // A first wrong pick auto-reveals the hint and buys one more attempt.
          hintRevealed: previous.hintRevealed || !correct,
          locked: correct || attempts.length >= 2,
        },
      };
    });
  }, [question]);

  const revealHint = useCallback(() => {
    if (!question) return;
    setLog((current) => {
      const previous = current[question.id] || EMPTY_QUIZ_ANSWER;
      if (previous.hintRevealed) return current;
      return { ...current, [question.id]: { ...previous, hintRevealed: true } };
    });
  }, [question]);

  const next = useCallback(() => {
    if (index < quiz.questions.length - 1) setIndex(index + 1);
    else setPhase("summary");
  }, [index, quiz.questions.length]);

  const startRetry = useCallback(() => {
    const queue = buildRetryQueue(quiz, log);
    setRetryQueue(queue);
    setRetryRound(1);
    setRetryPick(null);
    setRetryCleared(queue.length === 0);
    setPhase("retry");
  }, [log, quiz]);

  const retryActiveQuestion = useMemo(() => {
    const questionId = retryQueue[0];
    if (!questionId) return null;
    const source = quiz.questions.find((item) => item.id === questionId);
    return source ? retryQuestionFor(source, retryRound) : null;
  }, [quiz.questions, retryQueue, retryRound]);

  const pickRetry = useCallback((optionId: string) => {
    setRetryPick((current) => current || optionId);
  }, []);

  const advanceRetry = useCallback(() => {
    const questionId = retryQueue[0];
    if (!questionId || !retryActiveQuestion) return;
    const correct = retryPick === retryActiveQuestion.correctOptionId;
    const nextQueue = advanceRetryQueue(retryQueue, questionId, correct);
    setRetryQueue(nextQueue);
    setRetryRound((current) => current + 1);
    setRetryPick(null);
    if (!nextQueue.length) setRetryCleared(true);
  }, [retryActiveQuestion, retryPick, retryQueue]);

  const backToSummary = useCallback(() => {
    setPhase("summary");
    setRetryPick(null);
  }, []);

  return {
    quiz,
    open,
    setOpen,
    phase,
    index,
    question,
    entry,
    log,
    summary,
    finished,
    pick,
    revealHint,
    next,
    startRetry,
    retryQueue,
    retryActiveQuestion,
    retryPick,
    retryCleared,
    pickRetry,
    advanceRetry,
    backToSummary,
  };
}

// ── Overlay ──────────────────────────────────────────────────

export function QuizOverlay({ run }: { run: QuizRun }) {
  const copy = useAppCopy();
  const send = useAppendUserText();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [peeking, setPeeking] = useState(false);
  const { quiz, phase, question, entry, open, setOpen } = run;
  const locked = entry.locked;

  // Every new question (and the summary) starts at the top of the panel.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [phase, run.index, run.retryQueue]);

  const close = useCallback(() => {
    setOpen(false);
    setPeeking(false);
  }, [setOpen]);

  // aria-modal without focus management strands keyboard and screen-reader
  // users on the hidden page: move focus in on open, give it back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearTimeout(timer);
      if (previous && document.contains(previous) && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  // "看原文 p.N": hand the PDF pane the page and get out of the way for a moment.
  const peekSource = useCallback((pageNo: number) => {
    try {
      window.dispatchEvent(new CustomEvent(NAVIGATE_PAGE_EVENT, { detail: { pageNo } }));
    } catch {
      // Navigation is a convenience; a browser without CustomEvent still shows the quiz.
    }
    setPeeking(true);
  }, []);

  useEffect(() => {
    if (!peeking) return;
    const timer = window.setTimeout(() => setPeeking(false), PEEK_DURATION_MS);
    const handlePointerMove = (event: PointerEvent) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const inside = event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom;
      if (inside) setPeeking(false);
    };
    document.addEventListener("pointermove", handlePointerMove);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", handlePointerMove);
    };
  }, [peeking]);

  const optionIds = useMemo(() => {
    if (phase === "retry") return run.retryActiveQuestion?.options.map((option) => option.id) || [];
    return question?.options.map((option) => option.id) || [];
  }, [phase, question, run.retryActiveQuestion]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab") {
        trapTabWithin(panelRef.current, event);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "Enter") {
        if (phase === "quiz" && locked) {
          event.preventDefault();
          run.next();
        } else if (phase === "retry" && run.retryPick) {
          event.preventDefault();
          run.advanceRetry();
        }
        return;
      }
      if (phase === "summary") return;
      const shortcut = shortcutOptionId(event.key, optionIds);
      if (!shortcut) return;
      event.preventDefault();
      if (phase === "retry") run.pickRetry(shortcut);
      else run.pick(shortcut);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, locked, open, optionIds, phase, run]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const total = quiz.questions.length;
  const current = phase === "quiz" ? run.index + 1 : total;
  const progressPercent = total ? Math.max(6, (current / total) * 100) : 0;
  const skillLabel = phase === "quiz" && question
    ? quiz.skills.find((skill) => skill.id === question.skillId)?.label || question.skillId
    : copy.agent.quizSummaryTitle;

  return createPortal(
    <div
      className={`quiz-scrim ${peeking ? "quiz-peek" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="quiz-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={quiz.title || copy.agent.quizDialogAria}
        tabIndex={-1}
      >
        <div className="quiz-topbar">
          <p className="quiz-goal">{quiz.setGoal || copy.agent.quizSetGoalFallback}</p>
          <div className="quiz-progress" aria-label={copy.agent.quizProgress(current, total)}>
            <span className="quiz-progress-track" aria-hidden="true">
              <span className="quiz-progress-fill" style={{ width: `${progressPercent}%` }} />
            </span>
            <span className="quiz-progress-count">{copy.agent.quizProgress(current, total)}</span>
          </div>
          <div className="quiz-topbar-end">
            <span className="quiz-skill-tag">{skillLabel}</span>
            <button
              className="quiz-close"
              type="button"
              onClick={close}
              aria-label={copy.agent.quizClose}
              title={copy.agent.quizClose}
            >
              <X />
            </button>
          </div>
        </div>
        <div className="quiz-body" ref={bodyRef}>
          {phase === "quiz" && question && (
            <QuizQuestionView run={run} question={question} onPeek={peekSource} onSend={send} onClose={close} />
          )}
          {phase === "summary" && <QuizSummaryView run={run} onSend={send} onClose={close} />}
          {phase === "retry" && <QuizRetryView run={run} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Skeleton shown while the model is still writing the set. */
export function QuizSkeletonOverlay() {
  const copy = useAppCopy();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="quiz-scrim">
      <div className="quiz-panel" role="dialog" aria-label={copy.agent.quizDialogAria} aria-busy="true">
        <div className="quiz-topbar">
          <p className="quiz-goal" role="status">{copy.agent.quizGenerating}</p>
        </div>
        <div className="quiz-body">
          <div className="quiz-skeleton" aria-hidden="true">
            <span className="quiz-skeleton-line long" />
            <span className="quiz-skeleton-line medium" />
            <span className="quiz-skeleton-row" />
            <span className="quiz-skeleton-row" />
            <span className="quiz-skeleton-row" />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Question ─────────────────────────────────────────────────

function QuizQuestionView({
  run,
  question,
  onPeek,
  onSend,
  onClose,
}: {
  run: QuizRun;
  question: QuizQuestion;
  onPeek: (pageNo: number) => void;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const copy = useAppCopy();
  const { entry } = run;
  const feedbackRef = useRef<HTMLDivElement>(null);
  const chosenId = entry.attempts[entry.attempts.length - 1] || "";
  const chosen = question.options.find((option) => option.id === chosenId) || null;
  const correctOption = question.options.find((option) => option.id === question.correctOptionId) || null;
  const isCorrect = chosenId === question.correctOptionId;
  // Scoring, the retry queue and the weak-point store all key on the FIRST
  // pick; the feedback block must not hide the misconception that pick revealed.
  const firstId = entry.attempts[0] || "";
  const firstPick = firstId && firstId !== chosenId ? question.options.find((option) => option.id === firstId) || null : null;
  const recoveredOnRetry = isCorrect && Boolean(firstPick);
  const isLast = run.index >= run.quiz.questions.length - 1;

  // Locking a question reveals a long feedback block; bring it (and "下一题") into view.
  useEffect(() => {
    if (!entry.locked) return;
    feedbackRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entry.locked, question.id]);

  return (
    <>
      <div className="quiz-stem">
        <ReaderMarkdown className="markdown-body" text={question.stem} />
      </div>
      <div className="quiz-options" role="group" aria-label={question.stem}>
        {question.options.map((option, position) => (
          <button
            className={`quiz-option ${optionStateClass(option.id, question.correctOptionId, entry)}`}
            key={option.id}
            type="button"
            disabled={entry.locked || entry.attempts.includes(option.id)}
            aria-pressed={entry.attempts.includes(option.id)}
            onClick={() => run.pick(option.id)}
          >
            <span className="quiz-option-key" aria-hidden="true">{option.id}</span>
            <span className="quiz-option-text">
              <ReaderMarkdown className="markdown-body" text={option.text} />
            </span>
            <span className="quiz-option-shortcut" aria-hidden="true">{position + 1}</span>
          </button>
        ))}
      </div>
      <div className="quiz-quiet-actions">
        {question.hint && (
          <button className="quiz-quiet-link" type="button" onClick={run.revealHint} disabled={entry.hintRevealed}>
            {copy.agent.quizHint}
          </button>
        )}
        {question.evidence.page && (
          <button className="quiz-quiet-link" type="button" onClick={() => onPeek(question.evidence.page as number)}>
            {copy.agent.quizViewSource(question.evidence.page)}
          </button>
        )}
        {entry.hintRevealed && question.hint && (
          <p className="quiz-hint-text">{question.hint}</p>
        )}
      </div>
      {!entry.locked && entry.attempts.length > 0 && (
        <div className="quiz-nudge">
          <p className="quiz-nudge-title">{copy.agent.challengeIncorrect}</p>
          {chosen?.diagnosis && <p className="quiz-nudge-text">{chosen.diagnosis}</p>}
          <p className="quiz-nudge-text quiz-nudge-retry">{copy.agent.quizRetryPrompt}</p>
        </div>
      )}
      {entry.locked && (
        <div className={`quiz-feedback ${isCorrect ? "correct" : "incorrect"} ${recoveredOnRetry ? "recovered" : ""}`} ref={feedbackRef}>
          <p className="quiz-feedback-title">
            {recoveredOnRetry ? copy.agent.quizCorrectOnRetry : isCorrect ? copy.agent.challengeCorrect : copy.agent.challengeIncorrect}
            <span className="quiz-feedback-answer">{copy.agent.quizAnswerLabel(question.correctOptionId)}</span>
          </p>
          {firstPick && (firstPick.diagnosis || firstPick.fix) && (
            <div className="quiz-first-pick">
              <QuizBlock
                label={copy.agent.quizFirstPickLabel(firstPick.id)}
                text={[firstPick.diagnosis, firstPick.fix].filter(Boolean).join("\n\n")}
              />
            </div>
          )}
          {chosen?.diagnosis && (
            <QuizBlock label={copy.agent.quizDiagnosisLabel} text={chosen.diagnosis} />
          )}
          {chosen?.fix && !isCorrect && <p className="quiz-feedback-fix">{chosen.fix}</p>}
          {question.explanation.whyCorrect && (
            <QuizBlock label={copy.agent.quizWhyCorrect} text={question.explanation.whyCorrect} />
          )}
          {question.explanation.coreIdea && (
            <QuizBlock label={copy.agent.quizCoreIdea} text={question.explanation.coreIdea} />
          )}
          <QuizExamRelevance question={question} />
          {isCorrect
            ? question.followUp && <QuizBlock label={copy.agent.quizFollowUp} text={question.followUp} />
            : question.bridge && <QuizBlock label={copy.agent.quizBridge} text={question.bridge} />}
          <div className="quiz-feedback-actions">
            <button
              className="quiz-action"
              type="button"
              onClick={() => {
                onSend(buildChallengeFollowUpPrompt({
                  stem: question.stem,
                  chosenOptionId: chosenId,
                  chosenOptionText: chosen?.text || "",
                  correctOptionId: question.correctOptionId,
                  correctOptionText: correctOption?.text || "",
                  isCorrect,
                  misconception: chosen?.misconception,
                  diagnosis: chosen?.diagnosis,
                  coreIdea: question.explanation.coreIdea,
                  pageNo: question.evidence.page,
                  anchor: question.evidence.anchor,
                }));
                onClose();
              }}
            >
              {copy.agent.quizAskAi}
            </button>
            <button className="quiz-action primary quiz-next" type="button" onClick={run.next}>
              {isLast ? copy.agent.quizSeeSummary : copy.agent.quizNext}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function QuizExamRelevance({ question }: { question: QuizQuestion }) {
  const copy = useAppCopy();
  const [expanded, setExpanded] = useState(false);
  const { howTested, typicalTrap, weight } = question.examRelevance;
  if (!howTested && !typicalTrap) return null;
  return (
    <div className="quiz-exam">
      <button
        className="quiz-quiet-link quiz-exam-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {copy.agent.quizExamSection}
      </button>
      {expanded && (
        <div className="quiz-exam-body">
          {howTested && <p>{howTested}</p>}
          {typicalTrap && <p><span className="quiz-block-label">{copy.agent.quizExamTrap}</span>{typicalTrap}</p>}
          {weight && <p className="quiz-exam-weight">{copy.agent.quizExamWeight(weight)}</p>}
        </div>
      )}
    </div>
  );
}

function QuizBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="quiz-block">
      <span className="quiz-block-label">{label}</span>
      <ReaderMarkdown className="markdown-body" text={text} />
    </div>
  );
}

// ── Summary ──────────────────────────────────────────────────

function QuizSummaryView({
  run,
  onSend,
  onClose,
}: {
  run: QuizRun;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const copy = useAppCopy();
  const { summary, quiz } = run;
  const weakLabels = summary.bySkill.filter((skill) => skill.status === "weak").map((skill) => skill.label);
  const misconceptions = summary.missed.map((miss) => miss.misconception).filter(Boolean);

  return (
    <div className="quiz-summary">
      <div className="quiz-summary-score">
        <strong>{copy.agent.quizScore(summary.firstTryCorrect, summary.total)}</strong>
        {summary.eventuallyCorrect > summary.firstTryCorrect && (
          <span>{copy.agent.quizEventuallyCorrect(summary.eventuallyCorrect, summary.total)}</span>
        )}
        {summary.hintsUsed > 0 && <span>{copy.agent.quizHintsUsed(summary.hintsUsed)}</span>}
      </div>
      <section className="quiz-summary-section">
        <h4>{copy.agent.quizSkillHeading}</h4>
        <ul className="quiz-skill-list">
          {summary.bySkill.map((skill) => (
            <li className="quiz-skill-row" key={skill.skillId}>
              <span className="quiz-skill-name">{skill.label}</span>
              <span className="quiz-skill-score">{copy.agent.quizSkillScore(skill.correct, skill.total)}</span>
              <span className={`quiz-skill-status ${skill.status}`}>{skillStatusLabel(skill.status, copy)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="quiz-summary-section">
        <h4>{copy.agent.quizMissedHeading}</h4>
        {summary.missed.length ? (
          <ul className="quiz-missed-list">
            {summary.missed.map((miss) => (
              <li className="quiz-missed-row" key={miss.questionId}>
                <span className="quiz-missed-stem">{miss.stem}</span>
                <span className="quiz-missed-detail">
                  {miss.chosenOptionId}
                  {miss.misconception ? ` · ${miss.misconception}` : miss.diagnosis ? ` · ${miss.diagnosis}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiz-summary-empty">{copy.agent.quizMissedEmpty}</p>
        )}
      </section>
      <div className="quiz-summary-actions">
        <button
          className="quiz-action primary quiz-retry-start"
          type="button"
          onClick={run.startRetry}
          disabled={!summary.missed.length}
        >
          {copy.agent.quizRetryMissed(summary.missed.length)}
        </button>
        <button
          className="quiz-action"
          type="button"
          onClick={() => {
            onSend(copy.agent.quizNewSetMessage(
              quiz.questions.length,
              weakLabels.join("、"),
              misconceptions.slice(0, 3).join("；"),
            ));
            onClose();
          }}
        >
          {copy.agent.quizNewSetSameSkills}
        </button>
        <button
          className="quiz-action"
          type="button"
          onClick={() => {
            onSend(copy.agent.challengeUserMessage("problem", 1));
            onClose();
          }}
        >
          {copy.agent.quizGenerateProblem}
        </button>
        <button
          className="quiz-action"
          type="button"
          onClick={() => {
            onSend(copy.agent.quizDiagnoseMessage(answerLogText(run.quiz, run.summary, copy)));
            onClose();
          }}
        >
          {copy.agent.quizDiagnose}
        </button>
        <button className="quiz-action" type="button" onClick={onClose}>
          {copy.agent.quizEnd}
        </button>
      </div>
    </div>
  );
}

// ── Retry loop ───────────────────────────────────────────────

function QuizRetryView({ run }: { run: QuizRun }) {
  const copy = useAppCopy();
  const question = run.retryActiveQuestion;

  if (run.retryCleared || !question) {
    return (
      <div className="quiz-retry-done">
        <p className="quiz-retry-cleared">{copy.agent.quizRetryCleared}</p>
        <button className="quiz-action primary" type="button" onClick={run.backToSummary}>
          {copy.agent.quizBackToSummary}
        </button>
      </div>
    );
  }

  const picked = run.retryPick;
  const isCorrect = picked === question.correctOptionId;
  const chosen = question.options.find((option) => option.id === picked) || null;

  return (
    <>
      <p className="quiz-retry-heading">
        {copy.agent.quizRetryHeading}
        <span>{copy.agent.quizRetryRemaining(run.retryQueue.length)}</span>
        <button className="quiz-quiet-link quiz-retry-exit" type="button" onClick={run.backToSummary}>
          {copy.agent.quizBackToSummary}
        </button>
      </p>
      <div className="quiz-stem">
        <ReaderMarkdown className="markdown-body" text={question.stem} />
      </div>
      <div className="quiz-options" role="group" aria-label={question.stem}>
        {question.options.map((option, position) => (
          <button
            className={`quiz-option ${picked ? retryStateClass(option.id, question.correctOptionId, picked) : ""}`}
            key={option.id}
            type="button"
            disabled={Boolean(picked)}
            onClick={() => run.pickRetry(option.id)}
          >
            <span className="quiz-option-key" aria-hidden="true">{option.id}</span>
            <span className="quiz-option-text">
              <ReaderMarkdown className="markdown-body" text={option.text} />
            </span>
            <span className="quiz-option-shortcut" aria-hidden="true">{position + 1}</span>
          </button>
        ))}
      </div>
      {picked && (
        <div className={`quiz-feedback ${isCorrect ? "correct" : "incorrect"}`}>
          <p className="quiz-feedback-title">
            {isCorrect ? copy.agent.challengeCorrect : copy.agent.challengeIncorrect}
            <span className="quiz-feedback-answer">{copy.agent.quizAnswerLabel(question.correctOptionId)}</span>
          </p>
          {chosen?.diagnosis && <QuizBlock label={copy.agent.quizDiagnosisLabel} text={chosen.diagnosis} />}
          {question.explanation.coreIdea && (
            <QuizBlock label={copy.agent.quizCoreIdea} text={question.explanation.coreIdea} />
          )}
          <div className="quiz-feedback-actions">
            <button className="quiz-action primary quiz-next" type="button" onClick={run.advanceRetry}>
              {copy.agent.quizNext}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── In-thread card ───────────────────────────────────────────

export function QuizThreadCard({ run, children }: { run: QuizRun; children?: ReactNode }) {
  const copy = useAppCopy();
  const { quiz, summary, finished } = run;
  return (
    <section className="quiz-thread-card" aria-label={quiz.title || copy.agent.quizDialogAria}>
      <div className="quiz-thread-head">
        <h3 className="quiz-thread-title">{quiz.title || copy.agent.challengeTitle}</h3>
        <span className="quiz-thread-count">{copy.agent.quizQuestionCount(quiz.questions.length)}</span>
      </div>
      {quiz.setGoal && <p className="quiz-thread-goal">{quiz.setGoal}</p>}
      <div className="quiz-thread-foot">
        {finished && (
          <span className="quiz-thread-score">{copy.agent.quizScore(summary.firstTryCorrect, summary.total)}</span>
        )}
        <button className="quiz-thread-open" type="button" onClick={() => run.setOpen(true)}>
          {finished ? copy.agent.quizViewSummary : summary.answered > 0 ? copy.agent.quizReopen : copy.agent.quizOpen}
        </button>
      </div>
      {children}
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function optionStateClass(
  optionId: string,
  correctOptionId: string,
  entry: { attempts: string[]; locked: boolean },
) {
  if (!entry.locked) return entry.attempts.includes(optionId) ? "tried" : "";
  if (optionId === correctOptionId) return "correct";
  if (entry.attempts.includes(optionId)) return "incorrect";
  return "dimmed";
}

function retryStateClass(optionId: string, correctOptionId: string, picked: string) {
  if (optionId === correctOptionId) return "correct";
  if (optionId === picked) return "incorrect";
  return "dimmed";
}

function trapTabWithin(panel: HTMLElement | null, event: KeyboardEvent) {
  if (!panel) return;
  const focusable = Array.from(
    panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  );
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!focusable.length) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!active || !panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function shortcutOptionId(key: string, optionIds: string[]) {
  if (/^[1-9]$/.test(key)) return optionIds[Number(key) - 1] || "";
  const letter = key.toUpperCase();
  if (!/^[A-Z]$/.test(letter)) return "";
  return optionIds.includes(letter) ? letter : "";
}

function skillStatusLabel(status: "weak" | "ok" | "strong", copy: ReturnType<typeof useAppCopy>) {
  if (status === "strong") return copy.agent.quizSkillStrong;
  if (status === "ok") return copy.agent.quizSkillOk;
  return copy.agent.quizSkillWeak;
}

function answerLogText(quiz: QuizSet, summary: QuizRunSummary, copy: ReturnType<typeof useAppCopy>) {
  const lines = quiz.questions.map((question, index) => {
    const miss = summary.missed.find((item) => item.questionId === question.id);
    const chosen = miss ? `${miss.chosenOptionId}. ${miss.chosenOptionText}` : question.correctOptionId;
    return copy.agent.quizAnswerLogLine(index + 1, question.stem, chosen, question.correctOptionId);
  });
  return [copy.agent.quizScore(summary.firstTryCorrect, summary.total), ...lines].join("\n");
}
