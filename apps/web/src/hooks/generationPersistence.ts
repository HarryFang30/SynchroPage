import { mergePageIntoPack } from "../lib/generation/generationRuntime";
import {
  cachedPdfDirectFileInputFromBlob,
  cachedPdfDirectFileInputFromUrl,
  pdfDirectFileCacheKey,
  type PdfDirectFileInput,
} from "../lib/pdf/directFile";
import {
  saveGeneratedPage,
} from "../lib/persistence";
import { asPersistedRecord } from "../lib/workspace/synchroPageState";
import type { PageData, PagePack, TeachingGenerationQualityPlan } from "../lib/generation/teachingGeneration";

// ── Single page persistence ───────────────────────────────────

export function createPersistGeneratedPage(params: {
  workspaceId: string;
  documentId: string;
  currentDocumentId: string | null;
}): (generatedPage: PageData) => Promise<void> {
  const { workspaceId, documentId, currentDocumentId } = params;
  return async (generatedPage: PageData) => {
    if (currentDocumentId !== documentId) return;
    await saveGeneratedPage({
      id: `${documentId}:page:${generatedPage.page_no}`,
      workspaceId,
      documentId,
      generatedPageIndex: generatedPage.page_no - 1,
      sourcePdfPageNumber: generatedPage.page_no,
      title: generatedPage.teaching.slide_title,
      markdown: generatedPage.teaching.speaker_notes_md,
      json: asPersistedRecord(generatedPage),
      confidence: generatedPage.teaching.confidence,
      status: generatedPage.status === "failed" ? "failed" : "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };
}

// ── Serialized persistence queue ──────────────────────────────

export interface PersistenceQueue {
  enqueue: (page: PageData) => void;
  flush: () => Promise<void>;
}

export function createPersistenceQueue(persistPage: (page: PageData) => Promise<void>): PersistenceQueue {
  let queue = Promise.resolve();
  const enqueue = (page: PageData) => {
    queue = queue
      .then(() => persistPage(page))
      .catch(() => undefined);
  };
  const flush = () => queue;
  return { enqueue, flush };
}

// ── Document file loader (URL variant) ────────────────────────

export function createDocumentFileLoaderFromUrl(params: {
  pdfUrl: string;
  documentTitle: string;
}): (plan: TeachingGenerationQualityPlan) => Promise<PdfDirectFileInput | null> {
  const { pdfUrl, documentTitle } = params;
  let documentFilePromise: Promise<PdfDirectFileInput | null> | null = null;
  return (plan: TeachingGenerationQualityPlan) => {
    if (!pdfUrl || !plan.attachPdf) return Promise.resolve(null);
    documentFilePromise ??= cachedPdfDirectFileInputFromUrl(pdfUrl, documentTitle).catch(() => null);
    return documentFilePromise;
  };
}

// ── Document file loader (Blob variant) ───────────────────────

export function createDocumentFileLoaderFromBlob(params: {
  pdfBlob: Blob;
  fileName: string;
  workspaceId: string;
  documentId: string;
}): (plan: TeachingGenerationQualityPlan) => Promise<PdfDirectFileInput | null> {
  const { pdfBlob, fileName, workspaceId, documentId } = params;
  let documentFilePromise: Promise<PdfDirectFileInput | null> | null = null;
  return (plan: TeachingGenerationQualityPlan) => {
    if (!plan.attachPdf) return Promise.resolve(null);
    documentFilePromise ??= cachedPdfDirectFileInputFromBlob(
      pdfBlob,
      fileName,
      pdfDirectFileCacheKey(workspaceId, documentId),
    ).catch(() => null);
    return documentFilePromise;
  };
}

// ── Commit generated page ─────────────────────────────────────

export interface CommitGeneratedPageContext {
  workingPack: PagePack;
  workingPagesByNumber: Map<number, PageData>;
}

export function createCommitGeneratedPage(
  ctx: CommitGeneratedPageContext,
  setPack: (pack: PagePack) => void,
  queuePersist: (page: PageData) => void,
  onComplete?: () => void,
): (page: PageData) => void {
  return (generatedPage: PageData) => {
    ctx.workingPack = mergePageIntoPack(ctx.workingPack, generatedPage);
    ctx.workingPagesByNumber.set(generatedPage.page_no, generatedPage);
    setPack(ctx.workingPack);
    onComplete?.();
    queuePersist(generatedPage);
  };
}
