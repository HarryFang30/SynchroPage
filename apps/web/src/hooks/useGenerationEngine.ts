import { useCallback } from "react";
import type { AppCopy } from "../i18n";
import type {
  GenerationFailureKind,
  PageData,
  PagePack,
  TeachingGenerationQualityPlan,
  TeachingOutputLanguage,
} from "../lib/generation/teachingGeneration";
import {
  batchTeachingPages,
  clampTeachingReasoningEffort,
  fullPdfContextForTeachingGeneration,
  generatedTeachingNeedsRetry,
  groupTeachingBatchesBySegment,
  PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
  planForRetry,
  prioritizeTeachingPages,
  shouldPreferTeachingCandidate,
  teachingModelCapabilities,
  teachingProviderForPlan,
  TEACHING_BATCH_FALLBACK_CONCURRENCY,
  TEACHING_DOCUMENT_GENERATION_CONCURRENCY,
  TEACHING_GENERATION_CONCURRENCY,
  teachingExtractionPageNumbers,
  teachingGenerationQualityPlan,
  teachingModelRequestPriority,
  teachingOutputLanguageName,
  TEACHING_PROJECT_MODEL_REQUEST_CONCURRENCY,
  TEACHING_PROJECT_WARMUP_PAGE_COUNT,
  teachingWarmupPageNumbers,
  type GeneratedTeachingPageResponse,
  type GeneratedTeachingPagesResponse,
  type TeachingGenerationBatch,
} from "../lib/generation/teachingGeneration";
import {
  lessonPlanDepthForPage,
  lessonPlanMatchesLanguage,
  lessonPlanRequestPages,
  lessonPlanRequestSlice,
  normalizeLessonPlan,
  type LessonPlan,
  type LessonPlanDepth,
} from "../lib/generation/lessonPlan";
import {
  classifyGenerationFailure,
  createAsyncLimiter,
  generationWindowStorageKey,
  initialGenerationWindow,
  isAbortError,
  isReasoningGenerationModel,
  limiterOutcomeForFailure,
  loadPersistedGenerationWindow,
  mergePageIntoPack,
  missingSourceTextPageNumbers,
  normalizeGeneratedPage,
  pageWithSourceText,
  runWithConcurrencyLimit,
  type AsyncLimiter,
  type GenerationFailureClassification,
} from "../lib/generation/generationRuntime";
import type { AsyncLimiterPriority } from "../lib/generation/teachingGeneration";
import { requestJson } from "../lib/http/requestJson";
import {
  extractPdfPagesFromBlob,
  mergePdfContextPages,
  type PdfContextPage,
  type PdfPageExtractionOptions,
} from "../lib/pdf/textExtraction";
import {
  createDraftPagePack,
  formatPageRanges,
  generateTargetPageNumbers,
  pagePackFromPersistence,
  type GeneratePageMode,
} from "../lib/workspace/synchroPageState";
import {
  loadDocumentGenerationBundle,
  saveGeneratedPagesFromPack,
  saveLessonPlan,
  type DocumentSidebarItem,
} from "../lib/persistence";
import { hasCompletedTeaching } from "../lib/generation/generationRuntime";
import type { ModelApiConfig, UiPreferences } from "../settings";
import type { PanelVisibility } from "../lib/workspace/synchroPageState";
import {
  buildRunningPageData,
  buildFailedPageData,
  normalizeGeneratedWithLanguage,
  buildSinglePageRequestBody,
  buildBatchPagesRequestBody,
} from "./generationPageUtils";
import {
  createPersistGeneratedPage,
  createPersistenceQueue,
  createDocumentFileLoaderFromUrl,
  createDocumentFileLoaderFromBlob,
} from "./generationPersistence";

/**
 * Backend per-request deadline by reasoning effort (seconds), mirrored from
 * GET /api/generate/status. The client timeout must always sit ABOVE it, or a
 * request the server would have answered is counted as a client timeout and
 * re-issued while the server is still working on it (F10).
 */
const TEACHING_BACKEND_DEADLINE_SECONDS: Record<string, number> = {
  none: 180,
  low: 180,
  medium: 300,
  high: 480,
  xhigh: 600,
  max: 600,
};
const TEACHING_BATCH_EXTRA_SECONDS_PER_PAGE = 60;
const TEACHING_BATCH_EXTRA_FREE_PAGES = 2;
const TEACHING_REQUEST_TIMEOUT_MARGIN_MS = 20_000;
/** Informational "still generating" notice cadence — never aborts (F02). */
const TEACHING_SLOW_NOTICE_INTERVAL_MS = 30_000;
const PDF_FETCH_TIMEOUT_MS = 30_000;
const PDF_TEXT_EXTRACTION_BASE_TIMEOUT_MS = 45_000;
const PDF_TEXT_EXTRACTION_PER_PAGE_TIMEOUT_MS = 2_000;
const PDF_TEXT_EXTRACTION_MAX_TIMEOUT_MS = 240_000;
const TEACHING_PAGE_MAX_ATTEMPTS = 4;
const TEACHING_PAGE_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const;
const TEACHING_RETRY_JITTER_RATIO = 0.3;
/** Dispatch bound only; the adaptive limiter is the real concurrency knob. */
const TEACHING_BATCH_DISPATCH_CONCURRENCY = 6;
const GENERATION_STATUS_REQUEST_TIMEOUT_MS = 5_000;

type GenerationRequestWatchdogOptions = {
  timeoutMessage?: string;
  /** Interval between informational slow notices; the request is never aborted. */
  slowMs?: number;
  onSlow?: (elapsedSeconds: number) => void;
};

type GenerationRuntimeLimits = {
  deadlines?: Record<string, number>;
  concurrency?: number;
};

export interface GenerationEngineParams {
  isGeneratingNotes: boolean;
  setIsGeneratingNotes: (v: boolean) => void;
  pack: PagePack;
  setPack: (pack: PagePack | ((prev: PagePack) => PagePack)) => void;
  pdfExtractedPages: PdfContextPage[];
  setPdfExtractedPages: (pages: PdfContextPage[]) => void;
  pdfPageCount: number | null;
  pdfUrl: string;
  generatePageMode: GeneratePageMode;
  generateRangeDraft: string;
  currentPdfPageNo: number;
  setCurrentPageNo: (fn: number | ((prev: number) => number)) => void;
  teachingOutputLanguage: TeachingOutputLanguage;
  workspaceId: string | null;
  documentId: string | null;
  activeProjectId: string | null;
  documentItems: DocumentSidebarItem[];
  copy: AppCopy;
  uiPreferences: UiPreferences;
  modelApiConfig: ModelApiConfig;
  generationAbortControllerRef: React.MutableRefObject<AbortController | null>;
  setJobStatus: (status: string) => void;
  setPanels: (fn: PanelVisibility | ((prev: PanelVisibility) => PanelVisibility)) => void;
  setActiveTab: (tab: "notes" | "structure" | "json") => void;
  refreshDocumentItems: (nextWorkspaceId?: string | null, activeDocumentId?: string | null, nextActiveProjectId?: string | null) => Promise<DocumentSidebarItem[]>;
}

export function useGenerationEngine(p: GenerationEngineParams) {
  const handleGenerateNotes = useCallback(() => {
    if (p.isGeneratingNotes) return;
    const pageOutputLanguage = p.teachingOutputLanguage;
    const pageOutputLanguageLabel = teachingOutputLanguageName(pageOutputLanguage);
    const totalPages = Math.max(p.pdfPageCount || p.pack.document.page_count || p.pack.pages.length || p.pdfExtractedPages.length, 1);
    const sourceTextByPage = new Map<number, string>();
    for (const page of p.pdfExtractedPages) {
      sourceTextByPage.set(page.page_no, page.text_md);
    }
    for (const page of p.pack.pages) {
      if (!sourceTextByPage.has(page.page_no) && page.source.text_md) {
        sourceTextByPage.set(page.page_no, page.source.text_md);
      }
    }
    const targetPageNumbers = generateTargetPageNumbers(p.generatePageMode, p.generateRangeDraft, p.currentPdfPageNo, totalPages);
    if (!targetPageNumbers?.length) {
      p.setJobStatus(p.copy.status.generationInvalidPageRange(totalPages));
      return;
    }
    const missingTargetSourceText = missingSourceTextPageNumbers(targetPageNumbers, sourceTextByPage);
    const draftPack = createDraftPagePack(p.pack.document.title, p.pack.document.source_pdf_url, totalPages, p.pack.document.id);
    const packPagesByNumber = new Map(p.pack.pages.map((item) => [item.page_no, item]));

    let workingPack: PagePack = {
      ...p.pack,
      document: {
        ...p.pack.document,
        page_count: totalPages,
      },
      pages: Array.from({ length: totalPages }, (_, index) => {
        const pageNo = index + 1;
        const existing = packPagesByNumber.get(pageNo) || draftPack.pages[index];
        return pageWithSourceText(existing, sourceTextByPage.get(pageNo) || "");
      }),
    };
    let workingPagesByNumber = new Map(workingPack.pages.map((item) => [item.page_no, item]));
    const targetPageSet = new Set(targetPageNumbers);
    let scopedPages = workingPack.pages.filter((item) => targetPageSet.has(item.page_no));
    // "All" re-plans the lesson and rewrites every page; the other scopes only
    // fill what is missing.
    const forceRegenerate = p.generatePageMode === "all";
    const generatedThisRun = new Set<number>();
    // Pages this run gave up on; excluded from later passes of the same run
    // only, so a page that failed in an earlier session is still retried.
    const failedThisRun = new Set<number>();
    const needsWork = (item: PageData) =>
      !generatedThisRun.has(item.page_no) &&
      !failedThisRun.has(item.page_no) &&
      (forceRegenerate || !hasCompletedTeaching(item, pageOutputLanguage));
    let pagesToGenerate = prioritizeTeachingPages(scopedPages.filter(needsWork), p.currentPdfPageNo);
    // Pages already complete before this run; a pre-run fact, never recomputed
    // after a pass has finished pages (F07).
    const skippedPages = scopedPages.length - pagesToGenerate.length;
    if (!pagesToGenerate.length) {
      p.setPack(workingPack);
      p.setJobStatus(p.copy.status.generationScopeAlreadyComplete(formatPageRanges(targetPageNumbers)));
      return;
    }

    p.setIsGeneratingNotes(true);
    p.setPanels((current) => ({ ...current, notes: true }));
    p.setActiveTab("notes");
    p.setJobStatus(p.copy.status.generationPreparingCache(pagesToGenerate.length));
    p.setPack(workingPack);

    p.generationAbortControllerRef.current?.abort();
    const generationAbortController = new AbortController();
    p.generationAbortControllerRef.current = generationAbortController;
    const generationSignal = generationAbortController.signal;

    void (async () => {
      let completed = 0;
      const runtimeLimits: GenerationRuntimeLimits = {};
      const runTeachingModelRequest = createTeachingRequestLimiter({
        modelRef: p.modelApiConfig.defaults.teachingBalanced,
        maxConcurrency: TEACHING_GENERATION_CONCURRENCY,
        onRateLimited: (seconds) => p.setJobStatus(p.copy.status.generationRateLimited(seconds)),
        onConcurrencyReduced: (limit) => p.setJobStatus(p.copy.status.generationConcurrencyReduced(limit)),
      });
      void fetchGenerationRuntimeLimits(generationSignal).then((limits) => {
        if (limits) Object.assign(runtimeLimits, limits);
      });
      try {
        let extractedPagesForGeneration = p.pdfExtractedPages;
        const getDocumentFileForPlan = createDocumentFileLoaderFromUrl({
          pdfUrl: p.pdfUrl,
          documentTitle: workingPack.document.source_pdf_url || workingPack.document.title,
        });
        const persistPage = createPersistGeneratedPage({
          workspaceId: p.workspaceId || "",
          documentId: p.documentId || "",
          currentDocumentId: workingPack.document.id,
        });
        const persistQueue = createPersistenceQueue(persistPage);
        const commitGeneratedPage = (generatedPage: PageData) => {
          if (generationSignal.aborted) return;
          workingPack = mergePageIntoPack(workingPack, generatedPage);
          workingPagesByNumber.set(generatedPage.page_no, generatedPage);
          generatedThisRun.add(generatedPage.page_no);
          p.setPack(workingPack);
          completed += 1;
          persistQueue.enqueue(generatedPage);
        };

        // One planning call over the whole deck: segments, per-page role and
        // depth. Failure is not fatal; the backend then judges depth per page.
        const ensureLessonPlan = async () => {
          if (generationSignal.aborted) return;
          const planRef = p.modelApiConfig.defaults.teachingQuality;
          const reasoningEffort = clampTeachingReasoningEffort(
            "medium",
            teachingModelCapabilities(teachingProviderForPlan(p.modelApiConfig, planRef.providerId), planRef.model),
          );
          p.setJobStatus(p.copy.status.generationPlanning(totalPages));
          const timeoutMs = teachingRequestTimeoutMs(reasoningEffort, totalPages, runtimeLimits.deadlines);
          try {
            const response = await runGenerationRequestWithTimeout(generationSignal, timeoutMs, (requestSignal) =>
              requestJson<{ plan?: unknown }>(
                "/api/generate/plan",
                {
                  method: "POST",
                  body: JSON.stringify({
                    modelProviderId: planRef.providerId,
                    model: planRef.model,
                    reasoningEffort,
                    document: { id: workingPack.document.id, title: workingPack.document.title, page_count: totalPages },
                    pageCount: totalPages,
                    outputLanguage: pageOutputLanguage,
                    outputLanguageLabel: pageOutputLanguageLabel,
                    uiLanguage: p.uiPreferences.language,
                    pages: lessonPlanRequestPages(workingPack.pages),
                  }),
                  signal: requestSignal,
                },
                p.copy.errors.accountNotFound,
              ),
            {
              timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(timeoutMs)),
              slowMs: generationSlowNoticeIntervalMs(),
              onSlow: () => p.setJobStatus(p.copy.status.generationPlanning(totalPages)),
            });
            const rawPlan = response.plan && typeof response.plan === "object" ? (response.plan as Record<string, unknown>) : {};
            const lessonPlan = normalizeLessonPlan({ ...rawPlan, output_language: pageOutputLanguage });
            if (!lessonPlan) throw new Error("empty lesson plan");
            workingPack = { ...workingPack, document: { ...workingPack.document, lesson_plan: lessonPlan } };
            p.setPack(workingPack);
            if (p.workspaceId && p.documentId && workingPack.document.id === p.documentId) {
              await saveLessonPlan(p.documentId, lessonPlan).catch(() => undefined);
            }
          } catch (error) {
            if (generationSignal.aborted || isAbortError(error)) throw error;
            p.setJobStatus(p.copy.status.generationPlanFailed);
          }
        };

        const mergeExtractedPages = (pages: PdfContextPage[]) => {
          if (!pages.length) return;
          extractedPagesForGeneration = mergePdfContextPages(extractedPagesForGeneration, pages);
          p.setPdfExtractedPages(extractedPagesForGeneration);
          for (const page of pages) {
            sourceTextByPage.set(page.page_no, page.text_md);
          }
          workingPack = {
            ...workingPack,
            pages: workingPack.pages.map((page) => pageWithSourceText(page, sourceTextByPage.get(page.page_no) || "")),
          };
          workingPagesByNumber = new Map(workingPack.pages.map((item) => [item.page_no, item]));
          scopedPages = workingPack.pages.filter((item) => targetPageSet.has(item.page_no));
          pagesToGenerate = prioritizeTeachingPages(scopedPages.filter(needsWork), p.currentPdfPageNo);
          p.setPack(workingPack);
        };

        const runGenerationPass = async (passPagesToGenerate: PageData[], contextPages: PdfContextPage[]) => {
          if (!passPagesToGenerate.length || generationSignal.aborted) return;
          const documentContext = fullPdfContextForTeachingGeneration(
            workingPack,
            totalPages,
            contextPages,
            passPagesToGenerate.map((page) => page.page_no),
          );
          const lessonPlan = workingPack.document.lesson_plan;
          const handoffFor = (pageNo: number) => {
            const previous = workingPagesByNumber.get(pageNo - 1);
            return previous && hasCompletedTeaching(previous, pageOutputLanguage) ? previous.teaching.handoff || "" : "";
          };
          p.setJobStatus(p.copy.status.generationStarted(passPagesToGenerate.length));
          const generationInputPagesByNumber = new Map(workingPagesByNumber);
          let started = 0;
          const markRunningPage = (pageToGenerate: PageData) => {
            const pageNo = pageToGenerate.page_no;
            const basePage = generationInputPagesByNumber.get(pageNo) || draftPack.pages[pageNo - 1];
            if (generationSignal.aborted) return basePage;
            const runningPage = buildRunningPageData(basePage, pageOutputLanguage);
            workingPack = mergePageIntoPack(workingPack, runningPage);
            workingPagesByNumber.set(pageNo, runningPage);
            p.setPack(workingPack);
            p.setCurrentPageNo((current) => current || pageNo);
            started += 1;
            p.setJobStatus(p.copy.status.generationPage(started, passPagesToGenerate.length, pageNo));
            return runningPage;
          };

          const requestGeneratedPage = async (runningPage: PageData, plan: TeachingGenerationQualityPlan) => {
            const pageNo = runningPage.page_no;
            const previousPage = generationInputPagesByNumber.get(pageNo - 1);
            const nextPage = generationInputPagesByNumber.get(pageNo + 1);
            const documentFile = await getDocumentFileForPlan(plan);
            const priority = teachingModelRequestPriority([runningPage], p.currentPdfPageNo, "now", "next");
            const timeoutMs = teachingRequestTimeoutMs(plan.reasoningEffort, 1, runtimeLimits.deadlines);
            const response = await runLimitedGenerationRequest(
              runTeachingModelRequest,
              { priority, signal: generationSignal },
              () =>
                runGenerationRequestWithTimeout(generationSignal, timeoutMs, (requestSignal) =>
                  requestJson<GeneratedTeachingPageResponse>(
                    "/api/generate/page",
                    {
                      ...buildSinglePageRequestBody({
                        plan,
                        document: workingPack.document,
                        documentContext,
                        documentFile,
                        outputLanguage: pageOutputLanguage,
                        outputLanguageLabel: pageOutputLanguageLabel,
                        uiLanguage: p.uiPreferences.language,
                        runningPage,
                        pageCount: totalPages,
                        lessonPlan: lessonPlanRequestSlice(lessonPlan, [pageNo], handoffFor(pageNo)),
                        previousPage: previousPage
                          ? { page_no: previousPage.page_no, title: previousPage.teaching.slide_title }
                          : null,
                        nextPage: nextPage
                          ? { page_no: nextPage.page_no, title: nextPage.teaching.slide_title }
                          : null,
                      }),
                      signal: requestSignal,
                    },
                    p.copy.errors.accountNotFound,
                  ),
                {
                  timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(timeoutMs)),
                  slowMs: generationSlowNoticeIntervalMs(),
                  onSlow: (elapsedSeconds) => p.setJobStatus(p.copy.status.generationPageSlow(pageNo, elapsedSeconds)),
                }),
            );
            return normalizeGeneratedWithLanguage(response, runningPage, pageOutputLanguage);
          };

          const generateSinglePage = async (
            runningPage: PageData,
            plan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "initial", p.modelApiConfig),
            fallbackOnFailure?: PageData,
          ) => {
            const pageNo = runningPage.page_no;
            if (generationSignal.aborted) return;
            await generatePageWithAutoRetry({
              runningPage,
              initialPlan: plan,
              depth: lessonPlanDepthForPage(lessonPlan, pageNo),
              preference: p.uiPreferences.modelReasoningEffort,
              modelApiConfig: p.modelApiConfig,
              outputLanguage: pageOutputLanguage,
              copy: p.copy,
              signal: generationSignal,
              fallbackOnFailure,
              requestGeneratedPage,
              commitGeneratedPage,
              markRetryingPage: (page, attempt, totalAttempts, kind) => {
                if (generationSignal.aborted) return;
                const retryingPage = buildRetryingPageData(page, pageOutputLanguage);
                workingPack = mergePageIntoPack(workingPack, retryingPage);
                workingPagesByNumber.set(pageNo, retryingPage);
                p.setPack(workingPack);
                p.setJobStatus(
                  p.copy.status.generationPageRetryingReason(pageNo, attempt, totalAttempts, retryReasonText(kind, p.copy)),
                );
              },
              commitFailedPage: (failedPage) => {
                if (generationSignal.aborted) return;
                workingPack = mergePageIntoPack(workingPack, failedPage);
                workingPagesByNumber.set(pageNo, failedPage);
                p.setPack(workingPack);
                p.setJobStatus(p.copy.status.generationPageFailed(pageNo, generationFailureMessage(failedPage)));
                failedThisRun.add(pageNo);
                persistQueue.enqueue(failedPage);
              },
            });
          };

          const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort, p.modelApiConfig, {
            lessonPlan,
            currentPageNo: p.currentPdfPageNo,
          });
          const runPageBatch = async (pageBatch: TeachingGenerationBatch) => {
            if (generationSignal.aborted) return;
            const runningPages = pageBatch.pages.map(markRunningPage);
            if (runningPages.length === 1) {
              await generateSinglePage(runningPages[0], pageBatch.plan);
              return;
            }

            const handledPageNumbers = new Set<number>();
            try {
              const documentFile = await getDocumentFileForPlan(pageBatch.plan);
              const priority = teachingModelRequestPriority(runningPages, p.currentPdfPageNo, "now", "next");
              const timeoutMs = teachingRequestTimeoutMs(
                pageBatch.plan.reasoningEffort,
                runningPages.length,
                runtimeLimits.deadlines,
              );
              const response = await runLimitedGenerationRequest(
                runTeachingModelRequest,
                { priority, signal: generationSignal },
                () =>
                  runGenerationRequestWithTimeout(generationSignal, timeoutMs, (requestSignal) =>
                    requestJson<BatchGenerationResponse>(
                      "/api/generate/pages",
                      {
                        ...buildBatchPagesRequestBody({
                          plan: pageBatch.plan,
                          document: workingPack.document,
                          documentContext,
                          documentFile,
                          outputLanguage: pageOutputLanguage,
                          outputLanguageLabel: pageOutputLanguageLabel,
                          uiLanguage: p.uiPreferences.language,
                          runningPages,
                          pageCount: totalPages,
                          lessonPlan: lessonPlanRequestSlice(
                            lessonPlan,
                            runningPages.map((page) => page.page_no),
                            handoffFor(runningPages[0].page_no),
                          ),
                        }),
                        signal: requestSignal,
                      },
                      p.copy.errors.accountNotFound,
                    ),
                  {
                    timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(timeoutMs)),
                    slowMs: generationSlowNoticeIntervalMs(),
                    onSlow: (elapsedSeconds) =>
                      p.setJobStatus(p.copy.status.generationBatchSlow(runningPages.length, elapsedSeconds)),
                  }),
              );
              const outcome = resolveBatchResponse({
                response,
                runningPages,
                plan: pageBatch.plan,
                lessonPlan,
                outputLanguage: pageOutputLanguage,
                preference: p.uiPreferences.modelReasoningEffort,
                modelApiConfig: p.modelApiConfig,
                isAborted: () => generationSignal.aborted,
                commitGeneratedPage: (generatedPage) => {
                  workingPack = mergePageIntoPack(workingPack, generatedPage);
                  workingPagesByNumber.set(generatedPage.page_no, generatedPage);
                  generatedThisRun.add(generatedPage.page_no);
                  completed += 1;
                  persistQueue.enqueue(generatedPage);
                },
                onHandled: (pageNo) => handledPageNumbers.add(pageNo),
              });
              if (generationSignal.aborted) return;
              p.setPack(workingPack);
              await runWithConcurrencyLimit(outcome.weakPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async ({ runningPage, retryPlan, fallback }) => {
                await generateSinglePage(runningPage, retryPlan, fallback);
              });
              // Contract (b): a 200 with "missing" means those pages alone must be
              // regenerated singly — the pages that did parse stay committed.
              await runWithConcurrencyLimit(outcome.missingPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                await generateSinglePage(runningPage, singlePageFallbackPlan(pageBatch.plan, runningPage, p.uiPreferences.modelReasoningEffort, p.modelApiConfig));
              });
            } catch (error) {
              if (generationSignal.aborted || isAbortError(error)) return;
              const classification = classifyGenerationFailure(error);
              const pendingPages = runningPages.filter((page) => !handledPageNumbers.has(page.page_no));
              await runWithConcurrencyLimit(pendingPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                await generateSinglePage(
                  runningPage,
                  batchFailureFallbackPlan(classification, pageBatch.plan, runningPage, p.uiPreferences.modelReasoningEffort, p.modelApiConfig),
                );
              });
            }
          };
          // Batches of one segment run in order (each carries the previous
          // page's handoff); different segments run side by side.
          await runWithConcurrencyLimit(groupTeachingBatchesBySegment(pageBatches), TEACHING_BATCH_DISPATCH_CONCURRENCY, async (segmentBatches) => {
            for (const pageBatch of segmentBatches) {
              if (generationSignal.aborted) return;
              await runPageBatch(pageBatch);
            }
          }, { signal: generationSignal });
        };

        const allPageNumbers = workingPack.pages.map((page) => page.page_no);
        const needsPlan = forceRegenerate || !lessonPlanMatchesLanguage(workingPack.document.lesson_plan, pageOutputLanguage);
        const missingAllSourceText = missingSourceTextPageNumbers(allPageNumbers, sourceTextByPage);
        const currentPagesToGenerate = () =>
          prioritizeTeachingPages(
            workingPack.pages.filter((page) => targetPageSet.has(page.page_no) && needsWork(page)),
            p.currentPdfPageNo,
          );

        if (p.pdfUrl && (missingTargetSourceText.length || (needsPlan && missingAllSourceText.length))) {
          p.setJobStatus(p.copy.status.pdfTextExtracting(targetPageNumbers.length - missingTargetSourceText.length, targetPageNumbers.length));
          const pdfBlob = await fetchPdfBlobForGeneration(p.pdfUrl, generationSignal, p.copy).catch(() => null);
          if (pdfBlob && needsPlan) {
            // Planning reads the whole deck, so every page's text comes first.
            const extractionPageNumbers = allPageNumbers.filter((pageNo) => !sourceTextByPage.has(pageNo));
            const extracted = extractionPageNumbers.length
              ? await extractPdfPagesForGeneration(pdfBlob, {
                  priorityPageNumbers: [p.currentPdfPageNo, ...targetPageNumbers],
                  pageNumbers: extractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }, generationSignal).catch(() => {
                  if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
                  return null;
                })
              : null;
            if (extracted?.pages.length) mergeExtractedPages(extracted.pages);
            if (generationSignal.aborted) return;
            await ensureLessonPlan();
            if (generationSignal.aborted) return;
            await runGenerationPass(currentPagesToGenerate(), extractedPagesForGeneration);
          } else if (pdfBlob && missingTargetSourceText.length > TEACHING_PROJECT_WARMUP_PAGE_COUNT) {
            const warmupPageNumbers = teachingWarmupPageNumbers(totalPages, p.currentPdfPageNo, targetPageNumbers);
            const warmupPageSet = new Set(warmupPageNumbers);
            const warmupExtractionPageNumbers = teachingExtractionPageNumbers(totalPages, warmupPageNumbers)
              .filter((pageNo) => !sourceTextByPage.has(pageNo));
            const warmupExtracted = warmupExtractionPageNumbers.length
              ? await extractPdfPagesForGeneration(pdfBlob, {
                  priorityPageNumbers: warmupPageNumbers,
                  pageNumbers: warmupExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }, generationSignal).catch(() => {
                  if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
                  return null;
                })
              : null;
            if (warmupExtracted?.pages.length) mergeExtractedPages(warmupExtracted.pages);
            if (generationSignal.aborted) return;

            const remainingExtractionPageNumbers = teachingExtractionPageNumbers(totalPages, targetPageNumbers)
              .filter((pageNo) => !sourceTextByPage.has(pageNo));
            const remainingExtractionPromise = remainingExtractionPageNumbers.length
              ? extractPdfPagesForGeneration(pdfBlob, {
                  priorityPageNumbers: [p.currentPdfPageNo, ...targetPageNumbers],
                  pageNumbers: remainingExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }, generationSignal).catch(() => {
                  if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
                  return null;
                })
              : Promise.resolve(null);
            void remainingExtractionPromise.catch(() => undefined);

            await runGenerationPass(
              pagesToGenerate.filter((page) => warmupPageSet.has(page.page_no)),
              extractedPagesForGeneration,
            );
            if (generationSignal.aborted) return;
            const remainingExtracted = await remainingExtractionPromise;
            if (remainingExtracted?.pages.length) mergeExtractedPages(remainingExtracted.pages);
            if (generationSignal.aborted) return;
            // Always recompute from the live workingPack: scopedPages is a
            // pre-run snapshot and would re-select pages the warm-up pass just
            // finished (F14).
            await runGenerationPass(currentPagesToGenerate(), extractedPagesForGeneration);
          } else if (pdfBlob) {
            const extracted = await extractPdfPagesForGeneration(pdfBlob, {
              priorityPageNumbers: targetPageNumbers,
              pageNumbers: teachingExtractionPageNumbers(totalPages, targetPageNumbers),
              shouldCancel: () => generationSignal.aborted,
              concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
            }, generationSignal).catch(() => {
              if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
              return null;
            });
            if (extracted?.pages.length) mergeExtractedPages(extracted.pages);
            if (generationSignal.aborted) return;
            await runGenerationPass(pagesToGenerate, extractedPagesForGeneration);
          } else {
            await runGenerationPass(pagesToGenerate, extractedPagesForGeneration);
          }
        } else {
          if (generationSignal.aborted) return;
          if (needsPlan) await ensureLessonPlan();
          if (generationSignal.aborted) return;
          await runGenerationPass(currentPagesToGenerate(), extractedPagesForGeneration);
        }
        // A stopped run must not write its half-marked working pack or claim
        // completion; the app already reverted the in-flight pages to drafts.
        if (generationSignal.aborted) return;
        if (p.workspaceId && p.documentId && workingPack.document.id === p.documentId) {
          await persistQueue.flush();
          await saveGeneratedPagesFromPack({ workspaceId: p.workspaceId, documentId: p.documentId, pack: workingPack });
          await p.refreshDocumentItems(p.workspaceId, p.documentId, p.activeProjectId);
        }
        p.setJobStatus(p.copy.status.generationDone(completed, scopedPages.length, skippedPages));
      } catch (error) {
        if (generationSignal.aborted || isAbortError(error)) return;
        const message = generationErrorMessage(error, p.copy);
        workingPack = failActiveGenerationPages(
          workingPack,
          message,
          pageOutputLanguage,
          p.copy,
          classifyGenerationFailure(error).kind,
        );
        p.setPack(workingPack);
        p.setJobStatus(message);
      } finally {
        if (p.generationAbortControllerRef.current === generationAbortController) {
          p.generationAbortControllerRef.current = null;
          p.setIsGeneratingNotes(false);
        }
      }
    })();
  }, [
    p.activeProjectId,
    p.copy,
    p.currentPdfPageNo,
    p.documentId,
    p.generatePageMode,
    p.generateRangeDraft,
    p.isGeneratingNotes,
    p.modelApiConfig,
    p.pack,
    p.pdfExtractedPages,
    p.pdfPageCount,
    p.pdfUrl,
    p.refreshDocumentItems,
    p.teachingOutputLanguage,
    p.uiPreferences.language,
    p.uiPreferences.modelReasoningEffort,
    p.workspaceId,
  ]);

  const handleGenerateProjectMissingNotes = useCallback(() => {
    if (p.isGeneratingNotes || !p.workspaceId) return;
    const _workspaceId = p.workspaceId;
    const _documentId = p.documentId;
    const _activeProjectId = p.activeProjectId;
    const workspaceId = _workspaceId;
    const documentId = _documentId;
    const activeProjectId = _activeProjectId;
    const projectDocumentItems = p.documentItems.filter((item) =>
      item.mimeType === "application/pdf" &&
      item.status !== "missing-file" &&
      (!_activeProjectId || !item.projectId || item.projectId === _activeProjectId),
    );
    if (!projectDocumentItems.length) {
      p.setJobStatus(p.copy.status.generationBatchNoDocuments);
      return;
    }

    p.setIsGeneratingNotes(true);
    p.setPanels((current) => ({ ...current, notes: true }));
    p.setActiveTab("notes");
    const estimatedPages = projectDocumentItems.reduce((sum, item) => sum + Math.max(item.pageCount || 0, 1), 0);
    p.setJobStatus(p.copy.status.generationBatchStarted(projectDocumentItems.length, estimatedPages));

    p.generationAbortControllerRef.current?.abort();
    const generationAbortController = new AbortController();
    p.generationAbortControllerRef.current = generationAbortController;
    const generationSignal = generationAbortController.signal;

    void (async () => {
      let completedTotal = 0;
      let checkedTotal = 0;
      let skippedTotal = 0;
      let processedDocuments = 0;
      const runtimeLimits: GenerationRuntimeLimits = {};
      const runTeachingModelRequest = createTeachingRequestLimiter({
        modelRef: p.modelApiConfig.defaults.teachingBalanced,
        maxConcurrency: TEACHING_PROJECT_MODEL_REQUEST_CONCURRENCY,
        onRateLimited: (seconds) => p.setJobStatus(p.copy.status.generationRateLimited(seconds)),
        onConcurrencyReduced: (limit) => p.setJobStatus(p.copy.status.generationConcurrencyReduced(limit)),
      });
      void fetchGenerationRuntimeLimits(generationSignal).then((limits) => {
        if (limits) Object.assign(runtimeLimits, limits);
      });
      try {
        await runWithConcurrencyLimit(projectDocumentItems, TEACHING_DOCUMENT_GENERATION_CONCURRENCY, async (item, index) => {
          processedDocuments += 1;
          p.setJobStatus(p.copy.status.generationBatchDocument(index + 1, projectDocumentItems.length, item.title || ""));

          const bundle = await loadDocumentGenerationBundle(_workspaceId, item.documentId);
          if (!bundle.pdfBlob?.blob) {
            return;
          }
          const pdfBlob = bundle.pdfBlob.blob;

          const sourcePack = pagePackFromPersistence(bundle.document, bundle.generatedPages, p.copy);
          const persistedPageCount = Math.max(bundle.document.pageCount || 0, 0);
          const knownPageCount = Math.max(persistedPageCount, sourcePack.document.page_count || 0, bundle.generatedPages.length, 1);
          const sourcePagesByNumber = new Map(sourcePack.pages.map((page) => [page.page_no, page]));
          let draftPack = createDraftPagePack(sourcePack.document.title, sourcePack.document.source_pdf_url, knownPageCount, sourcePack.document.id);
          let workingPack: PagePack = {
            ...sourcePack,
            document: {
              ...sourcePack.document,
              page_count: knownPageCount,
            },
            pages: Array.from({ length: knownPageCount }, (_, pageIndex) => {
              const pageNo = pageIndex + 1;
              return sourcePagesByNumber.get(pageNo) || draftPack.pages[pageIndex];
            }),
          };
          const documentPriorityPage = item.currentPdfPageNumber || 1;
          let pagesToGenerate = prioritizeTeachingPages(
            workingPack.pages.filter((page) => !hasCompletedTeaching(page, p.teachingOutputLanguage)),
            documentPriorityPage,
          );
          if (persistedPageCount > 0 && !pagesToGenerate.length) {
            checkedTotal += workingPack.pages.length;
            skippedTotal += workingPack.pages.length;
            if (item.documentId === _documentId) p.setPack(workingPack);
            return;
          }

          const targetPageNumbers = pagesToGenerate.map((page) => page.page_no);
          const activeDocumentExtractionReady =
            item.documentId === _documentId &&
            p.pdfExtractedPages.length >= Math.max(p.pdfPageCount || p.pack.document.page_count || item.pageCount || 0, 1);
          const useWarmupExtraction = !activeDocumentExtractionReady && persistedPageCount <= 0;
          const warmupPageNumbers = useWarmupExtraction
            ? teachingWarmupPageNumbers(
                Math.max(bundle.document.pageCount || 0, item.pageCount || 0, knownPageCount),
                documentPriorityPage,
              )
            : [];
          const selectiveExtractionPageNumbers = useWarmupExtraction
            ? warmupPageNumbers
            : persistedPageCount > 0
              ? teachingExtractionPageNumbers(knownPageCount, targetPageNumbers)
              : undefined;
          const extracted = activeDocumentExtractionReady
            ? {
                pageCount: Math.max(p.pdfPageCount || p.pack.document.page_count || item.pageCount || p.pdfExtractedPages.length, 1),
                pages: p.pdfExtractedPages,
              }
            : await extractPdfPagesForGeneration(pdfBlob, {
                priorityPageNumbers: [item.currentPdfPageNumber || 1, ...targetPageNumbers, ...warmupPageNumbers],
                pageNumbers: selectiveExtractionPageNumbers,
                shouldCancel: () => generationSignal.aborted,
                concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
              }, generationSignal).catch(() => {
                if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
                return { pageCount: knownPageCount, pages: [] as PdfContextPage[] };
              });
          if (generationSignal.aborted) return;
          let totalPages = Math.max(extracted.pageCount, bundle.document.pageCount || 0, bundle.generatedPages.length, 1);
          let extractedPagesForGeneration = extracted.pages;
          const sourceTextByPage = new Map<number, string>();
          const mergeExtractedPages = (pages: PdfContextPage[]) => {
            extractedPagesForGeneration = mergePdfContextPages(extractedPagesForGeneration, pages);
            for (const page of pages) {
              sourceTextByPage.set(page.page_no, page.text_md);
            }
          };
          mergeExtractedPages(extracted.pages);

          let workingPagesByNumber = new Map<number, PageData>();
          const failedThisRun = new Set<number>();
          const rebuildWorkingPack = () => {
            draftPack = createDraftPagePack(sourcePack.document.title, sourcePack.document.source_pdf_url, totalPages, sourcePack.document.id);
            workingPack = {
              ...sourcePack,
              document: {
                ...sourcePack.document,
                page_count: totalPages,
              },
              pages: Array.from({ length: totalPages }, (_, pageIndex) => {
                const pageNo = pageIndex + 1;
                const existing = workingPagesByNumber.get(pageNo) || sourcePagesByNumber.get(pageNo) || draftPack.pages[pageIndex];
                return pageWithSourceText(existing, sourceTextByPage.get(pageNo) || "");
              }),
            };
            workingPagesByNumber = new Map(workingPack.pages.map((page) => [page.page_no, page]));
          };
          rebuildWorkingPack();

          const initialPagesToGenerate = prioritizeTeachingPages(
            workingPack.pages.filter((page) => !hasCompletedTeaching(page, p.teachingOutputLanguage)),
            documentPriorityPage,
          );
          const skippedPages = workingPack.pages.length - initialPagesToGenerate.length;
          checkedTotal += workingPack.pages.length;
          skippedTotal += skippedPages;
          if (!initialPagesToGenerate.length) {
            if (item.documentId === _documentId) p.setPack(workingPack);
            return;
          }

          const getDocumentFileForPlan = createDocumentFileLoaderFromBlob({
            pdfBlob,
            fileName: bundle.document.fileName,
            workspaceId: _workspaceId,
            documentId: item.documentId,
          });
          const persistPage = createPersistGeneratedPage({
            workspaceId: _workspaceId,
            documentId: item.documentId,
            currentDocumentId: item.documentId,
          });
          const persistQueue = createPersistenceQueue(persistPage);

          const commitGeneratedPage = (generatedPage: PageData) => {
            if (generationSignal.aborted) return;
            workingPack = mergePageIntoPack(workingPack, generatedPage);
            workingPagesByNumber.set(generatedPage.page_no, generatedPage);
            completedTotal += 1;
            if (item.documentId === _documentId) p.setPack(workingPack);
            persistQueue.enqueue(generatedPage);
          };

          const runGenerationPass = async (passPagesToGenerate: PageData[], contextPages: PdfContextPage[]) => {
            if (!passPagesToGenerate.length || generationSignal.aborted) return;
            const documentContext = fullPdfContextForTeachingGeneration(
              workingPack,
              totalPages,
              contextPages,
              passPagesToGenerate.map((page) => page.page_no),
            );
            const lessonPlan = workingPack.document.lesson_plan;
            const handoffFor = (pageNo: number) => {
              const previous = workingPagesByNumber.get(pageNo - 1);
              return previous && hasCompletedTeaching(previous, p.teachingOutputLanguage) ? previous.teaching.handoff || "" : "";
            };
            const generationInputPagesByNumber = new Map(workingPagesByNumber);
            let started = 0;
            const markRunningPage = (pageToGenerate: PageData) => {
              const pageNo = pageToGenerate.page_no;
              const basePage = generationInputPagesByNumber.get(pageNo) || draftPack.pages[pageNo - 1];
              if (generationSignal.aborted) return basePage;
              const runningPage = buildRunningPageData(basePage, p.teachingOutputLanguage);
              workingPack = mergePageIntoPack(workingPack, runningPage);
              workingPagesByNumber.set(pageNo, runningPage);
              if (item.documentId === _documentId) p.setPack(workingPack);
              started += 1;
              p.setJobStatus(`${p.copy.status.generationBatchDocument(index + 1, projectDocumentItems.length, item.title || "")} · ${p.copy.status.generationPage(started, passPagesToGenerate.length, pageNo)}`);
              return runningPage;
            };

            const requestGeneratedPage = async (runningPage: PageData, plan: TeachingGenerationQualityPlan) => {
              const pageNo = runningPage.page_no;
              const previousPage = generationInputPagesByNumber.get(pageNo - 1);
              const nextPage = generationInputPagesByNumber.get(pageNo + 1);
              const documentFile = await getDocumentFileForPlan(plan);
              const priority = item.documentId === _documentId
                ? teachingModelRequestPriority([runningPage], p.currentPdfPageNo, "next", "later")
                : "later";
              const timeoutMs = teachingRequestTimeoutMs(plan.reasoningEffort, 1, runtimeLimits.deadlines);
              const response = await runLimitedGenerationRequest(
                runTeachingModelRequest,
                { priority, signal: generationSignal },
                () =>
                  runGenerationRequestWithTimeout(generationSignal, timeoutMs, (requestSignal) =>
                    requestJson<GeneratedTeachingPageResponse>(
                      "/api/generate/page",
                      {
                        ...buildSinglePageRequestBody({
                          plan,
                          document: workingPack.document,
                          documentContext,
                          documentFile,
                          outputLanguage: p.teachingOutputLanguage,
                          outputLanguageLabel: teachingOutputLanguageName(p.teachingOutputLanguage),
                          uiLanguage: p.uiPreferences.language,
                          runningPage,
                          pageCount: totalPages,
                          lessonPlan: lessonPlanRequestSlice(lessonPlan, [pageNo], handoffFor(pageNo)),
                          previousPage: previousPage
                            ? { page_no: previousPage.page_no, title: previousPage.teaching.slide_title }
                            : null,
                          nextPage: nextPage
                            ? { page_no: nextPage.page_no, title: nextPage.teaching.slide_title }
                            : null,
                        }),
                        signal: requestSignal,
                      },
                      p.copy.errors.accountNotFound,
                    ),
                  {
                    timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(timeoutMs)),
                    slowMs: generationSlowNoticeIntervalMs(),
                    onSlow: (elapsedSeconds) => p.setJobStatus(p.copy.status.generationPageSlow(pageNo, elapsedSeconds)),
                  }),
              );
              const normalizedGeneratedPage = normalizeGeneratedPage(response.page, runningPage);
              return {
                ...normalizedGeneratedPage,
                teaching: {
                  ...normalizedGeneratedPage.teaching,
                  output_language: p.teachingOutputLanguage,
                },
              };
            };

            const generateSinglePage = async (
              runningPage: PageData,
              plan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "initial", p.modelApiConfig),
              fallbackOnFailure?: PageData,
            ) => {
              const pageNo = runningPage.page_no;
              if (generationSignal.aborted) return;
              await generatePageWithAutoRetry({
                runningPage,
                initialPlan: plan,
                depth: lessonPlanDepthForPage(lessonPlan, pageNo),
                preference: p.uiPreferences.modelReasoningEffort,
                modelApiConfig: p.modelApiConfig,
                outputLanguage: p.teachingOutputLanguage,
                copy: p.copy,
                signal: generationSignal,
                fallbackOnFailure,
                requestGeneratedPage,
                commitGeneratedPage,
                markRetryingPage: (page, attempt, totalAttempts, kind) => {
                  if (generationSignal.aborted) return;
                  const retryingPage = buildRetryingPageData(page, p.teachingOutputLanguage);
                  workingPack = mergePageIntoPack(workingPack, retryingPage);
                  workingPagesByNumber.set(pageNo, retryingPage);
                  if (item.documentId === _documentId) p.setPack(workingPack);
                  p.setJobStatus(`${p.copy.status.generationBatchDocument(index + 1, projectDocumentItems.length, item.title || "")} · ${p.copy.status.generationPageRetryingReason(pageNo, attempt, totalAttempts, retryReasonText(kind, p.copy))}`);
                },
                commitFailedPage: (failedPage) => {
                  if (generationSignal.aborted) return;
                  workingPack = mergePageIntoPack(workingPack, failedPage);
                  workingPagesByNumber.set(pageNo, failedPage);
                  if (item.documentId === _documentId) p.setPack(workingPack);
                  p.setJobStatus(p.copy.status.generationPageFailed(pageNo, generationFailureMessage(failedPage)));
                  failedThisRun.add(pageNo);
                  persistQueue.enqueue(failedPage);
                },
              });
            };

            const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort, p.modelApiConfig, {
              lessonPlan,
              currentPageNo: documentPriorityPage,
            });
            const runPageBatch = async (pageBatch: TeachingGenerationBatch) => {
              if (generationSignal.aborted) return;
              const runningPages = pageBatch.pages.map(markRunningPage);
              if (runningPages.length === 1) {
                await generateSinglePage(runningPages[0], pageBatch.plan);
                return;
              }

              const handledPageNumbers = new Set<number>();
              try {
                const documentFile = await getDocumentFileForPlan(pageBatch.plan);
                const priority = item.documentId === _documentId
                  ? teachingModelRequestPriority(runningPages, p.currentPdfPageNo, "next", "later")
                  : "later";
                const timeoutMs = teachingRequestTimeoutMs(
                  pageBatch.plan.reasoningEffort,
                  runningPages.length,
                  runtimeLimits.deadlines,
                );
                const response = await runLimitedGenerationRequest(
                  runTeachingModelRequest,
                  { priority, signal: generationSignal },
                  () =>
                    runGenerationRequestWithTimeout(generationSignal, timeoutMs, (requestSignal) =>
                      requestJson<BatchGenerationResponse>(
                        "/api/generate/pages",
                        {
                          ...buildBatchPagesRequestBody({
                            plan: pageBatch.plan,
                            document: workingPack.document,
                            documentContext,
                            documentFile,
                            outputLanguage: p.teachingOutputLanguage,
                            outputLanguageLabel: teachingOutputLanguageName(p.teachingOutputLanguage),
                            uiLanguage: p.uiPreferences.language,
                            runningPages,
                            pageCount: totalPages,
                            lessonPlan: lessonPlanRequestSlice(
                              lessonPlan,
                              runningPages.map((page) => page.page_no),
                              handoffFor(runningPages[0].page_no),
                            ),
                          }),
                          signal: requestSignal,
                        },
                        p.copy.errors.accountNotFound,
                      ),
                    {
                      timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(timeoutMs)),
                      slowMs: generationSlowNoticeIntervalMs(),
                      onSlow: (elapsedSeconds) =>
                        p.setJobStatus(p.copy.status.generationBatchSlow(runningPages.length, elapsedSeconds)),
                    }),
                );
                const outcome = resolveBatchResponse({
                  response,
                  runningPages,
                  plan: pageBatch.plan,
                  lessonPlan,
                  outputLanguage: p.teachingOutputLanguage,
                  preference: p.uiPreferences.modelReasoningEffort,
                  modelApiConfig: p.modelApiConfig,
                  isAborted: () => generationSignal.aborted,
                  commitGeneratedPage: (generatedPage) => {
                    workingPack = mergePageIntoPack(workingPack, generatedPage);
                    workingPagesByNumber.set(generatedPage.page_no, generatedPage);
                    completedTotal += 1;
                    persistQueue.enqueue(generatedPage);
                  },
                  onHandled: (pageNo) => handledPageNumbers.add(pageNo),
                });
                if (generationSignal.aborted) return;
                if (item.documentId === _documentId) p.setPack(workingPack);
                await runWithConcurrencyLimit(outcome.weakPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async ({ runningPage, retryPlan, fallback }) => {
                  await generateSinglePage(runningPage, retryPlan, fallback);
                });
                await runWithConcurrencyLimit(outcome.missingPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                  await generateSinglePage(runningPage, singlePageFallbackPlan(pageBatch.plan, runningPage, p.uiPreferences.modelReasoningEffort, p.modelApiConfig));
                });
              } catch (error) {
                if (generationSignal.aborted || isAbortError(error)) return;
                const classification = classifyGenerationFailure(error);
                const pendingPages = runningPages.filter((page) => !handledPageNumbers.has(page.page_no));
                await runWithConcurrencyLimit(pendingPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                  await generateSinglePage(
                    runningPage,
                    batchFailureFallbackPlan(classification, pageBatch.plan, runningPage, p.uiPreferences.modelReasoningEffort, p.modelApiConfig),
                  );
                });
              }
            };
            await runWithConcurrencyLimit(groupTeachingBatchesBySegment(pageBatches), TEACHING_BATCH_DISPATCH_CONCURRENCY, async (segmentBatches) => {
              for (const pageBatch of segmentBatches) {
                if (generationSignal.aborted) return;
                await runPageBatch(pageBatch);
              }
            }, { signal: generationSignal });
          };

          if (useWarmupExtraction) {
            const warmupPageSet = new Set(warmupPageNumbers);
            const remainingInitialTargetPageNumbers = initialPagesToGenerate
              .filter((page) => !warmupPageSet.has(page.page_no))
              .map((page) => page.page_no);
            const remainingExtractionPageNumbers = teachingExtractionPageNumbers(totalPages, remainingInitialTargetPageNumbers)
              .filter((pageNo) => !sourceTextByPage.has(pageNo));
            const remainingExtractionPromise = remainingExtractionPageNumbers.length
              ? extractPdfPagesForGeneration(pdfBlob, {
                  priorityPageNumbers: [item.currentPdfPageNumber || 1, ...remainingInitialTargetPageNumbers],
                  pageNumbers: remainingExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }, generationSignal).catch(() => {
                  if (!generationSignal.aborted) p.setJobStatus(p.copy.status.pdfTextExtractionFallback);
                  return { pageCount: totalPages, pages: [] as PdfContextPage[] };
                })
              : Promise.resolve({ pageCount: totalPages, pages: [] as PdfContextPage[] });
            void remainingExtractionPromise.catch(() => undefined);
            await runGenerationPass(
              initialPagesToGenerate.filter((page) => warmupPageSet.has(page.page_no)),
              extractedPagesForGeneration,
            );
            if (generationSignal.aborted) return;
            const remainingTargetPageNumbers = prioritizeTeachingPages(
              workingPack.pages.filter((page) => needsGenerationPass(page, p.teachingOutputLanguage, failedThisRun)),
              documentPriorityPage,
            ).map((page) => page.page_no);
            if (remainingTargetPageNumbers.length) {
              const remainingExtracted = await remainingExtractionPromise;
              if (generationSignal.aborted) return;
              mergeExtractedPages(remainingExtracted.pages);
              rebuildWorkingPack();
              const remainingPagesToGenerate = prioritizeTeachingPages(
                workingPack.pages.filter((page) => needsGenerationPass(page, p.teachingOutputLanguage, failedThisRun)),
                documentPriorityPage,
              );
              await runGenerationPass(remainingPagesToGenerate, extractedPagesForGeneration);
            } else {
              await remainingExtractionPromise.catch(() => null);
            }
          } else {
            await runGenerationPass(initialPagesToGenerate, extractedPagesForGeneration);
          }

          if (generationSignal.aborted) return;
          await persistQueue.flush();
          await saveGeneratedPagesFromPack({ workspaceId: _workspaceId, documentId: item.documentId, pack: workingPack });
          if (item.documentId === _documentId) p.setPack(workingPack);
        }, { continueOnError: true, signal: generationSignal });

        if (generationSignal.aborted) return;
        await p.refreshDocumentItems(_workspaceId, _documentId, _activeProjectId);
        p.setJobStatus(p.copy.status.generationBatchDone(completedTotal, checkedTotal || estimatedPages, processedDocuments, skippedTotal));
      } catch (error) {
        if (generationSignal.aborted || isAbortError(error)) return;
        p.setJobStatus(generationErrorMessage(error, p.copy));
      } finally {
        if (p.generationAbortControllerRef.current === generationAbortController) {
          p.generationAbortControllerRef.current = null;
          p.setIsGeneratingNotes(false);
        }
      }
    })();
  }, [
    p.activeProjectId,
    p.copy,
    p.currentPdfPageNo,
    p.documentId,
    p.documentItems,
    p.isGeneratingNotes,
    p.modelApiConfig,
    p.pack.document.page_count,
    p.pdfExtractedPages,
    p.pdfPageCount,
    p.refreshDocumentItems,
    p.teachingOutputLanguage,
    p.uiPreferences.language,
    p.uiPreferences.modelReasoningEffort,
    p.workspaceId,
  ]);

  return { handleGenerateNotes, handleGenerateProjectMissingNotes };
}

type GeneratePageWithAutoRetryOptions = {
  runningPage: PageData;
  initialPlan: TeachingGenerationQualityPlan;
  /** Depth the lesson plan assigned; relaxes the weak-output floor for skim and brief pages. */
  depth?: LessonPlanDepth;
  preference: UiPreferences["modelReasoningEffort"];
  modelApiConfig: ModelApiConfig;
  outputLanguage: TeachingOutputLanguage;
  copy: AppCopy;
  signal: AbortSignal;
  fallbackOnFailure?: PageData;
  requestGeneratedPage: (runningPage: PageData, plan: TeachingGenerationQualityPlan) => Promise<PageData>;
  commitGeneratedPage: (generatedPage: PageData) => Promise<void> | void;
  commitFailedPage: (failedPage: PageData) => Promise<void> | void;
  markRetryingPage: (
    runningPage: PageData,
    attempt: number,
    totalAttempts: number,
    kind: GenerationFailureKind,
  ) => void;
};

/**
 * Per-page retry loop. The plan for attempt N+1 is derived from WHY attempt N
 * failed (planForRetry), so a slow/rate-limited upstream never turns into a
 * heavier, slower request. Only a weak model answer escalates, and only once.
 */
async function generatePageWithAutoRetry({
  runningPage,
  initialPlan,
  depth,
  preference,
  modelApiConfig,
  outputLanguage,
  copy,
  signal,
  fallbackOnFailure,
  requestGeneratedPage,
  commitGeneratedPage,
  commitFailedPage,
  markRetryingPage,
}: GeneratePageWithAutoRetryOptions) {
  let bestFallback = fallbackOnFailure;
  let lastError: unknown = null;
  let lastFailureKind: GenerationFailureKind | null = null;
  let plan = initialPlan;
  let transportFailureSeen = false;
  let qualityEscalations = 0;
  let usedAttempts = 0;
  const retryContext = { page: runningPage, preference, modelApiConfig };

  for (let attempt = 1; attempt <= TEACHING_PAGE_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return;
    usedAttempts = attempt;

    try {
      const generatedPage = await requestGeneratedPage(runningPage, plan);
      const shouldRetryWeakOutput =
        plan.retryOnWeakOutput &&
        generatedTeachingNeedsRetry(generatedPage, depth) &&
        !transportFailureSeen &&
        qualityEscalations < 1 &&
        attempt < TEACHING_PAGE_MAX_ATTEMPTS;
      if (shouldRetryWeakOutput) {
        bestFallback = bestFallback && shouldPreferTeachingCandidate(bestFallback, generatedPage, depth)
          ? bestFallback
          : generatedPage;
        qualityEscalations += 1;
        lastFailureKind = "quality";
        plan = planForRetry("quality", plan, attempt, retryContext);
        markRetryingPage(runningPage, attempt + 1, TEACHING_PAGE_MAX_ATTEMPTS, "quality");
        await waitBeforeTeachingRetry(attempt, "quality", signal);
        continue;
      }

      const finalPage = bestFallback && shouldPreferTeachingCandidate(bestFallback, generatedPage, depth)
        ? bestFallback
        : generatedPage;
      await commitGeneratedPage(finalPage);
      return;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      lastError = error;
      const classification = classifyGenerationFailure(error);
      lastFailureKind = classification.kind;
      if (attempt >= TEACHING_PAGE_MAX_ATTEMPTS || !classification.retryable) break;
      transportFailureSeen = true;
      plan = planForRetry(classification.kind, plan, attempt, retryContext);
      markRetryingPage(runningPage, attempt + 1, TEACHING_PAGE_MAX_ATTEMPTS, classification.kind);
      await waitBeforeTeachingRetry(attempt, classification.kind, signal);
    }
  }

  if (bestFallback) {
    await commitGeneratedPage(bestFallback);
    return;
  }

  const message = (lastError as Error | null)?.message || copy.agent.generationFailed;
  await commitFailedPage(
    buildFailedPageData(
      runningPage,
      message,
      outputLanguage,
      copy,
      lastFailureKind ? { kind: lastFailureKind, attempts: usedAttempts } : undefined,
    ),
  );
}

// ── Shared request/limiter plumbing (used by both generation flows) ──

export type BatchGenerationResponse = GeneratedTeachingPagesResponse & {
  missing?: unknown;
  timing?: { elapsed_ms?: number; attempts?: number; coalesced?: boolean };
};

/**
 * Client timeout = backend deadline for this effort (+ per-extra-batch-page
 * budget) + a margin, so the client never gives up on a request the backend is
 * still legitimately working on.
 */
export function teachingRequestTimeoutMs(
  effort: UiPreferences["modelReasoningEffort"],
  pageCount = 1,
  deadlines?: Record<string, number>,
) {
  const configured = Number(deadlines?.[effort]);
  const baseSeconds = Number.isFinite(configured) && configured > 0
    ? Math.max(configured, TEACHING_BACKEND_DEADLINE_SECONDS[effort] ?? 300)
    : TEACHING_BACKEND_DEADLINE_SECONDS[effort] ?? 300;
  const extraSeconds = Math.max(0, Math.floor(pageCount) - TEACHING_BATCH_EXTRA_FREE_PAGES) * TEACHING_BATCH_EXTRA_SECONDS_PER_PAGE;
  return (baseSeconds + extraSeconds) * 1_000 + TEACHING_REQUEST_TIMEOUT_MARGIN_MS;
}

function createTeachingRequestLimiter(params: {
  modelRef: { providerId: string; model: string };
  maxConcurrency: number;
  onRateLimited: (seconds: number) => void;
  onConcurrencyReduced: (limit: number) => void;
}): AsyncLimiter {
  const { providerId, model } = params.modelRef;
  const persistKey = generationWindowStorageKey(providerId, model);
  const initial = initialGenerationWindow(model, loadPersistedGenerationWindow(persistKey));
  // Reasoning models stay well under the backend semaphore; fast models may use it all.
  const ceiling = Math.min(params.maxConcurrency, isReasoningGenerationModel(model) ? 4 : 6);
  return createAsyncLimiter({
    min: 1,
    max: Math.max(initial, ceiling),
    initial,
    persistKey,
    onGate: (gateMs) => params.onRateLimited(Math.max(1, Math.round(gateMs / 1_000))),
    onWindowChange: (concurrency, direction) => {
      if (direction === "decrease") params.onConcurrencyReduced(concurrency);
    },
  });
}

/** Runs a request through the shared limiter and feeds the outcome back to it. */
async function runLimitedGenerationRequest<T>(
  limiter: AsyncLimiter,
  options: { priority: AsyncLimiterPriority; signal: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await limiter(run, options);
    limiter.report({ outcome: "success", latencyMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    if (!isAbortError(error)) {
      const classification = classifyGenerationFailure(error);
      limiter.report({
        outcome: limiterOutcomeForFailure(classification),
        latencyMs: Date.now() - startedAt,
        retryAfterMs: classification.retryAfterMs,
      });
    }
    throw error;
  }
}

type BatchResponseOutcome = {
  missingPages: PageData[];
  weakPages: Array<{ runningPage: PageData; retryPlan: TeachingGenerationQualityPlan; fallback: PageData }>;
};

/**
 * Commits every page the batch actually returned and reports the rest.
 * A partially parsed batch must never discard the pages that did come back.
 */
function resolveBatchResponse(params: {
  response: BatchGenerationResponse;
  runningPages: PageData[];
  plan: TeachingGenerationQualityPlan;
  lessonPlan?: LessonPlan;
  outputLanguage: TeachingOutputLanguage;
  preference: UiPreferences["modelReasoningEffort"];
  modelApiConfig: ModelApiConfig;
  isAborted: () => boolean;
  commitGeneratedPage: (page: PageData) => void;
  onHandled: (pageNo: number) => void;
}): BatchResponseOutcome {
  const { response, runningPages, plan, lessonPlan, outputLanguage, preference, modelApiConfig } = params;
  const generatedPagesByNumber = new Map(
    (Array.isArray(response.pages) ? response.pages : []).map((page) => [Number(page.page_no || 0), page]),
  );
  const reportedMissing = new Set(
    (Array.isArray(response.missing) ? response.missing : [])
      .map((pageNo) => Number(pageNo))
      .filter((pageNo) => Number.isFinite(pageNo)),
  );
  const outcome: BatchResponseOutcome = { missingPages: [], weakPages: [] };

  for (const runningPage of runningPages) {
    if (params.isAborted()) break;
    const rawGeneratedPage = generatedPagesByNumber.get(runningPage.page_no);
    if (!rawGeneratedPage || reportedMissing.has(runningPage.page_no)) {
      outcome.missingPages.push(runningPage);
      continue;
    }
    const normalizedGeneratedPage = normalizeGeneratedPage(rawGeneratedPage, runningPage);
    const generatedPage: PageData = {
      ...normalizedGeneratedPage,
      teaching: {
        ...normalizedGeneratedPage.teaching,
        output_language: outputLanguage,
      },
    };
    if (plan.retryOnWeakOutput && generatedTeachingNeedsRetry(generatedPage, lessonPlanDepthForPage(lessonPlan, runningPage.page_no))) {
      outcome.weakPages.push({
        runningPage,
        retryPlan: teachingGenerationQualityPlan(runningPage, preference, "retry", modelApiConfig),
        fallback: generatedPage,
      });
      params.onHandled(runningPage.page_no);
      continue;
    }
    params.commitGeneratedPage(generatedPage);
    params.onHandled(runningPage.page_no);
  }
  return outcome;
}

/** Plan for a page the batch did not return: same weight, single page. */
function singlePageFallbackPlan(
  batchPlan: TeachingGenerationQualityPlan,
  runningPage: PageData,
  preference: UiPreferences["modelReasoningEffort"],
  modelApiConfig: ModelApiConfig,
) {
  return planForRetry("invalid_json", batchPlan, 1, { page: runningPage, preference, modelApiConfig });
}

/** Plan after the whole batch request failed — never heavier than the batch. */
function batchFailureFallbackPlan(
  classification: GenerationFailureClassification,
  batchPlan: TeachingGenerationQualityPlan,
  runningPage: PageData,
  preference: UiPreferences["modelReasoningEffort"],
  modelApiConfig: ModelApiConfig,
) {
  if (!classification.retryable) {
    return teachingGenerationQualityPlan(runningPage, preference, "initial", modelApiConfig);
  }
  return planForRetry(classification.kind, batchPlan, 1, { page: runningPage, preference, modelApiConfig });
}

function retryReasonText(kind: GenerationFailureKind, copy: AppCopy) {
  switch (kind) {
    case "timeout":
      return copy.status.generationRetryReasonTimeout;
    case "rate_limit":
      return copy.status.generationRetryReasonRateLimit;
    case "network":
      return copy.status.generationRetryReasonNetwork;
    case "invalid_json":
    case "truncated":
      return copy.status.generationRetryReasonInvalidJson;
    case "quality":
      return copy.status.generationRetryReasonWeakOutput;
    default:
      return copy.status.generationRetryReasonServer;
  }
}

/**
 * A page still needs a generation pass and is not one THIS run already gave up
 * on. Pages that failed in an earlier session stay eligible (F04).
 */
function needsGenerationPass(page: PageData, outputLanguage: TeachingOutputLanguage, failedThisRun: Set<number>) {
  return !failedThisRun.has(page.page_no) && !hasCompletedTeaching(page, outputLanguage);
}

/** Optional backend runtime limits; old backends 404 and we keep the defaults. */
async function fetchGenerationRuntimeLimits(signal: AbortSignal): Promise<GenerationRuntimeLimits | null> {
  try {
    const response = await runGenerationRequestWithTimeout(
      signal,
      GENERATION_STATUS_REQUEST_TIMEOUT_MS,
      (requestSignal) =>
        requestJson<{ concurrency?: number; deadlines_seconds?: Record<string, number> }>(
          "/api/generate/status",
          { method: "GET", signal: requestSignal },
        ),
    );
    const deadlines = response?.deadlines_seconds;
    const concurrency = Number(response?.concurrency);
    return {
      deadlines: deadlines && typeof deadlines === "object" ? deadlines : undefined,
      concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
    };
  } catch {
    return null;
  }
}

function buildRetryingPageData(page: PageData, outputLanguage: TeachingOutputLanguage): PageData {
  return {
    ...page,
    status: "retrying",
    teaching: {
      ...page.teaching,
      output_language: outputLanguage,
    },
  };
}

function generationFailureMessage(page: PageData) {
  return page.teaching.speaker_notes_md.replace(/^## .+?\n\n/s, "").trim() || "Generation failed";
}

function generationErrorMessage(error: unknown, copy: AppCopy) {
  const message = (error as Error | null)?.message || String(error || "");
  return message.trim() || copy.agent.generationFailed;
}

function failActiveGenerationPages(
  pack: PagePack,
  message: string,
  outputLanguage: TeachingOutputLanguage,
  copy: AppCopy,
  kind?: GenerationFailureKind,
): PagePack {
  return {
    ...pack,
    pages: pack.pages.map((page) => {
      if (page.status !== "running" && page.status !== "retrying") return page;
      return buildFailedPageData(page, message, outputLanguage, copy, kind ? { kind, attempts: 1 } : undefined);
    }),
  };
}

/**
 * 3 s / 10 s / 30 s with +-30% jitter. Rate limits do NOT wait here: the shared
 * limiter gate already holds every page until the cooldown expires, so adding a
 * per-page sleep would only serialise the run.
 */
export function teachingRetryDelayMs(attempt: number, kind: GenerationFailureKind) {
  if (kind === "rate_limit") return 0;
  const baseDelay = TEACHING_PAGE_RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), TEACHING_PAGE_RETRY_DELAYS_MS.length - 1)];
  const jitter = 1 - TEACHING_RETRY_JITTER_RATIO + Math.random() * TEACHING_RETRY_JITTER_RATIO * 2;
  return Math.round(baseDelay * jitter);
}

async function waitBeforeTeachingRetry(attempt: number, kind: GenerationFailureKind, signal: AbortSignal) {
  await abortableDelay(teachingRetryDelayMs(attempt, kind), signal);
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  let abort: (() => void) | null = null;
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    abort = () => {
      window.clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  }).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
}

async function fetchPdfBlobForGeneration(pdfUrl: string, signal: AbortSignal, copy: AppCopy) {
  const response = await runGenerationRequestWithTimeout(
    signal,
    PDF_FETCH_TIMEOUT_MS,
    (requestSignal) => fetch(pdfUrl, { signal: requestSignal }),
    { timeoutMessage: copy.errors.generationRequestTimedOut(timeoutSeconds(PDF_FETCH_TIMEOUT_MS)) },
  );
  if (!response.ok) throw new Error(response.statusText || copy.agent.generationFailed);
  return runGenerationRequestWithTimeout(
    signal,
    PDF_FETCH_TIMEOUT_MS,
    () => response.blob(),
    { timeoutMessage: copy.errors.generationRequestTimedOut(timeoutSeconds(PDF_FETCH_TIMEOUT_MS)) },
  );
}

async function extractPdfPagesForGeneration(
  blob: Blob,
  options: PdfPageExtractionOptions,
  signal: AbortSignal,
) {
  const timeoutMs = pdfExtractionTimeoutMs(options.pageNumbers || options.priorityPageNumbers);
  return runGenerationRequestWithTimeout(
    signal,
    timeoutMs,
    (requestSignal) => extractPdfPagesFromBlob(blob, {
      ...options,
      shouldCancel: () => signal.aborted || requestSignal.aborted || Boolean(options.shouldCancel?.()),
    }),
  );
}

/**
 * Runs a request with a hard deadline and an INFORMATIONAL slow-progress
 * notice. The slow notice never aborts: on a reasoning model a 60-300 s request
 * is normal, and aborting it left the backend burning tokens on a request
 * nobody was listening to (F01/F02).
 */
async function runGenerationRequestWithTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  options: GenerationRequestWatchdogOptions = {},
) {
  if (parentSignal.aborted) throw createAbortError();

  const controller = new AbortController();
  const timeoutError = createGenerationTimeoutError(timeoutMs, options.timeoutMessage);
  const slowMs = options.onSlow && options.slowMs && options.slowMs > 0 ? options.slowMs : 0;
  let timeoutTimer: number | null = null;
  let slowTimer: number | null = null;
  let abortFromParent: (() => void) | null = null;
  const startedAt = Date.now();

  const runPromise = Promise.resolve().then(() => run(controller.signal));
  const abortRace = new Promise<never>((_resolve, reject) => {
    abortFromParent = () => {
      controller.abort(parentSignal.reason);
      reject(createAbortError());
    };
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  });
  const timeoutRace = new Promise<never>((_resolve, reject) => {
    timeoutTimer = window.setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  if (slowMs) {
    slowTimer = window.setInterval(() => {
      options.onSlow?.(Math.max(1, Math.round((Date.now() - startedAt) / 1_000)));
    }, slowMs);
  }

  try {
    return await Promise.race([runPromise, abortRace, timeoutRace]);
  } finally {
    runPromise.catch(() => undefined);
    if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
    if (slowTimer !== null) window.clearInterval(slowTimer);
    if (abortFromParent) parentSignal.removeEventListener("abort", abortFromParent);
  }
}

/**
 * Cadence of the informational "still generating" status line. The window
 * override only shortens the notice interval now — it no longer aborts anything.
 */
function generationSlowNoticeIntervalMs() {
  const override = typeof window === "undefined"
    ? NaN
    : Number((window as Window & { __SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS?: unknown }).__SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(TEACHING_SLOW_NOTICE_INTERVAL_MS, Math.max(100, Math.floor(override)));
  }
  return TEACHING_SLOW_NOTICE_INTERVAL_MS;
}

function pdfExtractionTimeoutMs(pageNumbers?: number[]) {
  const pageCount = Math.max(1, pageNumbers?.length || 1);
  return Math.min(
    PDF_TEXT_EXTRACTION_MAX_TIMEOUT_MS,
    PDF_TEXT_EXTRACTION_BASE_TIMEOUT_MS + pageCount * PDF_TEXT_EXTRACTION_PER_PAGE_TIMEOUT_MS,
  );
}

function createGenerationTimeoutError(timeoutMs: number, message?: string) {
  const seconds = timeoutSeconds(timeoutMs);
  const error = new Error(message || `讲解生成超时（${seconds} 秒）。这一页可能是图表密集页、服务端限流或上游模型处理过慢，请稍后重试。`);
  error.name = "TimeoutError";
  return error;
}

function timeoutSeconds(timeoutMs: number) {
  return Math.round(timeoutMs / 1000);
}

function createAbortError() {
  try {
    return new DOMException("Generation aborted", "AbortError");
  } catch {
    const error = new Error("Generation aborted");
    error.name = "AbortError";
    return error;
  }
}
