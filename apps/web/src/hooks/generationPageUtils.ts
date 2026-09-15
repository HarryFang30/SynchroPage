import type { AppCopy } from "../i18n";
import {
  generationFailureMarkdown,
  teachingQualityPlanPayload,
  teachingRequestPage,
  type GeneratedTeachingPageResponse,
  type GenerationFailureKind,
  type PageData,
  type PagePack,
  type TeachingGenerationQualityPlan,
  type TeachingOutputLanguage,
} from "../lib/generation/teachingGeneration";
import { normalizeGeneratedPage } from "../lib/generation/generationRuntime";
import type { LessonPlanRequestSlice } from "../lib/generation/lessonPlan";
import type { PdfDirectFileInput } from "../lib/pdf/directFile";
import type { PageImageInput } from "../lib/pdf/pageImages";
import type { PdfContextPayload } from "../lib/pdf/textExtraction";

// ── Running page builder ──────────────────────────────────────

export function buildRunningPageData(
  basePage: PageData,
  outputLanguage: TeachingOutputLanguage,
): PageData {
  return {
    ...basePage,
    status: "running",
    teaching: {
      ...basePage.teaching,
      output_language: outputLanguage,
      speaker_notes_md:
        basePage.status === "failed" || basePage.teaching.output_language !== outputLanguage
          ? ""
          : basePage.teaching.speaker_notes_md,
    },
  };
}

// ── Failed page builder ───────────────────────────────────────

export type GenerationFailureDetail = {
  kind: GenerationFailureKind;
  attempts: number;
};

/**
 * A transport failure (timeout / 429 / network / bad JSON) is NOT a quality
 * signal: it records teaching.generation_error and leaves needs_review alone so
 * the next run does not escalate the page to the heavy quality plan (F04).
 */
export function buildFailedPageData(
  runningPage: PageData,
  message: string,
  outputLanguage: TeachingOutputLanguage,
  copy: AppCopy,
  failure?: GenerationFailureDetail,
): PageData {
  const pageNo = runningPage.page_no;
  const transportFailure = Boolean(failure) && failure?.kind !== "quality";
  return {
    ...runningPage,
    status: "failed",
    teaching: {
      ...runningPage.teaching,
      output_language: outputLanguage,
      slide_title: runningPage.teaching.slide_title || `PDF p.${pageNo}`,
      speaker_notes_md: generationFailureMarkdown(message, outputLanguage),
      confidence: 0,
      needs_review: transportFailure ? Boolean(runningPage.teaching.needs_review) : true,
      generation_error: failure
        ? { kind: failure.kind, attempts: Math.max(1, Math.floor(failure.attempts)), at: Date.now() }
        : runningPage.teaching.generation_error,
    },
  };
}

// ── Response normalization ────────────────────────────────────

export function normalizeGeneratedWithLanguage(
  response: GeneratedTeachingPageResponse,
  runningPage: PageData,
  outputLanguage: TeachingOutputLanguage,
): PageData {
  const normalized = normalizeGeneratedPage(response.page, runningPage);
  return {
    ...normalized,
    teaching: {
      ...normalized.teaching,
      output_language: outputLanguage,
    },
  };
}

// ── API request body builders ─────────────────────────────────

export interface SinglePageRequestParams {
  plan: TeachingGenerationQualityPlan;
  document: PagePack["document"];
  documentContext: PdfContextPayload | null;
  documentFile: PdfDirectFileInput | null;
  outputLanguage: TeachingOutputLanguage;
  outputLanguageLabel: string;
  uiLanguage: string;
  runningPage: PageData;
  pageCount: number;
  previousPage: { page_no: number; title: string } | null;
  nextPage: { page_no: number; title: string } | null;
  /** Lesson-plan rows and segment for this page, with the previous page's handoff. */
  lessonPlan?: LessonPlanRequestSlice;
  /** Renderings of pages whose text layer is unreadable, for a model that reads images. */
  pageImages?: PageImageInput[];
}

export function buildSinglePageRequestBody(params: SinglePageRequestParams) {
  const { plan, document, documentContext, documentFile, outputLanguage, outputLanguageLabel, uiLanguage, runningPage, pageCount, previousPage, nextPage, lessonPlan, pageImages } = params;
  return {
    method: "POST" as const,
    body: JSON.stringify({
      modelProviderId: plan.providerId,
      model: plan.model,
      fallbackModelProviderId: plan.fallbackProviderId,
      fallbackModel: plan.fallbackModel,
      reasoningEffort: plan.reasoningEffort,
      qualityPlan: teachingQualityPlanPayload(plan),
      document,
      documentContext,
      documentFile,
      outputLanguage,
      outputLanguageLabel,
      uiLanguage,
      page: teachingRequestPage(runningPage, plan),
      pageCount,
      previousPage,
      nextPage,
      lessonPlan,
      ...(pageImages?.length ? { pageImages } : {}),
    }),
  };
}

export interface BatchPagesRequestParams {
  plan: TeachingGenerationQualityPlan;
  document: PagePack["document"];
  documentContext: PdfContextPayload | null;
  documentFile: PdfDirectFileInput | null;
  outputLanguage: TeachingOutputLanguage;
  outputLanguageLabel: string;
  uiLanguage: string;
  runningPages: PageData[];
  pageCount: number;
  /** Lesson-plan rows and segment for these pages, with the previous page's handoff. */
  lessonPlan?: LessonPlanRequestSlice;
  pageImages?: PageImageInput[];
}

export function buildBatchPagesRequestBody(params: BatchPagesRequestParams) {
  const { plan, document, documentContext, documentFile, outputLanguage, outputLanguageLabel, uiLanguage, runningPages, pageCount, lessonPlan, pageImages } = params;
  return {
    method: "POST" as const,
    body: JSON.stringify({
      modelProviderId: plan.providerId,
      model: plan.model,
      fallbackModelProviderId: plan.fallbackProviderId,
      fallbackModel: plan.fallbackModel,
      reasoningEffort: plan.reasoningEffort,
      qualityPlan: teachingQualityPlanPayload(plan),
      document,
      documentContext,
      documentFile,
      outputLanguage,
      outputLanguageLabel,
      uiLanguage,
      pages: runningPages.map((page) => teachingRequestPage(page, plan)),
      pageCount,
      lessonPlan,
      ...(pageImages?.length ? { pageImages } : {}),
    }),
  };
}
