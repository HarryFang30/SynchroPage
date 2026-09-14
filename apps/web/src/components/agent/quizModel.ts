// Quiz (Challenge) domain model.
//
// Everything in this file is pure and framework-free so the parsing, scoring
// and retry-queue rules can be unit-tested without React. The only impure part
// is the weak-point store at the bottom, which is guarded so a blocked or full
// localStorage can never break a quiz run.

// ── JSON extraction ──────────────────────────────────────────

/** Pull the JSON object out of a model reply that may be fenced or chatty. */
export function extractJsonObjectText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : "";
}

/**
 * Re-escape characters that are illegal inside a JSON string. Models writing
 * LaTeX routinely emit a single backslash ("\vec{E}"), which is not valid JSON.
 */
export function escapeInvalidJsonStringCharacters(input: string) {
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

/** Parse JSON, repairing LaTeX-style escapes first and falling back to the raw text. */
export function parseJsonLoose(raw: string): unknown {
  // Valid JSON first: the repair pass would turn legal "\n" / "\t" escapes into
  // literal backslashes, so it must only run when the raw text does not parse.
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to the LaTeX repair path.
  }
  const repaired = escapeInvalidJsonStringCharacters(raw);
  if (repaired === raw) return null;
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// ── Contract markers ─────────────────────────────────────────

export const QUIZ_TYPE_V2 = "synchropage.challenge_quiz.v2";
export const QUIZ_TYPE_V1 = "synchropage.challenge_quiz.v1";
export const PROBLEM_TYPE_V1 = "synchropage.challenge_problem.v1";

export function containsChallengeMarker(text: string) {
  return text.includes(QUIZ_TYPE_V2) || text.includes(QUIZ_TYPE_V1) || text.includes(PROBLEM_TYPE_V1);
}

export function looksLikeChallengeText(text: string) {
  const value = text.trim();
  return value.startsWith("{") || value.startsWith("```json") || containsChallengeMarker(value);
}

/**
 * Stricter than `looksLikeChallengeText`: this one gates a full-screen skeleton
 * overlay, so it only fires once the stream has actually declared a quiz type
 * (the `type` key leads the payload). A reply that merely starts with "{" keeps
 * the ordinary in-thread thinking indicator.
 */
export function looksLikeQuizText(text: string) {
  const value = text.trim();
  return value.includes(QUIZ_TYPE_V2) || value.includes(QUIZ_TYPE_V1);
}

// ── Types ────────────────────────────────────────────────────

export type QuizSkill = {
  id: string;
  label: string;
};

export type QuizOption = {
  id: string;
  text: string;
  correct: boolean;
  diagnosis: string;
  misconception: string;
  fix: string;
};

export type QuizExamRelevance = {
  howTested: string;
  typicalTrap: string;
  weight: string;
};

export type QuizEvidence = {
  page: number | null;
  anchor: string;
  quote: string;
};

export type QuizExplanation = {
  whyCorrect: string;
  coreIdea: string;
};

export type QuizQuestion = {
  id: string;
  skillId: string;
  knowledgeType: string;
  bloom: string;
  difficulty: number;
  stem: string;
  options: QuizOption[];
  correctOptionId: string;
  hint: string;
  explanation: QuizExplanation;
  examRelevance: QuizExamRelevance;
  evidence: QuizEvidence;
  followUp: string;
  bridge: string;
  retryVariant: QuizRetryVariant | null;
};

export type QuizRetryVariant = {
  stem: string;
  options: QuizOption[];
  correctOptionId: string;
};

export type QuizSet = {
  version: "v1" | "v2";
  title: string;
  setGoal: string;
  documentId: string;
  skills: QuizSkill[];
  questions: QuizQuestion[];
};

export type QuizAnswerEntry = {
  attempts: string[];
  hintRevealed: boolean;
  locked: boolean;
};

export type QuizAnswerLog = Record<string, QuizAnswerEntry>;

export type QuizSkillStat = {
  skillId: string;
  label: string;
  correct: number;
  total: number;
  status: "weak" | "ok" | "strong";
};

export type QuizMiss = {
  questionId: string;
  stem: string;
  skillId: string;
  label: string;
  chosenOptionId: string;
  chosenOptionText: string;
  misconception: string;
  diagnosis: string;
  page: number | null;
};

export type QuizRunSummary = {
  total: number;
  answered: number;
  firstTryCorrect: number;
  eventuallyCorrect: number;
  hintsUsed: number;
  bySkill: QuizSkillStat[];
  missed: QuizMiss[];
};

export const EMPTY_QUIZ_ANSWER: QuizAnswerEntry = { attempts: [], hintRevealed: false, locked: false };

// ── Parsing ──────────────────────────────────────────────────

/** Parse a quiz payload from raw assistant text. Accepts v2 and legacy v1. */
export function parseQuizFromText(text: string): QuizSet | null {
  const raw = extractJsonObjectText(text);
  if (!raw) return null;
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return parseQuizSetValue(parsed as Record<string, unknown>);
}

/** Parse an already-decoded JSON object into the v2 shape. */
export function parseQuizSetValue(value: Record<string, unknown>): QuizSet | null {
  const type = stringField(value.type);
  if (type && type !== QUIZ_TYPE_V2 && type !== QUIZ_TYPE_V1) return null;
  const version: QuizSet["version"] = type === QUIZ_TYPE_V1 ? "v1" : "v2";
  const rawQuestions = Array.isArray(value.questions) && value.questions.length ? value.questions : [value];
  const questions = uniqueQuestionIds(
    rawQuestions
      .map((item, index) => normalizeQuizQuestion(item, index))
      .filter((item): item is QuizQuestion => Boolean(item))
      .slice(0, 10),
  );
  if (!questions.length) return null;

  const declaredSkills = Array.isArray(value.skills)
    ? value.skills
        .map((item) => {
          const skill = objectField(item);
          const id = slug(stringField(skill.id));
          const label = stringField(skill.label) || id;
          return id ? { id, label } : null;
        })
        .filter((item): item is QuizSkill => Boolean(item))
    : [];
  const skills = mergeSkills(declaredSkills, questions);

  return {
    version,
    title: stringField(value.title) || "Challenge Quiz",
    setGoal: stringField(value.set_goal ?? value.setGoal),
    documentId: stringField(value.document_id ?? value.documentId) || "unknown",
    skills,
    questions,
  };
}

/** The answer log, retry queue and summary are keyed by id; collisions must not merge two questions. */
function uniqueQuestionIds(questions: QuizQuestion[]): QuizQuestion[] {
  const seen = new Set<string>();
  return questions.map((question) => {
    let id = question.id;
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${question.id}#${suffix}`)) suffix += 1;
      id = `${question.id}#${suffix}`;
    }
    seen.add(id);
    return id === question.id ? question : { ...question, id };
  });
}

function mergeSkills(declared: QuizSkill[], questions: QuizQuestion[]): QuizSkill[] {
  const byId = new Map<string, QuizSkill>();
  for (const skill of declared) byId.set(skill.id, skill);
  for (const question of questions) {
    if (byId.has(question.skillId)) continue;
    byId.set(question.skillId, { id: question.skillId, label: question.skillId });
  }
  return [...byId.values()];
}

function normalizeQuizQuestion(item: unknown, index: number): QuizQuestion | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  // v1 called the stem "question"; v2 calls it "stem".
  const stem = stringField(value.stem) || stringField(value.question);
  const declaredId = normalizeOptionId(value.correct_option_id ?? value.correctOptionId ?? value.answer, "");
  const legacyFeedback = objectField(value.feedback);
  const provisional = normalizeOptions(value.options, declaredId, legacyFeedback);
  const correctOptionId = resolveCorrectOptionId(declaredId, provisional);
  const options = correctOptionId === declaredId
    ? provisional
    : normalizeOptions(value.options, correctOptionId, legacyFeedback);
  if (!stem || options.length < 2 || !correctOptionId) return null;

  const explanation = value.explanation;
  const explanationObject = objectField(explanation);
  const legacyChallengeType = stringField(value.challenge_type ?? value.challengeType);
  const examRelevance = objectField(value.exam_relevance ?? value.examRelevance);
  const evidence = objectField(value.evidence);

  return {
    id: stringField(value.id) || `q${index + 1}`,
    skillId: slug(stringField(value.skill_id ?? value.skillId) || legacyChallengeType) || "general",
    knowledgeType: stringField(value.knowledge_type ?? value.knowledgeType) || "mixed",
    bloom: stringField(value.bloom) || "understand",
    difficulty: clampDifficulty(value.difficulty),
    stem,
    options,
    correctOptionId,
    hint: stringField(value.hint),
    explanation: {
      whyCorrect: typeof explanation === "string"
        ? explanation.trim()
        : stringField(explanationObject.why_correct ?? explanationObject.whyCorrect),
      coreIdea: stringField(explanationObject.core_idea ?? explanationObject.coreIdea),
    },
    examRelevance: {
      howTested: stringField(examRelevance.how_tested ?? examRelevance.howTested),
      typicalTrap: stringField(examRelevance.typical_trap ?? examRelevance.typicalTrap),
      weight: stringField(examRelevance.weight),
    },
    evidence: {
      page: positiveInteger(evidence.page),
      anchor: stringField(evidence.anchor),
      quote: stringField(evidence.quote),
    },
    followUp: stringField(value.follow_up ?? value.followUp),
    bridge: stringField(value.bridge),
    retryVariant: normalizeRetryVariant(value.retry_variant ?? value.retryVariant),
  };
}

/**
 * Prefer a declared correct_option_id that names a real option; otherwise fall
 * back to the single option flagged `correct: true` (an ambiguous payload with
 * several flags is rejected rather than graded against an arbitrary pick).
 */
function resolveCorrectOptionId(declaredId: string, options: QuizOption[]) {
  if (declaredId && options.some((option) => option.id === declaredId)) return declaredId;
  const flagged = options.filter((option) => option.correct);
  return flagged.length === 1 ? flagged[0].id : "";
}

function normalizeOptions(
  raw: unknown,
  correctOptionId: string,
  legacyFeedback: Record<string, unknown>,
): QuizOption[] {
  if (!Array.isArray(raw)) return [];
  const legacyCorrect = stringField(legacyFeedback.correct);
  const legacyIncorrect = stringField(legacyFeedback.incorrect);
  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const option = item as Record<string, unknown>;
      const id = normalizeOptionId(option.id, String.fromCharCode(65 + index));
      const text = stringField(option.text);
      if (!id || !text) return null;
      const correct = option.correct === true || option.correct === "true" || id === correctOptionId;
      return {
        id,
        text,
        correct,
        // v1 had a single feedback pair for the whole question; fan it out per option
        // so the overlay always has something evidence-shaped to show.
        diagnosis: stringField(option.diagnosis) || (correct ? legacyCorrect : legacyIncorrect),
        misconception: stringField(option.misconception),
        fix: stringField(option.fix),
      };
    })
    .filter((item): item is QuizOption => Boolean(item))
    .slice(0, 6);
}

function normalizeRetryVariant(raw: unknown): QuizRetryVariant | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const stem = stringField(value.stem);
  const declaredId = normalizeOptionId(value.correct_option_id ?? value.correctOptionId, "");
  const provisional = normalizeOptions(value.options, declaredId, {});
  const correctOptionId = resolveCorrectOptionId(declaredId, provisional);
  const options = correctOptionId === declaredId ? provisional : normalizeOptions(value.options, correctOptionId, {});
  if (!stem || options.length < 2 || !correctOptionId) return null;
  return { stem, options, correctOptionId };
}

// ── Scoring ──────────────────────────────────────────────────

export function quizAnswerEntry(log: QuizAnswerLog, questionId: string): QuizAnswerEntry {
  return log[questionId] || EMPTY_QUIZ_ANSWER;
}

export function isFirstTryCorrect(question: QuizQuestion, entry: QuizAnswerEntry) {
  return entry.attempts[0] === question.correctOptionId;
}

export function isEventuallyCorrect(question: QuizQuestion, entry: QuizAnswerEntry) {
  return entry.attempts.includes(question.correctOptionId);
}

/** Local, model-free scoring: the "How am I going" half of the summary screen. */
export function summarizeQuizRun(quiz: QuizSet, log: QuizAnswerLog): QuizRunSummary {
  const labels = new Map(quiz.skills.map((skill) => [skill.id, skill.label]));
  const stats = new Map<string, QuizSkillStat>();
  const missed: QuizMiss[] = [];
  let answered = 0;
  let firstTryCorrect = 0;
  let eventuallyCorrect = 0;
  let hintsUsed = 0;

  for (const question of quiz.questions) {
    const entry = quizAnswerEntry(log, question.id);
    const hasAttempt = entry.attempts.length > 0;
    const first = isFirstTryCorrect(question, entry);
    if (hasAttempt) answered += 1;
    if (first) firstTryCorrect += 1;
    if (isEventuallyCorrect(question, entry)) eventuallyCorrect += 1;
    if (entry.hintRevealed) hintsUsed += 1;

    const stat = stats.get(question.skillId) || {
      skillId: question.skillId,
      label: labels.get(question.skillId) || question.skillId,
      correct: 0,
      total: 0,
      status: "weak" as const,
    };
    stat.total += 1;
    if (first) stat.correct += 1;
    stats.set(question.skillId, stat);

    if (hasAttempt && !first) {
      const chosenId = entry.attempts[0];
      const chosen = question.options.find((option) => option.id === chosenId) || null;
      missed.push({
        questionId: question.id,
        stem: question.stem,
        skillId: question.skillId,
        label: labels.get(question.skillId) || question.skillId,
        chosenOptionId: chosenId,
        chosenOptionText: chosen?.text || "",
        misconception: chosen?.misconception || "",
        diagnosis: chosen?.diagnosis || "",
        page: question.evidence.page,
      });
    }
  }

  const bySkill = [...stats.values()].map((stat) => ({ ...stat, status: skillStatus(stat.correct, stat.total) }));
  return {
    total: quiz.questions.length,
    answered,
    firstTryCorrect,
    eventuallyCorrect,
    hintsUsed,
    bySkill,
    missed,
  };
}

export function skillStatus(correct: number, total: number): QuizSkillStat["status"] {
  if (total <= 0) return "weak";
  const ratio = correct / total;
  if (ratio >= 1) return "strong";
  if (ratio >= 0.5) return "ok";
  return "weak";
}

// ── Retry queue (successive relearning) ──────────────────────

/** Questions missed on the first try, in quiz order. */
export function buildRetryQueue(quiz: QuizSet, log: QuizAnswerLog): string[] {
  return quiz.questions
    .filter((question) => {
      const entry = quizAnswerEntry(log, question.id);
      return entry.attempts.length > 0 && !isFirstTryCorrect(question, entry);
    })
    .map((question) => question.id);
}

/**
 * A question leaves the queue once it is answered correctly; a wrong answer
 * moves it to the end so the learner interleaves rather than drilling one item.
 */
export function advanceRetryQueue(queue: string[], questionId: string, correct: boolean): string[] {
  const rest = queue.filter((id) => id !== questionId);
  return correct ? rest : [...rest, questionId];
}

/**
 * The item to present for a retry round: the model's variant when it supplied
 * one, otherwise the same question with options rotated so position memory does
 * not stand in for understanding. Deterministic in `round` so re-renders are stable.
 */
export function retryQuestionFor(question: QuizQuestion, round: number): QuizQuestion {
  if (question.retryVariant) {
    return {
      ...question,
      stem: question.retryVariant.stem,
      options: question.retryVariant.options,
      correctOptionId: question.retryVariant.correctOptionId,
    };
  }
  return { ...question, options: rotateOptions(question.options, round) };
}

/** Rotate option order while keeping each option's own id/letter attached to its text. */
export function rotateOptions(options: QuizOption[], round: number): QuizOption[] {
  if (options.length < 2) return options;
  const shift = ((round % options.length) + options.length) % options.length;
  if (shift === 0) return options;
  return [...options.slice(shift), ...options.slice(0, shift)];
}

// ── Weak-point memory ────────────────────────────────────────

export const QUIZ_WEAK_POINTS_KEY = "synchropage.quizWeakPoints.v1";
export const QUIZ_WEAK_POINTS_EVENT = "synchropage:quiz-weak-points";
const MAX_WEAK_POINTS_PER_DOCUMENT = 40;

export type QuizWeakPoint = {
  skillId: string;
  label: string;
  misconception: string;
  page: number | null;
  ts: number;
};

type WeakPointStore = Record<string, QuizWeakPoint[]>;

function readWeakPointStore(): WeakPointStore {
  try {
    const raw = window.localStorage.getItem(QUIZ_WEAK_POINTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as WeakPointStore : {};
  } catch {
    return {};
  }
}

function writeWeakPointStore(store: WeakPointStore) {
  try {
    window.localStorage.setItem(QUIZ_WEAK_POINTS_KEY, JSON.stringify(store));
  } catch {
    // A blocked or full storage must never break the quiz run.
  }
}

export function readQuizWeakPoints(documentId: string): QuizWeakPoint[] {
  const list = readWeakPointStore()[documentId || "unknown"];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => normalizeWeakPoint(item))
    .filter((item): item is QuizWeakPoint => Boolean(item));
}

export function saveQuizWeakPoints(documentId: string, additions: QuizWeakPoint[]) {
  if (!additions.length) return readQuizWeakPoints(documentId);
  const key = documentId || "unknown";
  const merged = dedupeWeakPoints([...additions, ...readQuizWeakPoints(key)]).slice(0, MAX_WEAK_POINTS_PER_DOCUMENT);
  const store = readWeakPointStore();
  store[key] = merged;
  writeWeakPointStore(store);
  try {
    window.dispatchEvent(new CustomEvent(QUIZ_WEAK_POINTS_EVENT, { detail: { documentId: key } }));
  } catch {
    // Event dispatch is a nicety; the note refreshes on the next render anyway.
  }
  return merged;
}

export function dedupeWeakPoints(points: QuizWeakPoint[]): QuizWeakPoint[] {
  const seen = new Set<string>();
  const output: QuizWeakPoint[] = [];
  for (const point of points) {
    const key = `${point.skillId}::${point.misconception}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(point);
  }
  return output;
}

/** Turn a finished run into storable weak points (missed items only). */
export function weakPointsFromSummary(summary: QuizRunSummary, now = Date.now()): QuizWeakPoint[] {
  return summary.missed.map((miss) => ({
    skillId: miss.skillId,
    label: miss.label,
    misconception: miss.misconception || miss.diagnosis || miss.chosenOptionText,
    page: miss.page,
    ts: now,
  }));
}

function normalizeWeakPoint(item: unknown): QuizWeakPoint | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const skillId = stringField(value.skillId ?? value.skill_id);
  if (!skillId) return null;
  return {
    skillId,
    label: stringField(value.label) || skillId,
    misconception: stringField(value.misconception),
    page: positiveInteger(value.page),
    ts: Number(value.ts) || 0,
  };
}

// ── Active document id ───────────────────────────────────────
//
// The composer-footer note needs the current document id, but the thread only
// receives page data. The chat adapter (which does hold the pack) publishes it
// here when it is created and on every request.

let activeQuizDocumentId = "unknown";

export function setActiveQuizDocumentId(documentId: string) {
  activeQuizDocumentId = documentId || "unknown";
}

export function getActiveQuizDocumentId() {
  return activeQuizDocumentId;
}

// Assistant message ids whose quiz was produced by a run in THIS session and
// has not auto-opened yet. Restored messages are never marked, so reloading a
// saved thread (or remounting the panel) can never pop the overlay.
const liveQuizMessageIds = new Set<string>();

export function markLiveQuizMessage(messageId: string) {
  if (messageId) liveQuizMessageIds.add(messageId);
}

/** True exactly once per live message: the first caller wins the auto-open. */
export function consumeLiveQuizAutoOpen(messageId: string) {
  if (!messageId || !liveQuizMessageIds.has(messageId)) return false;
  liveQuizMessageIds.delete(messageId);
  return true;
}

// ── Small field helpers ──────────────────────────────────────

export function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeOptionId(value: unknown, fallback: string) {
  const id = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]$/.test(id) ? id : "";
}

function clampDifficulty(value: unknown) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 3;
  return Math.max(1, Math.min(5, number));
}

function positiveInteger(value: unknown) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function slug(value: string) {
  return value.trim().replace(/\s+/g, "_").slice(0, 64);
}
