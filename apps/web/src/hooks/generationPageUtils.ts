import type { AppCopy } from "../i18n";
import {
  generationFailureMarkdown,
  teachingQualityPlanPayload,
  teachingRequestPage,
  teachingDocumentContextForPlan,
  type GeneratedTeachingPageResponse,
  type PageData,
  type PagePack,
  type TeachingGenerationQualityPlan,
  type TeachingOutputLanguage,
} from "../lib/generation/teachingGeneration";
import { normalizeGeneratedPage } from "../lib/generation/generationRuntime";
import type { PdfDirectFileInput } from "../lib/pdf/directFile";

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

export function buildFailedPageData(
  runningPage: PageData,
  message: string,
  outputLanguage: TeachingOutputLanguage,
  copy: AppCopy,
): PageData {
  const pageNo = runningPage.page_no;
  return {
    ...runningPage,
    status: "failed",
    teaching: {
      ...runningPage.teaching,
      output_language: outputLanguage,
      slide_title: runningPage.teaching.slide_title || `PDF p.${pageNo}`,
      speaker_notes_md: generationFailureMarkdown(message, outputLanguage),
      confidence: 0,
      needs_review: true,
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
  documentContext: ReturnType<typeof teachingDocumentContextForPlan>;
  documentFile: PdfDirectFileInput | null;
  outputLanguage: TeachingOutputLanguage;
  outputLanguageLabel: string;
  uiLanguage: string;
  runningPage: PageData;
  pageCount: number;
  previousPage: { page_no: number; title: string } | null;
  nextPage: { page_no: number; title: string } | null;
}

export function buildSinglePageRequestBody(params: SinglePageRequestParams) {
  const { plan, document, documentContext, documentFile, outputLanguage, outputLanguageLabel, uiLanguage, runningPage, pageCount, previousPage, nextPage } = params;
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
    }),
  };
}

export interface BatchPagesRequestParams {
  plan: TeachingGenerationQualityPlan;
  document: PagePack["document"];
  documentContext: ReturnType<typeof teachingDocumentContextForPlan>;
  documentFile: PdfDirectFileInput | null;
  outputLanguage: TeachingOutputLanguage;
  outputLanguageLabel: string;
  uiLanguage: string;
  runningPages: PageData[];
  pageCount: number;
}

export function buildBatchPagesRequestBody(params: BatchPagesRequestParams) {
  const { plan, document, documentContext, documentFile, outputLanguage, outputLanguageLabel, uiLanguage, runningPages, pageCount } = params;
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
    }),
  };
}
