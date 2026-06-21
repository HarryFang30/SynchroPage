import type { PDFDocumentProxy } from "pdfjs-dist";
import type { UiPreferences } from "../../settings";

export type PdfContextPage = {
  page_no: number;
  title?: string;
  text_md: string;
};

export type PdfContextPayload = {
  documentId: string;
  documentTitle: string;
  pageCount: number;
  truncated: boolean;
  truncationPolicy: "all-pages" | "first-last-edge" | "target-neighbor-edge";
  fullPageLimit: number;
  edgePageCount: number;
  includedPageNumbers: number[];
  pages: PdfContextPage[];
};

export type PdfContextSettings = Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">;

export type PdfPageExtractionOptions = {
  priorityPageNumbers?: number[];
  pageNumbers?: number[];
  shouldCancel?: () => boolean;
  onProgress?: (pages: PdfContextPage[]) => void;
  progressBatchSize?: number;
  delayMs?: number;
  concurrency?: number;
};

type PdfContextPackPage = {
  page_no: number;
  source: {
    text_md: string;
  };
  teaching: {
    slide_title: string;
    speaker_notes_md: string;
  };
};

export type PdfContextSourcePack = {
  document: {
    id: string;
    title: string;
    page_count: number;
  };
  pages: PdfContextPackPage[];
};

const PDF_TEXT_EXTRACTION_CONCURRENCY = 4;

let pdfJsRuntimePromise: Promise<typeof import("./pdfjs")> | null = null;

export function loadPdfJsRuntime() {
  pdfJsRuntimePromise ??= import("./pdfjs");
  return pdfJsRuntimePromise;
}

export function sanitizePdfContextSettings(settings: PdfContextSettings) {
  const fullPageLimit = Math.min(Math.max(Math.floor(Number(settings.pdfContextFullPageLimit) || 50), 1), 500);
  const edgePageCount = Math.min(Math.max(Math.floor(Number(settings.pdfContextEdgePageCount) || 10), 1), 100);
  return { fullPageLimit, edgePageCount };
}

export function pdfContextPageNumbers(pageCount: number, settings: PdfContextSettings) {
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const total = Math.max(0, Math.floor(pageCount));
  if (total <= fullPageLimit) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (let pageNo = 1; pageNo <= Math.min(edgePageCount, total); pageNo += 1) {
    pages.add(pageNo);
  }
  for (let pageNo = Math.max(1, total - edgePageCount + 1); pageNo <= total; pageNo += 1) {
    pages.add(pageNo);
  }
  return Array.from(pages).sort((left, right) => left - right);
}

export function textContentToPlainText(textContent: { items?: unknown[] }) {
  const lines: string[] = [];
  let current = "";
  for (const item of textContent.items || []) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const text = String((item as { str?: unknown }).str || "");
    if (!text) continue;
    current += text;
    if ((item as { hasEOL?: boolean }).hasEOL) {
      lines.push(current.trimEnd());
      current = "";
    } else {
      current += " ";
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

export async function extractPdfPagesFromBlob(blob: Blob, options: number[] | PdfPageExtractionOptions = []) {
  const extractionOptions = Array.isArray(options) ? { priorityPageNumbers: options } : options;
  const url = URL.createObjectURL(blob);
  let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;
  try {
    const pdfJs = await loadPdfJsRuntime();
    loadingTask = pdfJs.getDocument({ url, worker: pdfJs.createPdfWorker() });
    const document = await loadingTask.promise;
    const pages = await extractPdfPagesFromDocument(document, {
      priorityPageNumbers: extractionOptions.priorityPageNumbers,
      pageNumbers: extractionOptions.pageNumbers,
      shouldCancel: extractionOptions.shouldCancel,
      onProgress: extractionOptions.onProgress,
      progressBatchSize: extractionOptions.progressBatchSize || 12,
      delayMs: extractionOptions.delayMs || 0,
      concurrency: extractionOptions.concurrency,
    });
    return { pageCount: document.numPages, pages };
  } finally {
    void loadingTask?.destroy().catch(() => undefined);
    URL.revokeObjectURL(url);
  }
}

export async function extractPdfContextFromDocument(
  document: PDFDocumentProxy,
  documentId: string,
  documentTitle: string,
  settings: PdfContextSettings,
): Promise<PdfContextPayload> {
  const pageCount = document.numPages;
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const truncated = includedPageNumbers.length < pageCount;
  const pages: PdfContextPage[] = [];
  for (const pageNo of includedPageNumbers) {
    const page = await document.getPage(pageNo);
    const textContent = await page.getTextContent();
    pages.push({
      page_no: pageNo,
      title: `PDF p.${pageNo}`,
      text_md: textContentToPlainText(textContent),
    });
  }
  return {
    documentId,
    documentTitle,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages,
  };
}

export async function extractPdfPagesFromDocument(
  document: PDFDocumentProxy,
  options: PdfPageExtractionOptions = {},
): Promise<PdfContextPage[]> {
  const pages: PdfContextPage[] = [];
  let pendingProgress = 0;
  const progressBatchSize = Math.max(1, options.progressBatchSize || 6);
  const pageNumbers = pdfExtractionOrder(document.numPages, options.priorityPageNumbers, options.pageNumbers);
  const publishProgress = () => {
    if (!options.onProgress || pendingProgress < progressBatchSize) return;
    pendingProgress = 0;
    options.onProgress(sortPdfContextPages(pages));
  };

  await runWithConcurrencyLimit(pageNumbers, options.concurrency || PDF_TEXT_EXTRACTION_CONCURRENCY, async (pageNo) => {
    if (options.shouldCancel?.()) return;
    const page = await document.getPage(pageNo);
    if (options.shouldCancel?.()) return;
    const textContent = await page.getTextContent();
    if (options.shouldCancel?.()) return;
    pages.push({
      page_no: pageNo,
      title: `PDF p.${pageNo}`,
      text_md: textContentToPlainText(textContent),
    });
    pendingProgress += 1;
    publishProgress();
    await waitForPdfExtractionIdle(options.delayMs);
  });
  if (options.onProgress && pendingProgress > 0) {
    options.onProgress(sortPdfContextPages(pages));
  }
  return sortPdfContextPages(pages);
}

export function sortPdfContextPages(pages: PdfContextPage[]) {
  return [...pages].sort((left, right) => left.page_no - right.page_no);
}

export function mergePdfContextPages(...pageGroups: PdfContextPage[][]) {
  const pagesByNumber = new Map<number, PdfContextPage>();
  for (const pages of pageGroups) {
    for (const page of pages) {
      pagesByNumber.set(page.page_no, page);
    }
  }
  return sortPdfContextPages([...pagesByNumber.values()]);
}

export function pdfContextFromExtractedPages(
  documentId: string,
  documentTitle: string,
  pageCount: number,
  settings: PdfContextSettings,
  extractedPages: PdfContextPage[],
): PdfContextPayload {
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const wantedPages = new Set(includedPageNumbers);
  const truncated = includedPageNumbers.length < pageCount;
  return {
    documentId,
    documentTitle,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages: extractedPages.filter((page) => wantedPages.has(page.page_no)),
  };
}

export function buildPdfContextFromPack(
  pack: PdfContextSourcePack,
  settings: PdfContextSettings,
): PdfContextPayload {
  const pageCount = Math.max(pack.document.page_count || pack.pages.length, pack.pages.length);
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const truncated = includedPageNumbers.length < pageCount;
  const wantedPages = new Set(includedPageNumbers);
  const pages = pack.pages
    .filter((page) => wantedPages.has(page.page_no))
    .map((page) => ({
      page_no: page.page_no,
      title: page.teaching.slide_title || `PDF p.${page.page_no}`,
      text_md: page.source.text_md || page.teaching.speaker_notes_md || "",
    }));
  return {
    documentId: pack.document.id,
    documentTitle: pack.document.title,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages,
  };
}

export function waitForPdfExtractionIdle(delayMs = 80) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function pdfExtractionOrder(pageCount: number, priorityPageNumbers: number[] = [], pageNumbers?: number[]) {
  const total = Math.max(0, pageCount);
  const seen = new Set<number>();
  const ordered: number[] = [];
  const add = (pageNo: number) => {
    if (!Number.isFinite(pageNo) || pageNo < 1 || pageNo > total || seen.has(pageNo)) return;
    seen.add(pageNo);
    ordered.push(pageNo);
  };
  const targetPageNumbers = pageNumbers?.length
    ? [...new Set(pageNumbers)]
        .filter((pageNo) => Number.isFinite(pageNo) && pageNo >= 1 && pageNo <= total)
        .sort((left, right) => left - right)
    : Array.from({ length: total }, (_, index) => index + 1);
  const targetSet = new Set(targetPageNumbers);
  priorityPageNumbers.forEach(add);
  for (const pageNo of targetPageNumbers) add(pageNo);
  if (pageNumbers?.length) {
    return ordered.filter((pageNo) => targetSet.has(pageNo));
  }
  return ordered;
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  if (!items.length) return;
  const concurrency = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }));
}
