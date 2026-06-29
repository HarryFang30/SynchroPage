import { useCallback } from "react";
import type { AppCopy } from "../i18n";
import type {
  PageData,
  PagePack,
  TeachingGenerationQualityPlan,
  TeachingOutputLanguage,
} from "../lib/generation/teachingGeneration";
import {
  batchTeachingPages,
  fullPdfContextForTeachingGeneration,
  generatedTeachingNeedsRetry,
  lightPdfContextForFastTeachingGeneration,
  PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
  prioritizeTeachingPages,
  shouldPreferTeachingCandidate,
  teachingDocumentContextForPlan,
  TEACHING_BATCH_FALLBACK_CONCURRENCY,
  TEACHING_DOCUMENT_GENERATION_CONCURRENCY,
  TEACHING_GENERATION_CONCURRENCY,
  teachingExtractionPageNumbers,
  teachingGenerationQualityPlan,
  teachingModelRequestPriority,
  teachingOutputLanguageName,
  TEACHING_PROJECT_MODEL_REQUEST_CONCURRENCY,
  TEACHING_PROJECT_WARMUP_PAGE_COUNT,
  teachingQualityPlanPayload,
  teachingRequestPage,
  teachingWarmupPageNumbers,
  type GeneratedTeachingPageResponse,
  type GeneratedTeachingPagesResponse,
} from "../lib/generation/teachingGeneration";
import {
  createAsyncLimiter,
  mergePageIntoPack,
  missingSourceTextPageNumbers,
  normalizeGeneratedPage,
  pageWithSourceText,
  runWithConcurrencyLimit,
} from "../lib/generation/generationRuntime";
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

const TEACHING_PAGE_REQUEST_TIMEOUT_MS = 120_000;
const TEACHING_BATCH_REQUEST_TIMEOUT_MS = 150_000;
const TEACHING_BATCH_STALL_TIMEOUT_MS = 35_000;
const PDF_FETCH_TIMEOUT_MS = 30_000;
const PDF_TEXT_EXTRACTION_BASE_TIMEOUT_MS = 45_000;
const PDF_TEXT_EXTRACTION_PER_PAGE_TIMEOUT_MS = 2_000;
const PDF_TEXT_EXTRACTION_MAX_TIMEOUT_MS = 240_000;
const TEACHING_PAGE_MAX_ATTEMPTS = 3;
const TEACHING_PAGE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const TEACHING_RATE_LIMIT_EXTRA_COOLDOWN_MS = 8_000;
const TEACHING_RATE_LIMIT_EXTRA_JITTER_MS = 4_000;

type GenerationRequestWatchdogOptions = {
  timeoutMessage?: string;
  stallMs?: number;
  stallMessage?: string;
  onStall?: () => void;
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
    let pagesToGenerate = prioritizeTeachingPages(
      scopedPages.filter((item) => !hasCompletedTeaching(item, pageOutputLanguage)),
      p.currentPdfPageNo,
    );
    let skippedPages = scopedPages.length - pagesToGenerate.length;
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
      const runTeachingModelRequest = createAsyncLimiter(TEACHING_GENERATION_CONCURRENCY);
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
          p.setPack(workingPack);
          completed += 1;
          persistQueue.enqueue(generatedPage);
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
          pagesToGenerate = prioritizeTeachingPages(
            scopedPages.filter((item) => !hasCompletedTeaching(item, pageOutputLanguage)),
            p.currentPdfPageNo,
          );
          skippedPages = scopedPages.length - pagesToGenerate.length;
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
          const fastDocumentContext = lightPdfContextForFastTeachingGeneration(
            workingPack,
            totalPages,
            contextPages,
          );
          p.setJobStatus(p.copy.status.generationStarted(passPagesToGenerate.length));
          const generationInputPagesByNumber = new Map(workingPagesByNumber);
          let started = 0;
          const markRunningPage = (pageToGenerate: PageData) => {
            const pageNo = pageToGenerate.page_no;
            const basePage = generationInputPagesByNumber.get(pageNo) || draftPack.pages[pageNo - 1];
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
            const response = await runTeachingModelRequest(() =>
              runGenerationRequestWithTimeout(generationSignal, TEACHING_PAGE_REQUEST_TIMEOUT_MS, (requestSignal) =>
                requestJson<GeneratedTeachingPageResponse>(
                  "/api/generate/page",
                  {
                    method: "POST",
                    signal: requestSignal,
                    body: JSON.stringify({
                      modelProviderId: plan.providerId,
                      model: plan.model,
                      fallbackModelProviderId: plan.fallbackProviderId,
                      fallbackModel: plan.fallbackModel,
                      reasoningEffort: plan.reasoningEffort,
                      qualityPlan: teachingQualityPlanPayload(plan),
                      document: workingPack.document,
                      documentContext: teachingDocumentContextForPlan(plan, documentContext, fastDocumentContext),
                      documentFile,
                      outputLanguage: pageOutputLanguage,
                      outputLanguageLabel: pageOutputLanguageLabel,
                      uiLanguage: p.uiPreferences.language,
                      page: teachingRequestPage(runningPage, plan),
                      pageCount: totalPages,
                      previousPage: previousPage
                        ? { page_no: previousPage.page_no, title: previousPage.teaching.slide_title }
                        : null,
                      nextPage: nextPage
                        ? { page_no: nextPage.page_no, title: nextPage.teaching.slide_title }
                        : null,
                    }),
                  },
                  p.copy.errors.accountNotFound,
                ),
              {
                timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_PAGE_REQUEST_TIMEOUT_MS)),
              }),
              { priority, signal: generationSignal },
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
              preference: p.uiPreferences.modelReasoningEffort,
              modelApiConfig: p.modelApiConfig,
              outputLanguage: pageOutputLanguage,
              copy: p.copy,
              signal: generationSignal,
              fallbackOnFailure,
              requestGeneratedPage,
              commitGeneratedPage,
              markRetryingPage: (page, attempt, totalAttempts) => {
                if (generationSignal.aborted) return;
                const retryingPage = buildRetryingPageData(page, pageOutputLanguage);
                workingPack = mergePageIntoPack(workingPack, retryingPage);
                workingPagesByNumber.set(pageNo, retryingPage);
                p.setPack(workingPack);
                p.setJobStatus(p.copy.status.generationPageRetrying(pageNo, attempt, totalAttempts));
              },
              commitFailedPage: (failedPage) => {
                if (generationSignal.aborted) return;
                workingPack = mergePageIntoPack(workingPack, failedPage);
                workingPagesByNumber.set(pageNo, failedPage);
                p.setPack(workingPack);
                p.setJobStatus(p.copy.status.generationPageFailed(pageNo, generationFailureMessage(failedPage)));
                persistQueue.enqueue(failedPage);
              },
            });
          };

          const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort, p.modelApiConfig);
          await runWithConcurrencyLimit(pageBatches, TEACHING_GENERATION_CONCURRENCY, async (pageBatch) => {
            const runningPages = pageBatch.pages.map(markRunningPage);
            if (runningPages.length === 1) {
              await generateSinglePage(runningPages[0], pageBatch.plan);
              return;
            }

            try {
              const documentFile = await getDocumentFileForPlan(pageBatch.plan);
              const priority = teachingModelRequestPriority(runningPages, p.currentPdfPageNo, "now", "next");
              const batchStallMs = generationBatchStallTimeoutMs();
              const response = await runTeachingModelRequest(() =>
                runGenerationRequestWithTimeout(generationSignal, TEACHING_BATCH_REQUEST_TIMEOUT_MS, (requestSignal) =>
                  requestJson<GeneratedTeachingPagesResponse>(
                    "/api/generate/pages",
                    {
                      method: "POST",
                      signal: requestSignal,
                      body: JSON.stringify({
                        modelProviderId: pageBatch.plan.providerId,
                        model: pageBatch.plan.model,
                        fallbackModelProviderId: pageBatch.plan.fallbackProviderId,
                        fallbackModel: pageBatch.plan.fallbackModel,
                        reasoningEffort: pageBatch.plan.reasoningEffort,
                        qualityPlan: teachingQualityPlanPayload(pageBatch.plan),
                        document: workingPack.document,
                        documentContext: teachingDocumentContextForPlan(pageBatch.plan, documentContext, fastDocumentContext),
                        documentFile,
                        outputLanguage: pageOutputLanguage,
                        outputLanguageLabel: pageOutputLanguageLabel,
                        uiLanguage: p.uiPreferences.language,
                        pages: runningPages.map((page) => teachingRequestPage(page, pageBatch.plan)),
                        pageCount: totalPages,
                      }),
                    },
                    p.copy.errors.accountNotFound,
                  ),
                {
                  stallMs: batchStallMs,
                  stallMessage: p.copy.errors.generationBatchRequestStalled(timeoutSeconds(batchStallMs)),
                  onStall: () => p.setJobStatus(p.copy.errors.generationBatchRequestStalled(timeoutSeconds(batchStallMs))),
                  timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_BATCH_REQUEST_TIMEOUT_MS)),
                }),
                { priority, signal: generationSignal },
              );
              const generatedPagesByNumber = new Map(
                response.pages.map((page) => [Number(page.page_no || 0), page]),
              );
              const retryPages: Array<{ runningPage: PageData; retryPlan: TeachingGenerationQualityPlan; fallback: PageData }> = [];
              for (const runningPage of runningPages) {
                const rawGeneratedPage = generatedPagesByNumber.get(runningPage.page_no);
                if (!rawGeneratedPage) throw new Error(`Batch response missed page ${runningPage.page_no}`);
                const normalizedGeneratedPage = normalizeGeneratedPage(rawGeneratedPage, runningPage);
                const generatedPage: PageData = {
                  ...normalizedGeneratedPage,
                  teaching: {
                    ...normalizedGeneratedPage.teaching,
                    output_language: pageOutputLanguage,
                  },
                };
                if (pageBatch.plan.retryOnWeakOutput && generatedTeachingNeedsRetry(generatedPage)) {
                  const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry", p.modelApiConfig);
                  retryPages.push({ runningPage, retryPlan, fallback: generatedPage });
                  continue;
                }
                if (generationSignal.aborted) return;
                workingPack = mergePageIntoPack(workingPack, generatedPage);
                workingPagesByNumber.set(generatedPage.page_no, generatedPage);
                completed += 1;
                persistQueue.enqueue(generatedPage);
              }
              p.setPack(workingPack);
              await runWithConcurrencyLimit(retryPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async ({ runningPage, retryPlan, fallback }) => {
                await generateSinglePage(runningPage, retryPlan, fallback);
              });
            } catch {
              if (generationSignal.aborted) return;
              await runWithConcurrencyLimit(runningPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                await generateSinglePage(runningPage);
              });
            }
          });
        };

        if (p.pdfUrl && missingTargetSourceText.length) {
          p.setJobStatus(p.copy.status.pdfTextExtracting(targetPageNumbers.length - missingTargetSourceText.length, targetPageNumbers.length));
          const pdfBlob = await fetchPdfBlobForGeneration(p.pdfUrl, generationSignal, p.copy).catch(() => null);
          if (pdfBlob && missingTargetSourceText.length > TEACHING_PROJECT_WARMUP_PAGE_COUNT) {
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
            const remainingPagesToGenerate = prioritizeTeachingPages(
              scopedPages.filter((page) => !hasCompletedTeaching(page, pageOutputLanguage)),
              p.currentPdfPageNo,
            );
            await runGenerationPass(remainingPagesToGenerate, extractedPagesForGeneration);
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
          await runGenerationPass(pagesToGenerate, extractedPagesForGeneration);
        }
        if (p.workspaceId && p.documentId && workingPack.document.id === p.documentId) {
          await persistQueue.flush();
          await saveGeneratedPagesFromPack({ workspaceId: p.workspaceId, documentId: p.documentId, pack: workingPack });
          await p.refreshDocumentItems(p.workspaceId, p.documentId, p.activeProjectId);
        }
        p.setJobStatus(p.copy.status.generationDone(completed, scopedPages.length, skippedPages));
      } catch (error) {
        if (generationSignal.aborted || (error as Error).name === "AbortError") return;
        const message = generationErrorMessage(error, p.copy);
        workingPack = failActiveGenerationPages(workingPack, message, pageOutputLanguage, p.copy);
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
      const runTeachingModelRequest = createAsyncLimiter(TEACHING_PROJECT_MODEL_REQUEST_CONCURRENCY);
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
            const fastDocumentContext = lightPdfContextForFastTeachingGeneration(
              workingPack,
              totalPages,
              contextPages,
            );
            const generationInputPagesByNumber = new Map(workingPagesByNumber);
            let started = 0;
            const markRunningPage = (pageToGenerate: PageData) => {
              const pageNo = pageToGenerate.page_no;
              const basePage = generationInputPagesByNumber.get(pageNo) || draftPack.pages[pageNo - 1];
              const runningPage: PageData = {
                ...basePage,
                status: "running",
                teaching: {
                  ...basePage.teaching,
                  output_language: p.teachingOutputLanguage,
                  speaker_notes_md:
                    basePage.status === "failed" || basePage.teaching.output_language !== p.teachingOutputLanguage
                      ? ""
                      : basePage.teaching.speaker_notes_md,
                },
              };
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
              const response = await runTeachingModelRequest(() =>
                runGenerationRequestWithTimeout(generationSignal, TEACHING_PAGE_REQUEST_TIMEOUT_MS, (requestSignal) =>
                  requestJson<GeneratedTeachingPageResponse>(
                    "/api/generate/page",
                    {
                      method: "POST",
                      signal: requestSignal,
                      body: JSON.stringify({
                        modelProviderId: plan.providerId,
                        model: plan.model,
                        fallbackModelProviderId: plan.fallbackProviderId,
                        fallbackModel: plan.fallbackModel,
                        reasoningEffort: plan.reasoningEffort,
                        qualityPlan: teachingQualityPlanPayload(plan),
                        document: workingPack.document,
                        documentContext: teachingDocumentContextForPlan(plan, documentContext, fastDocumentContext),
                        documentFile,
                        outputLanguage: p.teachingOutputLanguage,
                        outputLanguageLabel: teachingOutputLanguageName(p.teachingOutputLanguage),
                        uiLanguage: p.uiPreferences.language,
                        page: teachingRequestPage(runningPage, plan),
                        pageCount: totalPages,
                        previousPage: previousPage
                          ? { page_no: previousPage.page_no, title: previousPage.teaching.slide_title }
                          : null,
                        nextPage: nextPage
                          ? { page_no: nextPage.page_no, title: nextPage.teaching.slide_title }
                          : null,
                      }),
                    },
                    p.copy.errors.accountNotFound,
                  ),
                {
                  timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_PAGE_REQUEST_TIMEOUT_MS)),
                }),
                { priority, signal: generationSignal },
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
                preference: p.uiPreferences.modelReasoningEffort,
                modelApiConfig: p.modelApiConfig,
                outputLanguage: p.teachingOutputLanguage,
                copy: p.copy,
                signal: generationSignal,
                fallbackOnFailure,
                requestGeneratedPage,
                commitGeneratedPage,
                markRetryingPage: (page, attempt, totalAttempts) => {
                  if (generationSignal.aborted) return;
                  const retryingPage = buildRetryingPageData(page, p.teachingOutputLanguage);
                  workingPack = mergePageIntoPack(workingPack, retryingPage);
                  workingPagesByNumber.set(pageNo, retryingPage);
                  if (item.documentId === _documentId) p.setPack(workingPack);
                  p.setJobStatus(`${p.copy.status.generationBatchDocument(index + 1, projectDocumentItems.length, item.title || "")} · ${p.copy.status.generationPageRetrying(pageNo, attempt, totalAttempts)}`);
                },
                commitFailedPage: (failedPage) => {
                  if (generationSignal.aborted) return;
                  workingPack = mergePageIntoPack(workingPack, failedPage);
                  workingPagesByNumber.set(pageNo, failedPage);
                  if (item.documentId === _documentId) p.setPack(workingPack);
                  p.setJobStatus(p.copy.status.generationPageFailed(pageNo, generationFailureMessage(failedPage)));
                  persistQueue.enqueue(failedPage);
                },
              });
            };

            const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort, p.modelApiConfig);
            await runWithConcurrencyLimit(pageBatches, TEACHING_GENERATION_CONCURRENCY, async (pageBatch) => {
              const runningPages = pageBatch.pages.map(markRunningPage);
              if (runningPages.length === 1) {
                await generateSinglePage(runningPages[0], pageBatch.plan);
                return;
              }

              try {
                const documentFile = await getDocumentFileForPlan(pageBatch.plan);
                const priority = item.documentId === _documentId
                  ? teachingModelRequestPriority(runningPages, p.currentPdfPageNo, "next", "later")
                  : "later";
                const batchStallMs = generationBatchStallTimeoutMs();
                const response = await runTeachingModelRequest(() =>
                  runGenerationRequestWithTimeout(generationSignal, TEACHING_BATCH_REQUEST_TIMEOUT_MS, (requestSignal) =>
                    requestJson<GeneratedTeachingPagesResponse>(
                      "/api/generate/pages",
                      {
                        method: "POST",
                        signal: requestSignal,
                        body: JSON.stringify({
                          modelProviderId: pageBatch.plan.providerId,
                          model: pageBatch.plan.model,
                          fallbackModelProviderId: pageBatch.plan.fallbackProviderId,
                          fallbackModel: pageBatch.plan.fallbackModel,
                          reasoningEffort: pageBatch.plan.reasoningEffort,
                          qualityPlan: teachingQualityPlanPayload(pageBatch.plan),
                          document: workingPack.document,
                          documentContext: teachingDocumentContextForPlan(pageBatch.plan, documentContext, fastDocumentContext),
                          documentFile,
                          outputLanguage: p.teachingOutputLanguage,
                          outputLanguageLabel: teachingOutputLanguageName(p.teachingOutputLanguage),
                          uiLanguage: p.uiPreferences.language,
                          pages: runningPages.map((page) => teachingRequestPage(page, pageBatch.plan)),
                          pageCount: totalPages,
                        }),
                      },
                      p.copy.errors.accountNotFound,
                    ),
                  {
                    stallMs: batchStallMs,
                    stallMessage: p.copy.errors.generationBatchRequestStalled(timeoutSeconds(batchStallMs)),
                    onStall: () => p.setJobStatus(p.copy.errors.generationBatchRequestStalled(timeoutSeconds(batchStallMs))),
                    timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_BATCH_REQUEST_TIMEOUT_MS)),
                  }),
                  { priority, signal: generationSignal },
                );
                const generatedPagesByNumber = new Map(
                  response.pages.map((page) => [Number(page.page_no || 0), page]),
                );
                const retryPages: Array<{ runningPage: PageData; retryPlan: TeachingGenerationQualityPlan; fallback: PageData }> = [];
                for (const runningPage of runningPages) {
                  const rawGeneratedPage = generatedPagesByNumber.get(runningPage.page_no);
                  if (!rawGeneratedPage) throw new Error(`Batch response missed page ${runningPage.page_no}`);
                  const normalizedGeneratedPage = normalizeGeneratedPage(rawGeneratedPage, runningPage);
                  const generatedPage: PageData = {
                    ...normalizedGeneratedPage,
                    teaching: {
                      ...normalizedGeneratedPage.teaching,
                      output_language: p.teachingOutputLanguage,
                    },
                  };
                  if (pageBatch.plan.retryOnWeakOutput && generatedTeachingNeedsRetry(generatedPage)) {
                    const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry", p.modelApiConfig);
                    retryPages.push({ runningPage, retryPlan, fallback: generatedPage });
                    continue;
                  }
                  if (generationSignal.aborted) return;
                  workingPack = mergePageIntoPack(workingPack, generatedPage);
                  workingPagesByNumber.set(generatedPage.page_no, generatedPage);
                  completedTotal += 1;
                  persistQueue.enqueue(generatedPage);
                }
                if (item.documentId === _documentId) p.setPack(workingPack);
                await runWithConcurrencyLimit(retryPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async ({ runningPage, retryPlan, fallback }) => {
                  await generateSinglePage(runningPage, retryPlan, fallback);
                });
              } catch {
                if (generationSignal.aborted) return;
                await runWithConcurrencyLimit(runningPages, TEACHING_BATCH_FALLBACK_CONCURRENCY, async (runningPage) => {
                  await generateSinglePage(runningPage);
                });
              }
            });
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
              workingPack.pages.filter((page) => !hasCompletedTeaching(page, p.teachingOutputLanguage)),
              documentPriorityPage,
            ).map((page) => page.page_no);
            if (remainingTargetPageNumbers.length) {
              const remainingExtracted = await remainingExtractionPromise;
              if (generationSignal.aborted) return;
              mergeExtractedPages(remainingExtracted.pages);
              rebuildWorkingPack();
              const remainingPagesToGenerate = prioritizeTeachingPages(
                workingPack.pages.filter((page) => !hasCompletedTeaching(page, p.teachingOutputLanguage)),
                documentPriorityPage,
              );
              await runGenerationPass(remainingPagesToGenerate, extractedPagesForGeneration);
            } else {
              await remainingExtractionPromise.catch(() => null);
            }
          } else {
            await runGenerationPass(initialPagesToGenerate, extractedPagesForGeneration);
          }

          await persistQueue.flush();
          await saveGeneratedPagesFromPack({ workspaceId: _workspaceId, documentId: item.documentId, pack: workingPack });
          if (item.documentId === _documentId) p.setPack(workingPack);
        }, { continueOnError: true });

        await p.refreshDocumentItems(_workspaceId, _documentId, _activeProjectId);
        p.setJobStatus(p.copy.status.generationBatchDone(completedTotal, checkedTotal || estimatedPages, processedDocuments, skippedTotal));
      } catch (error) {
        if (generationSignal.aborted || (error as Error).name === "AbortError") return;
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
  preference: UiPreferences["modelReasoningEffort"];
  modelApiConfig: ModelApiConfig;
  outputLanguage: TeachingOutputLanguage;
  copy: AppCopy;
  signal: AbortSignal;
  fallbackOnFailure?: PageData;
  requestGeneratedPage: (runningPage: PageData, plan: TeachingGenerationQualityPlan) => Promise<PageData>;
  commitGeneratedPage: (generatedPage: PageData) => Promise<void> | void;
  commitFailedPage: (failedPage: PageData) => Promise<void> | void;
  markRetryingPage: (runningPage: PageData, attempt: number, totalAttempts: number) => void;
};

async function generatePageWithAutoRetry({
  runningPage,
  initialPlan,
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

  for (let attempt = 1; attempt <= TEACHING_PAGE_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return;
    const plan = attempt === 1
      ? initialPlan
      : teachingGenerationQualityPlan(runningPage, preference, "retry", modelApiConfig);

    try {
      const generatedPage = await requestGeneratedPage(runningPage, plan);
      const shouldRetryWeakOutput =
        plan.retryOnWeakOutput &&
        generatedTeachingNeedsRetry(generatedPage) &&
        attempt < TEACHING_PAGE_MAX_ATTEMPTS;
      if (shouldRetryWeakOutput) {
        bestFallback = bestFallback && shouldPreferTeachingCandidate(bestFallback, generatedPage)
          ? bestFallback
          : generatedPage;
        markRetryingPage(runningPage, attempt + 1, TEACHING_PAGE_MAX_ATTEMPTS);
        await waitBeforeTeachingRetry(attempt, null, signal);
        continue;
      }

      const finalPage = bestFallback && shouldPreferTeachingCandidate(bestFallback, generatedPage)
        ? bestFallback
        : generatedPage;
      await commitGeneratedPage(finalPage);
      return;
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal.aborted) return;
      lastError = error;
      if (attempt >= TEACHING_PAGE_MAX_ATTEMPTS || !shouldAutoRetryGenerationError(error, copy)) {
        break;
      }
      markRetryingPage(runningPage, attempt + 1, TEACHING_PAGE_MAX_ATTEMPTS);
      await waitBeforeTeachingRetry(attempt, error, signal);
    }
  }

  if (bestFallback) {
    await commitGeneratedPage(bestFallback);
    return;
  }

  const message = (lastError as Error | null)?.message || copy.agent.generationFailed;
  await commitFailedPage(buildFailedPageData(runningPage, message, outputLanguage, copy));
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
): PagePack {
  return {
    ...pack,
    pages: pack.pages.map((page) => {
      if (page.status !== "running" && page.status !== "retrying") return page;
      return buildFailedPageData(page, message, outputLanguage, copy);
    }),
  };
}

async function waitBeforeTeachingRetry(attempt: number, error: unknown, signal: AbortSignal) {
  const baseDelay = TEACHING_PAGE_RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), TEACHING_PAGE_RETRY_DELAYS_MS.length - 1)];
  const rateLimitDelay = isRateLimitGenerationError(error)
    ? TEACHING_RATE_LIMIT_EXTRA_COOLDOWN_MS + Math.random() * TEACHING_RATE_LIMIT_EXTRA_JITTER_MS
    : 0;
  await abortableDelay(baseDelay + rateLimitDelay, signal);
}

function shouldAutoRetryGenerationError(error: unknown, copy: AppCopy) {
  const typed = error as Error;
  if (typed.name === "GenerationStalledError" || typed.name === "TimeoutError") return true;
  const message = (typed.message || String(error || "")).toLowerCase();
  if (!message) return false;
  if (message === copy.errors.accountNotFound.toLowerCase()) return false;
  if (message.includes("oauth client id") || message.includes("account_not_found")) return false;
  if (message.includes("invalid_request") && !message.includes("timeout")) return false;
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("stalled") ||
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("empty generation response") ||
    /\b50[0-4]\b/.test(message)
  );
}

function isRateLimitGenerationError(error: unknown) {
  const message = ((error as Error | null)?.message || String(error || "")).toLowerCase();
  return message.includes("rate limit") || message.includes("429") || message.includes("too many requests");
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

async function runGenerationRequestWithTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  options: GenerationRequestWatchdogOptions = {},
) {
  if (parentSignal.aborted) throw createAbortError();

  const controller = new AbortController();
  const timeoutError = createGenerationTimeoutError(timeoutMs, options.timeoutMessage);
  const stallMs = options.stallMs && options.stallMs > 0 && options.stallMs < timeoutMs ? options.stallMs : 0;
  const stallError = stallMs ? createGenerationStalledError(stallMs, options.stallMessage) : null;
  let timeoutTimer: number | null = null;
  let stallTimer: number | null = null;
  let abortFromParent: (() => void) | null = null;

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
  const races: Array<Promise<T> | Promise<never>> = [runPromise, abortRace, timeoutRace];
  if (stallError && stallMs) {
    races.push(new Promise<never>((_resolve, reject) => {
      stallTimer = window.setTimeout(() => {
        options.onStall?.();
        controller.abort();
        reject(stallError);
      }, stallMs);
    }));
  }

  try {
    return await Promise.race(races);
  } finally {
    runPromise.catch(() => undefined);
    if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    if (abortFromParent) parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function createGenerationStalledError(timeoutMs: number, message?: string) {
  const seconds = timeoutSeconds(timeoutMs);
  const error = new Error(message || `讲解生成超过 ${seconds} 秒没有响应，已自动切换重试。`);
  error.name = "GenerationStalledError";
  return error;
}

function generationBatchStallTimeoutMs() {
  const override = typeof window === "undefined"
    ? NaN
    : Number((window as Window & { __SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS?: unknown }).__SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return Math.max(100, Math.floor(override));
  return TEACHING_BATCH_STALL_TIMEOUT_MS;
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
