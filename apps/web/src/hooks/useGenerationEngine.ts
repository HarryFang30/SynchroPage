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
  generationFailureMarkdown,
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
import type { UiPreferences } from "../settings";
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
const TEACHING_PAGE_REQUEST_STALL_MS = 60_000;
const TEACHING_BATCH_REQUEST_STALL_MS = 75_000;

type GenerationRequestWatchdogOptions = {
  stallMs?: number;
  stalledMessage?: string;
  timeoutMessage?: string;
  onStalled?: () => void;
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
                      model: plan.model,
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
                stallMs: TEACHING_PAGE_REQUEST_STALL_MS,
                stalledMessage: p.copy.errors.generationRequestStalled(timeoutSeconds(TEACHING_PAGE_REQUEST_STALL_MS)),
                timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_PAGE_REQUEST_TIMEOUT_MS)),
                onStalled: () => p.setJobStatus(p.copy.status.generationPageFailed(pageNo, p.copy.errors.generationRequestStalled(timeoutSeconds(TEACHING_PAGE_REQUEST_STALL_MS)))),
              }),
              { priority, signal: generationSignal },
            );
            return normalizeGeneratedWithLanguage(response, runningPage, pageOutputLanguage);
          };

          const generateSinglePage = async (
            runningPage: PageData,
            plan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort),
            fallbackOnFailure?: PageData,
          ) => {
            const pageNo = runningPage.page_no;
            if (generationSignal.aborted) return;
            try {
              let generatedPage = await requestGeneratedPage(runningPage, plan);
              if (plan.retryOnWeakOutput && generatedTeachingNeedsRetry(generatedPage)) {
                const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry");
                const retriedPage = await requestGeneratedPage(runningPage, retryPlan).catch(() => null);
                if (retriedPage && shouldPreferTeachingCandidate(retriedPage, generatedPage)) {
                  generatedPage = retriedPage;
                }
              }
              await commitGeneratedPage(generatedPage);
            } catch (error) {
              if ((error as Error).name === "AbortError") return;
              if (fallbackOnFailure) {
                await commitGeneratedPage(fallbackOnFailure);
                return;
              }
              const message = (error as Error).message || p.copy.agent.generationFailed;
              const failedPage = buildFailedPageData(runningPage, message, pageOutputLanguage, p.copy);
              workingPack = mergePageIntoPack(workingPack, failedPage);
              workingPagesByNumber.set(pageNo, failedPage);
              p.setPack(workingPack);
              p.setJobStatus(p.copy.status.generationPageFailed(pageNo, message));
              persistQueue.enqueue(failedPage);
            }
          };

          const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort);
          await runWithConcurrencyLimit(pageBatches, TEACHING_GENERATION_CONCURRENCY, async (pageBatch) => {
            const runningPages = pageBatch.pages.map(markRunningPage);
            if (runningPages.length === 1) {
              await generateSinglePage(runningPages[0], pageBatch.plan);
              return;
            }

            try {
              const documentFile = await getDocumentFileForPlan(pageBatch.plan);
              const priority = teachingModelRequestPriority(runningPages, p.currentPdfPageNo, "now", "next");
              const response = await runTeachingModelRequest(() =>
                runGenerationRequestWithTimeout(generationSignal, TEACHING_BATCH_REQUEST_TIMEOUT_MS, (requestSignal) =>
                  requestJson<GeneratedTeachingPagesResponse>(
                    "/api/generate/pages",
                    {
                      method: "POST",
                      signal: requestSignal,
                      body: JSON.stringify({
                        model: pageBatch.plan.model,
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
                  stallMs: TEACHING_BATCH_REQUEST_STALL_MS,
                  stalledMessage: p.copy.errors.generationBatchRequestStalled(timeoutSeconds(TEACHING_BATCH_REQUEST_STALL_MS)),
                  timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_BATCH_REQUEST_TIMEOUT_MS)),
                  onStalled: () => p.setJobStatus(p.copy.errors.generationBatchRequestStalled(timeoutSeconds(TEACHING_BATCH_REQUEST_STALL_MS))),
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
                  const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry");
                  retryPages.push({ runningPage, retryPlan, fallback: generatedPage });
                  continue;
                }
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
          const pdfBlob = await fetch(p.pdfUrl)
            .then((response) => {
              if (!response.ok) throw new Error(response.statusText || p.copy.agent.generationFailed);
              return response.blob();
            })
            .catch(() => null);
          if (pdfBlob && missingTargetSourceText.length > TEACHING_PROJECT_WARMUP_PAGE_COUNT) {
            const warmupPageNumbers = teachingWarmupPageNumbers(totalPages, p.currentPdfPageNo, targetPageNumbers);
            const warmupPageSet = new Set(warmupPageNumbers);
            const warmupExtractionPageNumbers = teachingExtractionPageNumbers(totalPages, warmupPageNumbers)
              .filter((pageNo) => !sourceTextByPage.has(pageNo));
            const warmupExtracted = warmupExtractionPageNumbers.length
              ? await extractPdfPagesFromBlob(pdfBlob, {
                  priorityPageNumbers: warmupPageNumbers,
                  pageNumbers: warmupExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }).catch(() => null)
              : null;
            if (warmupExtracted?.pages.length) mergeExtractedPages(warmupExtracted.pages);
            if (generationSignal.aborted) return;

            const remainingExtractionPageNumbers = teachingExtractionPageNumbers(totalPages, targetPageNumbers)
              .filter((pageNo) => !sourceTextByPage.has(pageNo));
            const remainingExtractionPromise = remainingExtractionPageNumbers.length
              ? extractPdfPagesFromBlob(pdfBlob, {
                  priorityPageNumbers: [p.currentPdfPageNo, ...targetPageNumbers],
                  pageNumbers: remainingExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
                }).catch(() => null)
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
            const extracted = await extractPdfPagesFromBlob(pdfBlob, {
              priorityPageNumbers: targetPageNumbers,
              pageNumbers: teachingExtractionPageNumbers(totalPages, targetPageNumbers),
              shouldCancel: () => generationSignal.aborted,
              concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
            }).catch(() => null);
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
            : await extractPdfPagesFromBlob(pdfBlob, {
                priorityPageNumbers: [item.currentPdfPageNumber || 1, ...targetPageNumbers, ...warmupPageNumbers],
                pageNumbers: selectiveExtractionPageNumbers,
                shouldCancel: () => generationSignal.aborted,
                concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
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
                        model: plan.model,
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
                  stallMs: TEACHING_PAGE_REQUEST_STALL_MS,
                  stalledMessage: p.copy.errors.generationRequestStalled(timeoutSeconds(TEACHING_PAGE_REQUEST_STALL_MS)),
                  timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_PAGE_REQUEST_TIMEOUT_MS)),
                  onStalled: () => p.setJobStatus(p.copy.status.generationPageFailed(pageNo, p.copy.errors.generationRequestStalled(timeoutSeconds(TEACHING_PAGE_REQUEST_STALL_MS)))),
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
              plan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort),
              fallbackOnFailure?: PageData,
            ) => {
              const pageNo = runningPage.page_no;
              if (generationSignal.aborted) return;
              try {
                let generatedPage = await requestGeneratedPage(runningPage, plan);
                if (plan.retryOnWeakOutput && generatedTeachingNeedsRetry(generatedPage)) {
                  const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry");
                  const retriedPage = await requestGeneratedPage(runningPage, retryPlan).catch(() => null);
                  if (retriedPage && shouldPreferTeachingCandidate(retriedPage, generatedPage)) {
                    generatedPage = retriedPage;
                  }
                }
                await commitGeneratedPage(generatedPage);
              } catch (error) {
                if ((error as Error).name === "AbortError") return;
                if (fallbackOnFailure) {
                  await commitGeneratedPage(fallbackOnFailure);
                  return;
                }
                const message = (error as Error).message || p.copy.agent.generationFailed;
                const failedPage: PageData = {
                  ...runningPage,
                  status: "failed",
                  teaching: {
                    ...runningPage.teaching,
                    output_language: p.teachingOutputLanguage,
                    slide_title: runningPage.teaching.slide_title || `PDF p.${pageNo}`,
                    speaker_notes_md: generationFailureMarkdown(message, p.teachingOutputLanguage),
                    confidence: 0,
                    needs_review: true,
                  },
                };
                workingPack = mergePageIntoPack(workingPack, failedPage);
                workingPagesByNumber.set(pageNo, failedPage);
                if (item.documentId === _documentId) p.setPack(workingPack);
                p.setJobStatus(p.copy.status.generationPageFailed(pageNo, message));
                persistQueue.enqueue(failedPage);
              }
            };

            const pageBatches = batchTeachingPages(passPagesToGenerate, p.uiPreferences.modelReasoningEffort);
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
                const response = await runTeachingModelRequest(() =>
                  runGenerationRequestWithTimeout(generationSignal, TEACHING_BATCH_REQUEST_TIMEOUT_MS, (requestSignal) =>
                    requestJson<GeneratedTeachingPagesResponse>(
                      "/api/generate/pages",
                      {
                        method: "POST",
                        signal: requestSignal,
                        body: JSON.stringify({
                          model: pageBatch.plan.model,
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
                    stallMs: TEACHING_BATCH_REQUEST_STALL_MS,
                    stalledMessage: p.copy.errors.generationBatchRequestStalled(timeoutSeconds(TEACHING_BATCH_REQUEST_STALL_MS)),
                    timeoutMessage: p.copy.errors.generationRequestTimedOut(timeoutSeconds(TEACHING_BATCH_REQUEST_TIMEOUT_MS)),
                    onStalled: () => p.setJobStatus(p.copy.errors.generationBatchRequestStalled(timeoutSeconds(TEACHING_BATCH_REQUEST_STALL_MS))),
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
                    const retryPlan = teachingGenerationQualityPlan(runningPage, p.uiPreferences.modelReasoningEffort, "retry");
                    retryPages.push({ runningPage, retryPlan, fallback: generatedPage });
                    continue;
                  }
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
              ? extractPdfPagesFromBlob(pdfBlob, {
                  priorityPageNumbers: [item.currentPdfPageNumber || 1, ...remainingInitialTargetPageNumbers],
                  pageNumbers: remainingExtractionPageNumbers,
                  shouldCancel: () => generationSignal.aborted,
                  concurrency: PDF_PROJECT_TEXT_EXTRACTION_CONCURRENCY,
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
        p.setJobStatus((error as Error).message || p.copy.agent.generationFailed);
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

async function runGenerationRequestWithTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  options: GenerationRequestWatchdogOptions = {},
) {
  if (parentSignal.aborted) throw createAbortError();

  const controller = new AbortController();
  let timedOut = false;
  let stalled = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const stallTimer = options.stallMs
    ? window.setTimeout(() => {
        stalled = true;
        options.onStalled?.();
        controller.abort();
      }, options.stallMs)
    : null;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await run(controller.signal);
  } catch (error) {
    if (stalled) throw createGenerationStalledError(options.stalledMessage, options.stallMs);
    if (timedOut) throw createGenerationTimeoutError(timeoutMs, options.timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timer);
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function createGenerationTimeoutError(timeoutMs: number, message?: string) {
  const seconds = timeoutSeconds(timeoutMs);
  const error = new Error(message || `讲解生成超时（${seconds} 秒）。这一页可能是图表密集页、服务端限流或上游模型处理过慢，请稍后重试。`);
  error.name = "TimeoutError";
  return error;
}

function createGenerationStalledError(message?: string, stallMs = TEACHING_PAGE_REQUEST_STALL_MS) {
  const seconds = timeoutSeconds(stallMs);
  const error = new Error(message || `OpenAI 上游超过 ${seconds} 秒没有返回，已自动停止这一页。可能是服务端限流或请求卡住，请稍后重试。`);
  error.name = "GenerationStalledError";
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
