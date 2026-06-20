import {
  PDFWorker,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

export { TextLayer, getDocument };
export type { PDFDocumentProxy, RenderTask };

export function createPdfWorker() {
  return PDFWorker.create({ port: new PdfJsWorker() });
}
