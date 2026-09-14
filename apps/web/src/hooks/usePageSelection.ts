import { useCallback, useEffect, useState } from "react";
import type { AppCopy } from "../i18n";

export type SelectedContextSourceType =
  | "pdf-page"
  | "generated-explanation"
  | "assistant-message"
  | "page"
  | "unknown";

export type SelectedPdfSource = {
  pageNumber: number;
  title?: string;
  text?: string;
  ref?: string;
  parser?: string;
};

export type SelectedContext = {
  id: string;
  text: string;
  sourceType: SelectedContextSourceType;
  documentTitle?: string;
  pageNumber?: number;
  pdfPageNumber?: number;
  generatedPageNumber?: number;
  sectionTitle?: string;
  messageId?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selectionRects?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  /** Rendered size of the PDF page layer the selection lives in (px). */
  pageSize?: {
    width: number;
    height: number;
  };
  viewportScale?: number;
  viewportRotation?: number;
  pdfSource?: SelectedPdfSource;
  /** The text is the learner's own note about the page, not page text. */
  learnerNote?: boolean;
  createdAt: number;
};

export type SelectionToolbarState = {
  context: SelectedContext;
  x: number;
  y: number;
};

type SelectionPageData = {
  page_no: number;
  source: {
    pdf_page_ref: string;
    text_md: string;
    parser: string;
  };
  teaching: {
    slide_title: string;
  };
};

export function usePageSelection(args: {
  documentTitle: string;
  page: SelectionPageData;
  copy: AppCopy;
  createId: (prefix: string) => string;
  setLastSelection: (context: SelectedContext | null) => void;
}) {
  const [toolbar, setToolbar] = useState<SelectionToolbarState | null>(null);

  const updateSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !text) {
      setToolbar(null);
      args.setLastSelection(null);
      return;
    }

    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement || null;
    if (!anchorElement || shouldIgnoreSelection(anchorElement)) {
      setToolbar(null);
      args.setLastSelection(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const source = detectSelectionSource(anchorElement, args.copy);
    const pdfPageLayer = anchorElement.closest<HTMLElement>(".pdf-page-layered");
    const pdfPageNumber = Number(pdfPageLayer?.dataset.pageNumber || args.page.page_no);
    const viewportScale = Number(pdfPageLayer?.dataset.viewportScale || "");
    const viewportRotation = Number(pdfPageLayer?.dataset.viewportRotation || "");
    const isPdfSelection = source.sourceType === "pdf-page" && Number.isFinite(pdfPageNumber);
    const isNotesSelection = source.sourceType === "generated-explanation";
    const sourcePdfPageNumber = isPdfSelection ? pdfPageNumber : args.page.page_no;
    const pageRect = pdfPageLayer?.getBoundingClientRect();
    const clientRects = pdfPageLayer ? pdfTextLayerSelectionRects(range, pdfPageLayer) : Array.from(range.getClientRects());
    const selectionRects = clientRects
      .filter((item) => item.width > 0 && item.height > 0)
      .map((item) => ({
        x: pageRect ? item.left - pageRect.left : item.left,
        y: pageRect ? item.top - pageRect.top : item.top,
        width: item.width,
        height: item.height,
      }));
    const context: SelectedContext = {
      id: args.createId("selected"),
      text,
      sourceType: source.sourceType,
      documentTitle: args.documentTitle,
      pageNumber: sourcePdfPageNumber,
      pdfPageNumber: isPdfSelection || isNotesSelection ? sourcePdfPageNumber : undefined,
      generatedPageNumber: isNotesSelection ? args.page.page_no : undefined,
      sectionTitle: source.label,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      selectionRects,
      pageSize: pageRect && pageRect.width > 0 ? { width: pageRect.width, height: pageRect.height } : undefined,
      viewportScale: source.sourceType === "pdf-page" && Number.isFinite(viewportScale) ? viewportScale : undefined,
      viewportRotation: source.sourceType === "pdf-page" && Number.isFinite(viewportRotation) ? viewportRotation : undefined,
      pdfSource: isNotesSelection
        ? {
            pageNumber: sourcePdfPageNumber,
            title: args.page.teaching.slide_title || `PDF p.${sourcePdfPageNumber}`,
            text: args.page.source.text_md,
            ref: args.page.source.pdf_page_ref,
            parser: args.page.source.parser,
          }
        : undefined,
      createdAt: Date.now(),
    };

    args.setLastSelection(context);
    setToolbar({
      context,
      x: Math.min(window.innerWidth - 18, Math.max(18, rect.left + rect.width / 2)),
      y: Math.max(18, rect.top - 12),
    });
  }, [args]);

  useEffect(() => {
    let selectionFrame = 0;
    const onSelectionChange = () => {
      if (selectionFrame) return;
      selectionFrame = window.requestAnimationFrame(() => {
        selectionFrame = 0;
        updateSelection();
      });
    };
    const clearOnScroll = () => {
      const selection = window.getSelection();
      if (!selection?.toString().trim()) setToolbar(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("mouseup", onSelectionChange);
    window.addEventListener("keyup", onSelectionChange);
    window.addEventListener("scroll", clearOnScroll, true);
    window.addEventListener("resize", clearOnScroll);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("mouseup", onSelectionChange);
      window.removeEventListener("keyup", onSelectionChange);
      window.removeEventListener("scroll", clearOnScroll, true);
      window.removeEventListener("resize", clearOnScroll);
      if (selectionFrame) window.cancelAnimationFrame(selectionFrame);
    };
  }, [updateSelection]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    args.setLastSelection(null);
    setToolbar(null);
  }, [args]);

  return { toolbar, clearSelection };
}

/**
 * Selection boxes that hug the PDF text-layer spans.
 *
 * `Range.getClientRects()` reports the inline boxes of the text nodes, whose
 * height comes from the font's ascent + descent and can be ~40% taller than
 * the span pdf.js positioned over the glyphs. Using each intersected span's
 * box (trimmed horizontally to the selected part) gives marker-tight
 * highlights that line up with the page.
 */
function pdfTextLayerSelectionRects(range: Range, pageLayer: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const spans = pageLayer.querySelectorAll<HTMLElement>(".pdf-text-layer span");
  for (const span of spans) {
    if (span.getAttribute("role") === "img" || !range.intersectsNode(span)) continue;
    const spanRect = span.getBoundingClientRect();
    if (!spanRect.width || !spanRect.height) continue;
    const partial = document.createRange();
    partial.selectNodeContents(span);
    if (range.compareBoundaryPoints(Range.START_TO_START, partial) > 0) {
      partial.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, partial) < 0) {
      partial.setEnd(range.endContainer, range.endOffset);
    }
    const partialRects = Array.from(partial.getClientRects()).filter((item) => item.width > 0);
    partial.detach();
    if (!partialRects.length) continue;
    const left = Math.max(spanRect.left, Math.min(...partialRects.map((item) => item.left)));
    const right = Math.min(spanRect.right, Math.max(...partialRects.map((item) => item.right)));
    if (right - left <= 0) continue;
    rects.push(new DOMRect(left, spanRect.top, right - left, spanRect.height));
  }
  return rects.length ? rects : Array.from(range.getClientRects());
}

function shouldIgnoreSelection(element: Element) {
  return Boolean(
    element.closest(
      "input, textarea, select, [contenteditable='true'], .aui-composer-root, .selection-toolbar",
    ),
  );
}

function detectSelectionSource(element: Element, copy: AppCopy): { sourceType: SelectedContextSourceType; label: string } {
  if (element.closest(".pdf-page-layered, .pdf-text-layer")) return { sourceType: "pdf-page", label: copy.agent.selectionSources.pdfPage };
  if (element.closest(".notes-pane")) return { sourceType: "generated-explanation", label: copy.agent.selectionSources.notes };
  if (element.closest(".assistant-message")) return { sourceType: "assistant-message", label: copy.agent.selectionSources.assistant };
  if (element.closest(".page-rail")) return { sourceType: "page", label: copy.agent.selectionSources.rail };
  return { sourceType: "unknown", label: copy.agent.selectionSources.page };
}
