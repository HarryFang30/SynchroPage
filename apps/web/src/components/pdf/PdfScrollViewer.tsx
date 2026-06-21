import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
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
}: {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  viewportWidth: number;
  geometry?: PdfPageGeometry | null;
  onGeometryReady: (pageNo: number, geometry: PdfPageGeometry) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pageStatus, setPageStatus] = useState<PdfPageRenderStatus>("loading");
  const [pageError, setPageError] = useState("");
  const displayMetrics = pdfPageDisplayMetrics(viewportWidth, geometry);
  const [viewportMeta, setViewportMeta] = useState({
    width: displayMetrics.width,
    height: displayMetrics.height,
    scale: 1,
    rotation: 0,
    pageNumber,
  });

  useEffect(() => {
    setViewportMeta((current) => ({
      ...current,
      width: displayMetrics.width,
      height: displayMetrics.height,
    }));
  }, [displayMetrics.height, displayMetrics.width]);

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
      setViewportMeta({
        width: viewport.width,
        height: viewport.height,
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

  return (
    <>
      <div
        className="pdf-page-layered"
        data-page-number={viewportMeta.pageNumber}
        data-viewport-rotation={viewportMeta.rotation}
        data-viewport-scale={viewportMeta.scale}
        style={{
          width: viewportMeta.width ? `${viewportMeta.width}px` : undefined,
          height: viewportMeta.height ? `${viewportMeta.height}px` : undefined,
          aspectRatio: `${Math.max(viewportMeta.width, 1)} / ${Math.max(viewportMeta.height, 1)}`,
        }}
      >
        <canvas ref={canvasRef} className="pdf-visual-layer" />
        <div ref={textLayerRef} className="textLayer pdf-text-layer" aria-label="PDF 可选文本层" />
      </div>
      {pageStatus === "loading" && <div className="pdf-layer-note">正在渲染 PDF 页面...</div>}
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
}, ref) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const activePageTimerRef = useRef<number | null>(null);
  const activePageFrameRef = useRef<number | null>(null);
  const lastActivePageRef = useRef(pageNumber);
  const restoredUrlRef = useRef("");
  const viewportWidth = useElementWidth(scrollContainerRef);
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

  const chooseActivePage = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
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
  }, [scheduleActivePage, updateRenderWindowCenter]);

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
    const firstTimer = window.setTimeout(() => scrollToPage(targetPage, "auto"), 80);
    const secondTimer = window.setTimeout(() => scrollToPage(targetPage, "auto"), 320);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearTimeout(secondTimer);
    };
  }, [pageCount, pageNumber, pdfDocument, scrollToPage, url, viewportWidth]);

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
    onViewerScroll?.();
    requestActivePageFromLayout();
  }, [onViewerScroll, requestActivePageFromLayout]);

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
            return (
              <div
                key={pageNo}
                ref={registerPageElement(pageNo)}
                className={`pdf-page-shell ${pageNo === safePageNumber ? "active" : ""}`}
                data-page-container-number={pageNo}
                role="listitem"
              >
                <div className="pdf-page-label">PDF · p.{pageNo}</div>
                {shouldRenderPage ? (
                  <PdfPageLayer
                    pdfDocument={pdfDocument}
                    pageNumber={pageNo}
                    viewportWidth={viewportWidth}
                    geometry={pageGeometries[pageNo] || pageGeometryFallback}
                    onGeometryReady={rememberPageGeometry}
                  />
                ) : (
                  <PdfPagePlaceholder viewportWidth={viewportWidth} geometry={pageGeometries[pageNo] || pageGeometryFallback} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
