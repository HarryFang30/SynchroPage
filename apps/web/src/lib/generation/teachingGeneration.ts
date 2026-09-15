import type { ModelApiConfig, ModelApiProvider, ModelRef, UiPreferences } from "../../settings";
import type { PdfContextPage, PdfContextPayload } from "../pdf/textExtraction";
import {
  LESSON_PLAN_SEGMENT_CHUNK_PAGES,
  lessonPlanRow,
  lessonPlanSegmentIndex,
  type LessonPlan,
  type LessonPlanDepth,
} from "./lessonPlan";

export type TeachingOutputLanguage = "zh-CN" | "en-US";

/**
 * Why the last generation attempt for a page failed. Derived from the typed
 * transport error (status + backend error code), never from message text.
 * "quality" is the only kind that may escalate to the heavy quality plan.
 */
export type GenerationFailureKind =
  | "timeout"
  | "rate_limit"
  | "network"
  | "invalid_json"
  | "truncated"
  | "server"
  | "quality";

export type GenerationErrorRecord = {
  kind: GenerationFailureKind;
  attempts: number;
  at: number;
};

export type PagePack = {
  schema: string;
  document: {
    id: string;
    title: string;
    source_pdf_url: string;
    page_count: number;
    /** Written once per document by the planning pass; drives depth and segments. */
    lesson_plan?: LessonPlan;
  };
  pages: PageData[];
};

export type PageData = {
  page_no: number;
  source: {
    pdf_page_ref: string;
    text_md: string;
    ocr_used: boolean;
    parser: string;
    page_type?: string;
  };
  teaching: {
    output_language?: TeachingOutputLanguage;
    slide_title: string;
    speaker_notes_md: string;
    /** One or two sentences on what the student holds after this page; the next page's request receives it. */
    handoff?: string;
    concepts: string[];
    visual_explanations: string[];
    prerequisites: string[];
    contextual_bridge?: string;
    formula_explanations?: string[];
    stuck_points?: string[];
    exam_angles?: string[];
    evidence?: Array<{
      kind: string;
      quote_or_reference: string;
    }>;
    needs_review?: boolean;
    needs_parser_fallback?: boolean;
    generation_error?: GenerationErrorRecord;
    confidence: number;
  };
  status: string;
};

export type AsyncLimiterPriority = "now" | "next" | "later";

export type TeachingGenerationAttempt = "initial" | "retry";

export type TeachingGenerationQualityPlan = {
  providerId: string;
  model: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  reasoningEffort: UiPreferences["modelReasoningEffort"];
  attachPdf: boolean;
  batchable: boolean;
  retryOnWeakOutput: boolean;
  attempt: TeachingGenerationAttempt;
  reasons: string[];
  /** Model-derived upper bound on pages per /api/generate/pages request. */
  maxBatchSize: number;
};

export type TeachingGenerationBatch = {
  pages: PageData[];
  plan: TeachingGenerationQualityPlan;
  /** Lesson-plan segment these pages belong to; batches of one segment run in order. */
  segmentId?: number;
};

export type GeneratedTeachingPageResponse = {
  page: Partial<PageData> & {
    source?: Partial<PageData["source"]>;
    teaching?: Partial<PageData["teaching"]>;
  };
  model?: string;
};

export type GeneratedTeachingPagesResponse = {
  pages: GeneratedTeachingPageResponse["page"][];
  model?: string;
};

export const TEACHING_GENERATION_CONCURRENCY = 6;
export const TEACHING_DOCUMENT_GENERATION_CONCURRENCY = 3;
const TEACHING_QUALITY_MODEL = "gpt-5.5";
const TEACHING_BALANCED_MODEL = "gpt-5.4";
const TEACHING_FAST_MODEL = "gpt-5.4-mini";
const TEACHING_TEXT_PAGE_BATCH_SIZE = 12;
const TEACHING_BALANCED_PAGE_BATCH_SIZE = 2;
const TEACHING_BALANCED_TEXT_PAGE_BATCH_SIZE = 4;
export const TEACHING_BATCH_FALLBACK_CONCURRENCY = 2;
export const TEACHING_PROJECT_MODEL_REQUEST_CONCURRENCY = 6;
export const TEACHING_PROJECT_WARMUP_PAGE_COUNT = 16;
const TEACHING_CONTEXT_PAGE_CHARS = 600;
const TEACHING_BALANCED_SOURCE_REQUEST_CHARS = 8_000;
const TEACHING_QUALITY_SOURCE_REQUEST_CHARS = 16_000;
const TEACHING_FILE_INPUT_MIN_TEXT_CHARS = 32;
const TEACHING_TEXT_HEAVY_MIN_CHARS = 260;
const TEACHING_COMPLEX_TEXT_FAST_MIN_CHARS = 900;
const TEACHING_COMPLEX_TEXT_BALANCED_SIGNAL_COUNT = 4;
const TEACHING_VISUAL_TEXT_MAX_CHARS = 520;
const TEACHING_LOW_QUALITY_CONFIDENCE = 0.58;
const TEACHING_LOW_QUALITY_NOTE_CHARS = 180;
const TEACHING_RETRY_CONFIDENCE = 0.42;
const TEACHING_RETRY_NOTE_CHARS = 90;
/** A brief page is one short paragraph; anything under this is a failed answer, not a short one. */
const TEACHING_BRIEF_RETRY_NOTE_CHARS = 30;
const TEACHING_BRIEF_LOW_QUALITY_NOTE_CHARS = 60;
export const PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY = 8;
const TEACHING_TEXT_COMPACT_PAGE_MAX_CHARS = 1_500;
const TEACHING_TEXT_COMPACT_AVG_CHARS = 1_000;
const TEACHING_CONTEXT_NEIGHBOR_PAGES = 2;
const TEACHING_CONTEXT_EDGE_PAGES = 2;

const teachingReasoningRank: Record<UiPreferences["modelReasoningEffort"], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

const teachingReasoningOrder: UiPreferences["modelReasoningEffort"][] = ["none", "low", "medium", "high", "xhigh", "max"];

/** Text length under which even a reasoning model gets the cheapest effort. */
const TEACHING_TINY_PAGE_TEXT_CHARS = 300;

export type TeachingModelFamily = "gpt-6" | "gpt-5" | "mini" | "gemini" | "grok" | "other";

export type TeachingModelCapabilities = {
  family: TeachingModelFamily;
  minEffort: UiPreferences["modelReasoningEffort"];
  maxEffort: UiPreferences["modelReasoningEffort"];
  /** The model is cheap enough for the compact fast-text prompt. */
  fastPath: boolean;
  recommendedBatchSize: number;
  /** The model reasons before answering, so runs start with a small window. */
  reasoning: boolean;
};

/**
 * Model family from the model id alone. Deliberately prefix/segment based so
 * new gateway models (gpt-6-astra, gpt-5.6-sol, …) are classified without a
 * hard-coded allow list. "gemini" must not be read as a "mini" model.
 */
export function modelFamily(model: string): TeachingModelFamily {
  const name = String(model || "").trim().toLowerCase();
  if (!name) return "other";
  if (name.includes("gemini")) return "gemini";
  if (name.includes("grok")) return "grok";
  if (/(?:^|[-_/.\s])mini(?:$|[-_/.\s])/.test(name)) return "mini";
  if (name.startsWith("gpt-6")) return "gpt-6";
  if (/^gpt-5(?:[.\-]|$)/.test(name)) return "gpt-5";
  return "other";
}

const teachingModelFamilyDefaults: Record<TeachingModelFamily, Omit<TeachingModelCapabilities, "family">> = {
  "gpt-6": { minEffort: "low", maxEffort: "max", fastPath: false, recommendedBatchSize: 4, reasoning: true },
  "gpt-5": { minEffort: "none", maxEffort: "max", fastPath: false, recommendedBatchSize: 4, reasoning: true },
  mini: { minEffort: "none", maxEffort: "high", fastPath: true, recommendedBatchSize: TEACHING_TEXT_PAGE_BATCH_SIZE, reasoning: false },
  gemini: { minEffort: "low", maxEffort: "high", fastPath: false, recommendedBatchSize: 4, reasoning: false },
  grok: { minEffort: "low", maxEffort: "high", fastPath: false, recommendedBatchSize: 4, reasoning: false },
  other: { minEffort: "none", maxEffort: "high", fastPath: false, recommendedBatchSize: 2, reasoning: false },
};

function normalizeReasoningEffortValue(value: unknown): UiPreferences["modelReasoningEffort"] | undefined {
  return typeof value === "string" && teachingReasoningOrder.includes(value as UiPreferences["modelReasoningEffort"])
    ? (value as UiPreferences["modelReasoningEffort"])
    : undefined;
}

function apiFeatureOverrides(provider: ModelApiProvider | undefined, model: string): Record<string, unknown> {
  const features = provider?.apiFeatures;
  if (!features || typeof features !== "object") return {};
  const perModelSource = (features as { models?: unknown }).models;
  const perModel =
    perModelSource && typeof perModelSource === "object" && !Array.isArray(perModelSource)
      ? (perModelSource as Record<string, unknown>)[model]
      : undefined;
  const perModelRecord = perModel && typeof perModel === "object" && !Array.isArray(perModel)
    ? (perModel as Record<string, unknown>)
    : {};
  return { ...(features as Record<string, unknown>), ...perModelRecord };
}

/**
 * Effort range / batch size / fast-path for a model, honouring
 * provider.apiFeatures (minEffort, maxEffort, recommendedBatchSize, fastPath)
 * and falling back to family defaults.
 */
export function teachingModelCapabilities(
  provider: ModelApiProvider | undefined,
  model: string,
): TeachingModelCapabilities {
  const family = modelFamily(model);
  const defaults = teachingModelFamilyDefaults[family];
  const overrides = apiFeatureOverrides(provider, model);
  const minEffort = normalizeReasoningEffortValue(overrides.minEffort) || defaults.minEffort;
  const maxEffortCandidate = normalizeReasoningEffortValue(overrides.maxEffort) || defaults.maxEffort;
  const maxEffort = teachingReasoningRank[maxEffortCandidate] < teachingReasoningRank[minEffort] ? minEffort : maxEffortCandidate;
  const batchSize = Math.floor(Number(overrides.recommendedBatchSize));
  return {
    family,
    minEffort,
    maxEffort,
    fastPath: typeof overrides.fastPath === "boolean" ? overrides.fastPath : defaults.fastPath,
    recommendedBatchSize: Number.isFinite(batchSize) && batchSize >= 1 ? Math.min(batchSize, 24) : defaults.recommendedBatchSize,
    reasoning: typeof overrides.reasoning === "boolean" ? overrides.reasoning : defaults.reasoning,
  };
}

export function clampTeachingReasoningEffort(
  effort: UiPreferences["modelReasoningEffort"],
  capabilities: TeachingModelCapabilities,
): UiPreferences["modelReasoningEffort"] {
  const rank = teachingReasoningRank[effort] ?? teachingReasoningRank.low;
  if (rank < teachingReasoningRank[capabilities.minEffort]) return capabilities.minEffort;
  if (rank > teachingReasoningRank[capabilities.maxEffort]) return capabilities.maxEffort;
  return effort;
}

export function lowerTeachingReasoningEffort(
  effort: UiPreferences["modelReasoningEffort"],
  capabilities?: TeachingModelCapabilities,
): UiPreferences["modelReasoningEffort"] {
  const index = Math.max(0, teachingReasoningOrder.indexOf(effort));
  const lowered = teachingReasoningOrder[Math.max(0, index - 1)];
  return capabilities ? clampTeachingReasoningEffort(lowered, capabilities) : lowered;
}

export function teachingProviderForPlan(
  config: ModelApiConfig | undefined,
  providerId: string,
): ModelApiProvider | undefined {
  return config?.providers.find((provider) => provider.id === providerId);
}

/** gpt-6 style models: content pages get a medium floor, tiny pages stay low. */
function teachingModelEffortFloor(
  capabilities: TeachingModelCapabilities,
  sourceTextLength: number,
): UiPreferences["modelReasoningEffort"] | undefined {
  if (capabilities.family !== "gpt-6") return undefined;
  return sourceTextLength < TEACHING_TINY_PAGE_TEXT_CHARS ? "low" : "medium";
}

export function normalizeTeachingOutputLanguage(value: unknown): TeachingOutputLanguage | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

export function resolveTeachingOutputLanguage(
  preferences: Pick<UiPreferences, "explanationLanguage" | "language">,
): TeachingOutputLanguage {
  return preferences.explanationLanguage === "zh-CN" || preferences.explanationLanguage === "en-US"
    ? preferences.explanationLanguage
    : preferences.language;
}

export function teachingOutputLanguageName(language: TeachingOutputLanguage) {
  return language === "en-US" ? "English" : "Simplified Chinese";
}

export function generationFailureMarkdown(message: string, language: TeachingOutputLanguage) {
  if (language === "en-US") {
    return `## Page notes generation failed\n\n${message}`;
  }
  return `## 本页讲解生成失败\n\n${message}`;
}

export function teachingGenerationReasoningEffort(
  preference: UiPreferences["modelReasoningEffort"],
  requested: UiPreferences["modelReasoningEffort"] = "low",
): UiPreferences["modelReasoningEffort"] {
  if (requested === "low") return preference === "none" ? "none" : "low";
  if (preference === "max") return "max";
  if (preference === "xhigh") return "xhigh";
  if (preference === "high") return "high";
  return requested;
}

export function teachingGenerationQualityPlan(
  page: PageData,
  preference: UiPreferences["modelReasoningEffort"],
  attempt: TeachingGenerationAttempt = "initial",
  modelApiConfig?: ModelApiConfig,
): TeachingGenerationQualityPlan {
  const text = pageTextForSignals(page);
  const sourceText = page.source.text_md.trim();
  const reasons: string[] = [];
  const formulaLike = pageHasFormulaSignals(text);
  const tableLike = pageHasTableSignals(text);
  const codeLike = pageHasCodeSignals(text);
  const visualLike = pageHasVisualSignals(page, text);
  const complexitySignalCount = pageComplexitySignalCount(text);
  const sparseText = sourceText.length < TEACHING_FILE_INPUT_MIN_TEXT_CHARS;
  const shortText = sourceText.length < TEACHING_TEXT_HEAVY_MIN_CHARS;
  const complexTextLike = formulaLike || tableLike || codeLike;
  const denseComplexText =
    complexTextLike &&
    (sourceText.length < TEACHING_COMPLEX_TEXT_FAST_MIN_CHARS ||
      complexitySignalCount >= TEACHING_COMPLEX_TEXT_BALANCED_SIGNAL_COUNT);
  const textGroundedFormulaPage =
    formulaLike &&
    !tableLike &&
    !codeLike &&
    !visualLike &&
    sourceText.length >= TEACHING_FILE_INPUT_MIN_TEXT_CHARS;
  // Only model-reported quality problems may escalate. A page that failed for
  // transport reasons (timeout / 429 / network) carries teaching.generation_error
  // instead and must be retried with the same — not a heavier — plan.
  const previousWeak =
    Boolean(page.teaching.needs_review) ||
    Boolean(page.teaching.needs_parser_fallback);

  let requestedReasoning: UiPreferences["modelReasoningEffort"] =
    sourceText.length <= TEACHING_TEXT_COMPACT_PAGE_MAX_CHARS ? "none" : "low";
  let attachPdf = false;
  let batchable = true;
  let retryOnWeakOutput = true;

  if (sparseText) {
    reasons.push("sparse-source-text");
    requestedReasoning = "high";
    attachPdf = true;
    batchable = false;
    retryOnWeakOutput = true;
  } else if (shortText) {
    reasons.push("short-source-text");
    if (visualLike || complexTextLike) {
      requestedReasoning = "medium";
    } else {
      reasons.push("short-text-fast-path");
    }
    batchable = true;
    retryOnWeakOutput = visualLike || complexTextLike;
  }

  if (complexTextLike) {
    if (formulaLike) reasons.push("formula");
    if (tableLike) reasons.push("table");
    if (codeLike) reasons.push("code");
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, "medium");
    retryOnWeakOutput = true;
    if (!denseComplexText) reasons.push("light-complex-text-balanced-path");
  }

  if (textGroundedFormulaPage) {
    reasons.push("formula-text-balanced-no-pdf-retry");
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, "medium");
    attachPdf = false;
    batchable = true;
    retryOnWeakOutput = false;
  }

  if (visualLike && sourceText.length <= TEACHING_VISUAL_TEXT_MAX_CHARS) {
    reasons.push("visual-heavy");
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, "medium");
    attachPdf = true;
    batchable = false;
    retryOnWeakOutput = true;
  }

  if (previousWeak) {
    reasons.push("previous-weak-output");
    requestedReasoning = "high";
    attachPdf = true;
    batchable = false;
    retryOnWeakOutput = true;
  }

  if (attempt === "retry") {
    reasons.push("quality-retry");
    requestedReasoning = "high";
    attachPdf = true;
    batchable = false;
    retryOnWeakOutput = false;
  }

  if (attachPdf) batchable = false;

  if (!reasons.length) reasons.push("text-fast-path");
  const modelDefaults = teachingModelDefaults(modelApiConfig);
  const selectedRef =
    attachPdf || requestedReasoning === "high"
      ? modelDefaults.quality
      : requestedReasoning === "medium"
        ? modelDefaults.balanced
        : modelDefaults.fast;
  const fallbackRef = modelDefaults.quality;
  const capabilities = teachingModelCapabilities(
    teachingProviderForPlan(modelApiConfig, selectedRef.providerId),
    selectedRef.model,
  );
  const effortFloor = teachingModelEffortFloor(capabilities, sourceText.length);
  if (effortFloor) {
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, effortFloor);
    reasons.push(`model-effort-floor-${effortFloor}`);
  }
  const reasoningEffort = clampTeachingReasoningEffort(
    teachingGenerationReasoningEffort(preference, requestedReasoning),
    capabilities,
  );
  return {
    providerId: selectedRef.providerId,
    model: selectedRef.model,
    fallbackProviderId:
      selectedRef.providerId === fallbackRef.providerId && selectedRef.model === fallbackRef.model
        ? undefined
        : fallbackRef.providerId,
    fallbackModel: selectedRef.providerId === fallbackRef.providerId && selectedRef.model === fallbackRef.model
      ? undefined
      : fallbackRef.model,
    reasoningEffort,
    attachPdf,
    batchable,
    retryOnWeakOutput,
    attempt,
    reasons,
    maxBatchSize: capabilities.recommendedBatchSize,
  };
}

export type PlanForRetryContext = {
  page: PageData;
  preference: UiPreferences["modelReasoningEffort"];
  modelApiConfig?: ModelApiConfig;
};

/**
 * Next plan after a failed attempt, keyed on WHY it failed.
 * - timeout / network / server: same effort, no PDF; a second such failure steps
 *   the effort down once (a slow upstream is not a quality problem).
 * - rate_limit: identical plan — the shared limiter gate provides the wait.
 * - invalid_json / truncated: same plan once, then one step lower.
 * - quality: the only kind that escalates to the heavy "retry" plan (high + PDF).
 */
export function planForRetry(
  kind: GenerationFailureKind,
  previousPlan: TeachingGenerationQualityPlan,
  attempt: number,
  context: PlanForRetryContext,
): TeachingGenerationQualityPlan {
  if (kind === "quality") {
    return teachingGenerationQualityPlan(context.page, context.preference, "retry", context.modelApiConfig);
  }
  if (kind === "rate_limit") return previousPlan;

  const capabilities = teachingModelCapabilities(
    teachingProviderForPlan(context.modelApiConfig, previousPlan.providerId),
    previousPlan.model,
  );
  // A truncated body is deterministic for the same budget: step down at once.
  const stepDown = kind === "truncated" || attempt >= 2;
  const reasoningEffort = stepDown
    ? lowerTeachingReasoningEffort(previousPlan.reasoningEffort, capabilities)
    : clampTeachingReasoningEffort(previousPlan.reasoningEffort, capabilities);
  // Transport failures must not grow the request; a truncated/invalid body keeps
  // whatever grounding the previous attempt had.
  const attachPdf = kind === "invalid_json" || kind === "truncated" ? previousPlan.attachPdf : false;
  const reasons = [
    ...previousPlan.reasons.filter((reason) => !reason.startsWith("retry-kind:")),
    `retry-kind:${kind}`,
    ...(stepDown ? ["retry-effort-step-down"] : []),
  ];
  return {
    ...previousPlan,
    attempt: "initial",
    reasoningEffort,
    attachPdf,
    batchable: false,
    retryOnWeakOutput: false,
    reasons,
  };
}

export function teachingQualityPlanPayload(plan: TeachingGenerationQualityPlan) {
  return {
    attempt: plan.attempt,
    providerId: plan.providerId,
    model: plan.model,
    fallbackProviderId: plan.fallbackProviderId,
    fallbackModel: plan.fallbackModel,
    reasoningEffort: plan.reasoningEffort,
    attachPdf: plan.attachPdf,
    batchable: plan.batchable,
    reasons: plan.reasons,
  };
}

function teachingModelDefaults(config?: ModelApiConfig): { fast: ModelRef; balanced: ModelRef; quality: ModelRef } {
  if (!config) {
    return {
      fast: { providerId: "codex_oauth", model: TEACHING_FAST_MODEL },
      balanced: { providerId: "codex_oauth", model: TEACHING_BALANCED_MODEL },
      quality: { providerId: "codex_oauth", model: TEACHING_QUALITY_MODEL },
    };
  }
  return {
    fast: config.defaults.teachingFast,
    balanced: config.defaults.teachingBalanced,
    quality: config.defaults.teachingQuality,
  };
}

export function teachingRequestPage(page: PageData, plan: TeachingGenerationQualityPlan) {
  const sourceTextLimit = teachingSourceRequestLimitForPlan(plan);
  const source = {
    pdf_page_ref: page.source.pdf_page_ref,
    text_md: truncateGenerationRequestText(page.source.text_md, sourceTextLimit),
  };
  return {
    page_no: page.page_no,
    source: {
      ...source,
      ocr_used: page.source.ocr_used,
      parser: page.source.parser,
      page_type: page.source.page_type,
    },
    teaching: {
      output_language: page.teaching.output_language,
      slide_title: page.teaching.slide_title,
      speaker_notes_md: truncateGenerationRequestText(page.teaching.speaker_notes_md, 1200),
      confidence: page.teaching.confidence,
      needs_review: page.teaching.needs_review,
      needs_parser_fallback: page.teaching.needs_parser_fallback,
    },
    status: page.status,
  };
}

export function prioritizeTeachingPages(pages: PageData[], priorityPageNo: number) {
  const safePriority = Number.isFinite(priorityPageNo) ? priorityPageNo : pages[0]?.page_no || 1;
  return pages.slice().sort((left, right) => {
    const distance = Math.abs(left.page_no - safePriority) - Math.abs(right.page_no - safePriority);
    return distance || left.page_no - right.page_no;
  });
}

export function prioritizeTeachingPageNumbers(pageNumbers: number[], priorityPageNo: number) {
  const safePriority = Number.isFinite(priorityPageNo) ? priorityPageNo : pageNumbers[0] || 1;
  return [...new Set(pageNumbers)]
    .filter((pageNo) => Number.isFinite(pageNo) && pageNo >= 1)
    .sort((left, right) => {
      const distance = Math.abs(left - safePriority) - Math.abs(right - safePriority);
      return distance || left - right;
    });
}

export function teachingWarmupPageNumbers(pageCountHint: number, priorityPageNo: number, targetPageNumbers: number[] = []) {
  if (targetPageNumbers.length) {
    return prioritizeTeachingPageNumbers(targetPageNumbers, priorityPageNo).slice(0, TEACHING_PROJECT_WARMUP_PAGE_COUNT);
  }
  const pageNumbers: number[] = [];
  const addPage = (pageNo: number) => {
    if (Number.isFinite(pageNo) && pageNo >= 1) pageNumbers.push(Math.floor(pageNo));
  };
  addPage(priorityPageNo);
  for (let offset = 1; offset < TEACHING_PROJECT_WARMUP_PAGE_COUNT; offset += 1) {
    addPage(priorityPageNo + offset);
    addPage(priorityPageNo - offset);
  }
  const fallbackTotal = Math.max(pageCountHint || 0, TEACHING_PROJECT_WARMUP_PAGE_COUNT);
  for (let pageNo = 1; pageNo <= fallbackTotal && pageNumbers.length < TEACHING_PROJECT_WARMUP_PAGE_COUNT * 2; pageNo += 1) {
    addPage(pageNo);
  }
  return prioritizeTeachingPageNumbers(pageNumbers, priorityPageNo).slice(0, TEACHING_PROJECT_WARMUP_PAGE_COUNT);
}

export function teachingModelRequestPriority(
  pages: PageData[],
  priorityPageNo: number,
  priority: AsyncLimiterPriority,
  fallback: AsyncLimiterPriority,
) {
  return pages.some((page) => page.page_no === priorityPageNo) ? priority : fallback;
}

/**
 * Structural pages (title, agenda, blank, summary) legitimately produce short
 * notes; they must never trigger the heavy weak-output retry.
 */
export function isLowContentTeachingPageType(page: PageData) {
  const pageType = String(page.source.page_type || "").trim().toLowerCase();
  return pageType === "title" || pageType === "agenda" || pageType === "blank" || pageType === "summary";
}

/**
 * How short the notes may legitimately be. The lesson plan's depth wins; a page
 * without a plan row falls back to its page_type (structural pages are short).
 */
function teachingNoteFloors(page: PageData, depth?: LessonPlanDepth) {
  if (depth === "skim" || (!depth && isLowContentTeachingPageType(page))) return { retry: 0, weak: 0 };
  if (depth === "brief") return { retry: TEACHING_BRIEF_RETRY_NOTE_CHARS, weak: TEACHING_BRIEF_LOW_QUALITY_NOTE_CHARS };
  return { retry: TEACHING_RETRY_NOTE_CHARS, weak: TEACHING_LOW_QUALITY_NOTE_CHARS };
}

export function generatedTeachingNeedsRetry(page: PageData, depth?: LessonPlanDepth) {
  const notes = page.teaching.speaker_notes_md.trim();
  const floors = teachingNoteFloors(page, depth);
  if (floors.retry === 0) {
    return page.status === "failed" || (Boolean(page.teaching.needs_parser_fallback) && !notes.length);
  }
  return (
    page.status === "failed" ||
    Boolean(page.teaching.needs_parser_fallback) ||
    (Boolean(page.teaching.needs_review) && page.teaching.confidence < TEACHING_LOW_QUALITY_CONFIDENCE) ||
    page.teaching.confidence < TEACHING_RETRY_CONFIDENCE ||
    notes.length < floors.retry
  );
}

export function shouldPreferTeachingCandidate(candidate: PageData, current: PageData, depth?: LessonPlanDepth) {
  if (generatedTeachingLooksWeak(current, depth) && !generatedTeachingLooksWeak(candidate, depth)) return true;
  return teachingPageQualityScore(candidate) >= teachingPageQualityScore(current) + 25;
}

export function clampPreferenceNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

export function teachingExtractionPageNumbers(pageCount: number, targetPageNumbers: number[]) {
  return [...new Set([...targetPageNumbers, ...teachingContextPageNumbers(pageCount)])]
    .filter((pageNo) => Number.isFinite(pageNo) && pageNo >= 1 && pageNo <= pageCount)
    .sort((left, right) => left - right);
}

export function fullPdfContextForTeachingGeneration(
  pack: PagePack,
  pageCount: number,
  extractedPages: PdfContextPage[],
  targetPageNumbers: number[] = [],
): PdfContextPayload {
  const extractedTextByPage = new Map(extractedPages.map((page) => [page.page_no, page.text_md]));
  const packPagesByNumber = new Map(pack.pages.map((page) => [page.page_no, page]));

  const sortedPageNumbers = teachingContextPageNumbers(pageCount, targetPageNumbers);
  const pages = sortedPageNumbers.map((pageNo) => {
    const packPage = packPagesByNumber.get(pageNo);
    return {
      page_no: pageNo,
      title: packPage?.teaching.slide_title || `PDF p.${pageNo}`,
      text_md: compactTeachingContextText(extractedTextByPage.get(pageNo) || packPage?.source.text_md || ""),
    };
  });
  const truncated = pages.length < pageCount;
  return {
    documentId: pack.document.id,
    documentTitle: pack.document.title,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "target-neighbor-edge" : "all-pages",
    fullPageLimit: pages.length,
    edgePageCount: TEACHING_CONTEXT_EDGE_PAGES,
    includedPageNumbers: sortedPageNumbers,
    pages,
  };
}

export type TeachingBatchOptions = {
  /** When set, batches follow the plan's segments and never cross one. */
  lessonPlan?: LessonPlan;
  /** The reader's page: its segment is taught first, then outward. */
  currentPageNo?: number;
};

/**
 * Group pages into requests. With a lesson plan every batch is a run of
 * consecutive pages of ONE segment (so the model can teach them as one
 * stretch), ordered so the reader's segment comes first; without a plan the
 * legacy grouping by shared quality plan applies.
 */
export function batchTeachingPages(
  pages: PageData[],
  preference: UiPreferences["modelReasoningEffort"],
  modelApiConfig?: ModelApiConfig,
  options: TeachingBatchOptions = {},
) {
  const lessonPlan = options.lessonPlan;
  const ordered = lessonPlan ? orderPagesForLessonPlan(pages, lessonPlan, options.currentPageNo) : pages;
  const batches: TeachingGenerationBatch[] = [];
  let currentBatch: PageData[] = [];
  let currentPlan: TeachingGenerationQualityPlan | null = null;
  let currentSegment: number | undefined;

  const flushCurrentBatch = () => {
    if (!currentBatch.length) return;
    const plan = currentPlan || teachingGenerationQualityPlan(currentBatch[0], preference, "initial", modelApiConfig);
    batches.push({ pages: currentBatch, plan, segmentId: currentSegment });
    currentBatch = [];
    currentPlan = null;
  };

  for (const page of ordered) {
    const plan = teachingGenerationQualityPlan(page, preference, "initial", modelApiConfig);
    const segmentId = lessonPlan ? lessonPlanRow(lessonPlan, page.page_no)?.segment : undefined;
    if (!plan.batchable) {
      flushCurrentBatch();
      batches.push({ pages: [page], plan, segmentId });
      continue;
    }
    const previous = currentBatch[currentBatch.length - 1];
    const breaksBatch =
      Boolean(currentPlan) &&
      (!teachingPlansCanShareBatch(currentPlan as TeachingGenerationQualityPlan, plan) ||
        currentSegment !== segmentId ||
        (Boolean(lessonPlan) && Boolean(previous) && page.page_no !== previous.page_no + 1) ||
        currentBatch.length >= teachingBatchSizeForPlan(currentPlan as TeachingGenerationQualityPlan, currentBatch, Boolean(lessonPlan)));
    if (breaksBatch) flushCurrentBatch();
    currentPlan ??= plan;
    currentSegment = segmentId;
    currentBatch.push(page);
  }

  flushCurrentBatch();
  return batches;
}

/**
 * Batches that belong to one segment run one after another so each carries the
 * previous page's handoff; different segments run concurrently.
 */
export function groupTeachingBatchesBySegment(batches: TeachingGenerationBatch[]): TeachingGenerationBatch[][] {
  const groups: TeachingGenerationBatch[][] = [];
  for (const batch of batches) {
    const last = groups[groups.length - 1];
    if (batch.segmentId !== undefined && last && last[0].segmentId === batch.segmentId) {
      last.push(batch);
    } else {
      groups.push([batch]);
    }
  }
  return groups;
}

function orderPagesForLessonPlan(pages: PageData[], plan: LessonPlan, currentPageNo?: number) {
  const currentIndex = lessonPlanSegmentIndex(plan, currentPageNo ?? pages[0]?.page_no ?? 1);
  return pages.slice().sort((left, right) => {
    const leftIndex = lessonPlanSegmentIndex(plan, left.page_no);
    const rightIndex = lessonPlanSegmentIndex(plan, right.page_no);
    const leftOffset = leftIndex - currentIndex;
    const rightOffset = rightIndex - currentIndex;
    const distance = Math.abs(leftOffset) - Math.abs(rightOffset);
    if (distance) return distance;
    // Same distance: the segment ahead of the reader before the one behind.
    const direction = Number(leftOffset < 0) - Number(rightOffset < 0);
    return direction || left.page_no - right.page_no;
  });
}

function maxTeachingReasoningEffort(
  left: UiPreferences["modelReasoningEffort"],
  right: UiPreferences["modelReasoningEffort"],
): UiPreferences["modelReasoningEffort"] {
  return teachingReasoningRank[right] > teachingReasoningRank[left] ? right : left;
}

function pageTextForSignals(page: PageData) {
  return `${page.source.text_md || ""}\n${page.teaching.slide_title || ""}`.trim();
}

function pageHasFormulaSignals(text: string) {
  return /\\(?:frac|sum|int|begin|end|cdots|rightarrow|operatorname|sqrt|leq|geq|alpha|beta|gamma|delta)|\$\$?[^$]+\$\$?|[∑∫√∞≈≤≥→↔]|(?:^|\s)[A-Za-z][\w]*\s*\([^)]*\)\s*=/m.test(text);
}

function pageHasTableSignals(text: string) {
  return /\|.+\|/.test(text) || /\b(?:truth table|state table|table|row|column|matrix)\b/i.test(text) || /(?:真值表|状态表|表格|矩阵)/.test(text);
}

function pageHasCodeSignals(text: string) {
  return /\b(?:module|endmodule|always|assign|wire|reg|logic|input|output|verilog|hdl|xor|nand|flip-flop)\b/i.test(text);
}

function countRegexMatches(text: string, pattern: RegExp) {
  return Array.from(text.matchAll(pattern)).length;
}

function pageComplexitySignalCount(text: string) {
  return (
    countRegexMatches(text, /\\(?:frac|sum|int|begin|end|cdots|rightarrow|operatorname|sqrt|leq|geq|alpha|beta|gamma|delta)|[∑∫√∞≈≤≥→↔]/g) +
    countRegexMatches(text, /\$\$?[^$]+\$\$?/g) +
    countRegexMatches(text, /\|.+\|/g) +
    countRegexMatches(text, /\b(?:module|endmodule|always|assign|wire|reg|logic|input|output|verilog|hdl|xor|nand|flip-flop)\b/gi)
  );
}

function pageHasVisualSignals(page: PageData, text: string) {
  const pageType = page.source.page_type || "";
  return (
    /^(figure|table|formula|exercise)$/i.test(pageType) ||
    /\b(?:figure|diagram|chart|plot|graph|waveform|circuit|state diagram|block diagram|timing|layout)\b/i.test(text) ||
    /(?:图|示意|电路图|波形|时序|框图|状态图|流程图)/.test(text)
  );
}

function compactTeachingPages(pages: PageData[]) {
  if (!pages.length) return false;
  const sourceLengths = pages.map((page) => page.source.text_md.trim().length);
  const maxChars = Math.max(...sourceLengths);
  const avgChars = sourceLengths.reduce((sum, length) => sum + length, 0) / sourceLengths.length;
  return maxChars <= TEACHING_TEXT_COMPACT_PAGE_MAX_CHARS && avgChars <= TEACHING_TEXT_COMPACT_AVG_CHARS;
}

function teachingBatchSizeForPlan(plan: TeachingGenerationQualityPlan, pages: PageData[] = [], planned = false) {
  if (plan.attachPdf) return 1;
  // A planned segment is taught in one request so the pages read as one stretch.
  if (planned) return LESSON_PLAN_SEGMENT_CHUNK_PAGES;
  // Without a plan only compact text pages are worth grouping, and never
  // beyond the model's recommended batch size.
  const limit = Math.max(1, plan.maxBatchSize || TEACHING_BALANCED_TEXT_PAGE_BATCH_SIZE);
  return compactTeachingPages(pages) ? limit : Math.min(limit, TEACHING_BALANCED_PAGE_BATCH_SIZE);
}

function teachingSourceRequestLimitForPlan(plan: TeachingGenerationQualityPlan) {
  if (plan.attachPdf || plan.reasoningEffort === "high" || plan.reasoningEffort === "xhigh" || plan.reasoningEffort === "max") {
    return TEACHING_QUALITY_SOURCE_REQUEST_CHARS;
  }
  return TEACHING_BALANCED_SOURCE_REQUEST_CHARS;
}

function truncateGenerationRequestText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 1))}…` : value;
}

function teachingPlansCanShareBatch(left: TeachingGenerationQualityPlan, right: TeachingGenerationQualityPlan) {
  return (
    left.providerId === right.providerId &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.attachPdf === right.attachPdf &&
    left.batchable === right.batchable &&
    left.attempt === right.attempt
  );
}

function generatedTeachingLooksWeak(page: PageData, depth?: LessonPlanDepth) {
  const notes = page.teaching.speaker_notes_md.trim();
  const modelReportedWeak =
    page.status === "failed" ||
    Boolean(page.teaching.needs_review) ||
    Boolean(page.teaching.needs_parser_fallback);
  const floors = teachingNoteFloors(page, depth);
  if (floors.weak === 0) return modelReportedWeak || !notes.length;
  return (
    modelReportedWeak ||
    page.teaching.confidence < TEACHING_LOW_QUALITY_CONFIDENCE ||
    notes.length < floors.weak
  );
}

function teachingPageQualityScore(page: PageData) {
  const notes = page.teaching.speaker_notes_md.trim();
  let score = page.teaching.confidence * 1000 + Math.min(notes.length, 4000) / 10;
  if (page.status === "failed") score -= 1000;
  if (page.teaching.needs_review) score -= 250;
  if (page.teaching.needs_parser_fallback) score -= 350;
  return score;
}

function compactTeachingContextText(text: string) {
  return truncatePromptContext(text, TEACHING_CONTEXT_PAGE_CHARS);
}

function teachingContextPageNumbers(pageCount: number, targetPageNumbers: number[] = []) {
  const includedPageNumbers = new Set<number>();
  const addPage = (pageNo: number) => {
    if (Number.isFinite(pageNo) && pageNo >= 1 && pageNo <= pageCount) includedPageNumbers.add(Math.floor(pageNo));
  };
  for (let pageNo = 1; pageNo <= Math.min(pageCount, TEACHING_CONTEXT_EDGE_PAGES); pageNo += 1) addPage(pageNo);
  for (let pageNo = Math.max(1, pageCount - TEACHING_CONTEXT_EDGE_PAGES + 1); pageNo <= pageCount; pageNo += 1) addPage(pageNo);
  for (const targetPageNo of targetPageNumbers) {
    for (
      let pageNo = targetPageNo - TEACHING_CONTEXT_NEIGHBOR_PAGES;
      pageNo <= targetPageNo + TEACHING_CONTEXT_NEIGHBOR_PAGES;
      pageNo += 1
    ) {
      addPage(pageNo);
    }
  }
  if (!includedPageNumbers.size) {
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) addPage(pageNo);
  }
  return [...includedPageNumbers].sort((left, right) => left - right);
}

function truncatePromptContext(text: string, max = 6000) {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[Truncated to keep the selected prompt concise.]`;
}
