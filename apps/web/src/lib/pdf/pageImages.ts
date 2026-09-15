/**
 * Renders PDF pages to PNG data URLs so a model that reads images (DeepSeek
 * flash, an OCR model, a vision model) can see a page whose text layer is
 * noise. Rendered with the app's own PDF.js worker at roughly 110 dpi for a
 * slide, which keeps a page under ~150 KB while formulas stay legible.
 *
 * Pure module apart from the DOM canvas it draws on.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfJsRuntime } from "./textExtraction";

export type PageImageInput = {
  page_no: number;
  /** data:image/png;base64,… */
  data_url: string;
  width: number;
  height: number;
};

export type RenderPdfPageImagesOptions = {
  /** Pixel width the page is rendered to; slides at 1100 px read at ~110 dpi. */
  targetWidth?: number;
  /** Keyed cache across passes of one run and across runs on the same document. */
  cacheKey?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

export const PAGE_IMAGE_TARGET_WIDTH = 1100;
const PAGE_IMAGE_MAX_SCALE = 2.5;
const PAGE_IMAGE_MIN_SCALE = 0.5;
const PAGE_IMAGE_CACHE_MAX_ENTRIES = 96;

const renderedPageImages = new Map<string, PageImageInput>();

function cacheKeyFor(cacheKey: string, pageNo: number, targetWidth: number) {
  return `${cacheKey}::${targetWidth}::p${pageNo}`;
}

function remember(key: string, image: PageImageInput) {
  renderedPageImages.delete(key);
  renderedPageImages.set(key, image);
  while (renderedPageImages.size > PAGE_IMAGE_CACHE_MAX_ENTRIES) {
    const oldest = renderedPageImages.keys().next().value;
    if (!oldest) break;
    renderedPageImages.delete(oldest);
  }
}

/** Renders the requested pages of a PDF blob; pages outside the document are skipped. */
export async function renderPdfPageImages(
  blob: Blob,
  pageNumbers: number[],
  options: RenderPdfPageImagesOptions = {},
): Promise<Map<number, PageImageInput>> {
  const targetWidth = options.targetWidth || PAGE_IMAGE_TARGET_WIDTH;
  const wanted = [...new Set(pageNumbers.filter((pageNo) => Number.isFinite(pageNo) && pageNo > 0))].sort((a, b) => a - b);
  const results = new Map<number, PageImageInput>();
  const missing: number[] = [];
  for (const pageNo of wanted) {
    const cached = options.cacheKey ? renderedPageImages.get(cacheKeyFor(options.cacheKey, pageNo, targetWidth)) : undefined;
    if (cached) results.set(pageNo, cached);
    else missing.push(pageNo);
  }
  if (!missing.length || !blob.size) return results;

  const url = URL.createObjectURL(blob);
  let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;
  let done = 0;
  try {
    const pdfJs = await loadPdfJsRuntime();
    loadingTask = pdfJs.getDocument({ url, worker: pdfJs.createPdfWorker() });
    const pdf = await loadingTask.promise;
    for (const pageNo of missing) {
      if (options.signal?.aborted) break;
      if (pageNo > pdf.numPages) continue;
      const page = await pdf.getPage(pageNo);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(PAGE_IMAGE_MAX_SCALE, Math.max(PAGE_IMAGE_MIN_SCALE, targetWidth / base.width));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) continue;
        canvasContext.fillStyle = "#ffffff";
        canvasContext.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext, viewport }).promise;
        const image: PageImageInput = {
          page_no: pageNo,
          data_url: canvas.toDataURL("image/png"),
          width: canvas.width,
          height: canvas.height,
        };
        results.set(pageNo, image);
        if (options.cacheKey) remember(cacheKeyFor(options.cacheKey, pageNo, targetWidth), image);
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
        done += 1;
        options.onProgress?.(done, missing.length);
      }
    }
    return results;
  } finally {
    void loadingTask?.destroy().catch(() => undefined);
    URL.revokeObjectURL(url);
  }
}
