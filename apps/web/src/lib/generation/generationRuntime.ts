import {
  modelFamily,
  normalizeTeachingOutputLanguage,
  type AsyncLimiterPriority,
  type GeneratedTeachingPageResponse,
  type GenerationErrorRecord,
  type GenerationFailureKind,
  type PageData,
  type PagePack,
  type TeachingOutputLanguage,
} from "./teachingGeneration";
import { HttpRequestError } from "../http/requestJson";
import { sourceTextLooksGarbled, TRANSCRIPTION_PARSER } from "../pdf/textQuality";

export type GenerationPageStatus = "done" | "running" | "retrying" | "failed" | "pending";

// ── Typed failure classification ──────────────────────────────
// Everything below keys on HTTP status + backend error code. Never on message
// text: upstream messages are free-form and change without notice.

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 413, 422]);
const RETRYABLE_BACKEND_CODES: Record<string, GenerationFailureKind> = {
  upstream_timeout: "timeout",
  queue_timeout: "rate_limit",
  rate_limited: "rate_limit",
  network_error: "network",
  empty_gateway_response: "invalid_json",
  invalid_generation_json: "invalid_json",
  output_truncated: "truncated",
};
const NON_RETRYABLE_BACKEND_CODES = new Set(["account_not_found", "model_api_key_missing"]);

export type GenerationFailureClassification = {
  kind: GenerationFailureKind;
  retryable: boolean;
  rateLimited: boolean;
  retryAfterMs?: number;
  status?: number;
  code?: string;
};

export function isAbortError(error: unknown) {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError";
}

export function classifyGenerationFailure(error: unknown): GenerationFailureClassification {
  const name = (error as { name?: string } | null)?.name || "";
  if (name === "GenerationStalledError" || name === "TimeoutError") {
    return { kind: "timeout", retryable: true, rateLimited: false };
  }
  if (error instanceof HttpRequestError) {
    const retryAfterMs = typeof error.retryAfterSeconds === "number" ? Math.round(error.retryAfterSeconds * 1000) : undefined;
    const code = error.code || "";
    if (NON_RETRYABLE_BACKEND_CODES.has(code) || code.startsWith("model_provider_")) {
      return { kind: "server", retryable: false, rateLimited: false, status: error.status, code };
    }
    const codeKind = RETRYABLE_BACKEND_CODES[code];
    if (codeKind) {
      return {
        kind: codeKind,
        retryable: true,
        rateLimited: codeKind === "rate_limit",
        retryAfterMs,
        status: error.status,
        code,
      };
    }
    if (error.status === 429) {
      return { kind: "rate_limit", retryable: true, rateLimited: true, retryAfterMs, status: error.status, code };
    }
    if (NON_RETRYABLE_HTTP_STATUSES.has(error.status)) {
      return { kind: "server", retryable: false, rateLimited: false, status: error.status, code };
    }
    if (RETRYABLE_HTTP_STATUSES.has(error.status)) {
      return {
        kind: error.status === 504 || error.status === 408 ? "timeout" : "server",
        retryable: true,
        rateLimited: false,
        retryAfterMs,
        status: error.status,
        code,
      };
    }
    return { kind: "server", retryable: false, rateLimited: false, status: error.status, code };
  }
  // fetch() network failures reject with a TypeError ("Failed to fetch", "Load failed", …).
  if (name === "TypeError") return { kind: "network", retryable: true, rateLimited: false };
  return { kind: "server", retryable: false, rateLimited: false };
}

export function limiterOutcomeForFailure(classification: GenerationFailureClassification): AsyncLimiterOutcome {
  if (classification.rateLimited) return "rate_limited";
  if (classification.kind === "timeout") return "timeout";
  return "error";
}

export function normalizeGeneratedPage(rawPage: GeneratedTeachingPageResponse["page"], fallback: PageData): PageData {
  const rawSource: Partial<PageData["source"]> = rawPage.source ?? {};
  const rawTeaching = (rawPage.teaching || rawPage) as Partial<PageData["teaching"]> & {
    title?: string;
    notes?: string;
  };
  const rawPageNo = Number(rawPage.page_no || fallback.page_no);
  const normalized: PageData = {
    page_no: Number.isFinite(rawPageNo) ? rawPageNo : fallback.page_no,
    source: {
      pdf_page_ref: rawSource.pdf_page_ref || `#page=${rawPage.page_no || fallback.page_no}`,
      text_md: rawSource.text_md || "",
      ocr_used: Boolean(rawSource.ocr_used),
      parser: rawSource.parser || "imported",
      page_type: rawSource.page_type,
    },
    teaching: {
      output_language: normalizeTeachingOutputLanguage(rawTeaching.output_language),
      slide_title: rawTeaching.slide_title || rawTeaching.title || "",
      speaker_notes_md: rawTeaching.speaker_notes_md || rawTeaching.notes || "",
      handoff: typeof rawTeaching.handoff === "string" ? rawTeaching.handoff.replace(/\s+/g, " ").trim() : "",
      concepts: Array.isArray(rawTeaching.concepts) ? rawTeaching.concepts : [],
      visual_explanations: Array.isArray(rawTeaching.visual_explanations)
        ? rawTeaching.visual_explanations
        : [],
      prerequisites: Array.isArray(rawTeaching.prerequisites) ? rawTeaching.prerequisites : [],
      contextual_bridge: rawTeaching.contextual_bridge || "",
      formula_explanations: Array.isArray(rawTeaching.formula_explanations) ? rawTeaching.formula_explanations : [],
      stuck_points: Array.isArray(rawTeaching.stuck_points) ? rawTeaching.stuck_points : [],
      exam_angles: Array.isArray(rawTeaching.exam_angles) ? rawTeaching.exam_angles : [],
      evidence: Array.isArray(rawTeaching.evidence) ? rawTeaching.evidence : [],
      needs_review: Boolean(rawTeaching.needs_review),
      needs_parser_fallback: Boolean(rawTeaching.needs_parser_fallback),
      // Carried when the raw page still records a failure, cleared otherwise so a
      // successful regeneration drops the stale error marker.
      generation_error: normalizeGenerationErrorRecord(rawTeaching.generation_error),
      confidence: Number(rawTeaching.confidence ?? 0.72),
    },
    status: rawPage.status || "ready",
  };
  return {
    ...fallback,
    ...normalized,
    page_no: fallback.page_no,
    source: {
      ...fallback.source,
      ...normalized.source,
      pdf_page_ref: normalized.source.pdf_page_ref || fallback.source.pdf_page_ref || `#page=${fallback.page_no}`,
      text_md: fallback.source.text_md || normalized.source.text_md,
      ocr_used: Boolean(normalized.source.ocr_used || fallback.source.ocr_used),
      // A transcribed page keeps its provenance whatever the model echoed back.
      parser: pageIsTranscribed(fallback) ? TRANSCRIPTION_PARSER : normalized.source.parser || fallback.source.parser || "pdfjs",
      text_garbled: pageIsTranscribed(fallback) ? false : Boolean(fallback.source.text_garbled || rawSource.text_garbled),
      // The model only echoes page_type when asked; a missing value must not
      // erase a classification the page already carries.
      page_type: normalized.source.page_type || fallback.source.page_type,
    },
    teaching: {
      ...fallback.teaching,
      ...normalized.teaching,
      slide_title: normalized.teaching.slide_title || fallback.teaching.slide_title || `PDF p.${fallback.page_no}`,
      speaker_notes_md: normalized.teaching.speaker_notes_md || fallback.teaching.speaker_notes_md,
      handoff: normalized.teaching.handoff || fallback.teaching.handoff || "",
      concepts: normalized.teaching.concepts.length ? normalized.teaching.concepts : fallback.teaching.concepts,
      visual_explanations: normalized.teaching.visual_explanations.length ? normalized.teaching.visual_explanations : fallback.teaching.visual_explanations,
      prerequisites: normalized.teaching.prerequisites.length ? normalized.teaching.prerequisites : fallback.teaching.prerequisites,
      // An explicitly returned empty array is a statement (title/agenda/blank
      // pages have no stuck points); only an absent key falls back.
      stuck_points: Array.isArray(rawTeaching.stuck_points) ? normalized.teaching.stuck_points || [] : fallback.teaching.stuck_points || [],
      exam_angles: Array.isArray(rawTeaching.exam_angles) ? normalized.teaching.exam_angles || [] : fallback.teaching.exam_angles || [],
      confidence: Number.isFinite(normalized.teaching.confidence) ? normalized.teaching.confidence : fallback.teaching.confidence,
    },
    status: normalized.status || "ready",
  };
}

const generationFailureKinds = new Set<GenerationFailureKind>([
  "timeout",
  "rate_limit",
  "network",
  "invalid_json",
  "truncated",
  "server",
  "quality",
]);

export function normalizeGenerationErrorRecord(value: unknown): GenerationErrorRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<GenerationErrorRecord>;
  if (!record.kind || !generationFailureKinds.has(record.kind)) return undefined;
  const attempts = Number(record.attempts);
  const at = Number(record.at);
  return {
    kind: record.kind,
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1,
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now(),
  };
}

export function mergePageIntoPack(pack: PagePack, page: PageData): PagePack {
  const pages = pack.pages.some((item) => item.page_no === page.page_no)
    ? pack.pages.map((item) => (item.page_no === page.page_no ? page : item))
    : [...pack.pages, page];
  return {
    ...pack,
    document: {
      ...pack.document,
      page_count: Math.max(pack.document.page_count || 0, pages.length, page.page_no),
    },
    pages: pages.slice().sort((left, right) => left.page_no - right.page_no),
  };
}

export function pageWithSourceText(page: PageData, sourceText: string): PageData {
  // A transcription replaced an unreadable text layer; the raw extraction
  // (which is what the viewer re-extracts on every load) must not undo it.
  if (pageIsTranscribed(page)) return page;
  const text = sourceText || page.source.text_md;
  return {
    ...page,
    source: {
      ...page.source,
      text_md: text,
      parser: page.source.parser || "pdfjs",
      text_garbled: sourceTextLooksGarbled(text),
    },
  };
}

/** The page's text came from a model reading the page image, not from the PDF's text layer. */
export function pageIsTranscribed(page: Pick<PageData, "source">) {
  return page.source.parser === TRANSCRIPTION_PARSER && Boolean(page.source.text_md.trim());
}

/** Flagged as noise by the extractor check and not yet replaced by a transcription. */
export function pageTextLayerIsUnreadable(page: Pick<PageData, "source">) {
  return Boolean(page.source.text_garbled) && !pageIsTranscribed(page);
}

export function pageWithTranscribedText(page: PageData, text: string): PageData {
  return {
    ...page,
    source: {
      ...page.source,
      text_md: text,
      ocr_used: true,
      parser: TRANSCRIPTION_PARSER,
      text_garbled: false,
    },
  };
}

export function missingSourceTextPageNumbers(pageNumbers: number[], sourceTextByPage: Map<number, string>) {
  return pageNumbers.filter((pageNo) => !(sourceTextByPage.get(pageNo) || "").trim());
}

export function hasCompletedTeaching(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage) {
  if (!page) return false;
  if (page.status === "failed" || page.status === "running" || page.status === "retrying" || !page.teaching.speaker_notes_md.trim()) return false;
  return !outputLanguage || page.teaching.output_language === outputLanguage;
}

export function generationPageStatus(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage): GenerationPageStatus {
  if (!page) return "pending";
  if (page.status === "running") return "running";
  if (page.status === "retrying") return "retrying";
  if (page.status === "failed") return "failed";
  if (!page.teaching.speaker_notes_md.trim()) return "pending";
  if (outputLanguage && page.teaching.output_language !== outputLanguage) return "pending";
  return "done";
}

export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { continueOnError?: boolean; signal?: AbortSignal } = {},
) {
  if (!items.length) return [];
  const concurrency = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let nextIndex = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      // Stop dispatching once the run is aborted; in-flight workers finish on their own.
      if (options.signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        if (!options.continueOnError) throw error;
        errors.push(error);
      }
    }
  }));
  return errors;
}

// ── Adaptive concurrency limiter (AIMD + shared rate-limit gate) ──

export type AsyncLimiterOutcome = "success" | "rate_limited" | "timeout" | "error";

export type AsyncLimiterReport = {
  outcome: AsyncLimiterOutcome;
  latencyMs?: number;
  retryAfterMs?: number;
};

export type AsyncLimiterStats = {
  window: number;
  active: number;
  queued: number;
  gateUntil: number;
};

export type AsyncLimiterOptions = {
  min?: number;
  max?: number;
  initial?: number;
  /** providerId::model key under synchropage.generationWindow.v1 */
  persistKey?: string;
  onWindowChange?: (concurrency: number, direction: "increase" | "decrease") => void;
  onGate?: (gateMs: number) => void;
};

export type AsyncLimiterRunOptions = { priority?: AsyncLimiterPriority; signal?: AbortSignal };

export interface AsyncLimiter {
  <T>(worker: () => Promise<T>, options?: AsyncLimiterRunOptions): Promise<T>;
  report: (report: AsyncLimiterReport) => void;
  stats: () => AsyncLimiterStats;
}

export const GENERATION_WINDOW_STORAGE_KEY = "synchropage.generationWindow.v1";
const GENERATION_WINDOW_MIN = 1;
const GENERATION_WINDOW_RESUME_MAX = 4;
const RATE_LIMIT_GATE_MIN_MS = 10_000;
const RATE_LIMIT_GATE_MAX_MS = 120_000;
const WINDOW_PERSIST_INTERVAL_MS = 2_000;

export function generationWindowStorageKey(providerId: string, model: string) {
  return `${providerId || "default"}::${model || "default"}`;
}

export function loadPersistedGenerationWindow(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(GENERATION_WINDOW_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const value = Math.floor(Number(parsed?.[key]));
    return Number.isFinite(value) && value >= 1 ? value : null;
  } catch {
    return null;
  }
}

export function savePersistedGenerationWindow(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    const stored = window.localStorage.getItem(GENERATION_WINDOW_STORAGE_KEY);
    const parsed = stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
    const next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    next[key] = Math.max(1, Math.floor(value));
    window.localStorage.setItem(GENERATION_WINDOW_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode, quota) — the window simply is not remembered
  }
}

/** gpt-6 / gpt-5.x (non-mini) think before answering: minutes, not seconds. */
export function isReasoningGenerationModel(model: string) {
  const family = modelFamily(model);
  return family === "gpt-6" || family === "gpt-5";
}

/** Reasoning models are slow and rate-limit sensitive: start at 2, others at 4. */
export function initialGenerationWindow(model: string, persisted?: number | null) {
  if (typeof persisted === "number" && Number.isFinite(persisted)) {
    return Math.min(Math.max(Math.floor(persisted), GENERATION_WINDOW_MIN), GENERATION_WINDOW_RESUME_MAX);
  }
  return isReasoningGenerationModel(model) ? 2 : 4;
}

export function createAsyncLimiter(limit: number | AsyncLimiterOptions): AsyncLimiter {
  const config: AsyncLimiterOptions = typeof limit === "number" ? { min: 1, max: limit, initial: limit } : limit;
  const minWindow = Math.max(1, Math.floor(config.min ?? GENERATION_WINDOW_MIN));
  const maxWindow = Math.max(minWindow, Math.floor(config.max ?? 6));
  let windowSize = Math.min(Math.max(config.initial ?? maxWindow, minWindow), maxWindow);
  let gateUntil = 0;
  let gateTimer: number | null = null;
  let lastPersistedWindow = 0;
  let lastPersistedAt = 0;

  const currentConcurrency = () => Math.min(Math.max(Math.floor(windowSize), minWindow), maxWindow);

  const persistWindow = () => {
    if (!config.persistKey) return;
    const value = currentConcurrency();
    const now = Date.now();
    if (value === lastPersistedWindow && now - lastPersistedAt < WINDOW_PERSIST_INTERVAL_MS) return;
    lastPersistedWindow = value;
    lastPersistedAt = now;
    savePersistedGenerationWindow(config.persistKey, value);
  };

  type QueuedTask = {
    priority: AsyncLimiterPriority;
    signal?: AbortSignal;
    start: () => void;
    reject: (error: unknown) => void;
    abortHandler?: () => void;
  };
  const queues: Record<AsyncLimiterPriority, QueuedTask[]> = {
    now: [],
    next: [],
    later: [],
  };
  const priorityOrder: AsyncLimiterPriority[] = ["now", "next", "later"];
  let active = 0;

  const dequeue = () => {
    for (const priority of priorityOrder) {
      const task = queues[priority].shift();
      if (task) return task;
    }
    return undefined;
  };

  const removeQueuedTask = (task: QueuedTask) => {
    const queue = queues[task.priority];
    const index = queue.indexOf(task);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  };

  const cleanupTask = (task: QueuedTask) => {
    if (task.abortHandler) task.signal?.removeEventListener("abort", task.abortHandler);
    task.abortHandler = undefined;
  };

  const queuedCount = () => queues.now.length + queues.next.length + queues.later.length;

  const scheduleGateDrain = (delayMs: number) => {
    if (gateTimer !== null || typeof window === "undefined") return;
    gateTimer = window.setTimeout(() => {
      gateTimer = null;
      drain();
    }, Math.max(10, Math.ceil(delayMs)));
  };

  const drain = () => {
    const now = Date.now();
    if (gateUntil > now) {
      if (queuedCount()) scheduleGateDrain(gateUntil - now);
      return;
    }
    while (active < currentConcurrency()) {
      const task = dequeue();
      if (!task) return;
      cleanupTask(task);
      if (task.signal?.aborted) {
        task.reject(abortError());
        continue;
      }
      active += 1;
      task.start();
    }
  };

  const release = () => {
    active = Math.max(0, active - 1);
    drain();
  };

  const report = (result: AsyncLimiterReport) => {
    const now = Date.now();
    if (result.outcome === "success") {
      // Additive increase: one extra slot per full window of successes.
      const next = Math.min(maxWindow, windowSize + 1 / Math.max(1, windowSize));
      const before = currentConcurrency();
      windowSize = next;
      if (currentConcurrency() > before) config.onWindowChange?.(currentConcurrency(), "increase");
      persistWindow();
      drain();
      return;
    }
    if (result.outcome !== "rate_limited" && result.outcome !== "timeout") return;
    // At most one multiplicative decrease per gate window, so a burst of 429s
    // from the same overload does not collapse the window to 1.
    if (now < gateUntil) return;
    const before = currentConcurrency();
    windowSize = Math.max(minWindow, Math.floor(windowSize * 0.5));
    const gateMs = Math.min(
      RATE_LIMIT_GATE_MAX_MS,
      Math.max(result.retryAfterMs && result.retryAfterMs > 0 ? result.retryAfterMs : 0, RATE_LIMIT_GATE_MIN_MS),
    );
    gateUntil = now + gateMs;
    config.onGate?.(gateMs);
    if (currentConcurrency() < before) config.onWindowChange?.(currentConcurrency(), "decrease");
    persistWindow();
    scheduleGateDrain(gateMs);
  };

  const runLimited = function runLimited<T>(
    worker: () => Promise<T>,
    options: AsyncLimiterRunOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask = {
        priority: options.priority || "next",
        signal: options.signal,
        reject,
        start: () => {
          void worker()
            .then(resolve, reject)
            .finally(release);
        },
      };
      if (task.signal) {
        task.abortHandler = () => {
          if (removeQueuedTask(task)) {
            cleanupTask(task);
            reject(abortError());
          }
        };
        task.signal.addEventListener("abort", task.abortHandler, { once: true });
      }
      queues[task.priority].push(task);
      drain();
    });
  } as AsyncLimiter;

  runLimited.report = report;
  runLimited.stats = () => ({ window: windowSize, active, queued: queuedCount(), gateUntil });
  return runLimited;
}

function abortError(message = "Generation canceled") {
  return new DOMException(message, "AbortError");
}
