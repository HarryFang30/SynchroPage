import type { ModelApiConfig, ModelApiProvider, ModelRef, UiPreferences } from "../../settings";
import type { PdfContextPage, PdfContextPayload } from "../pdf/textExtraction";
import { TRANSCRIPTION_PARSER } from "../pdf/textQuality";
import {
  LESSON_PLAN_SEGMENT_CHUNK_PAGES,
  lessonPlanRow,
  lessonPlanSegmentIndex,
  type LessonPlan,
  type LessonPlanDepth,
  type LessonPlanPage,
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
    /** The extracted text is noise (formulas drawn with an embedded font); set by the extractor check. */
    text_garbled?: boolean;
  };
  teaching: {
    output_language?: TeachingOutputLanguage;
    slide_title: string;
    speaker_notes_md: string;
    /** The one claim the student must take away; the explanation opens with it. */
    point?: string;
    /** One sentence on what the student holds after this page; the next page's request receives it. */
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
  /** Send a rendering of the page for a model that reads images but not PDFs. */
  attachPageImage: boolean;
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
// Depth is a ceiling, not a target: a page whose slide explains itself is
// taught in two sentences whatever its depth. These floors only catch an
// answer that failed (an empty or one-clause reply), never a short one.
const TEACHING_LOW_QUALITY_NOTE_CHARS = 60;
const TEACHING_RETRY_CONFIDENCE = 0.42;
const TEACHING_RETRY_NOTE_CHARS = 30;
const TEACHING_BRIEF_RETRY_NOTE_CHARS = 20;
const TEACHING_BRIEF_LOW_QUALITY_NOTE_CHARS = 30;
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

/**
 * Whether a provider's requests carry the PDF as an input_file. Only the
 * Responses-style adapters (OpenAI Responses, the ChatGPT Codex backend, and
 * gateways flagged pdfInputFile) pass it through; every Chat Completions
 * adapter drops the file and leaves a note in its place.
 */
export function providerSupportsPdfInput(provider: ModelApiProvider | undefined) {
  if (!provider || !provider.enabled) return false;
  const flag = provider.apiFeatures?.pdfInputFile;
  if (typeof flag === "boolean") return flag;
  return provider.type === "openai-responses" || provider.type === "codex-oauth";
}

/** The quality model, which every attachPdf request goes to, can see the PDF page itself. */
export function teachingQualityProviderReadsPdf(config?: ModelApiConfig) {
  const ref = teachingModelDefaults(config).quality;
  return providerSupportsPdfInput(teachingProviderForPlan(config, ref.providerId));
}

/**
 * Models known to accept an image in the message. Mirrors the backend's
 * IMAGE_INPUT_MODEL_PATTERN: DeepSeek flash reads images, v4-pro silently drops
 * them (verified against api.deepseek.com), the OCR model only takes images.
 */
const IMAGE_INPUT_MODEL_PATTERN =
  /deepseek-flash|deepseek-v4-flash|deepseek-ocr|gpt-4o|gpt-4\.1|gpt-5|gpt-6|gemini|claude|qwen[\w.-]*-vl|qwen-vl|glm-4\.?v|-vl-|(?:^|[-_/])vl(?:$|[-_/])|vision|-ocr(?:$|[-_/:])/i;

/** Whether a rendering of the page reaches this model as an image. */
export function providerModelReadsImages(provider: ModelApiProvider | undefined, model: string) {
  if (!provider || !provider.enabled || !model) return false;
  const features = (provider.apiFeatures ?? {}) as Record<string, unknown>;
  const perModel = features.models && typeof features.models === "object" ? (features.models as Record<string, unknown>)[model] : undefined;
  const modelFlag = perModel && typeof perModel === "object" ? (perModel as { imageInput?: unknown }).imageInput : undefined;
  if (typeof modelFlag === "boolean") return modelFlag;
  const visionModels = Array.isArray(features.visionModels) ? (features.visionModels as unknown[]) : [];
  if (visionModels.some((token) => typeof token === "string" && token && model.toLowerCase().includes(token.toLowerCase()))) return true;
  if (typeof features.imageInput === "boolean") return features.imageInput;
  return IMAGE_INPUT_MODEL_PATTERN.test(model);
}

/** The quality model can see a rendering of the page, though not the PDF file. */
export function teachingQualityModelReadsImages(config?: ModelApiConfig) {
  const ref = teachingModelDefaults(config).quality;
  return providerModelReadsImages(teachingProviderForPlan(config, ref.providerId), ref.model);
}

/**
 * Pages of a request whose rendering travels with it. A slide is a picture:
 * the curve, the boxed formula and the table the page is about are not in the
 * extracted text, and explanations written from the text alone talked past
 * them. A model that reads images therefore sees every page worth explaining;
 * when the PDF page itself is attached (and the provider reads PDFs) that
 * already covers it.
 */
export function teachingRequestImagePages(
  pages: PageData[],
  plan: TeachingGenerationQualityPlan,
  config?: ModelApiConfig,
  lessonPlan?: LessonPlan,
): number[] {
  if (plan.attachPageImage) return pages.map((page) => page.page_no);
  const provider = teachingProviderForPlan(config, plan.providerId);
  if (!providerModelReadsImages(provider, plan.model)) return [];
  if (plan.attachPdf && providerSupportsPdfInput(provider)) return [];
  return pages
    .filter((page) => {
      const depth = lessonPlanRow(lessonPlan, page.page_no)?.depth;
      return depth ? depth !== "skim" : !isLowContentTeachingPageType(page);
    })
    .map((page) => page.page_no);
}

export type UnreadablePageInput = "pdf" | "image";

export type UnreadableTextRoute =
  | { mode: "attach"; input: UnreadablePageInput }
  | { mode: "ocr"; ref: ModelRef }
  | { mode: "transcribe"; ref: ModelRef; input: UnreadablePageInput }
  | { mode: "none" };

function modelRefInput(config: ModelApiConfig | undefined, ref: ModelRef): UnreadablePageInput | undefined {
  const provider = teachingProviderForPlan(config, ref.providerId);
  if (providerModelReadsImages(provider, ref.model)) return "image";
  if (providerSupportsPdfInput(provider)) return "pdf";
  return undefined;
}

/**
 * How a page whose text layer is noise reaches a model that can see it, in
 * order of preference:
 * 1. the quality model sees the page itself, as the PDF page or as an image,
 *    in the teaching and planning requests;
 * 2. a dedicated OCR model (defaults.ocr, e.g. DeepSeek-OCR) reads the page
 *    image once and its Markdown replaces the noise;
 * 3. a general model transcribes the page once (defaults.transcription, else
 *    the first enabled model that reads images, else one that reads PDFs);
 * 4. nothing can see the page and the prompt says so.
 */
export function unreadableTextRoute(config?: ModelApiConfig): UnreadableTextRoute {
  if (teachingQualityProviderReadsPdf(config)) return { mode: "attach", input: "pdf" };
  if (teachingQualityModelReadsImages(config)) return { mode: "attach", input: "image" };
  const ocr = config?.defaults.ocr;
  if (ocr && teachingProviderForPlan(config, ocr.providerId)?.enabled) return { mode: "ocr", ref: ocr };
  const configured = config?.defaults.transcription;
  const configuredInput = configured ? modelRefInput(config, configured) : undefined;
  if (configured && configuredInput) return { mode: "transcribe", ref: configured, input: configuredInput };
  for (const provider of config?.providers ?? []) {
    const model = provider.models.find((item) => providerModelReadsImages(provider, item.trim()));
    if (model) return { mode: "transcribe", ref: { providerId: provider.id, model }, input: "image" };
  }
  for (const provider of config?.providers ?? []) {
    if (!providerSupportsPdfInput(provider)) continue;
    const model = provider.models.find((item) => item.trim());
    if (model) return { mode: "transcribe", ref: { providerId: provider.id, model }, input: "pdf" };
  }
  return { mode: "none" };
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

/**
 * How hard the model should think about a page, from what the lesson plan says
 * the page is worth. The amount of text on a slide says nothing about that: a
 * slide with one formula can be the page everything else rests on, and it was
 * exactly those pages that used to be explained with thinking switched off.
 */
export function lessonPlanReasoningFloor(
  row: Pick<LessonPlanPage, "depth" | "key"> | undefined,
): UiPreferences["modelReasoningEffort"] | undefined {
  if (!row || row.depth === "skim") return undefined;
  return row.key || row.depth === "full" ? "medium" : "low";
}

export function teachingGenerationQualityPlan(
  page: PageData,
  preference: UiPreferences["modelReasoningEffort"],
  attempt: TeachingGenerationAttempt = "initial",
  modelApiConfig?: ModelApiConfig,
  planRow?: Pick<LessonPlanPage, "depth" | "key">,
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
  // The extractor check flagged the text layer as noise (formulas drawn with
  // an embedded font). The page itself must reach the model: attached, when
  // the quality model reads PDFs; otherwise the prompt is told the text is
  // unreadable, and retrying on the same noise gains nothing.
  const garbledText = Boolean(page.source.text_garbled) && page.source.parser !== TRANSCRIPTION_PARSER;
  const garbledPageAttachable = garbledText && teachingQualityProviderReadsPdf(modelApiConfig);
  const garbledPageImageable = garbledText && !garbledPageAttachable && teachingQualityModelReadsImages(modelApiConfig);

  let requestedReasoning: UiPreferences["modelReasoningEffort"] =
    sourceText.length <= TEACHING_TEXT_COMPACT_PAGE_MAX_CHARS ? "none" : "low";
  let attachPdf = false;
  let attachPageImage = false;
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

  const planFloor = lessonPlanReasoningFloor(planRow);
  if (planFloor) {
    reasons.push(`lesson-plan-${planRow?.key ? "key" : planRow?.depth}`);
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, planFloor);
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

  if (garbledPageAttachable) {
    reasons.push("garbled-source-text");
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, "medium");
    attachPdf = true;
    batchable = false;
    retryOnWeakOutput = true;
  } else if (garbledPageImageable) {
    reasons.push("garbled-source-text-image");
    requestedReasoning = maxTeachingReasoningEffort(requestedReasoning, "medium");
    attachPageImage = true;
    batchable = false;
    retryOnWeakOutput = true;
  } else if (garbledText) {
    reasons.push("garbled-source-text-unreadable");
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

  // No model in this configuration can read the page: attaching the PDF for
  // it would only upload a file the adapter drops.
  if (garbledText && !garbledPageAttachable) attachPdf = false;
  if (attachPdf || attachPageImage) batchable = false;

  if (!reasons.length) reasons.push("text-fast-path");
  const modelDefaults = teachingModelDefaults(modelApiConfig);
  const selectedRef =
    attachPdf || attachPageImage || requestedReasoning === "high"
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
    attachPageImage,
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
  const keepGrounding = kind === "invalid_json" || kind === "truncated";
  const attachPdf = keepGrounding ? previousPlan.attachPdf : false;
  const attachPageImage = keepGrounding ? previousPlan.attachPageImage : false;
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
    attachPageImage,
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
    attachPageImage: plan.attachPageImage,
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
      ...(page.source.text_garbled ? { text_garbled: true } : {}),
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
    const row = lessonPlan ? lessonPlanRow(lessonPlan, page.page_no) : undefined;
    const plan = teachingGenerationQualityPlan(page, preference, "initial", modelApiConfig, row);
    const segmentId = row?.segment;
    if (!plan.batchable) {
      flushCurrentBatch();
      batches.push({ pages: [page], plan, segmentId });
      continue;
    }
    const previous = currentBatch[currentBatch.length - 1];
    const breaksBatch =
      Boolean(currentPlan) &&
      (!teachingPlansCanShareBatch(currentPlan as TeachingGenerationQualityPlan, plan, Boolean(lessonPlan)) ||
        currentSegment !== segmentId ||
        (Boolean(lessonPlan) && Boolean(previous) && page.page_no !== previous.page_no + 1) ||
        currentBatch.length >= teachingBatchSizeForPlan(currentPlan as TeachingGenerationQualityPlan, currentBatch, Boolean(lessonPlan)));
    if (breaksBatch) flushCurrentBatch();
    // A stretch of one segment is one request: it thinks as hard as its
    // hardest page needs instead of being cut wherever the effort changes.
    const open = currentPlan as TeachingGenerationQualityPlan | null;
    currentPlan = open
      ? { ...open, reasoningEffort: maxTeachingReasoningEffort(open.reasoningEffort, plan.reasoningEffort) }
      : plan;
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
  if (plan.attachPdf || plan.attachPageImage) return 1;
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

function teachingPlansCanShareBatch(
  left: TeachingGenerationQualityPlan,
  right: TeachingGenerationQualityPlan,
  planned = false,
) {
  return (
    left.providerId === right.providerId &&
    left.model === right.model &&
    (planned || left.reasoningEffort === right.reasoningEffort) &&
    left.attachPdf === right.attachPdf &&
    left.attachPageImage === right.attachPageImage &&
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
  // Length earns nothing beyond "there is an explanation": a longer candidate
  // is not a better one.
  let score = page.teaching.confidence * 1000 + (notes.length >= TEACHING_LOW_QUALITY_NOTE_CHARS ? 25 : 0);
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
