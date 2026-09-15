import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  forwardRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  extractPdfPagesFromDocument,
  loadPdfJsRuntime,
  pdfContextFromExtractedPages,
  pdfContextPageNumbers,
  waitForPdfExtractionIdle,
  type PdfContextPage,
  type PdfContextPayload,
} from "../../lib/pdf/textExtraction";

// ── Types ────────────────────────────────────────────────────

export type PdfViewMode = "continuous" | "single-page";

export type PdfScrollViewerHandle = {
  scrollToPage: (pageNumber: number, behavior?: ScrollBehavior) => void;
};

export type PdfPageRenderStatus = "loading" | "ready" | "empty-text" | "error";

export type PdfPageGeometry = {
  width: number;
  height: number;
  rotation: number;
};

export type PdfScrollViewerProps = {
  documentId: string;
  documentTitle: string;
  fallbackSrc: string;
  pageNumber: number;
  url: string;
  viewMode: PdfViewMode;
  pdfContextFullPageLimit: number;
  pdfContextEdgePageCount: number;
  onDocumentReady: (pageCount: number) => void;
  onActivePageChange: (pageNumber: number) => void;
  onPdfContextReady: (context: PdfContextPayload) => void;
  onPdfPagesTextReady: (pages: PdfContextPage[]) => void;
  onViewerScroll?: () => void;
  /** Pages the lesson plan marked as key; their labels carry a star. */
  keyPageNumbers?: ReadonlySet<number>;
  /** Extra layer drawn between the canvas and the text layer (highlights). */
  renderPageOverlay?: (pageNo: number) => ReactNode;
  /** Content shown directly under a page (margin notes). */
  renderPageFooter?: (pageNo: number) => ReactNode;
  /** Plain click on the page, with the point as page fractions (0..1). */
  onPageClick?: (pageNo: number, point: { x: number; y: number }) => void;
};

// ── Constants ────────────────────────────────────────────────

const pdfIntersectionThresholds = [0, 0.25, 0.5, 0.75, 1];

// ── Utility functions ────────────────────────────────────────

export function pdfPageDisplayMetrics(viewportWidth: number, geometry: PdfPageGeometry | null | undefined) {
  const naturalWidth = Math.max(geometry?.width || 612, 1);
  const naturalHeight = Math.max(geometry?.height || 792, 1);
  const availableWidth = Math.max((viewportWidth || 760) - 56, 280);
  const scale = Math.min(2.2, Math.max(0.45, availableWidth / naturalWidth));
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    width,
    height,
    aspectRatio: `${naturalWidth} / ${naturalHeight}`,
  };
}

function hasSelectableText(textContent: { items: unknown[] }) {
  return textContent.items.some((item) => {
    const value = item && typeof item === "object" && "str" in item ? item.str : "";
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isPdfRenderCancel(error: unknown) {
  const name = (error as { name?: string })?.name || "";
  return name === "RenderingCancelledException" || name === "AbortException";
}

/** The scaled page box inside a page shell (rendered page or placeholder). */
function pageBoxOf(shell: HTMLElement): HTMLElement {
  return shell.querySelector<HTMLElement>(".pdf-page-layered, .pdf-page-placeholder") || shell;
}

// ── useElementWidth hook ─────────────────────────────────────

export function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

// ── PdfPagePlaceholder ───────────────────────────────────────

function PdfPagePlaceholder({ viewportWidth, geometry }: { viewportWidth: number; geometry?: PdfPageGeometry | null }) {
  const displayMetrics = pdfPageDisplayMetrics(viewportWidth, geometry);
  return (
    <div
      className="pdf-page-placeholder"
      aria-hidden="true"
      style={{
        width: `${displayMetrics.width}px`,
        height: `${displayMetrics.height}px`,
        aspectRatio: displayMetrics.aspectRatio,
      }}
    />
  );
}

// ── PdfPageLayer ─────────────────────────────────────────────

function PdfPageLayer({
  pdfDocument,
  pageNumber,
  viewportWidth,
  geometry,
  onGeometryReady,
  renderPageOverlay,
  onPageClick,
}: {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  viewportWidth: number;
  geometry?: PdfPageGeometry | null;
  onGeometryReady: (pageNo: number, geometry: PdfPageGeometry) => void;
  renderPageOverlay?: (pageNo: number) => ReactNode;
  onPageClick?: (pageNo: number, point: { x: number; y: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pageStatus, setPageStatus] = useState<PdfPageRenderStatus>("loading");
  const [pageError, setPageError] = useState("");
  // The page box is sized from the same formula pdf.js renders with, straight
  // from props, so a pane-width change resizes real pages and placeholders in
  // the same layout pass (the scroll re-anchoring below relies on that).
  const displayMetrics = pdfPageDisplayMetrics(viewportWidth, geometry);
  const [viewportMeta, setViewportMeta] = useState({
    scale: 1,
    rotation: 0,
    pageNumber,
  });

  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return undefined;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: { cancel: () => void; render: () => Promise<void> } | null = null;
    const textLayerElement = textLayerRef.current;
    const canvas = canvasRef.current;

    const renderPage = async () => {
      const pdfJs = await loadPdfJsRuntime();
      if (cancelled) return;
      setPageStatus("loading");
      setPageError("");
      textLayerElement.replaceChildren();

      const safePageNumber = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages);
      const pdfPage = await pdfDocument.getPage(safePageNumber);
      if (cancelled) return;

      const baseViewport = pdfPage.getViewport({ scale: 1 });
      onGeometryReady(safePageNumber, {
        width: baseViewport.width,
        height: baseViewport.height,
        rotation: baseViewport.rotation,
      });
      const availableWidth = Math.max((viewportWidth || 760) - 56, 280);
      const scale = Math.min(2.2, Math.max(0.45, availableWidth / baseViewport.width));
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) throw new Error("浏览器无法创建 PDF canvas context");

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      textLayerElement.style.width = `${viewport.width}px`;
      textLayerElement.style.height = `${viewport.height}px`;
      textLayerElement.style.setProperty("--scale-factor", String(scale));
      textLayerElement.style.setProperty("--total-scale-factor", String(scale));
      textLayerElement.style.setProperty("--user-unit", "1");
      setViewportMeta({
        scale,
        rotation: viewport.rotation,
        pageNumber: safePageNumber,
      });

      renderTask = pdfPage.render({
        canvas,
        canvasContext,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        background: "rgb(255,255,255)",
      });

      await renderTask.promise;
      if (cancelled) return;
      setPageStatus("ready");

      try {
        await waitForPdfExtractionIdle(16);
        if (cancelled) return;
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;

        if (!hasSelectableText(textContent)) {
          if (!cancelled) setPageStatus("empty-text");
          return;
        }

        textLayer = new pdfJs.TextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
        });

        await textLayer!.render();
        textLayerElement.style.setProperty("--scale-factor", String(scale));
        textLayerElement.style.setProperty("--total-scale-factor", String(scale));
        textLayerElement.style.setProperty("--user-unit", "1");
      } catch (error) {
        if (!cancelled && !isPdfRenderCancel(error)) {
          textLayerElement.replaceChildren();
        }
      }
    };

    void renderPage().catch((error: unknown) => {
      if (cancelled || isPdfRenderCancel(error)) return;
      setPageError((error as Error).message || "PDF 当前页渲染失败");
      setPageStatus("error");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textLayerElement.replaceChildren();
    };
  }, [onGeometryReady, pageNumber, pdfDocument, viewportWidth]);

  const handleLayerClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onPageClick) return;
    // A drag-selection also ends in a click; only plain clicks hit-test highlights.
    if (window.getSelection()?.toString().trim()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    onPageClick(viewportMeta.pageNumber, {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    });
  }, [onPageClick, viewportMeta.pageNumber]);

  return (
    <>
      <div
        className="pdf-page-layered"
        data-page-number={viewportMeta.pageNumber}
        data-viewport-rotation={viewportMeta.rotation}
        data-viewport-scale={viewportMeta.scale}
        style={{
          width: `${displayMetrics.width}px`,
          height: `${displayMetrics.height}px`,
          aspectRatio: displayMetrics.aspectRatio,
        }}
        onClick={handleLayerClick}
      >
        <canvas ref={canvasRef} className="pdf-visual-layer" />
        {renderPageOverlay?.(viewportMeta.pageNumber)}
        <div ref={textLayerRef} className="textLayer pdf-text-layer" aria-label="PDF 可选文本层" />
        {/* Overlaid, not stacked below the page: a transient block here would
            shift every following page while a re-render is in flight. */}
        {pageStatus === "loading" && <div className="pdf-layer-note pdf-layer-note-loading">正在渲染 PDF 页面...</div>}
      </div>
      {pageStatus === "empty-text" && (
        <div className="pdf-layer-note">当前 PDF 页没有可选文本层。可以继续查看页面，OCR/text extraction 接口预留后续接入。</div>
      )}
      {pageStatus === "error" && <div className="pdf-layer-note error">{pageError || "PDF 当前页渲染失败"}</div>}
    </>
  );
}

// ── PdfScrollViewer (main) ───────────────────────────────────

export const PdfScrollViewer = forwardRef<PdfScrollViewerHandle, PdfScrollViewerProps>(function PdfScrollViewer({
  documentId,
  documentTitle,
  fallbackSrc,
  pageNumber,
  url,
  viewMode,
  pdfContextFullPageLimit,
  pdfContextEdgePageCount,
  onDocumentReady,
  onActivePageChange,
  onPdfContextReady,
  onPdfPagesTextReady,
  onViewerScroll,
  keyPageNumbers,
  renderPageOverlay,
  renderPageFooter,
  onPageClick,
}, ref) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const activePageTimerRef = useRef<number | null>(null);
  const activePageFrameRef = useRef<number | null>(null);
  const lastActivePageRef = useRef(pageNumber);
  const restoredUrlRef = useRef("");
  const viewportWidth = useElementWidth(scrollContainerRef);
  // Where the reader is: the page under the container's 50% line and how far
  // down that page the line sits. Captured on scroll, restored after a
  // width-driven rescale so panel toggles never move the reader.
  // `fraction` is clamped to the page box; `offsetPx` is the part of the
  // distance that lies outside the box (label, gap, notes footer), which
  // keeps its pixel height when the box rescales.
  const readingAnchorRef = useRef<{ pageNo: number; fraction: number; offsetPx: number } | null>(null);
  const lastViewportWidthRef = useRef(0);
  const restoringAnchorRef = useRef(false);
  // A programmatic jump (page arrows, keys, note jump, initial restore) that
  // may still be animating; a rescale lands it instead of restoring the
  // mid-animation anchor.
  const navigationTargetRef = useRef<{ pageNo: number; until: number } | null>(null);
  const initialRestoreTimersRef = useRef<number[]>([]);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState("");
  const [renderWindowCenter, setRenderWindowCenter] = useState(pageNumber);
  const [pageGeometries, setPageGeometries] = useState<Record<number, PdfPageGeometry>>({});
  const onDocumentReadyRef = useRef(onDocumentReady);
  const onPdfContextReadyRef = useRef(onPdfContextReady);
  const onPdfPagesTextReadyRef = useRef(onPdfPagesTextReady);
  const pageCount = pdfDocument?.numPages || 0;
  const safePageNumber = Math.min(Math.max(pageNumber, 1), Math.max(pageCount, 1));
  const pageNumbers = viewMode === "single-page"
    ? [safePageNumber]
    : Array.from({ length: pageCount }, (_, index) => index + 1);
  const pageGeometryFallback = pageGeometries[safePageNumber] || pageGeometries[1] || Object.values(pageGeometries)[0] || null;

  const updateRenderWindowCenter = useCallback((nextPage: number) => {
    setRenderWindowCenter((current) => current === nextPage ? current : nextPage);
  }, []);

  const rememberPageGeometry = useCallback((pageNo: number, geometry: PdfPageGeometry) => {
    setPageGeometries((current) => {
      const existing = current[pageNo];
      if (
        existing &&
        Math.abs(existing.width - geometry.width) < 0.5 &&
        Math.abs(existing.height - geometry.height) < 0.5 &&
        existing.rotation === geometry.rotation
      ) {
        return current;
      }
      return { ...current, [pageNo]: geometry };
    });
  }, []);

  const scheduleActivePage = useCallback((nextPage: number) => {
    if (lastActivePageRef.current === nextPage) return;
    if (activePageTimerRef.current) window.clearTimeout(activePageTimerRef.current);
    activePageTimerRef.current = window.setTimeout(() => {
      lastActivePageRef.current = nextPage;
      updateRenderWindowCenter(nextPage);
      onActivePageChange(nextPage);
    }, 130);
  }, [onActivePageChange, updateRenderWindowCenter]);

  const captureReadingAnchor = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const anchorY = rootRect.top + rootRect.height * 0.5;
    // Anchor to the page box itself: labels, notes and status lines around it
    // keep a fixed height while the box scales with the pane width. The line
    // may sit between two boxes, so fall back to the nearest one.
    let best: { pageNo: number; fraction: number; offsetPx: number; distance: number } | null = null;
    for (const [pageNo, element] of pageElementsRef.current) {
      const rect = pageBoxOf(element).getBoundingClientRect();
      if (!(rect.height > 0)) continue;
      const distance = anchorY < rect.top ? rect.top - anchorY : anchorY > rect.bottom ? anchorY - rect.bottom : 0;
      if (!best || distance < best.distance) {
        const raw = anchorY - rect.top;
        const fraction = Math.min(1, Math.max(0, raw / rect.height));
        best = { pageNo, fraction, offsetPx: raw - fraction * rect.height, distance };
      }
    }
    if (best) readingAnchorRef.current = { pageNo: best.pageNo, fraction: best.fraction, offsetPx: best.offsetPx };
  }, []);

  const chooseActivePage = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root || restoringAnchorRef.current) return;
    // Page boxes also change height without a scroll (a placeholder gets its
    // real geometry); keep the anchor in step with the current layout.
    captureReadingAnchor();
    const rootRect = root.getBoundingClientRect();
    const anchorY = rootRect.top + rootRect.height * 0.5;
    const visiblePages = Array.from(pageElementsRef.current.entries())
      .map(([pageNo, element]) => {
        const rect = element.getBoundingClientRect();
        const pageCenter = rect.top + rect.height / 2;
        const edgeDistance = rect.top > anchorY ? rect.top - anchorY : anchorY > rect.bottom ? anchorY - rect.bottom : 0;
        return {
          pageNo,
          top: rect.top,
          bottom: rect.bottom,
          centerDistance: Math.abs(pageCenter - anchorY),
          edgeDistance,
        };
      })
      .filter((entry) => entry.bottom > rootRect.top + 1 && entry.top < rootRect.bottom - 1);
    if (!visiblePages.length) return;

    const currentPage = visiblePages.find((entry) => entry.pageNo === lastActivePageRef.current);
    if (currentPage && currentPage.top <= anchorY && currentPage.bottom >= anchorY) {
      // The page under the line is still the active one: a change scheduled
      // by an earlier frame (mid-animation, before a relayout landed here)
      // must not fire later and report a page the reader is not on.
      if (activePageTimerRef.current) {
        window.clearTimeout(activePageTimerRef.current);
        activePageTimerRef.current = null;
      }
      updateRenderWindowCenter(currentPage.pageNo);
      return;
    }

    const centerHits = visiblePages.filter((entry) => entry.top <= anchorY && entry.bottom >= anchorY);
    const candidates = centerHits.length ? centerHits : visiblePages;
    candidates.sort((left, right) => {
      if (centerHits.length) return left.centerDistance - right.centerDistance;
      const edgeDelta = left.edgeDistance - right.edgeDistance;
      if (Math.abs(edgeDelta) > 1) return edgeDelta;
      return left.centerDistance - right.centerDistance;
    });
    updateRenderWindowCenter(candidates[0].pageNo);
    scheduleActivePage(candidates[0].pageNo);
  }, [captureReadingAnchor, scheduleActivePage, updateRenderWindowCenter]);

  const requestActivePageFromLayout = useCallback(() => {
    if (activePageFrameRef.current) return;
    activePageFrameRef.current = window.requestAnimationFrame(() => {
      activePageFrameRef.current = null;
      chooseActivePage();
    });
  }, [chooseActivePage]);

  const scrollToPage = useCallback((targetPage: number, behavior: ScrollBehavior = "smooth") => {
    const pageNo = Math.min(Math.max(targetPage, 1), Math.max(pageCount, 1));
    const root = scrollContainerRef.current;
    const pageElement = pageElementsRef.current.get(pageNo);
    updateRenderWindowCenter(pageNo);
    if (!root || !pageElement) {
      onActivePageChange(pageNo);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const top = Math.max(0, root.scrollTop + pageRect.top - rootRect.top - 14);
    // The container's CSS scroll-behavior animates "auto"/"smooth" for
    // roughly half a second; remember the destination for that long.
    navigationTargetRef.current = { pageNo, until: performance.now() + 900 };
    root.scrollTo({ top, behavior });
  }, [onActivePageChange, pageCount, updateRenderWindowCenter]);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  const registerPageElement = useCallback((pageNo: number) => (node: HTMLDivElement | null) => {
    if (node) {
      pageElementsRef.current.set(pageNo, node);
    } else {
      pageElementsRef.current.delete(pageNo);
    }
  }, []);

  useEffect(() => {
    onDocumentReadyRef.current = onDocumentReady;
    onPdfContextReadyRef.current = onPdfContextReady;
    onPdfPagesTextReadyRef.current = onPdfPagesTextReady;
  }, [onDocumentReady, onPdfContextReady, onPdfPagesTextReady]);

  useEffect(() => {
    let cancelled = false;
    let textExtractionTimer: number | null = null;
    setPdfDocument(null);
    setDocumentError("");
    setPageGeometries({});
    pageElementsRef.current.clear();
    restoredUrlRef.current = "";
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;

    void loadPdfJsRuntime()
      .then((pdfJs: Awaited<ReturnType<typeof loadPdfJsRuntime>>) => {
        if (cancelled) return null;
        loadingTask = pdfJs.getDocument({ url, worker: pdfJs.createPdfWorker() });
        return loadingTask!.promise;
      })
      .then((document: PDFDocumentProxy | null) => {
        if (!document || cancelled) {
          return;
        }
        setPdfDocument(document);
        onDocumentReadyRef.current(document.numPages);
        const initialGeometryPage = Math.min(Math.max(pageNumber, 1), document.numPages);
        const contextPageNumbers = pdfContextPageNumbers(document.numPages, {
          pdfContextFullPageLimit,
          pdfContextEdgePageCount,
        });
        let contextPublished = false;
        const publishExtractionProgress = (pages: PdfContextPage[]) => {
          if (cancelled) return;
          onPdfPagesTextReadyRef.current(pages);
          if (contextPublished) return;
          const extractedPageNumbers = new Set(pages.map((page) => page.page_no));
          if (!contextPageNumbers.every((pageNo) => extractedPageNumbers.has(pageNo))) return;
          contextPublished = true;
          onPdfContextReadyRef.current(pdfContextFromExtractedPages(
            documentId,
            documentTitle,
            document.numPages,
            { pdfContextFullPageLimit, pdfContextEdgePageCount },
            pages,
          ));
        };
        void document.getPage(initialGeometryPage)
          .then((page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>) => {
            if (cancelled) return;
            const viewport = page.getViewport({ scale: 1 });
            rememberPageGeometry(initialGeometryPage, {
              width: viewport.width,
              height: viewport.height,
              rotation: viewport.rotation,
            });
          })
          .catch(() => undefined);
        textExtractionTimer = window.setTimeout(() => {
          void extractPdfPagesFromDocument(document, {
            priorityPageNumbers: [initialGeometryPage, ...contextPageNumbers],
            shouldCancel: () => cancelled,
            progressBatchSize: 8,
            delayMs: 90,
            onProgress: publishExtractionProgress,
          })
            .then((pages: PdfContextPage[]) => {
              if (cancelled) return;
              publishExtractionProgress(pages);
              if (!contextPublished) {
                contextPublished = true;
                onPdfContextReadyRef.current(pdfContextFromExtractedPages(
                  documentId,
                  documentTitle,
                  document.numPages,
                  { pdfContextFullPageLimit, pdfContextEdgePageCount },
                  pages,
                ));
              }
            })
            .catch(() => undefined);
        }, 2800);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocumentError((error as Error).message || "PDF.js 无法加载该 PDF");
      });

    return () => {
      cancelled = true;
      if (textExtractionTimer !== null) window.clearTimeout(textExtractionTimer);
      if (activePageTimerRef.current) window.clearTimeout(activePageTimerRef.current);
      if (activePageFrameRef.current) window.cancelAnimationFrame(activePageFrameRef.current);
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [documentId, documentTitle, pdfContextEdgePageCount, pdfContextFullPageLimit, rememberPageGeometry, url]);

  useEffect(() => {
    lastActivePageRef.current = pageNumber;
    updateRenderWindowCenter(pageNumber);
  }, [pageNumber, updateRenderWindowCenter]);

  useEffect(() => {
    if (!pdfDocument || !scrollContainerRef.current || viewMode !== "continuous") return undefined;
    const observer = new IntersectionObserver(() => {
      requestActivePageFromLayout();
    }, {
      root: scrollContainerRef.current,
      threshold: pdfIntersectionThresholds,
    });

    const observedElements = Array.from(pageElementsRef.current.values());
    observedElements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [pdfDocument, pageCount, requestActivePageFromLayout, viewMode]);

  useEffect(() => {
    if (!pdfDocument || !pageCount || !viewportWidth || restoredUrlRef.current === url) return undefined;
    restoredUrlRef.current = url;
    const targetPage = Math.min(Math.max(pageNumber, 1), pageCount);
    // The timers are deliberately not cleared when a dependency (the pane
    // width, say) changes: the restore has already been claimed for this url
    // and a re-run would return early, so clearing here would drop it. A
    // document switch resets restoredUrlRef, which makes stale timers no-ops.
    const restore = () => {
      if (restoredUrlRef.current === url) scrollToPage(targetPage, "auto");
    };
    initialRestoreTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    initialRestoreTimersRef.current = [window.setTimeout(restore, 80), window.setTimeout(restore, 320)];
    return undefined;
  }, [pageCount, pageNumber, pdfDocument, scrollToPage, url, viewportWidth]);

  useEffect(() => () => {
    initialRestoreTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  // Page heights are a function of the pane width, scrollTop is not. When a
  // side panel opens or the window is resized, put the same spot of the same
  // page back under the 50% line before paint; two more passes catch pages
  // whose boxes settle a frame later. Active-page tracking is paused so the
  // relayout is never mistaken for the reader scrolling to the next page.
  useLayoutEffect(() => {
    const previousWidth = lastViewportWidthRef.current;
    lastViewportWidthRef.current = viewportWidth;
    const anchor = readingAnchorRef.current;
    if (!viewportWidth || !previousWidth || previousWidth === viewportWidth) return undefined;
    if (!pdfDocument || viewMode !== "continuous") return undefined;
    const navigation = navigationTargetRef.current;
    const inFlight = navigation && performance.now() < navigation.until ? navigation : null;
    if (!anchor && !inFlight) return undefined;

    restoringAnchorRef.current = true;
    const apply = () => {
      if (inFlight) {
        // The reader asked for a page and the animation has not landed yet:
        // land it in the new layout rather than freezing a frame of it.
        scrollToPage(inFlight.pageNo, "instant");
        return;
      }
      if (!anchor) return;
      const root = scrollContainerRef.current;
      const element = pageElementsRef.current.get(anchor.pageNo);
      if (!root || !element) return;
      const rootRect = root.getBoundingClientRect();
      const rect = pageBoxOf(element).getBoundingClientRect();
      if (!(rect.height > 0)) return;
      const pageTop = root.scrollTop + rect.top - rootRect.top;
      const target = Math.max(0, pageTop + rect.height * anchor.fraction + anchor.offsetPx - rootRect.height * 0.5);
      // scrollTo with an explicit behavior bypasses the container's CSS
      // scroll-behavior: smooth; an animated restore would let intermediate
      // scroll events overwrite the anchor before the layout settles.
      if (Math.abs(root.scrollTop - target) >= 1) root.scrollTo({ top: target, behavior: "instant" });
    };
    apply();
    let frame = window.requestAnimationFrame(() => {
      apply();
      frame = window.requestAnimationFrame(() => {
        apply();
        restoringAnchorRef.current = false;
        requestActivePageFromLayout();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      restoringAnchorRef.current = false;
    };
  }, [pdfDocument, requestActivePageFromLayout, scrollToPage, viewMode, viewportWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "PageDown") {
      event.preventDefault();
      scrollToPage(Math.min(safePageNumber + 1, Math.max(pageCount, 1)), "smooth");
    } else if (event.key === "PageUp") {
      event.preventDefault();
      scrollToPage(Math.max(safePageNumber - 1, 1), "smooth");
    } else if (event.key === "Home") {
      event.preventDefault();
      scrollToPage(1, "smooth");
    } else if (event.key === "End") {
      event.preventDefault();
      scrollToPage(Math.max(pageCount, 1), "smooth");
    }
  }, [pageCount, safePageNumber, scrollToPage]);

  const handleScroll = useCallback(() => {
    // Scroll events raised by the re-anchoring itself are not the reader moving.
    if (restoringAnchorRef.current) return;
    captureReadingAnchor();
    onViewerScroll?.();
    requestActivePageFromLayout();
  }, [captureReadingAnchor, onViewerScroll, requestActivePageFromLayout]);

  if (documentError) {
    return (
      <div className="pdf-native-fallback">
        <iframe title="PDF 预览 fallback" src={fallbackSrc} />
        <div className="pdf-layer-note error">PDF.js 渲染失败，已保留原生预览 fallback。{documentError}</div>
      </div>
    );
  }

  return (
    <div
      className={`pdf-js-viewer pdf-scroll-viewer ${viewMode === "single-page" ? "single-page" : "continuous"}`}
      ref={scrollContainerRef}
      aria-label={`${documentTitle} PDF 阅读器`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
    >
      {!pdfDocument && <div className="pdf-layer-note">正在加载 PDF...</div>}
      {pdfDocument && (
        <div className="pdf-page-stack" role="list" aria-label={`${documentTitle} PDF 页面`}>
          {pageNumbers.map((pageNo) => {
            const shouldRenderPage = viewMode === "single-page" || Math.abs(pageNo - renderWindowCenter) <= 1;
            const pageMetrics = pdfPageDisplayMetrics(viewportWidth, pageGeometries[pageNo] || pageGeometryFallback);
            return (
              <div
                key={pageNo}
                ref={registerPageElement(pageNo)}
                className={`pdf-page-shell ${pageNo === safePageNumber ? "active" : ""}`}
                data-page-container-number={pageNo}
                role="listitem"
                style={{ "--pdf-page-width": `${Math.round(pageMetrics.width)}px` } as CSSProperties}
              >
                <div className="pdf-page-label">PDF · p.{pageNo}{keyPageNumbers?.has(pageNo) ? " ★" : ""}</div>
                {shouldRenderPage ? (
                  <PdfPageLayer
                    pdfDocument={pdfDocument}
                    pageNumber={pageNo}
                    viewportWidth={viewportWidth}
                    geometry={pageGeometries[pageNo] || pageGeometryFallback}
                    onGeometryReady={rememberPageGeometry}
                    renderPageOverlay={renderPageOverlay}
                    onPageClick={onPageClick}
                  />
                ) : (
                  <PdfPagePlaceholder viewportWidth={viewportWidth} geometry={pageGeometries[pageNo] || pageGeometryFallback} />
                )}
                {renderPageFooter?.(pageNo)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
